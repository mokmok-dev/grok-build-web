import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TaskSummary } from "@grok-build-web/task-model";
import { ProjectList } from "./ProjectList.tsx";

const task = (patch: Partial<TaskSummary>): TaskSummary => ({
  id: "s1",
  title: "A task",
  cwd: "/tmp/work",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  messageCount: 2,
  usage: {},
  yolo: false,
  ...patch,
});

const projects = [{ id: "p1", name: "Alpha", root: "/tmp/alpha" }];

describe("ProjectList", () => {
  it("groups tasks and keeps projects collapsed by default", () => {
    render(
      <ProjectList
        projects={projects}
        tasks={[
          task({ id: "a", title: "Alpha task", cwd: "/tmp/alpha" }),
          task({ id: "u", title: "Other task" }),
        ]}
        selectedId={null}
        now={1}
        expanded={{}}
        onToggle={() => undefined}
        onSelect={() => undefined}
      />,
    );
    const header = screen.getByRole("button", { name: /^Alpha,/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Alpha task")).toBeNull();
    expect(screen.getByText("alpha · 1 task")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Ungrouped,/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.getByText("Other task")).toBeTruthy();
  });

  it("toggles a project section and reports the click", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <ProjectList
        projects={projects}
        tasks={[task({ id: "a", title: "Alpha task", cwd: "/tmp/alpha" })]}
        selectedId={null}
        now={1}
        expanded={{}}
        onToggle={onToggle}
        onSelect={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^Alpha,/ }));
    expect(onToggle).toHaveBeenCalledWith("p1", true);
  });

  it("shows an expanded project and reports a collapse", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <ProjectList
        projects={projects}
        tasks={[task({ id: "a", title: "Alpha task", cwd: "/tmp/alpha" })]}
        selectedId={null}
        now={1}
        expanded={{ p1: true }}
        onToggle={onToggle}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByText("Alpha task")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Alpha,/ }));
    expect(onToggle).toHaveBeenCalledWith("p1", false);
  });

  it("points aria-controls at the expanded task list", () => {
    render(
      <ProjectList
        projects={projects}
        tasks={[task({ id: "a", title: "Alpha task", cwd: "/tmp/alpha" })]}
        selectedId={null}
        now={1}
        expanded={{ p1: true }}
        onToggle={() => undefined}
        onSelect={() => undefined}
      />,
    );
    const header = screen.getByRole("button", { name: /^Alpha,/ });
    const id = header.getAttribute("aria-controls");
    expect(id).toBe("project-tasks-p1");
    expect(document.getElementById(id ?? "")).toBeTruthy();
    expect(header.closest("h2")).toBeTruthy();
  });

  it("expands the project that holds the selected task", () => {
    render(
      <ProjectList
        projects={projects}
        tasks={[task({ id: "a", title: "Alpha task", cwd: "/tmp/alpha" })]}
        selectedId="a"
        now={1}
        expanded={{}}
        onToggle={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /^Alpha,/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.getByText("Alpha task")).toBeTruthy();
  });

  it("groups on path-segment boundaries and prefers the longest root", () => {
    render(
      <ProjectList
        projects={[
          { id: "p1", name: "Alpha", root: "/tmp/alpha" },
          { id: "p2", name: "Deep", root: "/tmp/alpha/deep" },
        ]}
        tasks={[
          task({ id: "child", title: "Child task", cwd: "/tmp/alpha/src" }),
          task({ id: "deep", title: "Deep task", cwd: "/tmp/alpha/deep/one" }),
          task({ id: "sibling", title: "Sibling task", cwd: "/tmp/alphabet" }),
        ]}
        selectedId={null}
        now={1}
        expanded={{ p1: true, p2: true, ungrouped: true }}
        onToggle={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByText("Child task")).toBeTruthy();
    expect(screen.getByText("Deep task")).toBeTruthy();
    expect(screen.getByText("Sibling task")).toBeTruthy();
    expect(screen.getByText("alpha · 1 task")).toBeTruthy();
    expect(screen.getByText("deep · 1 task")).toBeTruthy();
    expect(screen.getByText("1 task")).toBeTruthy();
  });

  it("falls back to an expanded ungrouped section without projects", () => {
    render(
      <ProjectList
        projects={[]}
        tasks={[task({ id: "u", title: "Other task" })]}
        selectedId={null}
        now={1}
        expanded={{}}
        onToggle={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /^Ungrouped,/ })).toBeTruthy();
    expect(screen.getByText("Other task")).toBeTruthy();
  });

  it("shows no tasks for an expanded empty project", () => {
    render(
      <ProjectList
        projects={projects}
        tasks={[]}
        selectedId={null}
        now={1}
        expanded={{ p1: true }}
        onToggle={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByText("No tasks in this project.")).toBeTruthy();
  });

  it("keeps the create-a-task guidance for an empty ungrouped section", () => {
    render(
      <ProjectList
        projects={[]}
        tasks={[]}
        selectedId={null}
        now={1}
        expanded={{}}
        onToggle={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByText("No tasks yet. Create one to start a session.")).toBeTruthy();
  });
});
