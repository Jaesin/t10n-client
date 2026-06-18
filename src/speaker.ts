// The speech layer: chooses between high-quality cloud audio (Azure MP3 fetched
// via /tts and cached locally) and the browser's built-in speechSynthesis.
//
// `engine` is forward-looking and reactive — it reports which engine a tap will
// use *right now*, and notifies subscribers when a clip flips device → cloud.
// The speaker exposes an external store (subscribe + a synchronous snapshot of
// the cache index version) so the React layer can ride useSyncExternalStore.

import { AudioCache } from './cache.js';
import type { T10nClient } from './client.js';
import type {
  CachedAudio,
  DoneInfo,
  Engine,
  LangCode,
  SpeakOptions,
  SpeechFallback,
} from './types.js';

const DEFAULT_VOICES: Record<LangCode, string> = {
  ja: 'ja-JP-NanamiNeural',
  th: 'th-TH-PremwadeeNeural',
  en: 'en-US-JennyNeural',
};

/** Resolve the voice for a speak/fetch call from explicit voice → lang default. */
function resolveVoice(opts?: SpeakOptions): string {
  if (opts?.voice) return opts.voice;
  if (opts?.lang && DEFAULT_VOICES[opts.lang]) return DEFAULT_VOICES[opts.lang];
  return DEFAULT_VOICES.ja;
}

function deviceSpeechAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance !== 'undefined'
  );
}

function cloudAudioAvailable(): boolean {
  return typeof Audio !== 'undefined';
}

export interface SpeakerOptions {
  /** Fallback engine when no cloud clip is available. Default 'web-speech'. */
  fallback?: SpeechFallback;
}

export interface SpeakHandle {
  cancel(): void;
}

export interface Speaker {
  /** Which engine speak() will use right now for this text. Synchronous. */
  engineFor(text: string | null | undefined, opts?: SpeakOptions): Engine;
  /** Subscribe to cache-index changes (fires when a clip flips device → cloud). */
  subscribe(listener: () => void): () => void;
  /** Synchronous snapshot — a version number that bumps on every index change. */
  getSnapshot(): number;
  /** Speak via the current engine; cancels any prior playback. */
  speak(
    text: string,
    opts?: SpeakOptions & { onDone?: (info: DoneInfo) => void },
  ): SpeakHandle;
  /** Stop the current "now playing", whichever engine. */
  cancel(): void;
  /** Warm cloud clips → flips their engine to 'cloud'. Fire-and-forget; never throws. */
  prefetch(items: Array<{ text: string; voice?: string; lang?: LangCode }>): Promise<void>;
  /** Is the speaker currently producing audio? */
  readonly speaking: boolean;
  readonly capabilities: { cloud: boolean; device: boolean };
  /** Ensure the cache index is hydrated; bumps the store when done. */
  ready(): Promise<void>;
}

