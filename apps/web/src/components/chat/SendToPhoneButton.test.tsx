import { ShellSendToPhoneError } from "@t3tools/contracts";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  SEND_TO_PHONE_RESULT_MS,
  SendToPhoneButton,
  sendToPhoneFailureMessage,
  type SendToPhoneOutcome,
} from "./SendToPhoneButton";

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: "popup",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../../state/shell", () => ({ shellEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

const input = { kind: "text", text: "echo hi" } as const;
let renderer: ReactTestRenderer;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
});
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function deferredSend() {
  const pending: Array<(outcome: SendToPhoneOutcome | null) => void> = [];
  const send = vi.fn(
    () => new Promise<SendToPhoneOutcome | null>((resolve) => pending.push(resolve)),
  );
  return { send, resolve: (outcome: SendToPhoneOutcome | null) => pending.shift()!(outcome) };
}

async function mount(send: ReturnType<typeof deferredSend>["send"]) {
  await act(() => {
    renderer = create(<SendToPhoneButton input={input} send={send} />);
  });
  const button = () => renderer.root.findByType("button");
  const click = () => act(() => button().props.onClick({ stopPropagation() {} }));
  return { button, click };
}

it("spins while sending, shows the check, then returns to idle", async () => {
  const { send, resolve } = deferredSend();
  const { button, click } = await mount(send);
  expect(button().props["data-phone-state"]).toBe("idle");
  expect(button().props["aria-label"]).toBe("Copy to phone clipboard");

  await click();
  expect(send).toHaveBeenCalledWith(input);
  expect(button().props["data-phone-state"]).toBe("sending");
  expect(button().props["aria-label"]).toBe("Sending to phone…");

  await act(async () => resolve({ ok: true, detail: "sent to the phone (7 chars)" }));
  expect(button().props["data-phone-state"]).toBe("sent");
  expect(button().props["aria-label"]).toBe("On the phone clipboard");

  await act(() => {
    vi.advanceTimersByTime(SEND_TO_PHONE_RESULT_MS);
  });
  expect(button().props["data-phone-state"]).toBe("idle");
});

it("shows the X with the error, ignores clicks until it resets, then sends again", async () => {
  const { send, resolve } = deferredSend();
  const { button, click } = await mount(send);

  await click();
  await click();
  expect(send).toHaveBeenCalledTimes(1);

  await act(async () => resolve({ ok: false, message: "Phone not connected" }));
  expect(button().props["data-phone-state"]).toBe("failed");
  expect(button().props["aria-label"]).toBe("Phone not connected");
  await click();
  expect(send).toHaveBeenCalledTimes(1);

  await act(() => {
    vi.advanceTimersByTime(SEND_TO_PHONE_RESULT_MS);
  });
  expect(button().props["data-phone-state"]).toBe("idle");
  await click();
  expect(send).toHaveBeenCalledTimes(2);
});

it("goes straight back to idle when the request is interrupted", async () => {
  const { send, resolve } = deferredSend();
  const { button, click } = await mount(send);

  await click();
  await act(async () => resolve(null));
  expect(button().props["data-phone-state"]).toBe("idle");
  await click();
  expect(send).toHaveBeenCalledTimes(2);
});

it("reads notConnected and detail off ShellSendToPhoneError", () => {
  expect(
    sendToPhoneFailureMessage(
      new ShellSendToPhoneError({ detail: "Phone not connected", notConnected: true }),
    ),
  ).toBe("Phone not connected");
  expect(
    sendToPhoneFailureMessage(new ShellSendToPhoneError({ detail: "tailscale: no such peer" })),
  ).toBe("tailscale: no such peer");
  expect(sendToPhoneFailureMessage(new Error("socket closed"))).toBe("socket closed");
});
