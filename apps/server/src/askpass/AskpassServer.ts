/**
 * AskpassServer - answers the askpass helper with a password box in the thread.
 *
 * The helper connects to a unix socket in the state directory, so the route
 * is unreachable from the network, tunnels and remote clients included. Each
 * request raises a secret request card in the thread's running turn. The
 * user's answer goes straight back to the helper through SecretRequests and
 * is never stored, logged or recorded: the card carries only what asked and
 * how it ended.
 *
 * @module AskpassServer
 */
// @effect-diagnostics nodeBuiltinImport:off -- the socket is a plain Node HTTP server.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import { ASKPASS_TURN_ITEM_PREFIX, CommandId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { AgentAskpass } from "./AgentAskpass.ts";
import { ASKPASS_ASKERS, ASKPASS_REQUEST_PATH } from "./askpassProtocol.ts";

/** sudo gives up on its own after 5 minutes; this only bounds a forgotten card. */
const ASKPASS_TIMEOUT = Duration.minutes(10);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMMAND_CHARS = 300;

const AskpassRequest = Schema.fromJsonString(
  Schema.Struct({
    threadId: Schema.String,
    token: Schema.String,
    prompt: Schema.String,
    asker: Schema.String,
    command: Schema.String,
    caller: Schema.optional(Schema.String),
  }),
);
type AskpassRequest = typeof AskpassRequest.Type;
const decodeRequest = Schema.decodeUnknownOption(AskpassRequest);

const ASKPASS_FAILURES = {
  no_active_run: [409, "No turn is running in this thread, so there is nowhere to ask."],
  declined: [403, "The password was declined in T3."],
  timed_out: [408, "Nobody entered the password in T3."],
  unavailable: [503, "T3 could not show the password box."],
} as const;

export class AskpassError extends Schema.TaggedError<AskpassError>()("AskpassError", {
  reason: Schema.Literals(Object.keys(ASKPASS_FAILURES) as Array<keyof typeof ASKPASS_FAILURES>),
}) {
  get status(): number {
    return ASKPASS_FAILURES[this.reason][0];
  }
  override get message(): string {
    return ASKPASS_FAILURES[this.reason][1];
  }
}

const clip = (text: string) =>
  text.length > MAX_COMMAND_CHARS ? `${text.slice(0, MAX_COMMAND_CHARS - 1)}…` : text;

/** What the card says: who asks, what for, and the asker's own prompt. */
export function askpassCard(
  request: Pick<AskpassRequest, "prompt" | "asker" | "command" | "caller">,
): {
  readonly label: string;
  readonly reason: string;
  readonly placeholder: string;
} {
  const prompt = request.prompt.trim();
  const passphrase = /passphrase/i.test(prompt);
  const password = /password/i.test(prompt);
  const label =
    request.asker === "sudo"
      ? "sudo password"
      : request.asker.startsWith("git")
        ? /^username/i.test(prompt)
          ? "Git username"
          : "Git password"
        : passphrase
          ? "SSH key passphrase"
          : password
            ? "SSH password"
            : "SSH question";
  const ran =
    request.caller === undefined ? request.command : `${request.caller} (${request.command})`;
  return {
    label,
    reason: `${prompt ? `${prompt} ` : ""}Asked by: ${clip(ran)}`,
    placeholder: passphrase
      ? "Passphrase"
      : password || request.asker === "sudo"
        ? "Password"
        : "Answer",
  };
}

