import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as TmuxTyper from "./tmuxTyper.ts";

const encode = (text: string) => Stream.make(new TextEncoder().encode(text));

const layerTcmd = (
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

it.effect("passes the command after -- and reports the window tcmd typed into", () => {
  let args: ReadonlyArray<string> = [];
  return TmuxTyper.typeInTmux({ cwd: "/tmp", command: "-rf looks like a flag" }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        assert.deepStrictEqual(args, ["-d", "/tmp", "--", "-rf looks like a flag"]);
        assert.strictEqual(result.target, "T3:4");
      }),
    ),
    Effect.provide(
      layerTcmd({ exitCode: 0, stdout: "typed into T3:4 (cmd:-rf), not run\n" }, (command) => {
        args = command.args;
      }),
    ),
  );
});

it.effect("fails with tcmd's stderr when it refuses", () =>
  TmuxTyper.typeInTmux({ cwd: "/tmp", command: "echo hi" }).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        assert.strictEqual(error._tag, "ShellTypeInTmuxError");
        assert.strictEqual(error.detail, "tcmd: no such directory: /tmp");
      }),
    ),
    Effect.provide(layerTcmd({ exitCode: 2, stderr: "tcmd: no such directory: /tmp\n" })),
  ),
);
