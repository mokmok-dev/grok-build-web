import {
  AcpError,
  readTextFile,
  resolveAllowedPath,
  resolveCandidate,
  writeTextFile,
} from "@grok-build-web/acp-client";
import { Context, Effect, Layer } from "effect";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface FsBridgeShape {
  readonly read: (
    cwd: string,
    path: string,
    line?: number,
    limit?: number,
  ) => Effect.Effect<string, AcpError>;
  readonly write: (cwd: string, path: string, content: string) => Effect.Effect<void, AcpError>;
}

export class FsBridge extends Context.Service<FsBridge, FsBridgeShape>()(
  "@grok-build-web/server/FsBridge",
) {}

export interface FsBridgeOptions {
  readonly allowedRoots: readonly string[];
  readonly readOnly: boolean;
  readonly maxFileBytes: number;
}

/** Resolves every existing ancestor so a symlinked cwd or root compares as its target. */
export const realpathOfExistingAncestor = async (path: string): Promise<string> => {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(basename(current));
      current = parent;
    }
  }
};

export const makeFsBridge = (options: FsBridgeOptions): FsBridgeShape => {
  const guard = (cwd: string, candidate: string) =>
    Effect.gen(function* () {
      const resolved = resolveCandidate(candidate, cwd);
      const real = yield* Effect.promise(() => realpathOfExistingAncestor(resolved));
      const realCwd = yield* Effect.promise(() => realpathOfExistingAncestor(cwd));
      const realRoots = yield* Effect.promise(() =>
        Promise.all(options.allowedRoots.map(realpathOfExistingAncestor)),
      );
      const allowed = resolveAllowedPath(real, realCwd, realRoots);
      if (allowed === undefined) {
        return yield* new AcpError({ message: `Path is outside the allowed roots: ${candidate}` });
      }
      return allowed;
    });

  return {
    read: (cwd, path, line, limit) =>
      Effect.gen(function* () {
        const target = yield* guard(cwd, path);
        return yield* Effect.tryPromise({
          try: () => readTextFile(target, line, limit, { maxBytes: options.maxFileBytes }),
          catch: (cause) => new AcpError({ message: `Cannot read ${path}: ${String(cause)}` }),
        });
      }),
    write: (cwd, path, content) =>
      Effect.gen(function* () {
        if (options.readOnly) {
          return yield* new AcpError({ message: "Read-only mode: file writes are disabled" });
        }
        const target = yield* guard(cwd, path);
        yield* Effect.tryPromise({
          try: () => writeTextFile(target, content, { maxBytes: options.maxFileBytes }),
          catch: (cause) => new AcpError({ message: `Cannot write ${path}: ${String(cause)}` }),
        });
      }),
  };
};

export const fsBridgeLayer = (options: FsBridgeOptions): Layer.Layer<FsBridge> =>
  Layer.succeed(FsBridge, makeFsBridge(options));