export const make = Effect.gen(function* () {
  const askpass = yield* AgentAskpass;
  const socketPath = askpass.socketPath;
  if (socketPath === undefined) return;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const secretRequests = yield* SecretRequests.SecretRequests;
  const services = yield* Effect.context<never>();

  /** Shows the card, waits for the answer, and records how it ended. */
  const ask = Effect.fn("AskpassServer.ask")(function* (request: AskpassRequest) {
    const threadId = ThreadId.make(request.threadId);
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": threadId,
      "askpass.asker": request.asker,
    });
    const runs = yield* threadManagement
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError(() => new AskpassError({ reason: "unavailable" })));
    const run = ThreadManagementService.latestActiveRun(runs);
    if (run === undefined || run.rootNodeId === null) {
      return yield* new AskpassError({ reason: "no_active_run" });
    }
    const runId = run.id;
    const nodeId = run.rootNodeId;
    const turnItemId = TurnItemId.make(
      `${ASKPASS_TURN_ITEM_PREFIX}${encodeURIComponent(threadId)}:${NodeCrypto.randomBytes(8).toString("hex")}`,
    );
    const card = askpassCard(request);
    const record = (secretStatus: "pending" | "saved" | "declined" | "cancelled") =>
      threadManagement.dispatch({
        type: "secret_request.record",
        commandId: CommandId.make(`${turnItemId}:${secretStatus}`),
        threadId,
        runId,
        nodeId,
        turnItemId,
        label: card.label,
        reason: card.reason,
        placeholder: card.placeholder,
        secretStatus,
      });
    const recordLogged = (secretStatus: "saved" | "declined" | "cancelled") =>
      record(secretStatus).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.logWarning("Could not close an askpass card", { errorTag: error._tag }),
        ),
      );

    // Registered before the card shows, so no answer can arrive unrouted.
    const answer = yield* secretRequests.expectAnswer({ threadId, turnItemId });
    yield* record("pending").pipe(
      Effect.mapError(() => new AskpassError({ reason: "unavailable" })),
    );
    // The card stays open for as long as the asker waits, even past the end
    // of the turn: an agent's command that outlives its tool call's timeout
    // keeps running in the background and still wants the password. The
    // asker hanging up (sudo giving up, the command killed, the helper's
    // parent gone) interrupts this fiber, and the card must not outlive it.
    const outcome = yield* Deferred.await(answer).pipe(
      Effect.timeoutOption(ASKPASS_TIMEOUT),
      Effect.onInterrupt(() => recordLogged("cancelled")),
    );
    if (Option.isNone(outcome)) {
      yield* recordLogged("cancelled");
      return yield* new AskpassError({ reason: "timed_out" });
    }
    if (Option.isNone(outcome.value)) {
      yield* recordLogged("declined");
      return yield* new AskpassError({ reason: "declined" });
    }
    yield* recordLogged("saved");
    return outcome.value.value;
  }, Effect.scoped);

  const respond = (response: NodeHttp.ServerResponse, status: number, body: string) => {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
  };

  const handle = (incoming: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    if (incoming.method !== "POST" || incoming.url !== ASKPASS_REQUEST_PATH) {
      return respond(response, 404, "Not found.");
    }
    const chunks: Array<Buffer> = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return void incoming.destroy();
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      const request = decodeRequest(Buffer.concat(chunks).toString("utf8"));
      if (Option.isNone(request) || !ASKPASS_ASKERS.has(request.value.asker)) {
        return respond(response, 400, "Malformed askpass request.");
      }
      if (!askpass.verify(request.value.threadId, request.value.token)) {
        return respond(response, 403, "This command's askpass token is not valid for its thread.");
      }
      const fiber = Effect.runForkWith(services)(ask(request.value));
      response.on("close", () => {
        if (!response.writableFinished) fiber.interruptUnsafe();
      });
      fiber.addObserver((exit) => {
        if (Exit.isSuccess(exit)) return respond(response, 200, exit.value);
        const error = Cause.findErrorOption(exit.cause);
        if (Option.isSome(error)) return respond(response, error.value.status, error.value.message);
        respond(response, 500, "T3 could not ask for the password.");
      });
    });
  };

  yield* Effect.acquireRelease(
    Effect.callback<NodeHttp.Server, Error>((resume) => {
      // Only one server owns a state directory, so a socket file left here
      // belongs to an earlier run of it.
      NodeFS.rmSync(socketPath, { force: true });
      const server = NodeHttp.createServer(handle);
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(socketPath, () => {
        NodeFS.chmodSync(socketPath, 0o600);
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        server.closeAllConnections();
      }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(socketPath, { force: true })))),
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Askpass is off: could not listen on its socket.", {
        message: error.message,
      }),
    ),
  );
});

export const layer = Layer.effectDiscard(make);
