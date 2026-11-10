import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewTaskDialog } from "./NewTaskDialog.tsx";

describe("NewTaskDialog", () => {
  it("omits the cwd for the default project and submits the prompt", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(
      <NewTaskDialog
        defaultCwd="/work"
        projects={[]}
        models={[]}
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    );
    const select = screen.getByLabelText("Project") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(within(select).getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("Default working directory")).toBeTruthy();
    await user.type(screen.getByLabelText("First prompt"), "  hello  ");
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect(onCreate).toHaveBeenCalledWith({
      cwd: undefined,
      prompt: "hello",
      model: undefined,
      yolo: false,
    });
  });

  it("maps the selected project root to the working directory", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(
      <NewTaskDialog
        defaultCwd="/work"
        projects={[
          { id: "p1", name: "Alpha", root: "/work/alpha" },
          { id: "p2", name: "Beta", root: "/work/nested/beta" },
        ]}
        models={[]}
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    );
    expect(screen.getByRole("option", { name: "Alpha — /work/alpha" })).toBeTruthy();
    expect(screen.getByText("Working directory: /work")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Project"), "/work/nested/beta");
    expect(screen.getByText("Working directory: /work/nested/beta")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect(onCreate).toHaveBeenCalledWith({
      cwd: "/work/nested/beta",
      prompt: undefined,
      model: undefined,
      yolo: false,
    });
  });

  it("lists models and honours the yolo toggle", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(
      <NewTaskDialog
        defaultCwd="/work"
        projects={[]}
        models={[{ modelId: "m1", name: "Model One" }, { modelId: "m2" }]}
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Model"), "m2");
    await user.click(screen.getByLabelText(/Yolo mode/));
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect(onCreate).toHaveBeenCalledWith({
      cwd: undefined,
      prompt: undefined,
      model: "m2",
      yolo: true,
    });
    expect(screen.getByRole("option", { name: "Model One" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "m2" })).toBeTruthy();
  });

  it("keeps the dialog open and shows a rejected create", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {
      throw new Error("Working directory is outside the allowed roots");
    });
    render(
      <NewTaskDialog
        defaultCwd="/work"
        projects={[]}
        models={[]}
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    );
    await user.type(screen.getByLabelText("First prompt"), "keep me");
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByText("Working directory is outside the allowed roots")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "New task" })).toBeTruthy();
    expect((screen.getByLabelText("First prompt") as HTMLTextAreaElement).value).toBe("keep me");
    expect(
      (screen.getByRole("button", { name: "Create task" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("closes on cancel", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <NewTaskDialog
        defaultCwd="/work"
        projects={[]}
        models={[]}
        onClose={onClose}
        onCreate={async () => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
