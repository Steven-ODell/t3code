/**
 * Sao's fork: sends a chat file link to the phone's Downloads (`phonepush`,
 * Taildrop) or chat text to the phone's clipboard (`phoneclip`, through the
 * Claude Assist hub). Both scripts live in Omarchy-merge bin/. Text goes on
 * stdin, never as an argument: `phoneclip --pc` is a flag, so text starting
 * with "--pc" would send the PC clipboard instead.
 */
import {
  ShellSendToPhoneError,
  type ShellSendToPhoneInput,
  type ShellSendToPhoneResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** phoneclip's exit code when the hub has no phone connected. */
const PHONECLIP_NOT_CONNECTED = 3;

export const sendToPhone = Effect.fn("PhoneSender.sendToPhone")(function* (
  input: ShellSendToPhoneInput,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const script = input.kind === "file" ? "phonepush" : "phoneclip";
  // The service's PATH may not include ~/.local/bin, so look there first.
  const local = path.join(yield* HostProcess.HomeDirectory, ".local", "bin", script);
  const bin = (yield* fileSystem.exists(local).pipe(Effect.orElseSucceed(() => false)))
    ? local
    : script;

  const command =
    input.kind === "file"
      ? ChildProcess.make(bin, ["--", input.path], { stdin: "ignore" })
      : ChildProcess.make(bin, [], {
          stdin: Stream.make(new TextEncoder().encode(input.text)),
        });
  const [stdout, stderr, exitCode] = yield* spawner.spawn(command).pipe(
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
    // Taildrop of a big file can take a while; the hub answers in seconds.
    Effect.timeout(input.kind === "file" ? "120 seconds" : "15 seconds"),
    Effect.mapError((cause) => new ShellSendToPhoneError({ detail: cause.message })),
  );
  if (exitCode !== 0) {
    if (input.kind === "text" && exitCode === PHONECLIP_NOT_CONNECTED) {
      return yield* new ShellSendToPhoneError({
        detail: "Phone not connected",
        notConnected: true,
      });
    }
    return yield* new ShellSendToPhoneError({
      detail: stderr.trim() || `${script} exited with code ${exitCode}`,
    });
  }
  // phonepush prints "sent to pixel-9-pro-xl: a.txt", phoneclip
  // "sent to the phone (12 chars); ...".
  return {
    kind: input.kind,
    detail: stdout.trim() || "sent to the phone",
  } satisfies ShellSendToPhoneResult;
});
