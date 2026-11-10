import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Transcript } from "./Transcript.tsx";

describe("Transcript", () => {
  it("shows the empty state", () => {
    render(<Transcript messages={[]} plan={[]} usage={{}} streaming={false} />);
    expect(screen.getByText("No messages yet")).toBeTruthy();
  });

  it("renders messages, the plan and usage", () => {
    const { container } = render(
      <Transcript
        streaming
        messages={[
          { id: "u", role: "user", parts: [{ type: "text", content: "hi" }] },
          { id: "a", role: "assistant", parts: [{ type: "text", content: "hello" }] },
        ]}
        plan={[
          { content: "step", priority: "high", status: "pending" },
          { content: "bare", priority: "", status: "done" },
        ]}
        usage={{ totalTokens: 5 }}
      />,
    );
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Grok")).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(screen.getByText("step")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText("5 total")).toBeTruthy();
    const transcript = container.querySelector(".transcript");
    expect(transcript?.getAttribute("aria-busy")).toBe("true");
  });
});
