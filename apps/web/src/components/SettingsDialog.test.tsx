import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog.tsx";

const settings = {
  url: "ws://127.0.0.1:2419/ws",
  hasSecret: true,
  defaultCwd: "/work",
  defaultModel: "m1",
  readOnly: false,
};

describe("SettingsDialog", () => {
  it("submits changed settings", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<SettingsDialog settings={settings} onClose={() => undefined} onSave={onSave} />);
    expect((screen.getByLabelText("ACP WebSocket URL") as HTMLInputElement).value).toBe(
      settings.url,
    );
    expect(screen.getByPlaceholderText("stored on the server")).toBeTruthy();
    await user.type(screen.getByLabelText("Secret"), "new-secret");
    await user.clear(screen.getByLabelText("Default model"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({
      url: settings.url,
      secret: "new-secret",
      defaultCwd: "/work",
      defaultModel: undefined,
    });
  });

  it("notes read-only mode and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SettingsDialog
        settings={{ ...settings, readOnly: true }}
        onClose={onClose}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByText(/Read-only mode/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Close dialog/ }));
    expect(onClose).toHaveBeenCalled();
  });
});
