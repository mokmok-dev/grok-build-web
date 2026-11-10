import type { TaskSummary } from "@grok-build-web/task-model";
import { taskTitle } from "../api.ts";
import { StatusBadge } from "./StatusBadge.tsx";

export const TaskHeader = ({
  task,
  connected,
  onCancel,
  onClose,
  onRefresh,
}: {
  readonly task: TaskSummary;
  readonly connected: boolean;
  readonly onCancel: () => void;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
}) => (
  <header className="task-header">
    <div className="task-heading">
      <h1>{taskTitle(task)}</h1>
      <StatusBadge status={task.status} />
    </div>
    <p className="task-sub">
      {task.cwd} · {task.model ?? "default model"}
    </p>
    <div className="task-actions">
      <button type="button" onClick={onRefresh}>
        Refresh
      </button>
      <button type="button" onClick={onCancel} disabled={!connected || task.status !== "running"}>
        Cancel
      </button>
      <button type="button" onClick={onClose} disabled={!connected || task.status === "closed"}>
        Close
      </button>
    </div>
  </header>
);
