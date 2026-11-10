import type { ChatMessage, MessagePart, Task, ToolCall } from "./task.ts";

export type UiPart =
  | { readonly type: "text"; readonly content: string }
  | { readonly type: "thinking"; readonly content: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
      readonly state: "input-available" | "output-available";
      readonly output?: unknown;
    };

export interface UiMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly parts: readonly UiPart[];
}

const toUiTool = (tool: ToolCall): UiPart => ({
  type: "tool-call",
  id: tool.toolCallId,
  name: tool.name,
  arguments: tool.arguments === "" ? JSON.stringify(tool.input ?? {}) : tool.arguments,
  state: tool.status === "completed" ? "output-available" : "input-available",
  output: tool.output,
});

const toUiPart = (part: MessagePart): UiPart => {
  switch (part.type) {
    case "text":
      return { type: "text", content: part.text };
    case "thinking":
      return { type: "thinking", content: part.text };
    case "tool":
      return toUiTool(part.tool);
  }
};

const toUiMessage = (message: ChatMessage): UiMessage => ({
  id: message.id,
  role: message.role,
  parts: message.parts.map(toUiPart),
});

export const taskToUiMessages = (task: Task): readonly UiMessage[] =>
  task.messages.map(toUiMessage);
