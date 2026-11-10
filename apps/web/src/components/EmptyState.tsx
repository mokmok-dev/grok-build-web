import type { ReactNode } from "react";

export const EmptyState = ({
  title,
  body,
  action,
}: {
  readonly title: string;
  readonly body?: string;
  readonly action?: ReactNode;
}) => (
  <div className="empty-state">
    <h2>{title}</h2>
    {body === undefined ? null : <p>{body}</p>}
    {action}
  </div>
);
