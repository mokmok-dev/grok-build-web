import type { Settings } from "../api.ts";
import { Dialog } from "./Dialog.tsx";

export const SettingsDialog = ({
  settings,
  onClose,
}: {
  readonly settings: Settings;
  readonly onClose: () => void;
}) => (
  <Dialog title="Settings" onClose={onClose}>
    <dl className="settings-list">
      <dt>ACP WebSocket URL</dt>
      <dd>{settings.url}</dd>

      <dt>Secret</dt>
      <dd>{settings.hasSecret ? "Configured" : "Not set"}</dd>

      <dt>Default working directory</dt>
      <dd>{settings.defaultCwd}</dd>

      <dt>Default model</dt>
      <dd>{settings.defaultModel ?? "Not set"}</dd>

      <dt>Read-only mode</dt>
      <dd>{settings.readOnly ? "Enabled" : "Disabled"}</dd>

      <dt>Config file</dt>
      <dd>
        <code>{settings.configFile}</code>
      </dd>
    </dl>

    <p className="note">
      {settings.configFileExists ? (
        <>
          Settings are read from this file at startup. Edit it on the server host and restart the
          server to apply changes.
        </>
      ) : (
        <>
          No config file at this path; the values above come from the server environment. Create the
          file on the server host and restart the server to configure settings.
        </>
      )}
    </p>
  </Dialog>
);
