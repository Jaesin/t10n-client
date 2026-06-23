// Shared request/response types for the t10n worker. Mirrored (copied) from the
// worker's src/types.ts (see specs/06-client-library.md → "Types are shared by
// copying"). Keep these in sync as part of any schema change.

export type LangCode = 'en' | 'ja' | 'th';

export type Register = 'polite' | 'casual';

/**
 * Translation engine. `'gemini'` is the cloud primary; `'workersai'` is the open
 * Gemma model on Cloudflare's own network. Pin one via `TranslateRequest.provider`;
 * when unset the worker runs the default chain (Gemini, falling back to Workers AI).
 */
export type Provider = 'gemini' | 'workersai';

// ---- translate ----

export interface TranslateRequest {
  from: LangCode;
  to: LangCode;
  text: string;
  register?: Register;
  /**
   * Pin a single engine instead of the default Gemini→Workers AI chain. Mainly
   * to exercise the Workers AI path directly. A pinned request bypasses the
   * worker's translation cache so it always hits the chosen engine.
   */
  provider?: Provider;
}

export interface Segment {
  source: string;
  target: string;
  reading?: string;
  gloss?: string;
}

/**
 * A single syllable of a tonal-script language (currently Thai), carrying the
 * per-syllable pronunciation aids learners need. Returned in
 * `TranslateResponse.syllables` when either side of the translation is Thai;
 * the array describes the Thai text in the response (the target for en→th, the
 * source for th→en).
 */
export interface TonalSyllable {
  text: string; // the script glyph(s) for this syllable (e.g. Thai)
  romanization: string; // tone-marked romanization for this syllable
  tone: string; // 'mid' | 'low' | 'falling' | 'high' | 'rising'
  class?: string; // initial-consonant class: 'mid' | 'high' | 'low'
}

/** Thai politeness particle present in the Thai text. */
export type Particle = 'khrap' | 'kha' | 'neutral';

export interface TranslateResponse {
  from: LangCode;
  to: LangCode;
  source: string;
  text: string;
  reading?: string; // target ja
  romanization?: string; // target ja + th
  tones?: string[]; // target th
  segments: Segment[];
  // ---- Thai-side aids (present when from or to is 'th'); describe the Thai text ----
  syllables?: TonalSyllable[]; // per-syllable breakdown of the Thai text
  particle?: Particle; // polite ending particle in the Thai text
  rtgs?: string; // plain RTGS spelling (no tone marks), display-only
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
