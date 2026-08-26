/**
 * Who may use the console.
 *
 * The chat can start harness sessions, which can mutate a cluster — so this is
 * an authorization boundary, not a preference. It fails closed: an unset or
 * empty allowlist admits nobody.
 */

export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
}

/**
 * GitHub usernames are case-insensitive, so compare case-folded. Anything that
 * is not a plain non-empty string is rejected rather than coerced.
 */
export function isAllowed(username: unknown, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false;
  if (typeof username !== "string") return false;
  const normalized = username.trim().toLowerCase();
  if (normalized === "") return false;
  return allowlist.includes(normalized);
}
