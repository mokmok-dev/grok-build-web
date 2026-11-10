#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";

const fail = (message) => {
  console.error(`dev:tailnet: ${message}`);
  process.exit(1);
};

let status;
try {
  status = JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8" }));
} catch (error) {
  fail(`cannot read the Tailscale status: ${error.message}`);
}

const self = status?.Self;
const ipv4 = (self?.TailscaleIPs ?? []).find((address) => !address.includes(":"));
if (ipv4 === undefined) fail("this machine has no Tailscale IPv4 address");

const dnsName = String(self?.DNSName ?? "").replace(/\.$/, "");
const hosts = [
  ...(dnsName === "" ? [] : [dnsName]),
  ipv4,
  ...(process.env.GROK_WEB_ALLOWED_HOSTS ?? "").split(","),
]
  .map((host) => host.trim())
  .filter((host) => host !== "");

const env = {
  ...process.env,
  GROK_WEB_DEV_HOST: ipv4,
  GROK_WEB_ALLOWED_HOSTS: [...new Set(hosts)].join(","),
};

console.log(`dev:tailnet: Vite listens on ${ipv4}:5173; open http://${dnsName || ipv4}:5173`);
console.log(
  "dev:tailnet: every tailnet device can drive the agent; restrict it with Tailscale ACLs",
);

const child = spawn("pnpm", ["dev"], { env, stdio: "inherit" });
child.on("error", (error) => fail(`cannot start pnpm dev: ${error.message}`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 0));
});
