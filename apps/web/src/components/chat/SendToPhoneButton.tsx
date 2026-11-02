import {
  SHELL_SEND_TO_PHONE_TEXT_MAX_LENGTH,
  type EnvironmentId,
  type ShellSendToPhoneInput,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PhoneClipIcon, PhoneDownloadIcon } from "./PhoneIcons";

// Sao's fork: buttons that send a file or text to his phone through the
// server's `phonepush` / `phoneclip` scripts (RPC shell.sendToPhone).

export type SendToPhoneOutcome =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly message: string };

/** Resolves null when the request was interrupted (no result to show). */
export type SendToPhone = (input: ShellSendToPhoneInput) => Promise<SendToPhoneOutcome | null>;

export type SendToPhoneState =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | { readonly status: "sent" }
  | { readonly status: "failed"; readonly message: string };

/** How long the check or X stays before the icon comes back. */
export const SEND_TO_PHONE_RESULT_MS = 2_500;

export function sendToPhoneFailureMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "ShellSendToPhoneError") {
      const failure = error as { notConnected?: boolean; detail?: unknown };
      if (failure.notConnected === true) return "Phone not connected";
      if (typeof failure.detail === "string" && failure.detail.length > 0) return failure.detail;
    }
  }
  return error instanceof Error ? error.message : "Could not send to the phone";
}

/** The RPC as a promise of an outcome; undefined when this client can't run host actions. */
export function useSendToPhone(
  environmentId: EnvironmentId | null,
  canOperateHost: boolean,
): SendToPhone | undefined {
  const sendToPhoneCommand = useAtomCommand(shellEnvironment.sendToPhone, {
    reportFailure: false,
  });
  return useMemo(() => {
    if (environmentId === null || !canOperateHost) return undefined;
    return async (input: ShellSendToPhoneInput) => {
      if (input.kind === "text" && input.text.length > SHELL_SEND_TO_PHONE_TEXT_MAX_LENGTH) {
        return {
          ok: false,
          message: `Too long for the phone clipboard (${input.text.length} of ${SHELL_SEND_TO_PHONE_TEXT_MAX_LENGTH} chars)`,
        };
      }
      const result = await sendToPhoneCommand({ environmentId, input });
      if (isAtomCommandInterrupted(result)) return null;
      if (result._tag === "Success") return { ok: true, detail: result.value.detail };
      console.error("[chat-markdown] send to phone failed", input.kind, result.cause);
      return { ok: false, message: sendToPhoneFailureMessage(squashAtomCommandFailure(result)) };
    };
  }, [canOperateHost, environmentId, sendToPhoneCommand]);
}

/** idle -> sending -> sent | failed -> idle after SEND_TO_PHONE_RESULT_MS. Clicks while busy are ignored. */
export function useSendToPhoneState(send: () => Promise<SendToPhoneOutcome | null>) {
  const [state, setState] = useState<SendToPhoneState>({ status: "idle" });
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const trigger = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    setState({ status: "sending" });
    const finish = (next: SendToPhoneState) => {
      if (!mountedRef.current) return;
      setState(next);
      if (next.status === "idle") {
        busyRef.current = false;
        return;
      }
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null;
        busyRef.current = false;
        setState({ status: "idle" });
      }, SEND_TO_PHONE_RESULT_MS);
    };
    send().then(
      (outcome) =>
        finish(
          outcome === null
            ? { status: "idle" }
            : outcome.ok
              ? { status: "sent" }
              : { status: "failed", message: outcome.message },
        ),
      (error: unknown) => finish({ status: "failed", message: sendToPhoneFailureMessage(error) }),
    );
  }, [send]);

  return { state, trigger };
}

const IDLE_LABEL = { file: "Send file to phone", text: "Copy to phone clipboard" } as const;
const SENT_LABEL = { file: "Sent to phone Downloads", text: "On the phone clipboard" } as const;

export function sendToPhoneLabel(kind: ShellSendToPhoneInput["kind"], state: SendToPhoneState) {
  switch (state.status) {
    case "idle":
      return IDLE_LABEL[kind];
    case "sending":
      return "Sending to phone…";
    case "sent":
      return SENT_LABEL[kind];
    case "failed":
      return state.message;
  }
}

/**
 * Phone icon button: phone-arrow for a file, phone-pencil for text. Shows a
 * spinner while sending, then a check or X. `data-phone-state` lets a hover
 * host keep it visible while it isn't idle.
 */
export function SendToPhoneButton({
  input,
  send,
  className,
}: {
  input: ShellSendToPhoneInput;
  send: SendToPhone;
  className?: string;
}) {
  const sendInput = useCallback(() => send(input), [input, send]);
  const { state, trigger } = useSendToPhoneState(sendInput);
  const label = sendToPhoneLabel(input.kind, state);
  const iconClassName = "size-3";
  const icon =
    state.status === "sending" ? (
      <LoaderCircleIcon aria-hidden className={`${iconClassName} animate-spin`} />
    ) : state.status === "sent" ? (
      <CheckIcon aria-hidden className={`${iconClassName} text-success`} />
    ) : state.status === "failed" ? (
      <XIcon aria-hidden className={`${iconClassName} text-destructive`} />
    ) : input.kind === "file" ? (
      <PhoneDownloadIcon className={iconClassName} />
    ) : (
      <PhoneClipIcon className={iconClassName} />
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            className={className}
            data-phone-state={state.status}
            aria-busy={state.status === "sending"}
            onClick={(event) => {
              event.stopPropagation();
              trigger();
            }}
            aria-label={label}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
