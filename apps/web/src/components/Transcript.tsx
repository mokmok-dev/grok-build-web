import type { PlanEntry, Usage } from "@grok-build-web/task-model";
import type { UIMessage } from "@tanstack/ai-react";
import { usageLine } from "../api.ts";
import { EmptyState } from "./EmptyState.tsx";
import { PartView } from "./PartView.tsx";

const PlanChecklist = ({ entries }: { readonly entries: readonly PlanEntry[] }) => (
  <section className="plan" aria-label="Plan">
    <h2>Plan</h2>
    <ul>
      {entries.map((entry, index) => (
        <li key={`${index}-${entry.content}`} data-status={entry.status}>
          <span className="plan-status">{entry.status}</span>
          <span className="plan-content">{entry.content}</span>
          {entry.priority === "" ? null : <span className="plan-priority">{entry.priority}</span>}
        </li>
      ))}
    </ul>
  </section>
);

export const Transcript = ({
  messages,
  plan,
  usage,
  streaming,
}: {
  readonly messages: readonly UIMessage[];
  readonly plan: readonly PlanEntry[];
  readonly usage: Usage;
  readonly streaming: boolean;
}) => (
  <div className="transcript" aria-live="polite" aria-busy={streaming}>
    {messages.length === 0 ? (
      <EmptyState title="No messages yet" body="Send a prompt to start the conversation." />
    ) : (
      messages.map((message) => (
        <article key={message.id} className={`message message-${message.role}`}>
          <span className="message-role">{message.role === "user" ? "You" : "Grok"}</span>
          {message.parts.map((part, index) => (
            <PartView key={`${message.id}-${index}`} part={part} />
          ))}
        </article>
      ))
    )}
    {plan.length === 0 ? null : <PlanChecklist entries={plan} />}
    {usageLine(usage) === "" ? null : <p className="usage">{usageLine(usage)}</p>}
  </div>
);
