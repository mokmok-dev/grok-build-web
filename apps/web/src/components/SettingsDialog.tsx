import { useState } from "react";
import type { Settings } from "../api.ts";
import { Dialog } from "./Dialog.tsx";

export interface SettingsInput {
  readonly url?: string;
  readonly secret?: string;
  readonly defaultCwd?: string;
  readonly defaultModel?: string;
}

export const SettingsDialog = ({
  settings,
  onClose,
  onSave,
}: {
  readonly settings: Settings;
  readonly onClose: () => void;
  readonly onSave: (input: SettingsInput) => void;
}) => {
  const [url, setUrl] = useState(settings.url);
  const [secret, setSecret] = useState("");
  const [defaultCwd, setDefaultCwd] = useState(settings.defaultCwd);
  const [defaultModel, setDefaultModel] = useState(settings.defaultModel ?? "");

  return (
    <Dialog title="Settings" onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            url: url.trim(),
            secret: secret === "" ? undefined : secret,
            defaultCwd: defaultCwd.trim(),
            defaultModel: defaultModel.trim() === "" ? undefined : defaultModel.trim(),
          });
        }}
      >
        <label htmlFor="settings-url">ACP WebSocket URL</label>
        <input id="settings-url" value={url} onChange={(event) => setUrl(event.target.value)} />

        <label htmlFor="settings-secret">Secret</label>
        <input
          id="settings-secret"
          type="password"
          value={secret}
          placeholder={settings.hasSecret ? "stored on the server" : "not set"}
          onChange={(event) => setSecret(event.target.value)}
        />

        <label htmlFor="settings-cwd">Default working directory</label>
        <input
          id="settings-cwd"
          value={defaultCwd}
          onChange={(event) => setDefaultCwd(event.target.value)}
        />

        <label htmlFor="settings-model">Default model</label>
        <input
          id="settings-model"
          value={defaultModel}
          onChange={(event) => setDefaultModel(event.target.value)}
        />

        {settings.readOnly ? (
          <p className="note">Read-only mode is enabled on the server.</p>
        ) : null}

        <div className="form-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit">Save</button>
        </div>
      </form>
    </Dialog>
  );
};
