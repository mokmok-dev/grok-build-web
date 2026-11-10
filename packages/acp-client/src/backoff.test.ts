import { describe, expect, it } from "vitest";
import { defaultBackoff, nextDelay, type BackoffOptions } from "./backoff.ts";

const options = (random: number, patch: Partial<BackoffOptions> = {}): BackoffOptions => ({
  baseMs: 100,
  maxMs: 1000,
  factor: 2,
  jitter: 0.2,
  random: () => random,
  ...patch,
});

describe("nextDelay", () => {
  it("grows exponentially and is symmetric around the base delay", () => {
    expect(nextDelay(0, options(0.5))).toBe(100);
    expect(nextDelay(1, options(0.5))).toBe(200);
    expect(nextDelay(2, options(0.5))).toBe(400);
    expect(nextDelay(0, options(0))).toBe(80);
    expect(nextDelay(0, options(1))).toBe(120);
  });

  it("caps the delay at maxMs before applying jitter", () => {
    expect(nextDelay(10, options(0.5))).toBe(1000);
    expect(nextDelay(10, options(0))).toBe(800);
    expect(nextDelay(10, options(1))).toBe(1200);
  });

  it("never returns a negative delay", () => {
    expect(nextDelay(0, options(0, { jitter: 2 }))).toBe(0);
  });

  it("rounds the delay", () => {
    expect(nextDelay(0, options(1 / 3, { jitter: 0.5 }))).toBe(83);
  });

  it("uses the production defaults", () => {
    expect(defaultBackoff.baseMs).toBe(250);
    expect(defaultBackoff.maxMs).toBe(10_000);
    expect(defaultBackoff.factor).toBe(2);
    expect(defaultBackoff.jitter).toBe(0.2);
    expect(typeof defaultBackoff.random()).toBe("number");
  });
});
