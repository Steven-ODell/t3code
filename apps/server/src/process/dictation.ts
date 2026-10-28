/**
 * Sao's fork: the composer's mic button. Runs the `dictate` script
 * (Omarchy-merge bin/dictate, also bound to SUPER + D), which toggles voxtype
 * and unmutes the mic while it records. voxtype types the transcript into the
 * focused window, so the composer keeps focus while this runs.
 */
import { ShellToggleDictationError, type ShellToggleDictationInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const run = Effect.fn("Dictation.run")(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [stdout, stderr, exitCode] = yield* spawner
    .spawn(ChildProcess.make(command, args, { stdin: "ignore" }))
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
      Effect.timeout("5 seconds"),
      Effect.mapError((cause) => new ShellToggleDictationError({ detail: cause.message })),
    );
  if (exitCode !== 0) {
    return yield* new ShellToggleDictationError({
      detail: stderr.trim() || `${command} exited with code ${exitCode}`,
    });
  }
  return stdout.trim();
});

export const toggleDictation = Effect.fn("Dictation.toggleDictation")(function* (
  input: ShellToggleDictationInput,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The server's PATH may not include ~/.local/bin, so look there first.
  const local = path.join(yield* HostProcess.HomeDirectory, ".local", "bin", "dictate");
  const dictate = (yield* fileSystem.exists(local).pipe(Effect.orElseSucceed(() => false)))
    ? local
    : "dictate";

  const wasRecording = (yield* run("voxtype", ["status"])) === "recording";
  if (input.action === "stop" && !wasRecording) return { recording: false };
  yield* run(dictate, []);
  return { recording: !wasRecording };
});
