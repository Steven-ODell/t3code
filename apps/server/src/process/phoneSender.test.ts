import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as PhoneSender from "./phoneSender.ts";

const encode = (text: string) => Stream.make(new TextEncoder().encode(text));

const layerScript = (
  result: { readonly exitCode: number; readonly stdout?: string; readonly stderr?: string },
  onSpawn?: (command: ChildProcess.StandardCommand) => void,
) =>
  Layer.merge(
    NodeServices.layer,
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (ChildProcess.isStandardCommand(command)) onSpawn?.(command);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: result.stdout === undefined ? Stream.empty : encode(result.stdout),
            stderr: result.stderr === undefined ? Stream.empty : encode(result.stderr),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
  );

/** Reads what the command would have written to the child's stdin. */
const stdinText = (command: ChildProcess.StandardCommand) => {
  const stdin = command.options.stdin;
  return Stream.isStream(stdin)
    ? stdin.pipe(Stream.decodeText(), Stream.mkString)
    : Effect.succeed(`<${String(stdin)}>`);
};

it.effect("sends a file with phonepush, the path after --", () => {
  let spawned: ChildProcess.StandardCommand | undefined;
  return PhoneSender.sendToPhone({ kind: "file", path: "/tmp/-odd name.txt" }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        assert.match(spawned?.command ?? "", /phonepush$/);
        assert.deepStrictEqual(spawned?.args, ["--", "/tmp/-odd name.txt"]);
        assert.deepStrictEqual(result, {
          kind: "file",
          detail: "sent to pixel-9-pro-xl: -odd name.txt",
        });
      }),
    ),
    Effect.provide(
      layerScript({ exitCode: 0, stdout: "sent to pixel-9-pro-xl: -odd name.txt\n" }, (command) => {
        spawned = command;
      }),
    ),
  );
});

it.effect("sends text to phoneclip on stdin with no arguments", () => {
  let spawned: ChildProcess.StandardCommand | undefined;
  const text = "--pc is text here\n  indented line";
  return PhoneSender.sendToPhone({ kind: "text", text }).pipe(
    Effect.flatMap((result) =>
      Effect.gen(function* () {
        assert.match(spawned?.command ?? "", /phoneclip$/);
        assert.deepStrictEqual(spawned?.args, []);
        assert.strictEqual(yield* stdinText(spawned!), text);
        assert.strictEqual(result.kind, "text");
        assert.strictEqual(result.detail, "sent to the phone (33 chars)");
      }),
    ),
    Effect.provide(
      layerScript({ exitCode: 0, stdout: "sent to the phone (33 chars)\n" }, (command) => {
        spawned = command;
      }),
    ),
  );
});

it.effect("marks phoneclip exit 3 as not connected", () =>
  PhoneSender.sendToPhone({ kind: "text", text: "hi" }).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        assert.strictEqual(error._tag, "ShellSendToPhoneError");
        assert.strictEqual(error.notConnected, true);
        assert.strictEqual(error.detail, "Phone not connected");
      }),
    ),
    Effect.provide(
      layerScript({ exitCode: 3, stderr: "phoneclip: no phone connected; it'll copy...\n" }),
    ),
  ),
);

it.effect("fails with the script's stderr on any other exit", () =>
  PhoneSender.sendToPhone({ kind: "file", path: "/tmp/a.txt" }).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        assert.strictEqual(error.notConnected, undefined);
        assert.strictEqual(
          error.detail,
          "phonepush: pixel-9-pro-xl is offline. Open Tailscale on it and connect.",
        );
      }),
    ),
    Effect.provide(
      layerScript({
        exitCode: 1,
        stderr: "phonepush: pixel-9-pro-xl is offline. Open Tailscale on it and connect.\n",
      }),
    ),
  ),
);

it.effect("falls back to the exit code when stderr is empty", () =>
  PhoneSender.sendToPhone({ kind: "file", path: "/tmp/a.txt" }).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        assert.strictEqual(error.detail, "phonepush exited with code 2");
      }),
    ),
    Effect.provide(layerScript({ exitCode: 2 })),
  ),
);
