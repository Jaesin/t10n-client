// React 19 hooks adapter over the framework-free engine.
//
// - <T10nProvider> holds ONE client + ONE speaker (shared cache index, single
//   "now playing").
// - useTranslator is built on React 19's useActionState (translation is
//   user-triggered; you cannot await in render).
// - useSpeech rides useSyncExternalStore over the speaker so `engine` is
//   reactive and flips device → cloud when a clip caches.
// - useSpeaker exposes the speaker imperatively for one-offs.

import {
  createContext,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { createT10nClient } from '../index.js';
import type { T10nClient } from '../client.js';
import type { Speaker } from '../speaker.js';
import type {
  DoneInfo,
  Engine,
  LangCode,
  Register,
  SpeakOptions,
  SpeechFallback,
  TranslateResponse,
} from '../types.js';
import type { GetToken } from '../client.js';

interface T10nContextValue {
  client: T10nClient;
  speaker: Speaker;
}

const T10nContext = createContext<T10nContextValue | null>(null);

export interface T10nProviderProps {
  baseUrl?: string;
  getToken?: GetToken;
  /** Speech fallback when no cloud clip exists. Default 'web-speech'. */
  fallback?: SpeechFallback;
  /** Optional clips to warm on mount (fire-and-forget). */
  prefetch?: Array<{ text: string; voice?: string; lang?: LangCode }>;
  children?: React.ReactNode;
}

export function T10nProvider({
  baseUrl,
  getToken,
  fallback,
  prefetch,
  children,
}: T10nProviderProps): React.ReactElement {
  const value = useMemo<T10nContextValue>(() => {
    const client = createT10nClient({ baseUrl, getToken });
    const speaker = client.createSpeaker({ fallback });
    return { client, speaker };
    // Recreate only when connection details change. getToken is expected to be
    // stable; callers should memoize it if it closes over changing state.
  }, [baseUrl, getToken, fallback]);

  // Hydrate the cache index, then warm any prefetch items.
  useEffect(() => {
    let cancelled = false;
    void value.speaker.ready().then(() => {
      if (cancelled) return;
      if (prefetch && prefetch.length) void value.speaker.prefetch(prefetch);
    });
    return () => {
      cancelled = true;
      value.speaker.cancel();
    };
  }, [value, prefetch]);

  return <T10nContext.Provider value={value}>{children}</T10nContext.Provider>;
}

function useT10nContext(): T10nContextValue {
  const ctx = useContext(T10nContext);
  if (!ctx) {
    throw new Error('useT10n hooks must be used within a <T10nProvider>.');
  }
  return ctx;
}

export function useT10nClient(): T10nClient {
  return useT10nContext().client;
}

// ---- useTranslator ----

export interface UseTranslatorOptions {
  from: LangCode;
  to: LangCode;
  register?: Register;
}

/** The form action dispatcher returned by React 19's useActionState. */
export type TranslatorAction = (formData: FormData) => void;

/** Folded action state: the latest result plus any error from the last run. */
export interface TranslatorState {
  data: TranslateResponse | null;
  error: string | null;
}

/**
 * React 19 action-based translator. Returns a clean 3-tuple
 * `[state, action, isPending]` where `state` carries both `data` and `error`.
 * Wire `action` to a `<form action={...}>` with a `name="text"` field. For an
 * imperative translate (non-form screens), use {@link useTranslate}.
 */
export function useTranslator(
  opts: UseTranslatorOptions,
): [TranslatorState, TranslatorAction, boolean] {
  const { client } = useT10nContext();
  const { from, to, register } = opts;

  const [state, action, isPending] = useActionState<TranslatorState, FormData>(
    async (_prev, formData) => {
      const text = String(formData.get('text') ?? '').trim();
      if (!text) return { data: null, error: null };
      try {
        const data = await client.translate({ from, to, text, register });
        return { data, error: null };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { data: null, error: message };
      }
    },
    { data: null, error: null },
  );

  return [state, action, isPending];
}

/**
 * Imperative translate for non-form screens. Call the returned function only
 * from async event handlers — never during render. It rejects on failure.
 */
export function useTranslate(
  opts: UseTranslatorOptions,
): (text: string) => Promise<TranslateResponse> {
  const { client } = useT10nContext();
  const { from, to, register } = opts;
  return useCallback(
    (text: string): Promise<TranslateResponse> =>
      client.translate({ from, to, text, register }),
    [client, from, to, register],
  );
}

// ---- speaker store subscription ----

function useSpeakerStore(speaker: Speaker): number {
  return useSyncExternalStore(
    useCallback((cb) => speaker.subscribe(cb), [speaker]),
    () => speaker.getSnapshot(),
    () => speaker.getSnapshot(),
  );
}

// ---- useSpeaker (imperative) ----

export interface UseSpeakerResult {
  speak: (text: string, opts?: SpeakOptions & { onDone?: (info: DoneInfo) => void }) => void;
  cancel: () => void;
  speaking: boolean;
  engineFor: (text: string | null | undefined, opts?: SpeakOptions) => Engine;
  capabilities: { cloud: boolean; device: boolean };
}

export function useSpeaker(): UseSpeakerResult {
  const { speaker } = useT10nContext();
  // Subscribe so `speaking` and engine reads re-render.
  useSpeakerStore(speaker);

  const speak = useCallback(
    (text: string, opts?: SpeakOptions & { onDone?: (info: DoneInfo) => void }) => {
      speaker.speak(text, opts);
    },
    [speaker],
  );
  const cancel = useCallback(() => speaker.cancel(), [speaker]);
  const engineFor = useCallback(
    (text: string | null | undefined, opts?: SpeakOptions) => speaker.engineFor(text, opts),
    [speaker],
  );

  return {
    speak,
    cancel,
    speaking: speaker.speaking,
    engineFor,
    capabilities: speaker.capabilities,
  };
}

// ---- useSpeech (the button's hook) ----

export interface UseSpeechOptions {
  voice?: string;
  lang?: LangCode;
  /** Speak once when `text` becomes a new truthy value. */
  autoplay?: boolean;
  /** Optional telemetry — does NOT trigger a re-render. */
  onDone?: (info: DoneInfo) => void;
}

export interface UseSpeechResult {
  engine: Engine;
  speaking: boolean;
  speak: () => void;
  cancel: () => void;
}

export function useSpeech(
  text: string | null | undefined,
  opts: UseSpeechOptions = {},
): UseSpeechResult {
  const { speaker } = useT10nContext();
  useSpeakerStore(speaker);

  const { voice, lang, autoplay, onDone } = opts;
  const speakOpts = useMemo<SpeakOptions>(() => ({ voice, lang }), [voice, lang]);

  // Keep onDone current without re-binding speak.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const engine = speaker.engineFor(text, speakOpts);

  const speak = useCallback(() => {
    if (!text) return;
    speaker.speak(text, { ...speakOpts, onDone: (info) => onDoneRef.current?.(info) });
  }, [speaker, text, speakOpts]);

  const cancel = useCallback(() => speaker.cancel(), [speaker]);

  // Autoplay: fire once per new truthy `text`.
  const lastAutoplayed = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!autoplay) {
      lastAutoplayed.current = text;
      return;
    }
    if (text && text !== lastAutoplayed.current) {
      lastAutoplayed.current = text;
      speak();
    }
  }, [autoplay, text, speak]);

  return { engine, speaking: speaker.speaking, speak, cancel };
}
