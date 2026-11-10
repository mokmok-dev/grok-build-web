import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog.tsx";

const settings = {
  url: "ws://127.0.0.1:2419/ws",
  hasSecret: true,
  defaultCwd: "/work",
  roots: ["/work"],
  defaultModel: "m1",
  readOnly: false,
  configFile: "/etc/grok-build-web.config.json",
  configFileExists: true,
};

describe("SettingsDialog", () => {
  it("shows the resolved configuration without an edit path", () => {
    render(<SettingsDialog settings={settings} onClose={() => undefined} />);
    expect(screen.getByText(settings.url)).toBeTruthy();
    expect(screen.getByText("Configured")).toBeTruthy();
    expect(screen.getByText("/work")).toBeTruthy();
    expect(screen.getByText("m1")).toBeTruthy();
    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(screen.getByText(settings.configFile)).toBeTruthy();
    expect(screen.getByText(/read from this file/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("points at the environment when no file exists", () => {
    render(
      <SettingsDialog
        settings={{ ...settings, configFileExists: false }}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/No config file at this path/)).toBeTruthy();
    expect(screen.getByText(/come from the server environment/)).toBeTruthy();
  });

  it("notes unset values and read-only mode, then closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SettingsDialog
        settings={{ ...settings, hasSecret: false, defaultModel: undefined, readOnly: true }}
        onClose={onClose}
      />,
    );
    expect(screen.getAllByText("Not set")).toHaveLength(2);
    expect(screen.getByText("Enabled")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Close dialog/ }));
    expect(onClose).toHaveBeenCalled();
  });
});
