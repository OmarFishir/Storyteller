# Phone-in-hand preview — design (approved 2026-07-11)

**Goal (owner directive, 2026-07-04):** the current app — story engine,
conversational co-creation, the audio slice — running in the owner's hand on
their **iPhone 15 Pro Max**, iterable from there. Browser route (PWA-ish), NOT
Expo Go native, NOT the app store (explicitly delayed).

**Decisions made in brainstorm (owner-approved):**

1. **Delivery: live tunnels.** Both dev servers stay on the PC; the phone
   loads the live dev app over HTTPS tunnels. Tightest iterate-in-hand loop;
   works only while the PC runs; URLs rotate per session. Static-host deploy
   (stable installable URL) is a later step, not this slice.
2. **Gemini paid tier: flip it before the phone session** (recommended twice
   in prior reviews; audio makes every full turn ~4 Gemini calls and the free
   daily cap has cut off testing twice). Owner also sets a Google Cloud
   budget alert so spend can't silently blow past the ~$20/month dev budget.

## Verified facts this design stands on (researched 2026-07-11, not memory)

- **Expo's `--tunnel` is out.** Its shared ngrok service is degraded due to
  abuse ([expo#43335](https://github.com/expo/expo/issues/43335)); Expo
  maintainers recommend Cloudflare Tunnel / own ngrok. There is also an
  unresolved (closed-stale) TLS-cert-mismatch report on `*.exp.direct` web
  URLs. We use **cloudflared quick tunnels** for BOTH ports instead.
- **Cloudflared quick tunnels:** free, no account, random
  `https://*.trycloudflare.com` URL per run, HTTPS terminated by Cloudflare,
  no interstitial page (fetch-based API clients work directly), 200 in-flight
  request cap. **Official docs say quick tunnels "do not support SSE"** —
  community reports say SSE works in practice (likely a buffering/SLA
  disclaimer). This is the design's one plumbing risk; see the smoke test
  and fallback below.
- **iOS 18.4+ MediaRecorder supports `audio/webm;codecs=opus`**
  ([WebKit blog](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)).
  The owner's iPhone 15 Pro Max (mid-2026 iOS) is well past 18.4, so
  `lib/voice.ts`'s existing `isTypeSupported` branch picks webm/opus — the
  same container Chrome sends. **`lib/voice.ts` needs zero changes.**
  (Contingency if a real device disagrees: the code already falls back to the
  browser default — `audio/mp4`/AAC — and passes the real mime through to
  `/transcribe`; AAC is on Gemini's documented input list, `audio/mp4`
  container is documented on Google's Firebase surface but not the Gemini API
  docs' own list. One live clip verifies whichever container the phone
  actually sends.)
- **iOS autoplay policy (the top risk, confirmed):** `audio.play()` called
  outside a user-gesture call stack — exactly our fetch-`/narrate`-then-play
  flow — returns a rejected promise. Today
  [`client/lib/voiceOut.ts`](../../../client/lib/voiceOut.ts) ignores that
  rejection (`void audio.play()`), and a rejected `play()` does NOT fire
  `onerror` → `isSpeaking` hangs true with no sound. The device-voice
  fallback (`speechSynthesis.speak`) is ALSO gesture-gated on iOS and fails
  SILENTLY (no error event, `onend` never fires) → same hang.
- **The unlock mechanism (verified pattern):** iOS blesses individual media
  elements once played during a real user gesture; a blessed element may
  later be played programmatically after `src` swaps. So: ONE persistent
  `Audio` element, "unlocked" by a muted play inside any tap handler, reused
  for every narration. Note: `HTMLMediaElement.volume` is effectively
  read-only on iOS — use `.muted` for the silent unlock, never `volume = 0`.
- **getUserMedia works in Safari tabs and (since iOS 13.4) standalone PWAs**;
  no user-gesture requirement, but HTTPS is mandatory (on plain http,
  `navigator.mediaDevices` is `undefined` → our `available: false` stub →
  the mic button silently doesn't render — the original reason tunnels
  exist).
- **Expo SDK 57 Metro web has NO auto-PWA**: no manifest generation from
  `app.json`'s `web` field; a manifest would be a hand-placed
  `public/manifest.json` linked from `app/+html.tsx`. Deferred to the
  static-deploy step along with all Add-to-Home-Screen polish — rotating
  tunnel URLs give an installed icon nothing stable to point at.

## Architecture

### Tunnel topology

```
iPhone Safari ──HTTPS──> https://<rand-a>.trycloudflare.com ──> localhost:8081 (Expo dev server, web bundle + HMR websocket)
     │
     └────HTTPS──> https://<rand-b>.trycloudflare.com ──> localhost:8000 (FastAPI, holds the Gemini key)
```

- The client learns the backend tunnel URL via `EXPO_PUBLIC_API_URL` in
  `client/.env` — written fresh each session BEFORE the Expo server starts
  (Metro inlines env vars at start; ordering matters).
- CORS is already `allow_origins=["*"]` (documented dev-only stance), so the
  cross-origin trycloudflare→trycloudflare calls just work.
- The Gemini key never leaves the backend — architecture rule unchanged.

### `phone-preview.ps1` — the one-command session starter

A PowerShell script at the repo root. In order:

1. Start the backend (`uvicorn main:app`) if not already running.
2. Start `cloudflared tunnel --url http://localhost:8000`; parse the
   `https://*.trycloudflare.com` URL from its output.
3. Write `EXPO_PUBLIC_API_URL=<backend tunnel URL>` into `client/.env`
   (preserving other lines, e.g. `EXPO_PUBLIC_USE_MOCK`).
4. Start `cloudflared tunnel --url http://localhost:8081`.
5. Start the Expo dev server (`npx expo start` in `client/`).
6. Print the client tunnel URL — as text AND as a terminal QR code (via the
   pure-Python `segno` package, dev-only dep) — so the owner points the
   iPhone camera instead of typing a random subdomain.

The script is dev tooling, not product: best-effort, fail-loud, no tests
required beyond running it. Prereq it checks for and explains: `cloudflared`
installed (`winget install Cloudflare.cloudflared`).

### Security stance (this slice)

Quick-tunnel URLs are unguessable and die with the process; exposure is
PC-hours only. Accepted risk per the 2026-07-04 handoff: **no auth this
slice**. Don't post tunnel URLs anywhere public. A stable/public deployment
(later) is what requires the shared-secret header — explicitly out of scope
here.

## Client changes

### 1. `lib/voiceOut.ts` — iOS-proof narration (the real code change)

Rework the playback engine; the `VoiceOut` interface gains ONE method:

- **`unlock(): void`** — idempotent. Creates the persistent `Audio` element
  if needed and plays a tiny silent clip on it, muted, synchronously within
  the caller's gesture context; immediately pauses. First call blesses the
  element for the session; later calls no-op. On browsers that don't need
  it (desktop Chrome), it's harmless. If called OUTSIDE a gesture (some
  call sites can't guarantee one), its own `play()` rejection is swallowed —
  an unblessed call simply doesn't bless; nothing breaks.
- **One persistent `Audio` element** replaces `new Audio(url)` per
  utterance. Each narration sets `src` to the blob URL, un-mutes, plays.
  The existing generation counter / halt semantics are unchanged.
  **Placement requirement:** the element and its unlocked flag live at
  MODULE scope, not inside `getVoiceOut()`'s closure — today that factory
  builds fresh state per call, and a per-call element would lose the bless
  between Home (where the first tap happens) and Story (where narration
  plays).
- **`play()` rejection handled:** `.play().catch(...)` — if the generation
  still matches, flip `isSpeaking` false and give up on THAT utterance
  (do NOT fall back to `speechSynthesis` on an autoplay rejection — on iOS
  the fallback would silently hang; on other browsers a rejection here is
  equally a policy block). The story continues; only the sound is skipped.
  Rare once `unlock()` is wired to the gestures below.
- **Watchdog on the `speechSynthesis` fallback path** (used for `/narrate`
  failures and mock mode): if ~1.5s after `speak()` the engine reports it
  isn't speaking and the generation still matches, flip `isSpeaking` false.
  Covers iOS dropping gesture-less `speak()` calls with no event at all.
- **In passing:** revoke the blob URL on natural `onended` (the known
  bounded-leak riding minor from the audio slice review).

### 2. Wire `unlock()` into existing gestures

Call `voiceOut.unlock()` synchronously in handlers users already touch —
first touch wins, the rest no-op:

- `PushToTalk`'s press-in (alongside the existing `onActivate` →
  `voiceOut.stop()` wiring).
- Story's option-card tap (`handleChoose` entry, when invoked from a press).
- Home's "Begin the story" button (bless the session before the first scene
  ever narrates). Note the element lives in module scope, so a bless on Home
  carries into Story within the same page load.

