import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "./auth.config.ts";
import { parseConsoleUsers, verifyConsoleUser } from "./lib/credentials.ts";

/**
 * Layer 1 of two.
 *
 * A username and password decide *whether you may be here at all*; layer 2 is
 * the bridge token the proxy attaches server-side, which the browser never sees.
 *
 * The console can start harness sessions that mutate a cluster, so this is not
 * decoration. It fails closed: with CONSOLE_USERS unset, nobody gets in.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      name: "Console account",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const users = parseConsoleUsers(process.env["CONSOLE_USERS"]);
        const username = raw?.["username"];
        if (!(await verifyConsoleUser(username, raw?.["password"], users))) return null;

        // Only reached for a username that matched an account, so the cast is
        // sound; store it case-folded so the session name matches what the API
        // routes look up in CONSOLE_USERS.
        const name = (username as string).trim().toLowerCase();
        return { id: name, name };
      },
    }),
  ],
});
