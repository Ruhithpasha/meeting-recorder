// Load test: GET /api/meetings against 10,000 real meeting folders on disk.
// Run: npm run load   (gate: p97.5 < 20 ms at limit=50; autocannon reports p50/p90/p97.5/p99)
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import autocannon from "autocannon";
import { buildApp } from "../apps/daemon/src/app.ts";
import { createContainer } from "../apps/daemon/src/container.ts";

const COUNT = 10_000;
const TOKEN = "load-test-token";
const root = mkdtempSync(join(tmpdir(), "mr-load-"));
const meetingsDir = join(root, "Meetings");
mkdirSync(join(root, "web"), { recursive: true });
writeFileSync(join(root, "web", "index.html"), "<!doctype html>");

for (let i = 0; i < COUNT; i++) {
  const day = new Date(Date.UTC(2020, 0, 1) + i * 3_600_000);
  const id = `${day.toISOString().slice(0, 10)}_${day.toISOString().slice(11, 19).replaceAll(":", "-")}_zoom`;
  mkdirSync(join(meetingsDir, id), { recursive: true });
  writeFileSync(join(meetingsDir, id, "meta.json"), JSON.stringify({
    id, app: "Zoom", title: `Meeting ${i}`, startedAt: day.toISOString(), endedAt: day.toISOString(),
    durationSec: 1800, sizeBytes: 300_000_000, status: "complete", transcript: "none",
  }));
}

const bootStart = performance.now();
const container = await createContainer({
  meetingsDir, stateDir: root, agent: { send() {} }, log: { info() {}, warn() {} },
  dashboardUrl: () => "", openFolder: () => {},
});
const bootMs = performance.now() - bootStart;
let port = 0;
const app = await buildApp({ container, token: TOKEN, port: () => port, webDist: join(root, "web") });
await app.listen({ host: "127.0.0.1", port: 0 });
port = (app.server.address() as AddressInfo).port;

const result = await autocannon({
  url: `http://127.0.0.1:${port}/api/meetings?limit=50`,
  headers: { authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${port}` },
  connections: 10,
  duration: 10,
});
await app.close();

const p97_5 = result.latency.p97_5;
console.log(JSON.stringify({
  meetings: COUNT,
  indexBuildMs: Math.round(bootMs),
  requests: result.requests.total,
  rps: Math.round(result.requests.average),
  latencyMs: { p50: result.latency.p50, p90: result.latency.p90, p97_5, p99: result.latency.p99, max: result.latency.max },
  non2xx: result.non2xx,
  errors: result.errors,
}, null, 2));
if (p97_5 >= 20 || result.non2xx || result.errors) process.exit(1);
