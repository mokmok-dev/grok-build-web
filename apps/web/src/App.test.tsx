import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { App } from "./App.tsx";

test("renders the app shell", () => {
  render(<App />);
  expect(screen.getByText("Grok Build Web")).not.toBeNull();
});
