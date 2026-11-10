import type { TaskStatus } from "@grok-build-web/task-model";
import { STATUS_LABELS } from "../api.ts";

export const StatusBadge = ({ status }: { readonly status: TaskStatus }) => (
  <span className={`badge badge-${status}`} data-testid="status-badge">
    <span className="badge-dot" aria-hidden="true" />
    {STATUS_LABELS[status]}
  </span>
);
