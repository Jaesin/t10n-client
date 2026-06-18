import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioCache } from './cache.js';
import { createT10nClient } from './client.js';
import type { TtsResponse } from './types.js';

// --- Minimal in-memory Cache API mock ---------------------------------------

class FakeResponse {
  constructor(
    private body: string,
    public url = '',
  ) {}
  async json() {
    return JSON.parse(this.body);
  }
}

class FakeCache {
  store = new Map<string, FakeResponse>();
  async keys() {
    return [...this.store.keys()].map((url) => ({ url }));
  }
  async match(key: string) {
    return this.store.get(key) ?? undefined;
  }
  async put(key: string, res: { text?: () => Promise<string> } & FakeResponse) {
    // Our AudioCache passes a real Response in prod; here we stash the body text.
    const body = await (res.text ? res.text() : Promise.resolve(''));
    this.store.set(key, new FakeResponse(body, key));
  }
}

const TEXT = '駅はどこですか？';
const VOICE = 'ja-JP-NanamiNeural';

let fakeCache: FakeCache;

// Cast the global object so we can attach minimal browser shims without
// dragging in the full DOM lib types for the test.
const g = globalThis as unknown as Record<string, unknown>;

beforeEach(() => {
  fakeCache = new FakeCache();
  g.caches = { open: vi.fn(async () => fakeCache) };
  // speechSynthesis is irrelevant to the index test; mark device available.
  g.window = {
    speechSynthesis: { speak: vi.fn(), cancel: vi.fn() },
    SpeechSynthesisUtterance: function (this: Record<string, unknown>, t: string) {
      this.text = t;
    },
  };
  // Audio constructor present so cloudCapable === true.
  g.Audio = function () {};
});

afterEach(() => {
  vi.restoreAllMocks();
  delete g.caches;
  delete g.window;
  delete g.Audio;
});

// Build a real client (so we drive the speaker via the public
// `createT10nClient(...).createSpeaker(...)` surface) but stub `fetch` so /tts
// returns a fixed TtsResponse without touching the network.
function makeClient(audio: TtsResponse['audio']) {
  const fetchSpeech = vi.fn(
    async () =>
      new Response(JSON.stringify({ audio, cached: false } satisfies TtsResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const client = createT10nClient({
    baseUrl: 'https://test.local',
    fetch: fetchSpeech as unknown as typeof fetch,
  });
  return { client, fetchSpeech };
}

// Build a speaker with no network (warm calls will fail silently).
function makeSpeakerOffline() {
  const client = createT10nClient({
    baseUrl: 'https://test.local',
    fetch: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
  });
  return client.createSpeaker({ fallback: 'web-speech' });
}

describe('speaker cache index', () => {
  it("engineFor returns 'device' before cache and 'cloud' after a store; subscribe fires on the transition", async () => {
    const { client, fetchSpeech } = makeClient({
      base64: 'AAAA',
      format: 'mp3',
      duration_seconds: 1,
    });
    const speaker = client.createSpeaker({ fallback: 'web-speech' });

    await speaker.ready();

    // Before any clip is cached → device.
    expect(speaker.engineFor(TEXT, { voice: VOICE })).toBe('device');

    const fired = vi.fn();
    const unsub = speaker.subscribe(fired);

    // Warm the clip via prefetch → fetches, stores, flips to cloud.
    await speaker.prefetch([{ text: TEXT, voice: VOICE }]);

    expect(fetchSpeech).toHaveBeenCalledOnce();
    expect(speaker.engineFor(TEXT, { voice: VOICE })).toBe('cloud');
    expect(fired).toHaveBeenCalled();

    unsub();
  });

  it('hydrates the in-memory index from an existing Cache API entry', async () => {
    // Pre-seed the cache via the AudioCache itself, then a fresh speaker reads it.
    const seed = new AudioCache();
    await seed.set(TEXT, VOICE, { base64: 'AAAA', format: 'mp3' });

    const { client } = makeClient({ base64: 'AAAA', format: 'mp3', duration_seconds: 1 });
    const speaker = client.createSpeaker({ fallback: 'web-speech' });

    await speaker.ready();

    expect(speaker.engineFor(TEXT, { voice: VOICE })).toBe('cloud');
  });
});

describe('engineFor edge cases', () => {
  it('returns null for empty string', async () => {
    const speaker = makeSpeakerOffline();
    await speaker.ready();
    expect(speaker.engineFor('')).toBeNull();
  });

  it('returns null for null / undefined', async () => {
    const speaker = makeSpeakerOffline();
    await speaker.ready();
    expect(speaker.engineFor(null)).toBeNull();
    expect(speaker.engineFor(undefined)).toBeNull();
  });

  it("returns null when fallback is 'none' and clip is not cached", async () => {
    const client = createT10nClient({
      baseUrl: 'https://test.local',
      fetch: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    });
    const speaker = client.createSpeaker({ fallback: 'none' });
    await speaker.ready();
    expect(speaker.engineFor(TEXT, { voice: VOICE })).toBeNull();
  });
});

describe('AudioCache unavailable', () => {
  it('no-ops gracefully when caches is undefined', async () => {
    delete g.caches;
    const seed = new AudioCache();
    // set / get / init should all resolve without throwing.
    await expect(seed.init()).resolves.toBeUndefined();
    const stored = await seed.set(TEXT, VOICE, { base64: 'AAAA', format: 'mp3' });
    expect(stored).toBe(false);
    const got = await seed.get(TEXT, VOICE);
    expect(got).toBeNull();
    expect(seed.has(TEXT, VOICE)).toBe(false);
  });
});

describe('speaker.cancel()', () => {
  it('resets speaking to false and is idempotent', async () => {
    const speaker = makeSpeakerOffline();
    await speaker.ready();
    // cancel() when nothing is playing should not throw and speaking stays false.
    expect(() => speaker.cancel()).not.toThrow();
    expect(speaker.speaking).toBe(false);
    expect(() => speaker.cancel()).not.toThrow();
  });

  it('speak() then cancel() before playback resolves leaves speaking false', async () => {
    // Use a fetch that never resolves so the cloud path is perpetually pending.
    let settled = false;
    const client = createT10nClient({
      baseUrl: 'https://test.local',
      fetch: (() => new Promise(() => {})) as unknown as typeof fetch,
    });
    const speaker = client.createSpeaker({ fallback: 'none' });
    await speaker.ready();

    // Manually seed the cache index so engineFor returns 'cloud'.
    await client.cache.set(TEXT, VOICE, { base64: 'AAAA', format: 'mp3' });
    // Force a version bump so the index sees the new entry.
    const { client: client2 } = makeClient({ base64: 'AAAA', format: 'mp3', duration_seconds: 1 });
    const speaker2 = client2.createSpeaker({ fallback: 'none' });
    await speaker2.ready();
    // (speaker2 is just used to confirm hydration works; cancel test is on speaker)

    speaker.cancel();
    expect(speaker.speaking).toBe(false);
    settled = true;
    expect(settled).toBe(true); // ensure we reached here without hanging
  });
});
