// Engine entry point — no React. Translation, TTS fetching, the browser audio
// cache, and the speech layer (cloud + web-speech fallback) as an external store.
//
// The single public factory is `createT10nClient`. The client it returns owns
// its own audio cache and exposes `createSpeaker(...)`, which binds a speaker to
// that shared cache (so all speakers from one client share a single in-memory
// index and "now playing"). `createSpeaker` remains exported as a lower-level
// helper for callers who want to manage the cache themselves.

export { createT10nClient, T10nError, DEFAULT_BASE_URL } from './client.js';
export type { T10nClient, T10nClientOptions, GetToken } from './client.js';
export { createSpeaker } from './speaker.js';
export type { Speaker, SpeakerOptions, SpeakHandle } from './speaker.js';
export { AudioCache } from './cache.js';
export type {
  LangCode,
  Register,
  Provider,
  Segment,
  TonalSyllable,
  Particle,
  TranslateRequest,
  TranslateResponse,
  TtsRequest,
  TtsResponse,
  ApiError,
  Engine,
  SpeechFallback,
  SpeakOptions,
  DoneInfo,
  CachedAudio,
} from './types.js';
