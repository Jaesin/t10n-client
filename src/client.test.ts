import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createT10nClient, T10nError } from './client.js';

const g = globalThis as unknown as Record<string, unknown>;

beforeEach(() => {
  g.Audio = function () {};
});

afterEach(() => {
  vi.restoreAllMocks();
  delete g.Audio;
});

function makeClient(handler: (req: Request) => Response | Promise<Response>) {
  return createT10nClient({
    baseUrl: 'https://test.local',
    fetch: ((input: RequestInfo, init?: RequestInit) =>
      Promise.resolve(handler(new Request(input as string, init)))) as typeof fetch,
  });
}

describe('T10nError', () => {
  it('parses the worker error envelope on 4xx', async () => {
    const client = makeClient(() =>
      new Response(
        JSON.stringify({ error: { code: 'rate_limited', message: 'Too many requests' } }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(client.translate({ from: 'en', to: 'ja', text: 'hello' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof T10nError && e.code === 'rate_limited' && e.status === 429,
    );
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    const client = makeClient(() => new Response('bad gateway', { status: 502 }));
    await expect(client.translate({ from: 'en', to: 'ja', text: 'hello' })).rejects.toSatisfy(
      (e: unknown) => e instanceof T10nError && e.status === 502 && e.code === 'http_error',
    );
  });

  it('resolves on 200 and returns the parsed body', async () => {
    const payload = {
      from: 'en' as const,
      to: 'ja' as const,
      source: 'hello',
      text: 'こんにちは',
      segments: [],
      model: 'gpt-4o',
      cached: false,
    };
    const client = makeClient(() =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(client.translate({ from: 'en', to: 'ja', text: 'hello' })).resolves.toMatchObject(
      { text: 'こんにちは' },
    );
  });
});

describe('fetch timeout', () => {
  it('aborts with a TimeoutError when timeoutMs is exceeded', async () => {
    const client = createT10nClient({
      baseUrl: 'https://test.local',
      timeoutMs: 1,
      fetch: ((_input: RequestInfo, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        })) as typeof fetch,
    });
    await expect(
      client.translate({ from: 'en', to: 'ja', text: 'hello' }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('does not abort when timeoutMs is 0', async () => {
    const payload = {
      from: 'en' as const,
      to: 'ja' as const,
      source: 'hi',
      text: 'こんにちは',
      segments: [],
      model: 'gpt-4o',
      cached: false,
    };
    const client = createT10nClient({
      baseUrl: 'https://test.local',
      timeoutMs: 0,
      fetch: (async (_input: RequestInfo, _init?: RequestInit) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch,
    });
    await expect(
      client.translate({ from: 'en', to: 'ja', text: 'hi' }),
    ).resolves.toMatchObject({ text: 'こんにちは' });
  });
});
