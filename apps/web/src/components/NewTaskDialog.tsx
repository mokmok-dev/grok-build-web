import { useState } from "react";
import { type ModelInfo, type Project } from "../api.ts";
import { Dialog } from "./Dialog.tsx";

export interface NewTaskInput {
  readonly cwd?: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly yolo: boolean;
}

export const NewTaskDialog = ({
  defaultCwd,
  projects,
  models,
  onClose,
  onCreate,
}: {
  readonly defaultCwd: string;
  readonly projects: readonly Project[];
  readonly models: readonly ModelInfo[];
  readonly onClose: () => void;
  readonly onCreate: (input: NewTaskInput) => Promise<void>;
}) => {
  const [root, setRoot] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [yolo, setYolo] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const cwd = root === "" ? defaultCwd : root;

  return (
    <Dialog title="New task" onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (submitting) return;
          const trimmedPrompt = prompt.trim();
          setSubmitError(undefined);
          setSubmitting(true);
          // Sending no cwd leaves the choice to the server, which resolves its configured default.
          onCreate({
            cwd: root === "" ? undefined : root,
            prompt: trimmedPrompt === "" ? undefined : trimmedPrompt,
            model: model === "" ? undefined : model,
            yolo,
          })
            .catch((cause: unknown) =>
              setSubmitError(cause instanceof Error ? cause.message : String(cause)),
            )
            .finally(() => setSubmitting(false));
        }}
      >
        <label htmlFor="new-project">Project</label>
        <select id="new-project" value={root} onChange={(event) => setRoot(event.target.value)}>
          <option value="">Default working directory</option>
          {projects.map((project) => (
            <option key={project.id} value={project.root}>
              {project.name} — {project.root}
            </option>
          ))}
        </select>
        <p className="empty-note">
          {cwd === "" ? "Server default working directory" : `Working directory: ${cwd}`}
        </p>

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

        {submitError === undefined ? null : (
          <p className="error" role="status">
            {submitError}
          </p>
        )}

        <div className="form-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={submitting}>
            Create task
          </button>
        </div>
      </form>
    </Dialog>
  );
};
