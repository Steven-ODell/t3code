// @effect-diagnostics nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import {
  ASKPASS_HELPER_NAME,
  ASKPASS_SOCKET_ENV,
  ASKPASS_THREAD_ENV,
  ASKPASS_TOKEN_ENV,
} from "./askpassProtocol.ts";

/**
 * Routes password prompts in an agent's commands to its T3 thread.
 *
 * Agents run without a terminal, so sudo and ssh cannot ask for a password.
 * Each agent process gets SUDO_ASKPASS and SSH_ASKPASS pointing at T3's
 * askpass helper, SSH_ASKPASS_REQUIRE=force, and a `sudo` first on PATH that
 * adds `-A`. The helper reaches the server over a unix socket in the state
 * directory with a token bound to the thread, and the server shows a password
 * box in that thread (see AskpassServer.ts).
 *
 * The server provides the real implementation on Linux. The default sets
 * nothing, which is also the behavior in tests.
 */
export interface AgentAskpassShape {
  /** Variables for the thread's agent process, `PATH` holding only the directory to prepend. */
  readonly environment: (threadId: string) => Readonly<Record<string, string>> | undefined;
  /** Whether `token` is the one `environment` handed this thread. */
  readonly verify: (threadId: string, token: string) => boolean;
  /** Where the server listens, or undefined when askpass is off. */
  readonly socketPath: string | undefined;
}

export const AgentAskpass = Context.Reference<AgentAskpassShape>("t3/askpass/AgentAskpass", {
  defaultValue: () => ({
    environment: () => undefined,
    verify: () => false,
    socketPath: undefined,
  }),
});

/** Agent env with the askpass variables applied over `base`, or `base` untouched. */
export function withAskpassEnvironment(
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  if (extra === undefined) return base;
  const { PATH: binDir, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(binDir ? { PATH: base.PATH ? `${binDir}:${base.PATH}` : binDir } : {}),
  };
}

// sun_path holds 108 bytes including the terminator.
const MAX_SOCKET_PATH_BYTES = 107;

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * `sudo` for an agent's PATH. The agent has no terminal, so a sudo that would
 * prompt fails; this one adds `-A` to read the password through SUDO_ASKPASS.
 * Options that read no password (`-n`, `-S`, `-K`, `-V`) or already pick a
 * way (`-A`) run as written. Scanning stops at the command, and an option's
 * value (`-u name`, `-uname`) is skipped. The real sudo is the next one on
 * PATH, so the shim never runs itself.
 */
export const sudoShimScript = (binDir: string) => `#!/bin/sh
# T3: sudo in an agent's commands asks for its password in the thread.
self=${shellQuote(binDir)}
real=
IFS=:
for dir in $PATH; do
  [ "$dir" = "$self" ] && continue
  if [ -f "$dir/sudo" ] && [ -x "$dir/sudo" ] && ! [ "$dir/sudo" -ef "$0" ]; then
    real=$dir/sudo
    break
  fi
done
unset IFS
if [ -z "$real" ]; then
  echo "sudo: command not found" >&2
  exit 127
fi
[ -n "$SUDO_ASKPASS" ] || exec "$real" "$@"
skip=
for arg do
  if [ -n "$skip" ]; then
    skip=
    continue
  fi
  case $arg in
    --) break ;;
    --askpass | --stdin | --non-interactive | --remove-timestamp | --version | --help)
      exec "$real" "$@" ;;
    --*=*) ;;
    --chdir | --chroot | --close-from | --command-timeout | --group | --host | --other-user | --prompt | --role | --type | --user)
      skip=1 ;;
    --*) ;;
    -?*)
      rest=\${arg#-}
      while [ -n "$rest" ]; do
        flag=\${rest%"\${rest#?}"}
        rest=\${rest#?}
        case $flag in
          A | S | n | K | V) exec "$real" "$@" ;;
          C | D | R | T | U | g | h | p | r | t | u)
            [ -z "$rest" ] && skip=1
            break ;;
        esac
      done ;;
    *) break ;;
  esac
done
exec "$real" -A "$@"
`;

export const make = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "linux") return AgentAskpass.defaultValue();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const dir = path.join(stateDir, "askpass");
  const binDir = path.join(dir, "bin");
  const helperPath = path.join(dir, ASKPASS_HELPER_NAME);
  const socketPath = path.join(dir, "askpass.sock");
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    yield* Effect.logWarning("Askpass is off: the state directory path is too long for a socket.");
    return AgentAskpass.defaultValue();
  }

  const installed = yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(binDir, { recursive: true });
    yield* fileSystem.chmod(dir, 0o700);
    // Written on every start, so the helper always runs this install's CLI.
    const invocation = yield* resolveSelfInvocation();
    const command = [invocation.command, ...selfInvocationArgs(invocation, ["askpass"])]
      .map(shellQuote)
      .join(" ");
    yield* fileSystem.writeFileString(
      helperPath,
      `#!/bin/sh\n# T3: sudo -A and ssh run this for a password in an agent's commands.\nELECTRON_RUN_AS_NODE=1 exec ${command} "$@"\n`,
    );
    yield* fileSystem.chmod(helperPath, 0o700);
    const shimPath = path.join(binDir, "sudo");
    yield* fileSystem.writeFileString(shimPath, sudoShimScript(binDir));
    yield* fileSystem.chmod(shimPath, 0o700);
  }).pipe(
    Effect.as(true),
    Effect.catchCause((cause) =>
      Effect.logWarning("Askpass is off: could not install its helper.", cause).pipe(
        Effect.as(false),
      ),
    ),
  );
  if (!installed) return AgentAskpass.defaultValue();

  // Tokens only need to outlive this server: agents restart with it.
  const salt = NodeCrypto.randomBytes(32);
  const tokenFor = (threadId: string) =>
    NodeCrypto.createHmac("sha256", salt).update(threadId).digest("hex");

  return {
    environment: (threadId) => ({
      PATH: binDir,
      SUDO_ASKPASS: helperPath,
      SSH_ASKPASS: helperPath,
      SSH_ASKPASS_REQUIRE: "force",
      [ASKPASS_SOCKET_ENV]: socketPath,
      [ASKPASS_THREAD_ENV]: threadId,
      [ASKPASS_TOKEN_ENV]: tokenFor(threadId),
    }),
    verify: (threadId, token) => {
      const expected = Buffer.from(tokenFor(threadId));
      const given = Buffer.from(token);
      return given.length === expected.length && NodeCrypto.timingSafeEqual(given, expected);
    },
    socketPath,
  } satisfies AgentAskpassShape;
});

export const layer = Layer.effect(AgentAskpass, make);
