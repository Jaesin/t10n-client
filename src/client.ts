// Framework-free HTTP client for the t10n worker: translate + tts.
// Holds no secrets — the app injects `getToken`, which is forwarded as a
// Bearer token. Errors surface the service's { error: { code, message } }
// envelope as a typed T10nError rejection.

import { AudioCache } from './cache.js';
import { createSpeaker, type Speaker, type SpeakerOptions } from './speaker.js';
import type {
  TranslateRequest,
  TranslateResponse,
  TtsRequest,
  TtsResponse,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://t10n.mulenex.org';

/** A typed rejection carrying the worker's error envelope + HTTP status. */
export class T10nError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'T10nError';
    this.code = code;
    this.status = status;
  }
}

export type GetToken = () => string | null | Promise<string | null>;

export interface T10nClientOptions {
  /** Worker base URL. Defaults to https://t10n.mulenex.org */
  baseUrl?: string;
  /** Returns the caller's Firebase ID token (or null when unauthenticated). */
  getToken?: GetToken;
  /** Request timeout in ms. Defaults to 10 000. Pass 0 to disable. */
  timeoutMs?: number;
  /** Override for testing; defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface T10nClient {
  readonly baseUrl: string;
  /** The shared browser audio cache (one per client). */
  readonly cache: AudioCache;
  translate(req: TranslateRequest): Promise<TranslateResponse>;
  fetchSpeech(req: TtsRequest): Promise<TtsResponse>;
  /** Create a speaker bound to this client's shared audio cache. */
  createSpeaker(options?: SpeakerOptions): Speaker;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function createT10nClient(options: T10nClientOptions = {}): T10nClient {
  const baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL);
  const getToken = options.getToken;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetch ?? globalThis.fetch;

  async function post<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (getToken) {
      const token = await getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const res = await doFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      let code = 'http_error';
      let message = `Request to ${path} failed with ${res.status}`;
      try {
        const data = (await res.json()) as { error?: { code?: string; message?: string } };
        if (data?.error) {
          code = data.error.code ?? code;
          message = data.error.message ?? message;
        }
      } catch {
        // Non-JSON error body — keep the generic message.
      }
      throw new T10nError(code, message, res.status);
    }

    return (await res.json()) as T;
  }

  const cache = new AudioCache();

  const client: T10nClient = {
    baseUrl,
    cache,
    translate(req: TranslateRequest): Promise<TranslateResponse> {
      return post<TranslateResponse>('/translate', req);
    },
    fetchSpeech(req: TtsRequest): Promise<TtsResponse> {
      return post<TtsResponse>('/tts', req);
    },
    createSpeaker(speakerOptions?: SpeakerOptions): Speaker {
      return createSpeaker(client, cache, speakerOptions);
    },
  };

  return client;
}
