/**
 * Mints a CONSOLE_USERS entry.
 *
 *   npm run console:passwd -- reviewer
 *
 * Prompts for the password rather than taking it as an argument, so it does not
 * land in shell history or in the process list. Prints one `username:verifier`
 * pair; append it to CONSOLE_USERS, comma-separated, in the Vercel dashboard.
 *
 * With no password typed, it generates one and prints it once — that is the
 * copy to hand out, and it is not recoverable from the verifier afterwards.
 */

import { randomBytes } from "node:crypto";
import { hashPassword } from "../lib/credentials.ts";

/**
 * Reads a line from the terminal with nothing echoed.
 *
 * Raw mode rather than readline's own masking, which prints a placeholder per
 * keystroke and so leaks the length to anyone looking at the screen. Raw mode
 * also means handling Enter, backspace and Ctrl-C by hand, since the terminal
 * no longer does any of it for us.
 */
async function readSecret(prompt: string): Promise<string> {
  if (process.stdin.isTTY !== true) return "";
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let typed = "";
  try {
    for await (const chunk of process.stdin) {
      for (const char of chunk as string) {
        // Enter, in either of the two forms a terminal may send it.
        if (char === "\r" || char === "\n") return typed.trim();
        if (char === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          typed = typed.slice(0, -1);
          continue;
        }
        // Ignore the escape sequences that arrow keys and the like arrive as,
        // so they cannot end up inside the password.
        if (char >= " ") typed += char;
      }
    }
    return typed.trim();
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\n");
  }
}

/** Base64url of 18 random bytes: 24 characters, nothing ambiguous to transcribe. */
function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

async function main(): Promise<void> {
  const username = (process.argv[2] ?? "").trim().toLowerCase();
  if (username === "" || username.includes(":") || username.includes(",")) {
    console.error("usage: npm run console:passwd -- <username>");
    console.error("       a username may not contain ':' or ',' — those separate CONSOLE_USERS.");
    process.exit(2);
  }

  const typed = await readSecret(`Password for "${username}" (blank to generate): `);
  const generated = typed === "";
  const password = generated ? generatePassword() : typed;

  if (!generated && password.length < 12) {
    console.error("refusing a password under 12 characters — these credentials get handed out.");
    process.exit(2);
  }

  const verifier = await hashPassword(password);

  console.log("");
  if (generated) {
    console.log("  password (shown once — save it now):");
    console.log(`    ${password}`);
    console.log("");
  }
  console.log("  CONSOLE_USERS entry:");
  console.log(`    ${username}:${verifier}`);
  console.log("");
  console.log("  Multiple accounts go in the one variable, comma-separated.");
}

await main();
