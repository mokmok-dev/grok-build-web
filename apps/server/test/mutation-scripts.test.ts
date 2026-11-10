import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const script = resolve(repoRoot, "scripts/assert-mutation-scripts.mjs");

const run = (packagesDir?: string) =>
  spawnSync(process.execPath, packagesDir === undefined ? [script] : [script, packagesDir], {
    encoding: "utf8",
  });

const writePackage = (dir: string, name: string, mutation: boolean): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, scripts: mutation ? { mutation: "stryker run" } : { build: "true" } }),
  );
};

describe("assert-mutation-scripts", () => {
  it("accepts the real workspace packages", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects a scriptless package and names it", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-web-gate-"));
    const packages = join(root, "packages");
    writePackage(join(packages, "ok"), "@test/ok", true);
    writePackage(join(packages, "bare"), "@test/bare", false);
    const result = run(packages);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@test/bare");
  });

  it("follows symlinked package directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "grok-web-gate-"));
    const packages = join(root, "packages");
    mkdirSync(packages, { recursive: true });
    const real = join(root, "real-linked");
    writePackage(real, "@test/linked", false);
    symlinkSync(real, join(packages, "linked"));
    const result = run(packages);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@test/linked");
  });
});
