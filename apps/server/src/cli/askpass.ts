import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

import { runAskpassCli } from "../askpass/askpassCli.ts";

/**
 * `t3 askpass <prompt>` — the password helper sudo and ssh run in an agent's
 * commands; see askpassCli.ts. Real invocations dispatch through the bin.ts
 * fast path; this keeps the command wired for the full CLI.
 */
export const askpassCommand = Command.make("askpass", {
  prompt: Argument.String("prompt").pipe(Argument.withDefault("")),
}).pipe(
  Command.withDescription("Ask for a password in the agent's T3 thread, for sudo and ssh."),
  Command.unlisted,
  Command.withHandler(({ prompt }) => Effect.promise(() => runAskpassCli([prompt]))),
);
