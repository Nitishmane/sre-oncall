import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowed, parseAllowlist } from "../lib/allowlist.ts";
import { forwardableHeaders, safeUpstreamPath, upstreamUrl } from "../lib/proxy.ts";

test("the allowlist fails closed when unset or empty", () => {
  assert.equal(isAllowed("octocat", parseAllowlist(undefined)), false);
  assert.equal(isAllowed("octocat", parseAllowlist("")), false);
  assert.equal(isAllowed("octocat", parseAllowlist("  , ,, ")), false);
});

test("allowlist matching is case-insensitive and trimmed, like GitHub usernames", () => {
  const list = parseAllowlist(" OctoCat , hubot ");
  assert.equal(isAllowed("octocat", list), true);
  assert.equal(isAllowed("OCTOCAT", list), true);
  assert.equal(isAllowed(" hubot ", list), true);
  assert.equal(isAllowed("mona", list), false);
});

test("a non-string identity is rejected rather than coerced", () => {
  const list = parseAllowlist("octocat");
  for (const value of [undefined, null, 42, {}, ["octocat"], true]) {
    assert.equal(isAllowed(value, list), false, `${String(value)} must not pass`);
  }
});

test("a username that is only whitespace never matches", () => {
  assert.equal(isAllowed("   ", parseAllowlist("octocat, ")), false);
});

test("path traversal cannot escape the upstream prefix", () => {
  assert.equal(safeUpstreamPath(["..", "admin"]), null);
  assert.equal(safeUpstreamPath(["api", "..", "..", "etc"]), null);
  assert.equal(safeUpstreamPath(["api", ""]), null);
  assert.equal(safeUpstreamPath(["api", "."]), null);
  assert.equal(safeUpstreamPath(["api%2Fv1"[0] + "/x"]), null, "an embedded slash is refused");
  assert.equal(safeUpstreamPath(["api", "v1\\x"]), null);
  assert.equal(safeUpstreamPath(["api", "v1\0"]), null);
});

test("ordinary harness paths pass through", () => {
  assert.equal(safeUpstreamPath(["api", "v1", "sessions"]), "/api/v1/sessions");
  assert.equal(safeUpstreamPath(["api", "v1", "sessions", "sess_123", "turns"]),
    "/api/v1/sessions/sess_123/turns");
});

test("the upstream URL stays under the configured base", () => {
  const base = "https://example.ngrok-free.app/chat";
  const url = upstreamUrl(base, "/api/v1/sessions", "?limit=10");
  assert.equal(url, "https://example.ngrok-free.app/chat/api/v1/sessions?limit=10");
});

test("a base with a trailing slash does not produce a double slash", () => {
  const url = upstreamUrl("https://example.ngrok-free.app/chat/", "/api/v1/agents", "");
  assert.equal(url, "https://example.ngrok-free.app/chat/api/v1/agents");
});

test("a non-http base is refused, so the bearer cannot be sent over a foreign scheme", () => {
  assert.equal(upstreamUrl("file:///etc/passwd", "/api", ""), null);
  assert.equal(upstreamUrl("not a url", "/api", ""), null);
});

test("only a small header set is forwarded — never cookies or authorization", () => {
  const incoming = new Headers({
    accept: "text/event-stream",
    "content-type": "application/json",
    cookie: "authjs.session-token=secret",
    authorization: "Bearer attacker-supplied",
    "x-forwarded-for": "10.0.0.1",
    host: "evil.example",
  });
  const forwarded = forwardableHeaders(incoming);
  assert.equal(forwarded.get("accept"), "text/event-stream");
  assert.equal(forwarded.get("content-type"), "application/json");
  assert.equal(forwarded.get("cookie"), null, "the session cookie must not leave this origin");
  assert.equal(forwarded.get("authorization"), null, "a client-supplied bearer must not be relayed");
  assert.equal(forwarded.get("x-forwarded-for"), null);
  assert.equal(forwarded.get("host"), null);
});
