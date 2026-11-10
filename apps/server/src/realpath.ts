import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Resolves every existing ancestor, so a symlinked path compares as its target. */
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
