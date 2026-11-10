import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResult,
  isResponse,
  parseJsonRpcMessage,
  parseJsonRpcValue,
} from "./jsonrpc.ts";

describe("primitives", () => {
  it("asRecord accepts plain objects only", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([])).toBeUndefined();
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord("x")).toBeUndefined();
    expect(asRecord(1)).toBeUndefined();
  });

  it("asString accepts strings only", () => {
    expect(asString("x")).toBe("x");
    expect(asString(1)).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
  });

  it("asNumber accepts numbers only", () => {
    expect(asNumber(1)).toBe(1);
    expect(asNumber("1")).toBeUndefined();
  });

  it("asArray accepts arrays only", () => {
    expect(asArray([1])).toEqual([1]);
    expect(asArray({ length: 1 })).toBeUndefined();
  });
});

describe("encoders", () => {
  it("encodes requests with and without params", () => {
    expect(encodeRequest(1, "session/new", { cwd: "/tmp" })).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/tmp"}}',
    );
    expect(encodeRequest("a", "session/cancel")).toBe(
      '{"jsonrpc":"2.0","id":"a","method":"session/cancel"}',
    );
  });

  it("encodes notifications", () => {
    expect(encodeNotification("session/cancel", { sessionId: "s" })).toBe(
      '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}',
    );
    expect(encodeNotification("ping")).toBe('{"jsonrpc":"2.0","method":"ping"}');
  });

  it("encodes results and errors", () => {
    expect(encodeResult(7, { ok: true })).toBe('{"jsonrpc":"2.0","id":7,"result":{"ok":true}}');
    expect(encodeError(7, -32601, "nope")).toBe(
      '{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"nope"}}',
    );
  });
});

describe("parseJsonRpcMessage", () => {
  it("returns undefined for invalid JSON", () => {
    expect(parseJsonRpcMessage("{")).toBeUndefined();
  });

  it("round-trips encoded envelopes", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
        fc.string(),
        (id, method) => {
          const parsed = parseJsonRpcMessage(encodeRequest(id, method));
          expect(parsed).toEqual({ jsonrpc: "2.0", id, method, params: undefined });
        },
      ),
    );
  });
});

describe("parseJsonRpcValue", () => {
  it("rejects non-objects", () => {
    for (const value of [null, undefined, "x", 1, [], true]) {
      expect(parseJsonRpcValue(value)).toBeUndefined();
    }
  });

  it("rejects a wrong jsonrpc version", () => {
    expect(parseJsonRpcValue({ jsonrpc: "1.0", method: "x" })).toBeUndefined();
  });

  it("parses requests with string, number and null ids", () => {
    expect(parseJsonRpcValue({ jsonrpc: "2.0", id: "a", method: "m", params: [1] })).toEqual({
      jsonrpc: "2.0",
      id: "a",
      method: "m",
      params: [1],
    });
    expect(parseJsonRpcValue({ jsonrpc: "2.0", id: 2, method: "m" })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "m",
      params: undefined,
    });
    expect(parseJsonRpcValue({ jsonrpc: "2.0", id: null, method: "m" })).toEqual({
      jsonrpc: "2.0",
      id: null,
      method: "m",
      params: undefined,
    });
  });

  it("rejects a request with an invalid id", () => {
    expect(parseJsonRpcValue({ jsonrpc: "2.0", id: {}, method: "m" })).toBeUndefined();
    expect(parseJsonRpcValue({ jsonrpc: "2.0", id: true, method: "m" })).toBeUndefined();
  });

  it("parses notifications", () => {
    expect(parseJsonRpcValue({ jsonrpc: "2.0", method: "m" })).toEqual({
      jsonrpc: "2.0",
      method: "m",
      params: undefined,
    });
    expect(parseJsonRpcValue({ jsonrpc: "2.0", method: "m", params: { a: 1 } })).toEqual({
      jsonrpc: "2.0",
      method: "m",
      params: { a: 1 },
    });
  });

  it("parses successes", () => {
    expect(parseJsonRpcValue({ jsonrpc: "2.0", id: 1, result: null })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: null,
    });
  });

  it("parses failures with and without data", () => {
    expect(
      parseJsonRpcValue({ jsonrpc: "2.0", id: 1, error: { code: 1, message: "e", data: 2 } }),
    ).toEqual({ jsonrpc: "2.0", id: 1, error: { code: 1, message: "e", data: 2 } });
    expect(parseJsonRpcValue({ jsonrpc: "2.0", id: 1, error: { code: 1, message: "e" } })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: 1, message: "e", data: undefined },
    });
  });

  it("rejects malformed responses", () => {
    expect(parseJsonRpcValue({ jsonrpc: "2.0", id: 1 })).toBeUndefined();
    expect(parseJsonRpcValue({ jsonrpc: "2.0", error: { code: 1, message: "e" } })).toBeUndefined();
    expect(parseJsonRpcValue({ jsonrpc: "2.0", id: 1, error: { message: "e" } })).toBeUndefined();
    expect(parseJsonRpcValue({ jsonrpc: "2.0", id: 1, error: { code: 1 } })).toBeUndefined();
    expect(parseJsonRpcValue({ jsonrpc: "2.0", id: 1, error: [] })).toBeUndefined();
  });

  it("round-trips successes", () => {
    fc.assert(
      fc.property(fc.integer(), fc.json(), (id, result) => {
        expect(parseJsonRpcMessage(encodeResult(id, result))).toEqual({
          jsonrpc: "2.0",
          id,
          result,
        });
      }),
    );
  });
});

describe("isResponse", () => {
  it("distinguishes responses from requests and notifications", () => {
    expect(isResponse({ jsonrpc: "2.0", id: 1, result: 1 })).toBe(true);
    expect(isResponse({ jsonrpc: "2.0", id: 1, method: "m" })).toBe(false);
    expect(isResponse({ jsonrpc: "2.0", method: "m" })).toBe(false);
  });
});
