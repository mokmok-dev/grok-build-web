import type { TaskSummary } from "@grok-build-web/task-model";
import { basename, relativeTime, taskTitle } from "../api.ts";
import { StatusBadge } from "./StatusBadge.tsx";

export const TaskList = ({
  tasks,
  selectedId,
  now,
  onSelect,
}: {
  readonly tasks: readonly TaskSummary[];
  readonly selectedId: string | null;
  readonly now: number;
  readonly onSelect: (id: string) => void;
}) => {
  if (tasks.length === 0) {
    return <p className="empty-note">No tasks yet. Create one to start a session.</p>;
  }
  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <li key={task.id}>
          <button
            type="button"
            className={selectedId === task.id ? "task-item selected" : "task-item"}
            aria-current={selectedId === task.id ? "true" : undefined}
            onClick={() => onSelect(task.id)}
          >
            <span className="task-item-top">
              <StatusBadge status={task.status} />
              <span className="task-title">{taskTitle(task)}</span>
            </span>
            <span className="task-meta">
              {basename(task.cwd)} · {task.model ?? "default model"} ·{" "}
              {relativeTime(task.updatedAt, now)} · {task.messageCount} msg
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
};
