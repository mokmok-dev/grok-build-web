import type { UIMessage } from "@tanstack/ai-react";
import type { ReactNode } from "react";

type Part = UIMessage["parts"][number];

const ToolCard = ({
  name,
  state,
  children,
}: {
  readonly name: string;
  readonly state?: string;
  readonly children?: ReactNode;
}) => (
  <section className="tool-card" aria-label={`Tool ${name}`}>
    <header className="tool-card-header">
      <span className="tool-card-name">{name}</span>
      {state === undefined ? null : <span className="tool-card-state">{state}</span>}
    </header>
    {children}
  </section>
);

const formatValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export const PartView = ({ part }: { readonly part: Part }) => {
  switch (part.type) {
    case "text":
      return <p className="part-text">{part.content}</p>;
    case "thinking":
      return (
        <details className="part-thinking">
          <summary>Thinking</summary>
          <pre>{part.content}</pre>
        </details>
      );
    case "tool-call": {
      const input = part.arguments === "" ? undefined : part.arguments;
      return (
        <ToolCard name={part.name} state={part.state}>
          {input === undefined ? null : <pre className="tool-input">{formatValue(input)}</pre>}
          {part.output === undefined ? null : (
            <pre className="tool-output">{formatValue(part.output)}</pre>
          )}
        </ToolCard>
      );
    }
    case "tool-result":
      return (
        <ToolCard name={part.name ?? "tool"} state={part.state}>
          <pre className="tool-output">{formatValue(part.content)}</pre>
        </ToolCard>
      );
    default:
      return null;
  }
};
