import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState.tsx";

describe("EmptyState", () => {
  it("renders a title and body", () => {
    render(<EmptyState title="No tasks" body="Create one" />);
    expect(screen.getByRole("heading", { name: "No tasks" })).toBeTruthy();
    expect(screen.getByText("Create one")).toBeTruthy();
  });

  it("renders an optional action", () => {
    render(
      <EmptyState
        title="Nothing"
        action={
          <button type="button" onClick={() => undefined}>
            Act
          </button>
        }
      />,
    );
    expect(screen.getByRole("button", { name: "Act" })).toBeTruthy();
  });
});
