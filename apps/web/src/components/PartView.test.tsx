import { render, screen } from "@testing-library/react";
import type { UIMessage } from "@tanstack/ai-react";
import { describe, expect, it } from "vitest";
import { PartView } from "./PartView.tsx";

type Part = UIMessage["parts"][number];

const part = (value: unknown): Part => value as Part;

describe("PartView", () => {
  it("renders text", () => {
    render(<PartView part={part({ type: "text", content: "hello" })} />);
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("renders collapsible thinking", () => {
    render(<PartView part={part({ type: "thinking", content: "why" })} />);
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByText("why")).toBeTruthy();
  });

  it("renders a tool call with input and output", () => {
    render(
      <PartView
        part={part({
          type: "tool-call",
          id: "t1",
          name: "shell",
          arguments: '{"command":"ls"}',
          state: "complete",
          output: { ok: true },
        })}
      />,
    );
    expect(screen.getByLabelText("Tool shell")).toBeTruthy();
    expect(screen.getByText('{"command":"ls"}')).toBeTruthy();
    expect(screen.getByText(/"ok": true/)).toBeTruthy();
    expect(screen.getByText("complete")).toBeTruthy();
  });

  it("renders a bare tool call without input", () => {
    render(
      <PartView
        part={part({
          type: "tool-call",
          id: "t1",
          name: "shell",
          arguments: "",
          state: "input-streaming",
        })}
      />,
    );
    expect(screen.getByLabelText("Tool shell")).toBeTruthy();
    expect(screen.queryByText("{}")).toBeNull();
  });

  it("renders a formatted non-string tool argument", () => {
    render(
      <PartView
        part={part({
          type: "tool-call",
          id: "t1",
          name: "shell",
          arguments: "{",
          state: "input-streaming",
          output: "plain",
        })}
      />,
    );
    expect(screen.getByText("plain")).toBeTruthy();
  });

  it("renders tool results", () => {
    render(
      <PartView
        part={part({
          type: "tool-result",
          toolCallId: "t1",
          name: "shell",
          content: "done",
          state: "complete",
        })}
      />,
    );
    expect(screen.getByLabelText("Tool shell")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
  });

  it("renders nothing for unknown parts", () => {
    const { container } = render(<PartView part={part({ type: "image", url: "x" })} />);
    expect(container.textContent).toBe("");
  });
});
