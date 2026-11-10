import { useState } from "react";
import type { ModelInfo } from "../api.ts";
import { Dialog } from "./Dialog.tsx";

export interface NewTaskInput {
  readonly cwd: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly yolo: boolean;
}

export const NewTaskDialog = ({
  defaultCwd,
  models,
  onClose,
  onCreate,
}: {
  readonly defaultCwd: string;
  readonly models: readonly ModelInfo[];
  readonly onClose: () => void;
  readonly onCreate: (input: NewTaskInput) => void;
}) => {
  const [cwd, setCwd] = useState(defaultCwd);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [yolo, setYolo] = useState(false);

  return (
    <Dialog title="New task" onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmedCwd = cwd.trim();
          const trimmedPrompt = prompt.trim();
          onCreate({
            cwd: trimmedCwd === "" ? defaultCwd : trimmedCwd,
            prompt: trimmedPrompt === "" ? undefined : trimmedPrompt,
            model: model === "" ? undefined : model,
            yolo,
          });
        }}
      >
        <label htmlFor="new-cwd">Working directory</label>
        <input id="new-cwd" value={cwd} onChange={(event) => setCwd(event.target.value)} />

        <label htmlFor="new-model">Model</label>
        <select id="new-model" value={model} onChange={(event) => setModel(event.target.value)}>
          <option value="">Default</option>
          {models.map((entry) => (
            <option key={entry.modelId} value={entry.modelId}>
              {entry.name ?? entry.modelId}
            </option>
          ))}
        </select>

        <label htmlFor="new-prompt">First prompt</label>
        <textarea
          id="new-prompt"
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />

        <label className="checkbox" htmlFor="new-yolo">
          <input
            id="new-yolo"
            type="checkbox"
            checked={yolo}
            onChange={(event) => setYolo(event.target.checked)}
          />
          Yolo mode (auto-approve tool calls)
        </label>

        <div className="form-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit">Create task</button>
        </div>
      </form>
    </Dialog>
  );
};
