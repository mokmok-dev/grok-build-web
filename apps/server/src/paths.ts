import { isWithin, resolveCandidate } from "@grok-build-web/acp-client";
import { resolve } from "node:path";

export const isUsableRoot = (root: string): boolean => root !== "/";

export interface PathPolicy {
  readonly serverCwd: string;
  readonly defaultCwd: string;
  readonly allowedRoots: readonly string[];
}

/** Task working directories must stay under the default cwd or an explicitly allowed root. */
export const taskCwdAllowed = (cwd: string, policy: PathPolicy): boolean => {
  const resolved = resolveCandidate(cwd, policy.serverCwd);
  if (!isUsableRoot(resolved)) return false;
  return (
    isWithin(resolved, policy.defaultCwd) ||
    policy.allowedRoots.some((root) => isWithin(resolved, root))
  );
};

/** A terminal cwd may be the task cwd or any allowed root, never the filesystem root. */
export const terminalCwdAllowed = (
  cwd: string,
  taskCwd: string,
  allowedRoots: readonly string[],
): boolean => {
  const resolved = resolve(cwd);
  if (!isUsableRoot(resolved)) return false;
  return [taskCwd, ...allowedRoots].some((root) => isWithin(resolved, root));
};
