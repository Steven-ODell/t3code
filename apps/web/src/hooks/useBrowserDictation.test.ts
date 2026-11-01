import { describe, expect, it } from "vite-plus/test";

import { dictationPrefix, joinSpeechTranscript } from "./useBrowserDictation";

function speechEvent(...chunks: string[]) {
  return {
    results: chunks.map((transcript, index) => ({
      isFinal: index < chunks.length - 1,
      length: 1,
      0: { transcript },
    })),
  };
}

describe("joinSpeechTranscript", () => {
  it("joins final and interim results with single spaces", () => {
    expect(joinSpeechTranscript(speechEvent("open the", " composer  file"))).toBe(
      "open the composer file",
    );
  });

  it("returns an empty string before anything is heard", () => {
    expect(joinSpeechTranscript(speechEvent())).toBe("");
  });
});

describe("dictationPrefix", () => {
  it("adds a space only after a draft that does not end in whitespace", () => {
    expect(dictationPrefix("")).toBe("");
    expect(dictationPrefix("fix this")).toBe(" ");
    expect(dictationPrefix("fix this ")).toBe("");
    expect(dictationPrefix("fix this\n")).toBe("");
  });
});
