// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- drives the shim and the socket like sudo and the helper do.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { AgentAskpass, sudoShimScript } from "./AgentAskpass.ts";
import * as AskpassServer from "./AskpassServer.ts";
import type { AskpassRequestBody } from "./askpassProtocol.ts";

/** Runs the shim with a fake real sudo after it on PATH that prints the arguments it got. */
const runShim = (args: ReadonlyArray<string>, options: { readonly askpass?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-askpass-shim-" });
    const binDir = `${root}/bin`;
    yield* fs.makeDirectory(binDir);
    yield* fs.makeDirectory(`${root}/real`);
    yield* fs.writeFileString(`${binDir}/sudo`, sudoShimScript(binDir));
    yield* fs.chmod(`${binDir}/sudo`, 0o755);
    yield* fs.writeFileString(`${root}/real/sudo`, `#!/bin/sh\nprintf '%s\\n' "$@"\n`);
    yield* fs.chmod(`${root}/real/sudo`, 0o755);
    const result = NodeChildProcess.spawnSync(`${binDir}/sudo`, args, {
      encoding: "utf8",
      env: {
        PATH: `${binDir}:${root}/real:/usr/bin:/bin`,
        ...(options.askpass === false ? {} : { SUDO_ASKPASS: "/askpass" }),
      },
    });
    return result.stdout.trim().split("\n");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("the sudo shim adds -A only where sudo would ask for a password", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* runShim(["pacman", "-S", "godot"]), ["-A", "pacman", "-S", "godot"]);
    assert.deepEqual(yield* runShim(["-u", "root", "ls", "-n"]), ["-A", "-u", "root", "ls", "-n"]);
    assert.deepEqual(yield* runShim(["-uroot", "-v"]), ["-A", "-uroot", "-v"]);
    // Options that read no password, or pick their own way, run as written.
    assert.deepEqual(yield* runShim(["-n", "true"]), ["-n", "true"]);
    assert.deepEqual(yield* runShim(["-u", "nobody", "-S", "id"]), ["-u", "nobody", "-S", "id"]);
    assert.deepEqual(yield* runShim(["-nE", "id"]), ["-nE", "id"]);
    assert.deepEqual(yield* runShim(["--user=bob", "--stdin", "id"]), [
      "--user=bob",
      "--stdin",
      "id",
    ]);
    assert.deepEqual(yield* runShim(["-A", "id"]), ["-A", "id"]);
    assert.deepEqual(yield* runShim(["-K"]), ["-K"]);
    // Without T3's askpass there is nothing to route to.
    assert.deepEqual(yield* runShim(["id"], { askpass: false }), ["id"]);
  }),
);

it.effect("the card names what asked without the agent's shell around it", () =>
  Effect.sync(() => {
    const sudo = AskpassServer.askpassCard({
      prompt: "[sudo] password for sao: ",
      asker: "sudo",
      command: "sudo -A pacman -S godot",
    });
    assert.equal(sudo.label, "sudo password");
    assert.equal(sudo.reason, "[sudo] password for sao: Asked by: sudo -A pacman -S godot");
    const push = AskpassServer.askpassCard({
      prompt: "Enter passphrase for key '/home/sao/.ssh/id_ed25519': ",
      asker: "ssh",
      command: "/usr/bin/ssh git@github.com git-receive-pack 'me/repo.git'",
      caller: "git push origin main",
    });
    assert.equal(push.label, "SSH key passphrase");
    assert.equal(push.placeholder, "Passphrase");
    assert.include(push.reason, "git push origin main (/usr/bin/ssh git@github.com");
  }),
);

const threadId = "thread-askpass";
const goodToken = "token-for-thread";

/** One askpass request over the socket, as the helper sends it. */
const post = (socketPath: string, body: Partial<AskpassRequestBody>, signal?: AbortSignal) =>
  Effect.promise(
    () =>
      new Promise<{ readonly status: number; readonly body: string }>((resolve) => {
        const request = NodeHttp.request(
          { socketPath, path: "/askpass", method: "POST", signal },
          (response) => {
            let text = "";
            response.on("data", (chunk) => (text += chunk));
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
          },
        );
        request.on("error", () => resolve({ status: 0, body: "" }));
        request.end(
          JSON.stringify({
            threadId,
            token: goodToken,
            prompt: "[sudo] password for sao: ",
            asker: "sudo",
            command: "sudo -A pacman -S godot",
            ...body,
          }),
        );
      }),
  );

type Status = "pending" | "saved" | "declined" | "cancelled";

