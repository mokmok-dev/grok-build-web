import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TaskStatus } from "@grok-build-web/task-model";
import { StatusBadge } from "./StatusBadge.tsx";

describe("StatusBadge", () => {
  it("labels every status", () => {
    const cases: Array<[TaskStatus, string]> = [
      ["starting", "Starting"],
      ["idle", "Idle"],
      ["running", "Running"],
      ["awaiting_permission", "Awaiting permission"],
      ["error", "Error"],
      ["closed", "Closed"],
    ];
    for (const [status, label] of cases) {
      const { unmount } = render(<StatusBadge status={status} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it("carries a status class", () => {
    render(<StatusBadge status="running" />);
    expect(screen.getByTestId("status-badge").className).toContain("badge-running");
  });
});
