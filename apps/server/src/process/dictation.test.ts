import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as Dictation from "./dictation.ts";

const pc = new Set(["127.0.0.1", "100.125.80.104"]);

it("treats a direct loopback connection as this machine", () => {
  assert.deepStrictEqual(
    Dictation.resolveDictationTarget({
      socketAddress: "127.0.0.1",
      forwardedFor: undefined,
      localAddresses: pc,
    }),
    { kind: "local" },
  );
});

it("treats this machine's own tailnet IP behind tailscale serve as local", () => {
  assert.deepStrictEqual(
    Dictation.resolveDictationTarget({
      socketAddress: "127.0.0.1",
      forwardedFor: "100.125.80.104",
      localAddresses: pc,
    }),
    { kind: "local" },
  );
});

it("routes the laptop behind tailscale serve over SSH, trusting only the last hop", () => {
  assert.deepStrictEqual(
    Dictation.resolveDictationTarget({
      socketAddress: "127.0.0.1",
      forwardedFor: "100.125.80.104, 100.97.33.14",
      localAddresses: pc,
    }),
    { kind: "ssh", host: "omarchy-laptop" },
  );
});

it("ignores X-Forwarded-For on a direct connection", () => {
  assert.deepStrictEqual(
    Dictation.resolveDictationTarget({
      socketAddress: "100.93.240.118",
      forwardedFor: "100.125.80.104",
      localAddresses: pc,
    }),
    { kind: "unknown", address: "100.93.240.118" },
  );
});

const encode = (text: string) => Stream.make(new TextEncoder().encode(text));

const layerSpawner = (
  stdoutFor: (command: ChildProcess.StandardCommand) => string,
  spawned: Array<ChildProcess.StandardCommand>,
) =>
  Layer.merge(
    NodeServices.layer,
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const standard = command as ChildProcess.StandardCommand;
          spawned.push(standard);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: encode(stdoutFor(standard)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
  );

it.effect("runs status and dictate on the SSH host", () => {
  const spawned: Array<ChildProcess.StandardCommand> = [];
  return Dictation.toggleDictation(
    { action: "toggle" },
    { kind: "ssh", host: "omarchy-laptop" },
  ).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        assert.deepStrictEqual(result, { recording: true });
        assert.deepStrictEqual(
          spawned.map((command) => [command.command, command.args.at(-2), command.args.at(-1)]),
          [
            ["ssh", "omarchy-laptop", "export XDG_RUNTIME_DIR=/run/user/$(id -u); voxtype status"],
            [
              "ssh",
              "omarchy-laptop",
              "export XDG_RUNTIME_DIR=/run/user/$(id -u); exec ~/Omarchy-merge/bin/dictate",
            ],
          ],
        );
      }),
    ),
    Effect.provide(
      layerSpawner((command) => (command.args.at(-1)?.endsWith("status") ? "idle\n" : ""), spawned),
    ),
  );
});

it.effect("stop does nothing on the SSH host when it isn't recording", () => {
  const spawned: Array<ChildProcess.StandardCommand> = [];
  return Dictation.toggleDictation(
    { action: "stop" },
    { kind: "ssh", host: "omarchy-laptop" },
  ).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        assert.deepStrictEqual(result, { recording: false });
        assert.strictEqual(spawned.length, 1);
      }),
    ),
    Effect.provide(layerSpawner(() => "idle\n", spawned)),
  );
});

it.effect("refuses an unmapped machine instead of recording here", () => {
  const spawned: Array<ChildProcess.StandardCommand> = [];
  return Dictation.toggleDictation(
    { action: "toggle" },
    { kind: "unknown", address: "100.93.240.118" },
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        assert.strictEqual(error._tag, "ShellToggleDictationError");
        assert.include(error.detail, "100.93.240.118");
        assert.strictEqual(spawned.length, 0);
      }),
    ),
    Effect.provide(layerSpawner(() => "", spawned)),
  );
});
