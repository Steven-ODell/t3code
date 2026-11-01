/**
 * Sao's fork: the composer's mic button. Runs the `dictate` script
 * (Omarchy-merge bin/dictate, also bound to SUPER + D), which toggles voxtype
 * and unmutes the mic while it records. voxtype types the transcript into the
 * focused window, so the composer keeps focus while this runs.
 *
 * The click runs `dictate` on the machine it came from: a click from another
 * tailnet machine runs it there over SSH, so that machine's mic records and
 * its focused window (the T3 tab) gets the text.
 */
import * as NodeOS from "node:os";

import { ShellToggleDictationError, type ShellToggleDictationInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export type DictationTarget =
  | { readonly kind: "local" }
  | { readonly kind: "ssh"; readonly host: string }
  | { readonly kind: "unknown"; readonly address: string | undefined };

// Tailnet IPs of the other machines that open T3 from this one. Add a line per
// machine; it needs voxtype, ~/Omarchy-merge and SSH from here without a password.
const REMOTE_MACHINES: Readonly<Record<string, string>> = {
  "100.97.33.14": "omarchy-laptop",
};

const isLoopback = (address: string) => address === "::1" || address.startsWith("127.");

const ownAddresses = () =>
  new Set(
    Object.values(NodeOS.networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .map((entry) => entry.address),
  );

/**
 * Which machine clicked. `tailscale serve` connects from loopback and puts the
 * real client in X-Forwarded-For; its own entry is the last one, so that is the
 * only one trusted. The header is ignored on direct connections.
 */
export function resolveDictationTarget(input: {
  readonly socketAddress: string | undefined;
  readonly forwardedFor: string | undefined;
  readonly localAddresses?: ReadonlySet<string>;
}): DictationTarget {
  const viaProxy = input.socketAddress === undefined || isLoopback(input.socketAddress);
  const forwarded = input.forwardedFor?.split(",").at(-1)?.trim();
  const address = viaProxy ? forwarded || input.socketAddress : input.socketAddress;
  if (address === undefined || isLoopback(address)) return { kind: "local" };
  if ((input.localAddresses ?? ownAddresses()).has(address)) return { kind: "local" };
  const host = REMOTE_MACHINES[address];
  return host ? { kind: "ssh", host } : { kind: "unknown", address };
}

const run = Effect.fn("Dictation.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  timeout: Duration.Input = "5 seconds",
) {
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
      Effect.timeout(timeout),
      Effect.mapError((cause) => new ShellToggleDictationError({ detail: cause.message })),
    );
  if (exitCode !== 0) {
    return yield* new ShellToggleDictationError({
      detail: stderr.trim() || `${command} exited with code ${exitCode}`,
    });
  }
  return stdout.trim();
});

// Over non-interactive SSH there is no XDG_RUNTIME_DIR, and without it voxtype
// and wpctl can't find the user's daemon or PipeWire. ~/.local/bin isn't on
// PATH there either, so dictate is called by its repo path.
const runOn = (host: string, script: string) =>
  run(
    "ssh",
    [
      "-n",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=3",
      host,
      `export XDG_RUNTIME_DIR=/run/user/$(id -u); ${script}`,
    ],
    "10 seconds",
  );

export const toggleDictation = Effect.fn("Dictation.toggleDictation")(function* (
  input: ShellToggleDictationInput,
  target: DictationTarget = { kind: "local" },
) {
  if (target.kind === "unknown") {
    return yield* new ShellToggleDictationError({
      detail: `Dictation isn't set up for this machine (${target.address ?? "unknown address"}).`,
    });
  }
  if (target.kind === "ssh") {
    const wasRecording = (yield* runOn(target.host, "voxtype status")) === "recording";
    if (input.action === "stop" && !wasRecording) return { recording: false };
    yield* runOn(target.host, "exec ~/Omarchy-merge/bin/dictate");
    return { recording: !wasRecording };
  }

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
