/**
 * Who may use the console, and how they prove it.
 *
 * The console signs people in with a username and password rather than an
 * identity provider, because the accounts that need it are handed out with the
 * project — a reviewer is given credentials and expected to sign in and drive
 * the agent, with no GitHub account or org membership involved.
 *
 * The chat can start harness sessions, which can mutate a live cluster, so this
 * is an authorization boundary rather than a preference. It fails closed: an
 * unset or empty `CONSOLE_USERS` admits nobody.
 *
 * Passwords are never stored, here or in the environment. `CONSOLE_USERS`
 * carries a scrypt verifier per account:
 *
 *   CONSOLE_USERS="reviewer:scrypt$16384$8$1$<salt-b64>$<hash-b64>,ops:scrypt$..."
 *
 * Generate an entry with `npm run console:passwd -- <username>`.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

// `promisify` picks scrypt's three-argument overload and drops the one taking
// options, which is the only one that lets us set N/r/p. Restate the signature.
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/** scrypt parameters. 128 * N * r = 16 MiB, comfortably under the 32 MiB default cap. */
const COST = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export type Verifier = {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
};

/**
 * Usernames are compared case-folded so that `Reviewer` and `reviewer` are the
 * same account — anyone typing credentials from a submission form will get the
 * capitalisation wrong eventually, and a login that fails on shift-key state is
 * a support burden, not a security control.
 */
function normalize(username: unknown): string | null {
  if (typeof username !== "string") return null;
  const trimmed = username.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

function parseVerifier(encoded: string): Verifier | null {
  const parts = encoded.split("$");
  if (parts.length !== 6) return null;
  const [scheme, rawN, rawR, rawP, rawSalt, rawHash] = parts as [
    string, string, string, string, string, string,
  ];
  if (scheme !== "scrypt") return null;

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  // Reject anything non-integral or absurd rather than handing it to scrypt,
  // which would otherwise happily try to allocate 128 * N * r bytes.
  for (const value of [N, r, p]) {
    if (!Number.isInteger(value) || value < 1 || value > 1 << 22) return null;
  }
  if (128 * N * r > 64 * 1024 * 1024) return null;

  const salt = Buffer.from(rawSalt, "base64");
  const hash = Buffer.from(rawHash, "base64");
  if (salt.length === 0 || hash.length === 0) return null;

  return { N, r, p, salt, hash };
}

/**
 * Parses `CONSOLE_USERS`. A malformed entry is dropped rather than throwing:
 * a typo in one account must not take the whole console offline, and a dropped
 * entry simply cannot sign in, which is the safe direction to fail.
 */
export function parseConsoleUsers(raw: string | undefined): Map<string, Verifier> {
  const users = new Map<string, Verifier>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;

    // Split on the FIRST colon only: the verifier itself contains none, but a
    // username must never be able to smuggle one in and shift the boundary.
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;

    const username = normalize(trimmed.slice(0, separator));
    if (username === null) continue;

    const verifier = parseVerifier(trimmed.slice(separator + 1));
    if (verifier === null) continue;

    users.set(username, verifier);
  }
  return users;
}

/**
 * Whether a name still corresponds to a configured account.
 *
 * Sessions are JWTs, so they outlive a change to `CONSOLE_USERS`. The API routes
 * re-check with this on every request, which means removing someone from the
 * environment locks them out immediately instead of at token expiry.
 */
export function isKnownUser(username: unknown, users: Map<string, Verifier>): boolean {
  if (users.size === 0) return false;
  const normalized = normalize(username);
  return normalized !== null && users.has(normalized);
}

/** A verifier used only to spend the same time on an unknown username as on a real one. */
const DECOY: Verifier = {
  ...COST,
  salt: Buffer.alloc(SALT_LENGTH),
  hash: Buffer.alloc(KEY_LENGTH),
};

async function derive(password: string, verifier: Verifier): Promise<Buffer> {
  return await scryptAsync(password, verifier.salt, verifier.hash.length, {
    N: verifier.N,
    r: verifier.r,
    p: verifier.p,
    // scrypt's default cap is 32 MiB; parseVerifier already bounds the request.
    maxmem: 128 * verifier.N * verifier.r * 2,
  });
}

/**
 * Checks a username and password against the configured accounts.
 *
 * An unknown username still pays for a full scrypt derivation against `DECOY`,
 * so the response time does not reveal which usernames exist.
 */
export async function verifyConsoleUser(
  username: unknown,
  password: unknown,
  users: Map<string, Verifier>,
): Promise<boolean> {
  const normalized = normalize(username);
  const verifier = normalized === null ? undefined : users.get(normalized);

  if (typeof password !== "string" || password === "") {
    // Still spend the time, for the same reason as an unknown username.
    await derive("", DECOY);
    return false;
  }

  const derived = await derive(password, verifier ?? DECOY);
  if (verifier === undefined) return false;
  if (derived.length !== verifier.hash.length) return false;
  return timingSafeEqual(derived, verifier.hash);
}

/** Builds a fresh `CONSOLE_USERS` verifier. Used by `npm run console:passwd`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scryptAsync(password, salt, KEY_LENGTH, {
    ...COST,
    maxmem: 128 * COST.N * COST.r * 2,
  });
  return [
    "scrypt",
    COST.N,
    COST.r,
    COST.p,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}
