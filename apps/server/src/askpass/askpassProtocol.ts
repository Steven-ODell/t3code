/**
 * What the askpass helper and the server's askpass socket agree on. The
 * helper runs on sudo's and ssh's critical path, so this module imports
 * nothing.
 *
 * @module askpassProtocol
 */

/** Variables T3 sets on an agent's process so its commands can reach the socket. */
export const ASKPASS_SOCKET_ENV = "T3_ASKPASS_SOCKET";
export const ASKPASS_THREAD_ENV = "T3_ASKPASS_THREAD";
export const ASKPASS_TOKEN_ENV = "T3_ASKPASS_TOKEN";

/** The one route on the socket. */
export const ASKPASS_REQUEST_PATH = "/askpass";

/** The helper's file name; the password-prompt mod looks for it in SUDO_ASKPASS. */
export const ASKPASS_HELPER_NAME = "t3-askpass";

/**
 * Programs the helper answers for, by `/proc/<pid>/comm` (15 characters at
 * most, so git's https helper reads `git-remote-http`). Anything else that
 * runs the helper directly, such as the agent's own shell, would print the
 * password into the transcript, so it is refused.
 */
export const ASKPASS_ASKERS: ReadonlySet<string> = new Set([
  "sudo",
  "ssh",
  "ssh-add",
  "ssh-keygen",
  "git",
  "git-remote-http",
]);

export interface AskpassRequestBody {
  readonly threadId: string;
  readonly token: string;
  /** The prompt sudo or ssh passes as argv[1]. */
  readonly prompt: string;
  /** The asking program's comm, one of ASKPASS_ASKERS. */
  readonly asker: string;
  /** The asking program's command line. */
  readonly command: string;
  /** What ran the asker, for ssh started by `git push`. */
  readonly caller?: string;
}
