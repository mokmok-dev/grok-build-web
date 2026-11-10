import { useState } from "react";

export const Composer = ({
  disabled,
  placeholder,
  onSend,
}: {
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly onSend: (text: string) => void;
}) => {
  const [text, setText] = useState("");

  const submit = (): void => {
    const trimmed = text.trim();
    if (disabled || trimmed === "") return;
    onSend(trimmed);
    setText("");
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="sr-only" htmlFor="composer-input">
        Message
      </label>
      <textarea
        id="composer-input"
        rows={3}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-actions">
        <span className="composer-hint">Ctrl/Cmd + Enter to send</span>
        <button type="submit" disabled={disabled || text.trim() === ""}>
          Send
        </button>
      </div>
    </form>
  );
};
