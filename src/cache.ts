// Browser audio cache backed by the Cache API (available without a service
// worker in all modern browsers). Stores the JSON audio payload
// ({ base64, format }) returned by /tts, keyed by a synthetic text+voice URL,
// so cloud clips survive reloads and offline use. This is the ONLY TTS cache
// in the system — the worker has none in v1.
//
// Ported from jerno's app/src/data/audioCache.js (the more robust of the two
// drifted copies), extended with a synchronous in-memory index of cached keys
// so `engineFor` can answer without awaiting the async Cache API.
//
// Design rules:
// - Every operation degrades gracefully: if the Cache API is unavailable
//   (e.g. Safari private mode) or any call throws, we no-op / return null.
// - Mutating helpers are fire-and-forget safe: they never throw.

import type { CachedAudio } from './types.js';

const CACHE_NAME = 't10n-audio-v1';

function cacheAvailable(): boolean {
  return typeof caches !== 'undefined' && typeof caches.open === 'function';
}

// FNV-1a 32-bit: fast, synchronous, good distribution for short strings.
// Collision probability is negligible for TTS content; this is not security-sensitive.
function fnv1a(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

// Cache API keys must be http(s) URLs. Hash the text to avoid the ~2 KB per-key
// limit in Chrome's Cache API — long passages would silently fail to cache.
export function cacheKey(text: string, voice: string): string {
  return `https://audio-cache.t10n.local/tts?voice=${encodeURIComponent(voice)}&h=${fnv1a(text)}`;
}

/**
 * The audio cache plus a synchronous in-memory index of which keys are present.
 * The index is hydrated once from the Cache API on `init()` and kept in sync on
 * every store, so callers (the speaker) can answer "is this cached?" without
 * awaiting. All async methods degrade gracefully and never throw.
 */
export class AudioCache {
  private index = new Set<string>();
  private hydrated = false;
  private hydrating: Promise<void> | null = null;

  /** True once we've read the existing keys out of the Cache API. */
  get ready(): boolean {
    return this.hydrated;
  }

  /** Synchronous presence check against the in-memory index. */
  has(text: string, voice: string): boolean {
    return this.index.has(cacheKey(text, voice));
  }

  /**
   * Hydrate the in-memory index from the Cache API. Idempotent; safe to await
   * repeatedly. Never throws.
   */
  async init(): Promise<void> {
    if (this.hydrated) return;
    if (this.hydrating) return this.hydrating;
    this.hydrating = (async () => {
      if (cacheAvailable()) {
        try {
          const cache = await caches.open(CACHE_NAME);
          const keys = await cache.keys();
          for (const req of keys) this.index.add(req.url);
        } catch {
          // Private mode / unavailable — leave the index empty.
        }
      }
      this.hydrated = true;
      this.hydrating = null;
    })();
    return this.hydrating;
  }

  /** Returns the cached { base64, format } payload, or null. Never throws. */
  async get(text: string, voice: string): Promise<CachedAudio | null> {
    if (!cacheAvailable()) return null;
    try {
      const cache = await caches.open(CACHE_NAME);
      const res = await cache.match(cacheKey(text, voice));
      if (!res) return null;
      return (await res.json()) as CachedAudio;
    } catch {
      return null;
    }
  }

  /**
   * Clears the Cache API bucket and resets the in-memory index. Never throws.
   * Useful for debugging and "reset" flows.
   */
  async clear(): Promise<void> {
    this.index.clear();
    this.hydrated = false;
    this.hydrating = null;
    if (!cacheAvailable()) return;
    try {
      await caches.delete(CACHE_NAME);
    } catch {
      // best-effort
    }
  }

  /**
   * Stores an audio payload. Updates the in-memory index on success. Returns
   * true if the store (and index update) happened. Never throws.
   */
  async set(
    text: string,
    voice: string,
    audio: { base64?: string; format?: string },
  ): Promise<boolean> {
    if (!cacheAvailable() || !audio?.base64) return false;
    try {
      const cache = await caches.open(CACHE_NAME);
      const body = JSON.stringify({
        base64: audio.base64,
        format: audio.format || 'mp3',
      });
      await cache.put(
        cacheKey(text, voice),
        new Response(body, { headers: { 'Content-Type': 'application/json' } }),
      );
      this.index.add(cacheKey(text, voice));
      return true;
    } catch {
      // Quota exceeded, private mode, etc. — skip caching, carry on.
      return false;
    }
  }
}
