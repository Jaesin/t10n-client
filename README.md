# t10n-client

React 19 client for the **t10n** translation + TTS service (the private `t10n-worker`
Cloudflare Worker). A framework-free engine plus React hooks.

- **Engine** (`@mulenex/t10n-client`) — `createT10nClient` (`translate`, `fetchSpeech`) and
  `createSpeaker` (cloud/browser speech with fallback, browser audio cache). No React.
- **Hooks** (`@mulenex/t10n-client/react`) — `<T10nProvider>`, `useTranslator`,
  `useSpeech`, `useSpeaker`. React 19 (peer dependency).

`useSpeech` exposes a reactive `engine: 'cloud' | 'device' | null` so a speech button shows
which engine a tap will use, upgrading `device → cloud` as audio is cached.

Holds **no secrets** — it forwards the caller's Firebase ID token to the worker. Consumed by
the apps (jerno, thaitor, japan-2026) as a version-pinned git dependency.

> Design & API contract live in the private `t10n-worker` repo under `specs/`
> (04 = API contract, 06 = this client library).

## Status

Not built yet — see the worker repo's `specs/06-client-library.md`.
