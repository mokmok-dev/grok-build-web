import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PermissionBanner } from "./PermissionBanner.tsx";

const permission = {
  requestId: "r1",
  toolCallId: "t1",
  title: "Run ls",
  options: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject_once", name: "", kind: "reject_once" },
  ],
};

describe("PermissionBanner", () => {
  it("shows the tool and its options", () => {
    render(
      <PermissionBanner permission={permission} disabled={false} onDecide={() => undefined} />,
    );
    expect(screen.getByText("Run ls")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "reject_once" })).toBeTruthy();
  });

  it("reports the chosen option and denial", async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(<PermissionBanner permission={permission} disabled={false} onDecide={onDecide} />);
    await user.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onDecide).toHaveBeenCalledWith({ optionId: "allow_once" });
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith("cancel");
  });

  it("falls back to the tool call id and disables actions", () => {
    render(
      <PermissionBanner
        permission={{ ...permission, title: "" }}
        disabled
        onDecide={() => undefined}
      />,
    );
    expect(screen.getByText("t1")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Allow once" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
