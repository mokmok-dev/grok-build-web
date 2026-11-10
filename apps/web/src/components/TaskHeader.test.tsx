import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TaskSummary } from "@grok-build-web/task-model";
import { TaskHeader } from "./TaskHeader.tsx";

const task = (patch: Partial<TaskSummary>): TaskSummary => ({
  id: "s1",
  title: "My task",
  cwd: "/tmp/work",
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  usage: {},
  ...patch,
});

describe("TaskHeader", () => {
  it("shows the title, status and location", () => {
    render(
      <TaskHeader
        task={task({})}
        connected
        onCancel={() => undefined}
        onClose={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByRole("heading", { name: "My task" })).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText(/\/tmp\/work · default model/)).toBeTruthy();
  });

  it("disables actions while disconnected", () => {
    render(
      <TaskHeader
        task={task({})}
        connected={false}
        onCancel={() => undefined}
        onClose={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("enables cancel only while running and close only when open", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onClose = vi.fn();
    const onRefresh = vi.fn();
    const first = render(
      <TaskHeader
        task={task({ status: "idle" })}
        connected
        onCancel={onCancel}
        onClose={onClose}
        onRefresh={onRefresh}
      />,
    );
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onClose).toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalled();

    first.unmount();
    const closed = render(
      <TaskHeader
        task={task({ status: "closed" })}
        connected
        onCancel={onCancel}
        onClose={onClose}
        onRefresh={onRefresh}
      />,
    );
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    closed.unmount();
    first.unmount();
  });
});