### 3. `components/PushToTalk.tsx` — stuck-phase timeout 8s → 15s

Phone networks + `/transcribe` retries can exceed 8s; the timeout's job
(recovering from an empty clip that fires no callbacks) survives at 15s.

## What is deliberately NOT built (guard against re-scoping)

- No PWA manifest / icons / service worker / Add-to-Home-Screen polish —
  deferred to the static-deploy step (`public/manifest.json` + `+html.tsx`
  when it comes).
- No auth / shared-secret header — tunnel stance above.
- No native (Expo Go) `VoiceIn`/`VoiceOut` implementations, no EAS build, no
  app store.
- No `lib/voice.ts` changes — iOS 18.4+ records webm/opus already.
- No streamed narration / per-genre voices (Phase 4).

## Error handling

- Client behavior on tunnel death mid-session: existing error channels
  already cover it (`stream_error` status-0 "connection lost" banner for
  SSE; `/transcribe` upload failure message; `/narrate` failure → device
  voice → watchdog). No new client error UI.
- `voiceOut` terminal paths all flip `isSpeaking` false — the new rejection
  and watchdog paths join the existing stopped/ended/error/fetch-failure
  set. The UI can never hang in "speaking" again.
- Script failures (cloudflared missing, URL not parsed) fail loud with a
  plain-English message; nothing is silently skipped.

