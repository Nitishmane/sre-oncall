/**
 * An MCP server that returns a file from the deploy repository as text.
 *
 * It exists because of two limitations that meet badly:
 *
 *   1. GitHub's `get_file_contents` returns the file in an MCP `resource`
 *      block, and the harness forwards only `text` blocks to the model. The
 *      agent sees `successfully downloaded text file (SHA: …)` and never the
 *      bytes.
 *   2. The documented fallback — `curl` inside the sandbox — cannot run,
 *      because the sandbox fails to initialise on macOS: its `git ls-remote`
 *      hits the Xcode command-line-tools prompt and the whole sandbox dies.
 *
 * Between them the agent has no way to read a file exactly, so it cannot
 * produce a revert it can vouch for. It correctly refuses to guess, and the
 * incident stops there. This closes that gap and nothing else.
 *
 * Deliberately narrow. It serves ONE tool, over https only, from
 * raw.githubusercontent.com only, for one repository, with a size cap. A
 * general "fetch any URL" tool handed to an agent that reads attacker-
 * influenced data (alert labels, pod names, commit messages) is an SSRF
 * primitive; this is a file reader for one repository.
 */
import { createInterface } from "node:readline";

const REPO = process.env["RAW_FILE_REPO"] ?? "";
const MAX_BYTES = Number(process.env["RAW_FILE_MAX_BYTES"] ?? 512 * 1024);

/** `owner/repo` — anything else is refused rather than guessed at. */
function repoAllowed(owner, repo) {
  if (REPO === "") return false;
  return `${owner}/${repo}`.toLowerCase() === REPO.toLowerCase();
}

/** Refuses traversal and absolute paths; the ref must look like a ref. */
function pathAllowed(path) {
  if (path === "" || path.startsWith("/")) return false;
  if (path.includes("\0") || path.includes("..")) return false;
  return /^[A-Za-z0-9._\-/]+$/.test(path);
}

const REF = /^[A-Za-z0-9._\-/]{1,200}$/;

const TOOL = {
  name: "read_repo_file",
  description:
    "Read a file from the deploy repository at an exact git ref, returned verbatim as text. " +
    "Use this to obtain the previous good contents of a manifest before opening a revert " +
    "pull request — GitHub's get_file_contents cannot return file bytes here.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner." },
      repo: { type: "string", description: "Repository name." },
      ref: { type: "string", description: "Commit SHA, branch, or tag." },
      path: { type: "string", description: "Path within the repository." },
    },
    required: ["owner", "repo", "ref", "path"],
  },
};

async function readRepoFile(args) {
  const { owner = "", repo = "", ref = "", path = "" } = args ?? {};
  if (!repoAllowed(owner, repo)) {
    return `Refused: this server only serves ${REPO || "(no repository configured)"}.`;
  }
  if (!REF.test(ref)) return "Refused: that does not look like a git ref.";
  if (!pathAllowed(path)) return "Refused: path must be relative, with no '..' segments.";

  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
  const response = await fetch(url, {
    headers: { accept: "text/plain" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    return `Could not read ${path} at ${ref}: HTTP ${response.status}.`;
  }
  const text = await response.text();
  if (text.length > MAX_BYTES) {
    return `Refused: ${path} is ${text.length} bytes, over the ${MAX_BYTES} limit.`;
  }
  return text;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request) {
  const { id, method, params } = request;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "raw-file", version: "1.0.0" },
      },
    };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: [TOOL] } };
  }
  if (method === "tools/call") {
    if (params?.name !== TOOL.name) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "No such tool." } };
    }
    try {
      const text = await readRepoFile(params?.arguments);
      // A `text` block on purpose: a `resource` block would be dropped before
      // it reached the model, which is the whole problem this server solves.
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `read_repo_file failed: ${String(err)}` }],
        },
      };
    }
  }
  // Notifications carry no id and expect no reply.
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.trim() === "") continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  const reply = await handle(request);
  if (reply !== null) send(reply);
}