export function createSpeaker(
  client: T10nClient,
  cache: AudioCache,
  options: SpeakerOptions = {},
): Speaker {
  const fallback = options.fallback ?? 'web-speech';
  const deviceCapable = fallback === 'web-speech' && deviceSpeechAvailable();
  const cloudCapable = cloudAudioAvailable();

  const listeners = new Set<() => void>();
  let version = 0;
  let speaking = false;

  // Single "now playing" per speaker.
  let currentAudio: HTMLAudioElement | null = null;
  let currentUtterance: SpeechSynthesisUtterance | null = null;
  let playToken = 0;

  function emit(): void {
    version++;
    for (const l of listeners) l();
  }

  function stopPlayback(): void {
    playToken++;
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.src = '';
      } catch {
        // ignore
      }
      currentAudio = null;
    }
    if (currentUtterance && deviceSpeechAvailable()) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
      currentUtterance = null;
    }
    if (speaking) {
      speaking = false;
      emit();
    }
  }

  function setSpeaking(value: boolean): void {
    if (speaking !== value) {
      speaking = value;
      emit();
    }
  }

  function engineFor(text: string | null | undefined, opts?: SpeakOptions): Engine {
    if (!text) return null;
    const voice = resolveVoice(opts);
    if (cloudCapable && cache.has(text, voice)) return 'cloud';
    if (deviceCapable) return 'device';
    return null;
  }

  function playCloud(
    payload: CachedAudio,
    token: number,
    onDone?: (info: DoneInfo) => void,
  ): void {
    if (token !== playToken) return;
    const format = payload.format || 'mp3';
    const audio = new Audio(`data:audio/${format};base64,${payload.base64}`);
    currentAudio = audio;
    setSpeaking(true);
    const finish = () => {
      if (token !== playToken) return;
      currentAudio = null;
      setSpeaking(false);
      onDone?.({ engine: 'cloud', cached: true });
    };
    audio.addEventListener('ended', finish, { once: true });
    audio.addEventListener('error', finish, { once: true });
    audio.play().catch(() => {
      // Autoplay policy blocked the play — surface as not-speaking so the UI
      // never shows `speaking` falsely. (No onDone: nothing actually played.)
      if (token !== playToken) return;
      currentAudio = null;
      setSpeaking(false);
    });
  }

  function playDevice(
    text: string,
    opts: SpeakOptions | undefined,
    token: number,
    onDone?: (info: DoneInfo) => void,
  ): void {
    if (token !== playToken) return;
    const utterance = new window.SpeechSynthesisUtterance(text);
    if (opts?.lang) utterance.lang = ttsLangToBcp47(opts.lang);
    currentUtterance = utterance;
    setSpeaking(true);
    const finish = () => {
      if (token !== playToken) return;
      currentUtterance = null;
      setSpeaking(false);
      onDone?.({ engine: 'device', cached: false });
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      finish();
    }
  }

  function speak(
    text: string,
    opts?: SpeakOptions & { onDone?: (info: DoneInfo) => void },
  ): SpeakHandle {
    stopPlayback();
    const token = playToken;
    const handle: SpeakHandle = {
      cancel() {
        if (token === playToken) stopPlayback();
      },
    };
    if (!text) return handle;

    const voice = resolveVoice(opts);
    const engine = engineFor(text, opts);
    const onDone = opts?.onDone;

    if (engine === 'cloud') {
      // Play the cached clip. Fetch it (sync index says present) then play.
      void cache.get(text, voice).then((payload) => {
        if (payload) {
          playCloud(payload, token, onDone);
        } else if (deviceCapable) {
          // Index claimed cloud but read failed — fall back to device.
          playDevice(text, opts, token, onDone);
        } else {
          setSpeaking(false);
        }
      });
      return handle;
    }

    if (engine === 'device') {
      // Speak immediately via the browser, and warm the cloud clip in the
      // background so the next tap upgrades to 'cloud'.
      playDevice(text, opts, token, onDone);
      void warm(text, voice);
      return handle;
    }

    // engine === null — nothing to do.
    return handle;
  }

  // Fetch a clip and store it; flips engine to 'cloud'. Never throws.
  async function warm(text: string, voice: string): Promise<void> {
    if (!cloudCapable) return;
    if (cache.has(text, voice)) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
      const res = await client.fetchSpeech({ text, voice });
      if (res?.audio?.base64) {
        const stored = await cache.set(text, voice, res.audio);
        if (stored) emit();
      }
    } catch {
      // Network blip / 4xx / offline — leave it on the device engine.
    }
  }

  async function prefetch(
    items: Array<{ text: string; voice?: string; lang?: LangCode }>,
  ): Promise<void> {
    await Promise.allSettled(items.map((item) => warm(item.text, resolveVoice(item))));
  }

  async function ready(): Promise<void> {
    const before = cache.ready;
    await cache.init();
    if (!before) emit();
  }

  return {
    engineFor,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): number {
      return version;
    },
    speak,
    cancel(): void {
      stopPlayback();
    },
    prefetch,
    get speaking(): boolean {
      return speaking;
    },
    capabilities: { cloud: cloudCapable, device: deviceCapable },
    ready,
  };
}

const BCP47: Record<LangCode, string> = { ja: 'ja-JP', th: 'th-TH', en: 'en-US' };

function ttsLangToBcp47(lang: LangCode): string {
  return BCP47[lang];
}
