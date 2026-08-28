import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "../../auth.ts";

/**
 * The auth wall. Deliberately says why access is restricted rather than just
 * refusing: this console can start sessions that change a live cluster.
 */
export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  async function authenticate(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        username: formData.get("username"),
        password: formData.get("password"),
        redirectTo: "/",
      });
    } catch (err) {
      // A successful sign-in also leaves through this catch: `signIn` performs
      // the redirect by throwing, and that error is not an AuthError, so it has
      // to be re-thrown for Next to act on it.
      if (err instanceof AuthError) redirect("/signin?error=CredentialsSignin");
      throw err;
    }
  }

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
          This console can start agent sessions against a live cluster, so it is
          limited to accounts issued for it. Sign in with the credentials you
          were given.
        </p>

        <ErrorNote error={error} />

        <form action={authenticate} style={{ marginTop: "1.5rem" }}>
          <Field label="Username" name="username" type="text" autoComplete="username" />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
          />
          <button
            type="submit"
            style={{
              marginTop: "1.25rem",
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
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}

function Field({
  label,
  name,
  type,
  autoComplete,
}: {
  label: string;
  name: string;
  type: string;
  autoComplete: string;
}) {
  return (
    <label style={{ display: "block", marginTop: "1rem" }}>
      <span
        style={{
          display: "block",
          fontSize: "0.78rem",
          color: "var(--console-muted)",
          marginBottom: "0.35rem",
        }}
      >
        {label}
      </span>
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        required
        style={{
          width: "100%",
          padding: "0.6rem 0.75rem",
          borderRadius: "0.5rem",
          border: "1px solid var(--console-border)",
          background: "#0f131a",
          color: "var(--console-text)",
          fontSize: "0.92rem",
        }}
      />
    </label>
  );
}

function ErrorNote({ error }: { error: string | undefined }) {
  if (error === undefined) return null;
  // Never distinguish "no such account" from "wrong password": that difference
  // tells an attacker which usernames are worth guessing against.
  const message =
    error === "CredentialsSignin"
      ? "Incorrect username or password."
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
