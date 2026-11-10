import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog.tsx";

const Harness = ({ onClose }: { readonly onClose: () => void }) => {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      {open ? (
        <Dialog
          title="Example"
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        >
          <button type="button">Inner</button>
        </Dialog>
      ) : null}
    </div>
  );
};

describe("Dialog", () => {
  it("renders in a portal with an accessible name", () => {
    render(<Harness onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog", { name: "Example" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.body.contains(dialog)).toBe(true);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves focus inside on open", () => {
    render(<Harness onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("restores focus to the previous element after closing", async () => {
    const user = userEvent.setup();
    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.append(trigger);
    trigger.focus();

    render(<Harness onClose={() => undefined} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("closes on a backdrop click", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const backdrop = document.querySelector(".dialog-backdrop");
    if (backdrop === null) throw new Error("no backdrop");
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("traps Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(<Harness onClose={() => undefined} />);
    const buttons = within(screen.getByRole("dialog")).getAllByRole("button");
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (first === undefined || last === undefined) throw new Error("expected buttons");
    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);
    first.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });
});
