import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allocate, emptyCorrelation, take, takeAll } from "./jsonrpc-client.ts";

describe("correlation", () => {
  it("allocates sequential ids", () => {
    const [first, afterFirst] = allocate(emptyCorrelation<string>(), "a", "token-a");
    const [second, afterSecond] = allocate(afterFirst, "b", "token-b");
    expect([first, second]).toEqual([1, 2]);
    expect(afterSecond.entries.size).toBe(2);
    expect(afterSecond.entries.get(1)).toEqual({ method: "a", token: "token-a" });
    expect(afterSecond.entries.get(2)).toEqual({ method: "b", token: "token-b" });
  });

  it("takes an entry and removes it", () => {
    const [id, state] = allocate(emptyCorrelation<string>(), "a", "token");
    const [entry, next] = take(state, id);
    expect(entry).toEqual({ method: "a", token: "token" });
    expect(next.entries.size).toBe(0);
    expect(next.nextId).toBe(2);
  });

  it("returns the state untouched for an unknown id", () => {
    const state = allocate(emptyCorrelation<string>(), "a", "token")[1];
    const [entry, next] = take(state, 99);
    expect(entry).toBeUndefined();
    expect(next).toBe(state);
  });

  it("drains every entry", () => {
    const state = allocate(allocate(emptyCorrelation<string>(), "a", "one")[1], "b", "two")[1];
    const [entries, next] = takeAll(state);
    expect(entries).toEqual([
      { method: "a", token: "one" },
      { method: "b", token: "two" },
    ]);
    expect(next.entries.size).toBe(0);
    expect(next.nextId).toBe(3);
  });

  it("never reuses an id", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (count) => {
        let state = emptyCorrelation<number>();
        const ids: number[] = [];
        for (let index = 0; index < count; index += 1) {
          const [id, next] = allocate(state, "m", index);
          ids.push(id);
          state = next;
        }
        expect(new Set(ids).size).toBe(count);
        expect(ids).toEqual(Array.from({ length: count }, (_, index) => index + 1));
      }),
    );
  });
});
