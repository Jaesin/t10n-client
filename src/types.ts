// Shared request/response types for the t10n worker. Mirrored (copied) from the
// worker's src/types.ts (see specs/06-client-library.md → "Types are shared by
// copying"). Keep these in sync as part of any schema change.

export type LangCode = 'en' | 'ja' | 'th';

export type Register = 'polite' | 'casual';

// ---- translate ----

export interface TranslateRequest {
  from: LangCode;
  to: LangCode;
  text: string;
  register?: Register;
}

export interface Segment {
  source: string;
  target: string;
  reading?: string;
  gloss?: string;
}

export interface TranslateResponse {
  from: LangCode;
  to: LangCode;
  source: string;
  text: string;
  reading?: string; // target ja
  romanization?: string; // target ja + th
  tones?: string[]; // target th
  segments: Segment[];
  model: string;
  cached: boolean;
}

// ---- tts ----

export interface TtsRequest {
  text: string;
  voice?: string;
  lang?: LangCode;
}

export interface TtsResponse {
  audio: { base64: string; format: 'mp3'; duration_seconds: number };
  cached: boolean;
}

// ---- errors ----

export interface ApiError {
  error: { code: string; message: string };
}

// ---- client-lib-only types (not part of the worker contract) ----

/**
 * Which engine a `speak()` call will use *right now* (forward-looking, reactive):
 * - `'cloud'`  — an Azure clip is cached locally → instant high-quality play.
 * - `'device'` — no cloud clip yet (fetching / offline / no Azure) → speaks now via speechSynthesis.
 * - `null`     — neither available (no speechSynthesis, no Azure).
 */
export type Engine = 'cloud' | 'device' | null;

export type SpeechFallback = 'web-speech' | 'none';

export interface SpeakOptions {
  voice?: string;
  lang?: LangCode;
}

export interface DoneInfo {
  engine: 'cloud' | 'device';
  cached: boolean;
}

/** The cached audio payload stored in / read from the Cache API. */
export interface CachedAudio {
  base64: string;
  format: string;
}
