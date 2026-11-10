import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.tsx";

describe("Composer", () => {
  it("disables input and send while disconnected", () => {
    render(<Composer disabled placeholder="Disconnected" onSend={() => undefined} />);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends trimmed text and clears the field", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const { container } = render(<Composer disabled={false} placeholder="Ask" onSend={onSend} />);
    await user.type(screen.getByLabelText("Message"), "  hello  ");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("hello");
    const textarea = container.querySelector("textarea");
    expect(textarea?.value).toBe("");
  });

  it("sends with Ctrl+Enter and ignores plain Enter", async () => {
    const onSend = vi.fn();
    render(<Composer disabled={false} placeholder="Ask" onSend={onSend} />);
    const field = screen.getByLabelText("Message");
    fireEvent.change(field, { target: { value: "hi" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    expect(onSend).toHaveBeenCalledWith("hi");
    fireEvent.change(field, { target: { value: "meta" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("meta");
  });

  it("ignores empty submissions", () => {
    const onSend = vi.fn();
    render(<Composer disabled={false} placeholder="Ask" onSend={onSend} />);
    fireEvent.submit(
      screen.getByRole("button", { name: "Send" }).closest("form") as HTMLFormElement,
    );
    expect(onSend).not.toHaveBeenCalled();
  });
});
