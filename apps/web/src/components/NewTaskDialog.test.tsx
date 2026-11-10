import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewTaskDialog } from "./NewTaskDialog.tsx";

describe("NewTaskDialog", () => {
  it("prefills the default cwd and submits the prompt", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(
      <NewTaskDialog
        defaultCwd="/work"
        models={[]}
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    );
    expect((screen.getByLabelText("Working directory") as HTMLInputElement).value).toBe("/work");
    await user.type(screen.getByLabelText("First prompt"), "  hello  ");
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect(onCreate).toHaveBeenCalledWith({
      cwd: "/work",
      prompt: "hello",
      model: undefined,
      yolo: false,
    });
  });

  it("lists models and honours the yolo toggle", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(
      <NewTaskDialog
        defaultCwd="/work"
        models={[{ modelId: "m1", name: "Model One" }, { modelId: "m2" }]}
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Model"), "m2");
    await user.click(screen.getByLabelText(/Yolo mode/));
    await user.clear(screen.getByLabelText("Working directory"));
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect(onCreate).toHaveBeenCalledWith({
      cwd: "/work",
      prompt: undefined,
      model: "m2",
      yolo: true,
    });
    expect(screen.getByRole("option", { name: "Model One" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "m2" })).toBeTruthy();
  });

  it("closes on cancel", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <NewTaskDialog defaultCwd="/work" models={[]} onClose={onClose} onCreate={() => undefined} />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
