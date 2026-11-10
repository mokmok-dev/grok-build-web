import { isWithin, resolveCandidate } from "@grok-build-web/acp-client";
import { Effect } from "effect";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
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

const rootsOf = (policy: PathPolicy): readonly string[] => [
  policy.defaultCwd,
  ...policy.allowedRoots,
];

/**
 * Roots the project picker opens on: every bound that no other bound already covers. Anchors are
 * therefore the minimal covering roots, so `defaultCwd` has an anchor only when no allowed root
 * contains it.
 */
export const reachableRoots = (policy: PathPolicy): readonly string[] => {
  const roots = [...new Set(rootsOf(policy))];
  return roots.filter((root) => !roots.some((other) => other !== root && isWithin(root, other)));
};

export const resolveTaskCwd = (
  cwd: string,
  policy: PathPolicy,
): Effect.Effect<string | undefined> =>
  resolveRealPath(resolveCandidate(cwd, policy.serverCwd), rootsOf(policy));

/** Resolves a terminal cwd against the task cwd, returning the realpath only when it is in bounds. */
export const resolveTerminalCwd = (
  cwd: string,
  taskCwd: string,
  allowedRoots: readonly string[],
): Effect.Effect<string | undefined> =>
  resolveRealPath(resolve(taskCwd, cwd), [taskCwd, ...allowedRoots]);

// readdir materialises the whole directory before this slice, which is acceptable on the loopback,
// Host-guarded trust model. A wider bind or an untrusted caller makes it an amplification vector
// that needs a rate limit.
const DIRECTORY_ENTRY_LIMIT = 200;

const isDirectory = (candidate: string): Effect.Effect<boolean> =>
  Effect.match(Effect.tryPromise({ try: () => stat(candidate), catch: (cause) => cause }), {
    onFailure: () => false,
    onSuccess: (info) => info.isDirectory(),
  });

const readEntries = (candidate: string): Effect.Effect<readonly Dirent[] | undefined> =>
  Effect.match(
    Effect.tryPromise({
      try: () => readdir(candidate, { withFileTypes: true }),
      catch: (cause) => cause,
    }),
    { onFailure: () => undefined, onSuccess: (entries) => entries },
  );

export const resolveDirectory = (
  candidate: string,
  policy: PathPolicy,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const resolved = resolveCandidate(candidate, policy.serverCwd);
    if (!(yield* isDirectory(resolved))) return undefined;
    return yield* resolveRealPath(resolved, rootsOf(policy));
  });

export interface DirectoryListing {
  readonly path: string;
  readonly entries: readonly string[];
  readonly truncated?: true;
}

export const listDirectories = (
  candidate: string,
  policy: PathPolicy,
): Effect.Effect<DirectoryListing | undefined> =>
  Effect.gen(function* () {
    const roots = rootsOf(policy);
    const real = yield* resolveRealPath(resolveCandidate(candidate, policy.serverCwd), roots);
    if (real === undefined) return undefined;
    const entries = yield* readEntries(real);
    if (entries === undefined) return undefined;
    // isDirectory() is false for a symlink, so links are dropped without a stat; admitting a link
    // that sits inside the bounds but points outside would reopen the escape.
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(real, entry.name))
      .sort((left, right) => left.localeCompare(right));
    return {
      path: real,
      entries: directories.slice(0, DIRECTORY_ENTRY_LIMIT),
      ...(directories.length > DIRECTORY_ENTRY_LIMIT ? { truncated: true as const } : {}),
    };
  });