/** Runs `body` against a live askpass socket whose thread has one running turn. */
const withServer = <A>(
  body: (input: {
    readonly socketPath: string;
    /** Resolves with the card's turn item id once it shows. */
    readonly shown: Deferred.Deferred<string>;
    /** Resolves when the card is recorded with this status. */
    readonly recorded: (status: Status) => Effect.Effect<void>;
    /** Answers the card as the user would. */
    readonly answer: (value: Option.Option<string>) => Effect.Effect<void>;
    readonly dispatched: Array<OrchestrationV2ServerCommand>;
  }) => Effect.Effect<A>,
  options: { readonly runStatus?: string } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-askpass-" });
    const socketPath = `${root}/askpass.sock`;
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const shown = yield* Deferred.make<string>();
    const statuses = new Map<Status, Deferred.Deferred<void>>();
    for (const status of ["pending", "saved", "declined", "cancelled"] as const) {
      statuses.set(status, yield* Deferred.make<void>());
    }
    const expected = yield* Deferred.make<Deferred.Deferred<Option.Option<string>>>();
    const dependencies = Layer.mergeAll(
      Layer.succeed(AgentAskpass, {
        environment: () => undefined,
        verify: (thread, token) => thread === threadId && token === goodToken,
        socketPath,
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.succeed({
            runs: [
              {
                id: "run-1",
                ordinal: 1,
                status: options.runStatus ?? "running",
                rootNodeId: "node-root",
              },
            ],
          } as never),
        dispatch: (command) =>
          Effect.gen(function* () {
            dispatched.push(command);
            if (command.type !== "secret_request.record") return {} as never;
            if (command.secretStatus === "pending") {
              yield* Deferred.succeed(shown, command.turnItemId);
            }
            yield* Deferred.succeed(statuses.get(command.secretStatus)!, undefined);
            return {} as never;
          }),
      }),
      Layer.mock(SecretRequests.SecretRequests)({
        expectAnswer: () =>
          Effect.gen(function* () {
            const deferred = yield* Deferred.make<Option.Option<string>>();
            yield* Deferred.succeed(expected, deferred);
            return deferred;
          }),
      }),
    );
    return yield* body({
      socketPath,
      shown,
      recorded: (status) => Deferred.await(statuses.get(status)!),
      answer: (value) =>
        Deferred.await(expected).pipe(
          Effect.flatMap((deferred) => Deferred.succeed(deferred, value)),
          Effect.asVoid,
        ),
      dispatched,
    }).pipe(Effect.provide(AskpassServer.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("the typed password goes back to the asker and nowhere else", () =>
  withServer(({ socketPath, shown, answer, dispatched }) =>
    Effect.gen(function* () {
      const response = yield* Effect.forkChild(post(socketPath, {}));
      yield* Deferred.await(shown);
      yield* answer(Option.some("hunter2"));
      const result = yield* Fiber.join(response);
      assert.deepEqual(result, { status: 200, body: "hunter2" });
      const records = dispatched.flatMap((command) =>
        command.type === "secret_request.record" ? [command] : [],
      );
      assert.deepEqual(
        records.map((command) => command.secretStatus),
        ["pending", "saved"],
      );
      assert.equal(records[0]?.label, "sudo password");
      assert.include(records[0]?.reason ?? "", "sudo -A pacman -S godot");
      assert.isFalse(JSON.stringify(dispatched).includes("hunter2"));
    }),
  ),
);

it.effect("a declined prompt fails the asker", () =>
  withServer(({ socketPath, shown, answer, recorded }) =>
    Effect.gen(function* () {
      const response = yield* Effect.forkChild(post(socketPath, {}));
      yield* Deferred.await(shown);
      yield* answer(Option.none());
      const result = yield* Fiber.join(response);
      assert.equal(result.status, 403);
      assert.include(result.body, "declined");
      yield* recorded("declined");
    }),
  ),
);

it.effect("an asker that hangs up closes its card", () =>
  withServer(({ socketPath, shown, recorded }) =>
    Effect.gen(function* () {
      const abort = new AbortController();
      yield* Effect.forkChild(post(socketPath, {}, abort.signal));
      yield* Deferred.await(shown);
      abort.abort();
      yield* recorded("cancelled");
    }),
  ),
);

it.effect("refuses a token from another thread and shows nothing", () =>
  withServer(({ socketPath, dispatched }) =>
    Effect.gen(function* () {
      const result = yield* post(socketPath, { token: "someone-else" });
      assert.equal(result.status, 403);
      assert.equal(dispatched.length, 0);
    }),
  ),
);

it.effect("refuses when no turn is running to ask in", () =>
  withServer(
    ({ socketPath, dispatched }) =>
      Effect.gen(function* () {
        const result = yield* post(socketPath, {});
        assert.equal(result.status, 409);
        assert.equal(dispatched.length, 0);
      }),
    { runStatus: "completed" },
  ),
);
