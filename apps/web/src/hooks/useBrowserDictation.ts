import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "./useStableCallback";

// Sao's fork: dictation for phones. The desktop mic button runs the server
// machine's voxtype, which would record the PC from a phone. Chrome on Android
// backs the Web Speech API with Google's recognizer (the one Gboard uses), so
// touch devices transcribe in the browser instead. Needs a secure context
// (the tailnet's ts.net HTTPS address works; a bare http IP does not).

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}
interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined" || !window.isSecureContext) return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export function isBrowserDictationSupported(): boolean {
  return speechRecognitionConstructor() !== null;
}

/** Everything heard so far in one session, final and interim results joined. */
export function joinSpeechTranscript(event: SpeechRecognitionEventLike): string {
  let transcript = "";
  for (let index = 0; index < event.results.length; index += 1) {
    transcript += event.results[index]?.[0]?.transcript ?? "";
  }
  return transcript.replace(/\s+/g, " ").trim();
}

/** The separator to put between an existing draft and dictated text. */
export function dictationPrefix(draft: string): string {
  return draft.length === 0 || /\s$/.test(draft) ? "" : " ";
}

const BENIGN_ERRORS = new Set(["aborted", "no-speech"]);

/**
 * One utterance per session (`continuous` duplicates final results on
 * Android): recognition ends by itself after a pause, like tapping Gboard's
 * mic once. `onTranscript` gets the whole session's text on every update and
 * returns false when it can no longer place it (the draft was edited), which
 * stops listening.
 */
export function useBrowserDictation(options: {
  onStart: () => void;
  onTranscript: (transcript: string) => boolean;
  onError: (message: string) => void;
}) {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onStart = useStableCallback(options.onStart);
  const onTranscript = useStableCallback(options.onTranscript);
  const onError = useStableCallback(options.onError);

  const stop = useStableCallback(() => {
    recognitionRef.current?.stop();
  });

  const start = useStableCallback(() => {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition || recognitionRef.current) return;
    const recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) return;
      const transcript = joinSpeechTranscript(event);
      if (transcript.length > 0 && !onTranscript(transcript)) recognition.abort();
    };
    recognition.onerror = (event) => {
      if (BENIGN_ERRORS.has(event.error)) return;
      onError(
        event.error === "not-allowed"
          ? "Microphone access was blocked. Allow it in the browser's site settings."
          : `Speech recognition failed (${event.error}).`,
      );
    };
    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      setIsListening(false);
    };
    recognitionRef.current = recognition;
    onStart();
    try {
      recognition.start();
      setIsListening(true);
    } catch (error) {
      recognitionRef.current = null;
      onError(error instanceof Error ? error.message : "Speech recognition failed.");
    }
  });

  const toggle = useStableCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  });

  useEffect(
    () => () => {
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      recognition?.abort();
    },
    [],
  );

  return { isListening, toggle, stop };
}
