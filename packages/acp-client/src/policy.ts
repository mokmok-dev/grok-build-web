import type { PermissionOption } from "@grok-build-web/acp-protocol";
import { isAbsolute, resolve, sep } from "node:path";

export const isWithin = (candidate: string, root: string): boolean => {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate === root || candidate.startsWith(prefix);
};

export const resolveCandidate = (candidate: string, cwd: string): string =>
  isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);

export const allowedRoots = (cwd: string, extraRoots: readonly string[]): string[] => [
  resolve(cwd),
  ...extraRoots.map((root) => resolve(root)),
];

export const resolveAllowedPath = (
  candidate: string,
  cwd: string,
  extraRoots: readonly string[],
): string | undefined => {
  const resolved = resolveCandidate(candidate, cwd);
  for (const root of allowedRoots(cwd, extraRoots)) {
    if (isWithin(resolved, root)) return resolved;
  }
  return undefined;
};

export const autoSelectOption = (
  options: readonly PermissionOption[],
  yolo: boolean,
): string | undefined => {
  if (!yolo) return undefined;
  const allowOnce = options.find((option) => option.kind === "allow_once");
  if (allowOnce !== undefined) return allowOnce.optionId;
  const allowAlways = options.find((option) => option.kind === "allow_always");
  if (allowAlways !== undefined) return allowAlways.optionId;
  return undefined;
};

export const mayCreateTerminal = (
  readOnly: boolean,
  openTerminals: number,
  maxTerminals: number,
): boolean => !readOnly && openTerminals < maxTerminals;

export const truncateOutput = (
  buffer: string,
  limit: number,
): { readonly output: string; readonly truncated: boolean } => {
  if (buffer.length <= limit) return { output: buffer, truncated: false };
  return { output: buffer.slice(buffer.length - limit), truncated: true };
};
