/**
 * Sao's fork: types a chat code block into a new window of tmux session T3
 * without running it. The work lives in the `tcmd` script (Omarchy-merge
 * bin/tcmd), which waits for the shell prompt and uses a bracketed paste so a
 * multi-line command stays in the editor instead of running line by line.
 */
import { ShellTypeInTmuxError, type ShellTypeInTmuxInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export const typeInTmux = Effect.fn("TmuxTyper.typeInTmux")(function* (
  input: ShellTypeInTmuxInput,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The service's PATH may not include ~/.local/bin, so look there first.
  const local = path.join(yield* HostProcess.HomeDirectory, ".local", "bin", "tcmd");
  const tcmd = (yield* fileSystem.exists(local).pipe(Effect.orElseSucceed(() => false)))
    ? local
    : "tcmd";

  const [stdout, stderr, exitCode] = yield* spawner
    .spawn(ChildProcess.make(tcmd, ["-d", input.cwd, "--", input.command], { stdin: "ignore" }))
    .pipe(
      Effect.flatMap((handle) =>
        Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        ),
      ),
      Effect.scoped,
      Effect.timeout("10 seconds"),
      Effect.mapError((cause) => new ShellTypeInTmuxError({ detail: cause.message })),
    );
  if (exitCode !== 0) {
    return yield* new ShellTypeInTmuxError({
      detail: stderr.trim() || `tcmd exited with code ${exitCode}`,
    });
  }
  // tcmd prints "typed into T3:4 (cmd:ls), not run".
  return { target: /typed into (\S+)/.exec(stdout)?.[1] ?? "T3" };
});
