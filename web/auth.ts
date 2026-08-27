import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { isAllowed, parseAllowlist } from "./lib/allowlist.ts";

/**
 * Layer 1 of two.
 *
 * GitHub OAuth decides *who you are*; the allowlist decides *whether you may be
 * here at all*. Layer 2 is the bearer the proxy attaches server-side, which the
 * browser never sees.
 *
 * The console can start harness sessions that mutate a cluster, so this is not
 * decoration. It fails closed: with CHAT_ALLOWLIST unset, nobody gets in.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  // Auth.js infers this on Vercel and refuses to guess anywhere else, which
  // makes every request fail with UntrustedHost when the console runs locally
  // or behind the ngrok tunnel. Trusting the Host header is safe here because
  // it is not what bounds the OAuth flow: GitHub only ever redirects to the
  // callback URL registered on the OAuth app, and the allowlist in `signIn`
  // decides admission regardless of which host served the page.
  trustHost: true,
  pages: { signIn: "/signin", error: "/signin" },
  callbacks: {
    signIn({ profile }) {
      // `profile.login` is GitHub's username. Anything else is not an identity
      // we recognise, and `isAllowed` rejects non-strings rather than coercing.
      return isAllowed(profile?.["login"], parseAllowlist(process.env["CHAT_ALLOWLIST"]));
    },
    jwt({ token, profile }) {
      if (profile?.["login"] !== undefined) token["login"] = profile["login"];
      return token;
    },
    session({ session, token }) {
      if (session.user) session.user.name = String(token["login"] ?? session.user.name ?? "");
      return session;
    },
  },
});
