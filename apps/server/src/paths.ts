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

const real = (path: string): Effect.Effect<string> =>
  Effect.promise(() => realpathOfExistingAncestor(path));

/** Task working directories must stay under the default cwd or an explicitly allowed root. */
export const taskCwdAllowed = (cwd: string, policy: PathPolicy): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const candidate = yield* real(resolveCandidate(cwd, policy.serverCwd));
    if (!isUsableRoot(candidate)) return false;
    const defaultCwd = yield* real(policy.defaultCwd);
    if (isWithin(candidate, defaultCwd)) return true;
    const roots = yield* Effect.forEach(policy.allowedRoots, real);
    return roots.some((root) => isWithin(candidate, root));
  });

/** Resolves a terminal cwd against the task cwd, returning the realpath only when it is in bounds. */
export const resolveTerminalCwd = (
  cwd: string,
  taskCwd: string,
  allowedRoots: readonly string[],
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const candidate = yield* real(resolve(taskCwd, cwd));
    if (!isUsableRoot(candidate)) return undefined;
    const roots = yield* Effect.forEach([taskCwd, ...allowedRoots], real);
    return roots.some((root) => isWithin(candidate, root)) ? candidate : undefined;
  });
