// `pnpm -r run` skips projects without the script, so the gate must assert it exists everywhere.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const missing = [];
for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = JSON.parse(
    readFileSync(join(root, "packages", entry.name, "package.json"), "utf8"),
  );
  if (manifest.scripts?.mutation !== "stryker run") missing.push(manifest.name ?? entry.name);
}
if (missing.length > 0) {
  console.error(`packages without a "mutation" script: ${missing.join(", ")}`);
  process.exit(1);
}
