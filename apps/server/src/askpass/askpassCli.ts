// The helper runs on sudo's and ssh's critical path before any Effect runtime
// exists, so it stays on Node built-ins.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalTimers:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import {
  ASKPASS_ASKERS,
  ASKPASS_REQUEST_PATH,
  ASKPASS_SOCKET_ENV,
  ASKPASS_THREAD_ENV,
  ASKPASS_TOKEN_ENV,
  type AskpassRequestBody,
} from "./askpassProtocol.ts";

/**
 * `t3 askpass <prompt>`: the program sudo (`-A`) and ssh
 * (`SSH_ASKPASS_REQUIRE=force`) run for a password in an agent's commands.
 * It asks T3 to show a password box in the agent's thread, prints what the
 * user types to stdout for the asker to read, and exits 0. A declined,
 * abandoned or failed request exits 1, so sudo and ssh fail as if no password
 * was given. bin.ts dispatches here before the CLI module graph loads.
 */
export async function runAskpassCli(args: ReadonlyArray<string>): Promise<void> {
  const fail = (message: string) => {
    process.stderr.write(`t3 askpass: ${message}\n`);
    process.exitCode = 1;
  };
  const socketPath = process.env[ASKPASS_SOCKET_ENV];
  const threadId = process.env[ASKPASS_THREAD_ENV];
  const token = process.env[ASKPASS_TOKEN_ENV];
  if (!socketPath || !threadId || !token) {
    return fail("only works in commands an agent runs under T3.");
  }
  // ssh's notice-only prompts (touch your security key) expect no answer.
  if (process.env.SSH_ASKPASS_PROMPT === "none") return;

  const asker = processInfo(process.ppid);
  if (asker === undefined || !ASKPASS_ASKERS.has(asker.comm)) {
    return fail(
      `answers sudo, ssh and git only, and was run by ${asker?.comm ?? "an unknown program"}, so nothing was asked.`,
    );
  }
  // ssh that git started says little on its own; `git push origin` says what it is for.
  const parent = asker.comm === "ssh" ? processInfo(asker.ppid) : undefined;
  const caller = parent?.comm.startsWith("git") ? parent : undefined;
  const body: AskpassRequestBody = {
    threadId,
    token,
    prompt: args[0] ?? "",
    asker: asker.comm,
    command: asker.command,
    ...(caller === undefined ? {} : { caller: caller.command }),
  };

  // A killed sudo or ssh can leave this helper behind, still holding the
  // card open. Reparented means the asker is gone: hang up, which closes it.
  const abort = new AbortController();
  const askerPid = process.ppid;
  const watch = setInterval(() => {
    if (process.ppid !== askerPid) abort.abort();
  }, 1000);
  const response = await post(socketPath, JSON.stringify(body), abort.signal)
    .catch(() => undefined)
    .finally(() => clearInterval(watch));
  if (abort.signal.aborted) {
    response?.body.fill(0);
    return fail("the command that asked is gone, so the password box was closed.");
  }
  if (response === undefined) return fail("T3 is not answering, so nothing was asked.");
  if (response.status !== 200) {
    const message = response.body.toString("utf8").trim();
    response.body.fill(0);
    return fail(message || `T3 answered ${response.status}.`);
  }
  // sudo and ssh read one line. The buffer is wiped once it is written.
  const secret = response.body;
  await new Promise<void>((resolve) => {
    process.stdout.write(Buffer.concat([secret, Buffer.from("\n")]), () => resolve());
  });
  secret.fill(0);
}

interface ProcessInfo {
  readonly comm: string;
  readonly command: string;
  readonly ppid: number;
}

/** A process's name, command line and parent from /proc; undefined if it is gone or unreadable. */
function processInfo(pid: number): ProcessInfo | undefined {
  try {
    const comm = NodeFS.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    const command = NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\u0000")
      .filter((part) => part.length > 0)
      .join(" ");
    const ppid = Number(
      /^PPid:\s*(\d+)$/m.exec(NodeFS.readFileSync(`/proc/${pid}/status`, "utf8"))?.[1],
    );
    return { comm, command, ppid };
  } catch {
    return undefined;
  }
}

function post(
  socketPath: string,
  body: string,
  signal: AbortSignal,
): Promise<{ readonly status: number; readonly body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      {
        socketPath,
        path: ASKPASS_REQUEST_PATH,
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const all = Buffer.concat(chunks);
          for (const chunk of chunks) chunk.fill(0);
          resolve({ status: response.statusCode ?? 500, body: all });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}
