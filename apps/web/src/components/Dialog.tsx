import type { ReactNode } from "react";

export const Dialog = ({
  title,
  children,
  onClose,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
}) => (
  <div className="dialog-backdrop">
    <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header className="dialog-header">
        <h2>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>
          ×
        </button>
      </header>
      {children}
    </div>
  </div>
);
