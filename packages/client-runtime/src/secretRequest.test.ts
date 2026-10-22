import {
  ASKPASS_TURN_ITEM_PREFIX,
  SecretRequestError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestAnswerInput,
  secretRequestCopy,
  secretRequestDisplay,
  secretRequestFailureMessage,
  type SecretRequestItem,
} from "./secretRequest.ts";

const item = {
  id: TurnItemId.make("turn-item:secret-request:1"),
  threadId: ThreadId.make("thread-1"),
};

describe("secretRequestDisplay", () => {
  it("shows the form only while pending and maps every answer to its outcome copy", () => {
    const display = (secretStatus: SecretRequestItem["secretStatus"]) =>
      secretRequestDisplay({ secretStatus }, "local");
    expect(display("pending")).toEqual({ kind: "pending" });
    expect(display("saved")).toEqual({
      kind: "answered",
      outcome: "saved",
      label: "Saved securely and kept private",
    });
    expect(display("declined")).toEqual({
      kind: "answered",
      outcome: "declined",
      label: "Declined",
    });
    expect(display("cancelled")).toEqual({
      kind: "answered",
      outcome: "ended",
      label: "Request ended",
    });
  });

  it("never offers the form for a request inherited from another thread", () => {
    expect(secretRequestDisplay({ secretStatus: "pending" }, "inherited")).toEqual({
      kind: "pending-elsewhere",
      label: "Waiting for an answer in the original thread",
    });
    expect(secretRequestDisplay({ secretStatus: "saved" }, "inherited")).toMatchObject({
      outcome: "saved",
    });
  });
});

describe("password prompts", () => {
  it("say the value goes to the command rather than being stored", () => {
    const prompt = { id: `${ASKPASS_TURN_ITEM_PREFIX}thread-1:1` };
    expect(secretRequestCopy(prompt).submitLabel).toBe("Send");
    expect(secretRequestCopy(prompt).privacyNote).not.toContain("Stored");
    expect(secretRequestDisplay({ ...prompt, secretStatus: "saved" }, "local")).toMatchObject({
      outcome: "saved",
      label: "Sent to the command and kept private",
    });
    expect(secretRequestCopy(item).submitLabel).toBe("Save securely");
  });

  it("send a password exactly as typed, spaces included", () => {
    const prompt = { ...item, id: TurnItemId.make(`${ASKPASS_TURN_ITEM_PREFIX}thread-1:1`) };
    expect(secretRequestAnswerInput(prompt, { type: "save", secret: " pass word " })).toEqual({
      threadId: prompt.threadId,
      turnItemId: prompt.id,
      answer: { type: "save", secret: " pass word " },
    });
    expect(secretRequestAnswerInput(prompt, { type: "save", secret: "  " })).toBeNull();
  });
});

describe("secretRequestAnswerInput", () => {
  it("refuses a blank save and trims the value the server will store", () => {
    expect(secretRequestAnswerInput(item, { type: "save", secret: "   " })).toBeNull();
    expect(secretRequestAnswerInput(item, { type: "save", secret: " whsec_1 " })).toEqual({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "save", secret: "whsec_1" },
    });
    expect(secretRequestAnswerInput(item, { type: "decline" })).toEqual({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "decline" },
    });
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes through server errors but hides anything that could echo the payload", () => {
    expect(
      secretRequestFailureMessage(new SecretRequestError({ reason: "already_answered" })),
    ).toBe("This secret request was already answered.");
    expect(secretRequestFailureMessage(new Error('Expected string, got "whsec_1"'))).toBe(
      "Could not answer the request. Try again.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe("Could not answer the request. Try again.");
  });
});
