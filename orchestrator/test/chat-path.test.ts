import assert from "node:assert/strict";
import test from "node:test";
import { safeTarget } from "../src/routes/chat.ts";

const BASE = "http://localhost:8790";

test("an ordinary harness path passes through", () => {
  const target = safeTarget("/v1/sessions", BASE);
  assert.equal(target?.toString(), "http://localhost:8790/v1/sessions");
});

test("an empty path becomes the root", () => {
  assert.equal(safeTarget("/", BASE)?.pathname, "/");
});

test("the query string survives", () => {
  const target = safeTarget("/v1/sessions?hours=24", BASE);
  assert.equal(target?.search, "?hours=24");
});

test("traversal cannot reach the orchestrator's own routes", () => {
  // Without the guard `new URL()` normalises this to /incidents, which is
  // guarded by a different bearer than the chat proxy's.
  assert.equal(safeTarget("/../incidents", BASE), null);
  assert.equal(safeTarget("/v1/../../incidents", BASE), null);
});

test("percent-encoded traversal is rejected too", () => {
  assert.equal(safeTarget("/%2e%2e/incidents", BASE), null);
  assert.equal(safeTarget("/%2E%2E/webhook/grafana", BASE), null);
});

test("a malformed percent escape is refused rather than passed on", () => {
  assert.equal(safeTarget("/%zz", BASE), null);
});

test("a null byte is refused", () => {
  assert.equal(safeTarget("/v1/\0", BASE), null);
});

test("a non-http base cannot receive the bearer", () => {
  assert.equal(safeTarget("/v1/sessions", "file:///etc/passwd"), null);
  assert.equal(safeTarget("/v1/sessions", "not a url"), null);
});

test("a base with a path prefix keeps the result underneath it", () => {
  const target = safeTarget("/sessions", "http://localhost:8790/harness");
  assert.equal(target?.toString(), "http://localhost:8790/harness/sessions");
});

test("the result can never leave the configured origin", () => {
  const target = safeTarget("/v1/sessions", BASE);
  assert.equal(target?.origin, "http://localhost:8790");
});
