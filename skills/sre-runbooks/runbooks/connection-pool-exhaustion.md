# Connection-pool exhaustion

**Signature.** Latency climbing, often with `HighLatencyP99` firing. Logs
contain `connection pool`, `too many clients`, `timeout acquiring connection`,
or similar. Error rate may be normal at first — requests queue before they fail.

## Confirm

1. Grafana MCP — p99 latency next to request rate. Latency rising while request
   rate is **flat** means the service got slower, not busier: a pool, a lock, or
   a dependency. Both rising together is ordinary saturation.
2. Kubernetes MCP — logs across pods, looking for pool-acquisition errors. Note
   whether every pod reports them or only some.
3. Grafana MCP — the dependency's own metrics if it is scraped: active
   connections against max connections.

## Common causes, in the order they actually occur

| Cause | How to tell |
|---|---|
| Replica count grew; pods × pool size now exceeds the database's max connections | Compare replicas × configured pool size with the server limit |
| A slow query is holding connections | Latency rise concentrated on one route |
| A leak — connections acquired and never released | Active connections climb monotonically and never fall, including during quiet periods |
| The dependency itself is degraded | Its own latency or error metrics moved first |

## Remediate

- **Do not** raise the pool size as a reflex. If pods × pool already exceeds the
  server's limit, raising it makes the incident worse.
- Reduce demand first: scale replicas **down** if pods × pool exceeds the limit,
  or roll back the change that raised replica count.
- If a slow query is holding connections, that is a code fix — open a PR; do not
  attempt it live.
- If the dependency is degraded, escalate to its owner rather than tuning around
  it.

All of the above are gated changes. Include in your approval request the
arithmetic: replicas × pool size versus the server maximum.

## Verify

p99 latency back under threshold, and active connections stable rather than
merely lower. A pool that is still climbing slowly will fire again in an hour.
