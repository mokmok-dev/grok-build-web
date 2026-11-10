import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewProjectDialog } from "./NewProjectDialog.tsx";

const installDirs = (listings: Record<string, unknown>): string[] => {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      const path = new URL(url, "http://localhost").searchParams.get("path") ?? "";
      const body = listings[path] ?? { error: "cannot list" };
      return new Response(JSON.stringify(body), {
        status: listings[path] === undefined ? 400 : 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return requested;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NewProjectDialog", () => {
  it("lists the default directory, expands lazily and submits the root", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    const requested = installDirs({
      "/work": { path: "/work", entries: ["/work/app"] },
      "/work/app": {
        path: "/work/app",
        entries: ["/work/app/src"],
      },
    });
    render(
      <NewProjectDialog
        defaultCwd="/work"
        roots={["/work"]}
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    );
    const create = (): HTMLButtonElement =>
      screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement;
    expect(create().disabled).toBe(true);
    expect(screen.getByText("Select a directory")).toBeTruthy();

    expect(await screen.findByRole("button", { name: "app" })).toBeTruthy();
    expect(requested).toEqual(["/api/fs/dirs?path=%2Fwork"]);

    await user.click(screen.getByRole("button", { name: "Expand app" }));
    expect(await screen.findByRole("button", { name: "src" })).toBeTruthy();
    expect(requested).toEqual(["/api/fs/dirs?path=%2Fwork", "/api/fs/dirs?path=%2Fwork%2Fapp"]);

    await user.click(screen.getByRole("button", { name: "src" }));
    expect(screen.getByText("Selected: /work/app/src")).toBeTruthy();
    expect(create().disabled).toBe(false);
    await user.click(create());
    expect(onCreate).toHaveBeenCalledWith({ name: undefined, root: "/work/app/src" });
  });

  it("uses the selected directory basename as the name placeholder", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    installDirs({
      "/work": { path: "/work", entries: ["/work/app"] },
    });
    render(
      <NewProjectDialog
        defaultCwd="/work"
        roots={["/work"]}
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    );
    const name = screen.getByLabelText("Project name") as HTMLInputElement;
    expect(name.placeholder).toBe("work");
    await user.click(await screen.findByRole("button", { name: "app" }));
    expect(name.placeholder).toBe("app");
    await user.type(name, "  My app  ");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect(onCreate).toHaveBeenCalledWith({ name: "My app", root: "/work/app" });
  });

  it("opens one anchored row per reachable root so a disjoint root is browsable", async () => {
    const user = userEvent.setup();
    const requested = installDirs({
      "/work": { path: "/work", entries: [] },
      "/srv": { path: "/srv", entries: ["/srv/data"] },
    });
    render(
      <NewProjectDialog
        defaultCwd="/work"
        roots={["/work", "/srv"]}
        onClose={() => undefined}
        onCreate={vi.fn()}
      />,
    );
    expect(await screen.findByRole("button", { name: "work" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "data" })).toBeTruthy();
    expect(requested).toEqual(["/api/fs/dirs?path=%2Fwork", "/api/fs/dirs?path=%2Fsrv"]);

    await user.click(screen.getByRole("button", { name: "data" }));
    expect(screen.getByText("Selected: /srv/data")).toBeTruthy();
  });

  it("reports a truncated nested listing with the number shown", async () => {
    const user = userEvent.setup();
    installDirs({
      "/work": { path: "/work", entries: ["/work/app"] },
      "/work/app": {
        path: "/work/app",
        entries: ["/work/app/src"],
        truncated: true,
      },
    });
    render(
      <NewProjectDialog
        defaultCwd="/work"
        roots={["/work"]}
        onClose={() => undefined}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.queryByText("Showing the first 1 subdirectories")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Expand app" }));
    expect(await screen.findByText("Showing the first 1 subdirectories")).toBeTruthy();
  });

  it("starts from the server default when settings are unavailable", async () => {
    const requested = installDirs({ "": { path: "/srv", entries: [] } });
    render(
      <NewProjectDialog
        defaultCwd={null}
        roots={[]}
        onClose={() => undefined}
        onCreate={vi.fn()}
      />,
    );
    expect(await screen.findByRole("button", { name: "srv" })).toBeTruthy();
    expect(requested).toEqual(["/api/fs/dirs"]);
  });

  it("reports a directory that cannot be listed", async () => {
    installDirs({});
    render(
      <NewProjectDialog
        defaultCwd="/work"
        roots={["/work"]}
        onClose={() => undefined}
        onCreate={vi.fn()}
      />,
    );
    expect(await screen.findByText("cannot list")).toBeTruthy();
  });

  it("hides a directory error once the row is collapsed", async () => {
    const user = userEvent.setup();
    installDirs({
      "/work": { path: "/work", entries: ["/work/app"] },
    });
    render(
      <NewProjectDialog
        defaultCwd="/work"
        roots={["/work"]}
        onClose={() => undefined}
        onCreate={vi.fn()}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Expand app" }));
    expect(await screen.findByText("cannot list")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Collapse app" }));
    expect(screen.queryByText("cannot list")).toBeNull();
  });

  it("keeps the dialog open and shows a rejected create", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {
      throw new Error("A project already uses this directory: /work");
    });
    installDirs({ "/work": { path: "/work", entries: [] } });
    render(
      <NewProjectDialog
        defaultCwd="/work"
        roots={["/work"]}
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "work" }));
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("A project already uses this directory: /work")).toBeTruthy();
    expect(screen.getByText("Selected: /work")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("closes on cancel", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    installDirs({});
    render(<NewProjectDialog defaultCwd="/work" roots={[]} onClose={onClose} onCreate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
