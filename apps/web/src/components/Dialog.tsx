import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const Dialog = ({
  title,
  children,
  onClose,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    restoreRef.current = document.activeElement;
    const container = containerRef.current;
    const first = container?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? container)?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(container?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (focusable.length === 0) return;
      const firstFocusable = focusable[0];
      const lastFocusable = focusable[focusable.length - 1];
      if (firstFocusable === undefined || lastFocusable === undefined) return;
      if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
      if (event.shiftKey && document.activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
    };
  }, []);

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={containerRef}
        tabIndex={-1}
      >
        <header className="dialog-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            onClick={() => onCloseRef.current()}
          >
            ×
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
};
