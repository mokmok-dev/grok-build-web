// `pnpm -r run` skips projects without the script, so the gate must assert it exists everywhere.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagesDir = resolve(repoRoot, process.argv[2] ?? "packages");
const missing = [];
for (const entry of readdirSync(packagesDir)) {
  // stat follows symlinks, so a linked package directory is checked like a real one.
  const dir = join(packagesDir, entry);
  if (!statSync(dir).isDirectory()) continue;
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (manifest.scripts?.mutation !== "stryker run") missing.push(manifest.name ?? entry);
}
if (missing.length > 0) {
  console.error(`packages without a "mutation" script: ${missing.join(", ")}`);
  process.exit(1);
}
