import { createServer } from "node:http";
import { createMetrics } from "./metrics.ts";
import { loadFaults, startLeak } from "./faults.ts";

const port = Number(process.env["PORT"] ?? 8000);
const version = process.env["APP_VERSION"] ?? "dev";
const pod = process.env["POD_NAME"] ?? "local";
const faults = loadFaults();
const metrics = createMetrics();

if (faults.crashOnStart) {
  // Long enough to be scraped once and to look like a real startup failure.
  setTimeout(() => {
    console.error("fatal: dependency check failed (injected fault)");
    process.exit(1);
  }, 3000);
}

startLeak(faults.leakMbPerMinute);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const server = createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const route = url.pathname;

  const finish = (status: number, body: string, contentType = "application/json") => {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    if (route !== "/metrics") metrics.observe(route, status, seconds);
    res.writeHead(status, { "content-type": contentType });
    res.end(body);
  };

  if (route === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(metrics.render({ service: "demo-service", version, pod }));
    return;
  }

  if (route === "/healthz" || route === "/readyz") {
    finish(200, JSON.stringify({ ok: true, version }));
    return;
  }

  if (faults.latencyMs > 0) await sleep(faults.latencyMs);

  if (faults.errorRate > 0 && Math.random() < faults.errorRate) {
    finish(500, JSON.stringify({ error: "checkout: upstream call failed", version }));
    return;
  }

  if (route === "/checkout" || route === "/api/orders" || route === "/") {
    finish(200, JSON.stringify({ ok: true, route, version, pod }));
    return;
  }

  finish(404, JSON.stringify({ error: "not found", route }));
});

server.listen(port, () => {
  console.log(JSON.stringify({ message: "demo-service listening", port, version, faults }));
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
