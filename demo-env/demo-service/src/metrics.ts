/**
 * Minimal Prometheus text-exposition. Hand-rolled so the demo service has no
 * dependencies at all — one fewer thing that can break during a live demo.
 */

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export function createMetrics() {
  /** key: `route|status` */
  const requests = new Map<string, number>();
  /** key: `route` → per-bucket counts, sum, count */
  const latency = new Map<string, { buckets: number[]; sum: number; count: number }>();

  function observe(route: string, status: number, seconds: number): void {
    const key = `${route}|${status}`;
    requests.set(key, (requests.get(key) ?? 0) + 1);

    let hist = latency.get(route);
    if (!hist) {
      hist = { buckets: new Array<number>(LATENCY_BUCKETS.length).fill(0), sum: 0, count: 0 };
      latency.set(route, hist);
    }
    for (let i = 0; i < LATENCY_BUCKETS.length; i += 1) {
      if (seconds <= LATENCY_BUCKETS[i]!) hist.buckets[i] = (hist.buckets[i] ?? 0) + 1;
    }
    hist.sum += seconds;
    hist.count += 1;
  }

  function render(extraLabels: Record<string, string>): string {
    const base = Object.entries(extraLabels)
      .map(([key, value]) => `${key}="${value}"`)
      .join(",");
    const withBase = (labels: string) => (base ? `${base},${labels}` : labels);
    const lines: string[] = [];

    lines.push("# HELP http_requests_total Total HTTP requests.");
    lines.push("# TYPE http_requests_total counter");
    for (const [key, count] of requests) {
      const [route, status] = key.split("|");
      lines.push(`http_requests_total{${withBase(`route="${route}",status="${status}"`)}} ${count}`);
    }

    lines.push("# HELP http_request_duration_seconds HTTP request latency.");
    lines.push("# TYPE http_request_duration_seconds histogram");
    for (const [route, hist] of latency) {
      LATENCY_BUCKETS.forEach((bound, i) => {
        lines.push(
          `http_request_duration_seconds_bucket{${withBase(`route="${route}",le="${bound}"`)}} ${hist.buckets[i]}`,
        );
      });
      lines.push(`http_request_duration_seconds_bucket{${withBase(`route="${route}",le="+Inf"`)}} ${hist.count}`);
      lines.push(`http_request_duration_seconds_sum{${withBase(`route="${route}"`)}} ${hist.sum}`);
      lines.push(`http_request_duration_seconds_count{${withBase(`route="${route}"`)}} ${hist.count}`);
    }

    lines.push("# HELP process_resident_memory_bytes Resident memory of the process.");
    lines.push("# TYPE process_resident_memory_bytes gauge");
    lines.push(`process_resident_memory_bytes{${base}} ${process.memoryUsage().rss}`);

    return `${lines.join("\n")}\n`;
  }

  return { observe, render };
}
