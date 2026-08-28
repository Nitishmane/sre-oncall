import type { NextAuthConfig } from "next-auth";

/**
 * The half of the auth setup that carries no Node-only code.
 *
 * Middleware runs on the edge runtime, where `node:crypto` does not exist — and
 * the credentials provider needs scrypt. So the shared settings live here and
 * the provider is added in `auth.ts`, which is only ever imported from Node
 * route handlers and server components. Middleware builds its own instance from
 * this config and does nothing but verify the session cookie, which it can do
 * with `AUTH_SECRET` alone.
 */
export const authConfig = {
  providers: [],
  // Auth.js infers the host on Vercel and refuses to guess anywhere else, which
  // makes every request fail with UntrustedHost when the console runs locally
  // or behind the ngrok tunnel. Nothing about admission depends on the Host
  // header: the credentials check decides who gets in, whatever served the page.
  trustHost: true,
  // No database, so sessions are signed JWTs. The API routes re-check the
  // username against CONSOLE_USERS on every request, so a removed account
  // cannot keep using a token that has not expired yet.
  session: { strategy: "jwt" },
  pages: { signIn: "/signin", error: "/signin" },
  callbacks: {
    jwt({ token, user }) {
      if (user?.name) token["login"] = user.name;
      return token;
    },
    session({ session, token }) {
      if (session.user) session.user.name = String(token["login"] ?? session.user.name ?? "");
      return session;
    },
  },
} satisfies NextAuthConfig;
