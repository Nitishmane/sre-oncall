import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  isKnownUser,
  parseConsoleUsers,
  verifyConsoleUser,
} from "../lib/credentials.ts";
import { forwardableHeaders, safeUpstreamPath, upstreamUrl } from "../lib/proxy.ts";

// One derivation, reused: scrypt is deliberately slow, and every test below
// that needs a real account can share the same verifier.
const PASSWORD = "correct horse battery staple";
const VERIFIER = await hashPassword(PASSWORD);
const USERS = `reviewer:${VERIFIER}`;

test("the account list fails closed when unset or empty", () => {
  assert.equal(parseConsoleUsers(undefined).size, 0);
  assert.equal(parseConsoleUsers("").size, 0);
  assert.equal(parseConsoleUsers("  , ,, ").size, 0);
  assert.equal(isKnownUser("reviewer", parseConsoleUsers(undefined)), false);
});

test("an unset account list admits nobody, even with the right password", async () => {
  assert.equal(await verifyConsoleUser("reviewer", PASSWORD, parseConsoleUsers("")), false);
});

test("a correct username and password is accepted", async () => {
  assert.equal(await verifyConsoleUser("reviewer", PASSWORD, parseConsoleUsers(USERS)), true);
});

test("a wrong password is rejected for a real account", async () => {
  const users = parseConsoleUsers(USERS);
  assert.equal(await verifyConsoleUser("reviewer", "wrong", users), false);
  assert.equal(await verifyConsoleUser("reviewer", `${PASSWORD} `, users), false);
  assert.equal(await verifyConsoleUser("reviewer", PASSWORD.toUpperCase(), users), false);
});

test("usernames are case-insensitive and trimmed; passwords are not", async () => {
  const users = parseConsoleUsers(` REVIEWER:${VERIFIER} `);
  assert.equal(await verifyConsoleUser("reviewer", PASSWORD, users), true);
  assert.equal(await verifyConsoleUser("  Reviewer  ", PASSWORD, users), true);
  assert.equal(isKnownUser("ReViEwEr", users), true);
});

test("an unknown username is rejected whatever the password", async () => {
  const users = parseConsoleUsers(USERS);
  assert.equal(await verifyConsoleUser("mallory", PASSWORD, users), false);
  assert.equal(isKnownUser("mallory", users), false);
});

test("an empty or non-string password never authenticates", async () => {
  const users = parseConsoleUsers(USERS);
  for (const value of [undefined, null, "", 42, {}, [PASSWORD], true]) {
    assert.equal(
      await verifyConsoleUser("reviewer", value, users),
      false,
      `${String(value)} must not pass`,
    );
  }
});

test("a non-string identity is rejected rather than coerced", async () => {
  const users = parseConsoleUsers(USERS);
  for (const value of [undefined, null, 42, {}, ["reviewer"], true, "   "]) {
    assert.equal(isKnownUser(value, users), false, `${String(value)} must not be known`);
    assert.equal(await verifyConsoleUser(value, PASSWORD, users), false);
  }
});

test("several accounts can share the one variable", async () => {
  const other = await hashPassword("second account password");
  const users = parseConsoleUsers(`reviewer:${VERIFIER}, judge:${other}`);
  assert.equal(users.size, 2);
  assert.equal(await verifyConsoleUser("judge", "second account password", users), true);
  assert.equal(await verifyConsoleUser("judge", PASSWORD, users), false);
});

test("a malformed entry is dropped without taking the other accounts down", () => {
  const users = parseConsoleUsers(`broken, :${VERIFIER}, nohash:, bad:sha1$x$y, reviewer:${VERIFIER}`);
  assert.deepEqual([...users.keys()], ["reviewer"]);
});

test("a verifier demanding absurd memory is refused rather than run", () => {
  // 128 * N * r would be gigabytes; parsing it must not hand that to scrypt.
  assert.equal(parseConsoleUsers("bomb:scrypt$4194304$8$1$c2FsdA==$aGFzaA==").size, 0);
  assert.equal(parseConsoleUsers("bomb:scrypt$0$8$1$c2FsdA==$aGFzaA==").size, 0);
  assert.equal(parseConsoleUsers("bomb:scrypt$abc$8$1$c2FsdA==$aGFzaA==").size, 0);
});

test("a username cannot smuggle a colon to shift the verifier boundary", () => {
  // Splitting on the last colon instead of the first would make this parse.
  assert.equal(parseConsoleUsers(`a:b:${VERIFIER}`).size, 0);
});

test("each generated verifier is salted, so equal passwords do not collide", async () => {
  const [first, second] = await Promise.all([hashPassword("same"), hashPassword("same")]);
  assert.notEqual(first, second);
  assert.equal(await verifyConsoleUser("u", "same", parseConsoleUsers(`u:${first}`)), true);
  assert.equal(await verifyConsoleUser("u", "same", parseConsoleUsers(`u:${second}`)), true);
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
