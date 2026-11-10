import { isWithin, resolveCandidate } from "@grok-build-web/acp-client";
import { Effect } from "effect";
import { resolve } from "node:path";
import { realpathOfExistingAncestor } from "./realpath.ts";

export const isUsableRoot = (root: string): boolean => root !== "/";

export interface PathPolicy {
  readonly serverCwd: string;
  readonly defaultCwd: string;
  readonly allowedRoots: readonly string[];
}

/**
 * Resolves `candidate` to its real path and checks it against the real paths of `roots`.
 * An empty root list accepts any usable path, so callers decide when no bound applies.
 */
export const resolveRealPath = (
  candidate: string,
  roots: readonly string[],
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const real = yield* Effect.promise(() => realpathOfExistingAncestor(candidate));
    if (!isUsableRoot(real)) return undefined;
    if (roots.length === 0) return real;
    const realRoots = yield* Effect.forEach(roots, (root) =>
      Effect.promise(() => realpathOfExistingAncestor(root)),
    );
    return realRoots.some((root) => isWithin(real, root)) ? real : undefined;
  });

/** Task working directories must stay under the default cwd or an explicitly allowed root. */
export const taskCwdAllowed = (cwd: string, policy: PathPolicy): Effect.Effect<boolean> =>
  Effect.map(
    resolveRealPath(resolveCandidate(cwd, policy.serverCwd), [
      policy.defaultCwd,
      ...policy.allowedRoots,
    ]),
    (resolved) => resolved !== undefined,
  );

/** Resolves a terminal cwd against the task cwd, returning the realpath only when it is in bounds. */
export const resolveTerminalCwd = (
  cwd: string,
  taskCwd: string,
  allowedRoots: readonly string[],
): Effect.Effect<string | undefined> =>
  resolveRealPath(resolve(taskCwd, cwd), [taskCwd, ...allowedRoots]);