## Testing

- **TDD (jest) for all client changes** — the voiceOut rework is the heart:
  `unlock()` idempotence; persistent-element reuse across utterances
  (src swap, not new elements); `play()` rejection → `isSpeaking` false and
  no `speechSynthesis` attempt; watchdog flipping false when synthesis never
  starts, NOT firing when it does, and respecting generations (a stale
  watchdog can't kill a newer utterance); blob URL revoked on natural end;
  existing suite stays green (98 client tests today). PushToTalk timeout
  test updated to 15s. Backend: untouched (117 tests stay green).
- **Day-one SSE smoke test (before any client work):** run the backend +
  one quick tunnel, curl `/continue/stream?mock=true` through the tunnel
  from outside, confirm `scene_token` frames arrive INCREMENTALLY (not
  buffered into one lump). This validates the officially-unsupported SSE
  path. **Fallback if it fails:** free ngrok account (SSE known-good, plus
  one stable domain that kills URL rotation) — requires sending ngrok's
  `ngrok-skip-browser-warning` header on client fetches; build only if the
  smoke test forces it.
- **On-phone gut-check checklist** (doubles as the audio slice's overdue
  acceptance test; run on the paid tier):
  1. Phone OFF silent mode (the mute switch silences web audio).
  2. Open the QR'd URL in Safari; Home renders; templates load (backend
     tunnel reachable).
  3. First mic press → permission prompt → speak a premise → transcript
     lands in the premise box (first-ever real transcription-quality check).
  4. Begin story → scene streams token-by-token (SSE through tunnel, live).
  5. Scene auto-narrates in the Gemini voice (autoplay fix working; judge
     voice quality).
  6. Hold mic mid-narration → narration stops (barge-in interrupt).
  7. Speak an ordinal ("the second one") → instant pick; speak a question →
     conversational reply, streamed and narrated.
  8. ■ Stop mid-scene and mid-narration → both silence, partials kept.
  9. Watch `logs/usage.jsonl` per-call costs to sanity-check paid-tier
     spend.

## Known unknowns (handled worst-case, verified on the phone itself)

- Exact iOS `speechSynthesis` unlock semantics (conflicting community
  accounts, no Apple doc) — the watchdog makes every outcome safe.
- Quick-tunnel SSE (docs say unsupported, practice says works) — smoke test
  + ngrok fallback.
- HMR/Fast Refresh through the tunnel (undocumented) — nice-to-have; if it
  doesn't pass, a manual phone-side reload still iterates fine.
- Mic-permission persistence on iOS (re-prompts possible, especially if ever
  installed standalone) — cosmetic for a preview; note results during the
  gut-check.
