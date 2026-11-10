import type { PendingPermission } from "@grok-build-web/task-model";

export type PermissionDecision = { readonly optionId: string } | "cancel";

export const PermissionBanner = ({
  permission,
  disabled,
  onDecide,
}: {
  readonly permission: PendingPermission;
  readonly disabled: boolean;
  readonly onDecide: (decision: PermissionDecision) => void;
}) => (
  <section className="permission" role="alert" aria-live="assertive">
    <div className="permission-text">
      <strong>Permission required</strong>
      <span>{permission.title === "" ? permission.toolCallId : permission.title}</span>
    </div>
    <div className="permission-actions">
      {permission.options.map((option) => (
        <button
          key={option.optionId}
          type="button"
          disabled={disabled}
          onClick={() => onDecide({ optionId: option.optionId })}
        >
          {option.name === "" ? option.optionId : option.name}
        </button>
      ))}
      <button
        type="button"
        className="secondary"
        disabled={disabled}
        onClick={() => onDecide("cancel")}
      >
        Deny
      </button>
    </div>
  </section>
);
