import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TaskSummary } from "@grok-build-web/task-model";
import { TaskList } from "./TaskList.tsx";

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

describe("TaskList", () => {
  it("shows the empty state without tasks", () => {
    render(<TaskList tasks={[]} selectedId={null} now={1} onSelect={() => undefined} />);
    expect(screen.getByText(/No tasks yet/)).toBeTruthy();
  });

  it("shows task metadata and a title fallback", () => {
    render(
      <TaskList
        tasks={[task({ id: "a", title: "" }), task({ id: "b", title: "Second", model: "m" })]}
        selectedId={null}
        now={61_000}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByText("Untitled task")).toBeTruthy();
    expect(screen.getByText(/work · default model · 1m ago · 2 msg/)).toBeTruthy();
    expect(screen.getByText(/work · m · 1m ago · 2 msg/)).toBeTruthy();
  });

  it("marks the selected task and reports clicks", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <TaskList
        tasks={[task({ id: "a", title: "First" }), task({ id: "b", title: "Second" })]}
        selectedId="a"
        now={1}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole("button", { name: /First/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /Second/ }).getAttribute("aria-current")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Second/ }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });
});
