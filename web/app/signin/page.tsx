import { signIn } from "../../auth.ts";

/**
 * The auth wall. Deliberately says why access is restricted rather than just
 * refusing: this console can start sessions that change a live cluster.
 */
export default function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
      }}
    >
      <div
        style={{
          maxWidth: "26rem",
          width: "100%",
          background: "var(--console-panel)",
          border: "1px solid var(--console-border)",
          borderRadius: "0.75rem",
          padding: "2rem",
        }}
      >
        <h1 style={{ fontSize: "1.35rem", fontWeight: 600, marginBottom: "0.5rem" }}>
          SRE-Oncall console
        </h1>
        <p style={{ color: "var(--console-muted)", fontSize: "0.9rem", lineHeight: 1.6 }}>
          This console can start agent sessions against a live cluster, so access
          is limited to an allowlist of GitHub accounts.
        </p>

        <ErrorNote searchParams={searchParams} />

        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            style={{
              marginTop: "1.5rem",
              width: "100%",
              padding: "0.7rem 1rem",
              borderRadius: "0.5rem",
              border: "1px solid var(--console-border)",
              background: "#1c2129",
              color: "var(--console-text)",
              fontSize: "0.95rem",
              cursor: "pointer",
            }}
          >
            Continue with GitHub
          </button>
        </form>
      </div>
    </main>
  );
}

async function ErrorNote({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  if (error === undefined) return null;
  // AccessDenied is the allowlist rejecting a valid GitHub login — worth saying
  // plainly, because "sign-in failed" would send people to check their password.
  const message =
    error === "AccessDenied"
      ? "That GitHub account is not on the allowlist for this console."
      : "Sign-in failed. Try again, or check the console configuration.";
  return (
    <p
      style={{
        marginTop: "1rem",
        padding: "0.7rem 0.9rem",
        borderRadius: "0.5rem",
        border: "1px solid #3b2226",
        background: "#1e1416",
        color: "var(--console-firing)",
        fontSize: "0.85rem",
      }}
    >
      {message}
    </p>
  );
}
