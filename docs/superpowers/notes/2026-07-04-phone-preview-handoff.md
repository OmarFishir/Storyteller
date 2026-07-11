# Phone-in-hand preview — handoff for the next session

**Owner directive (2026-07-04, verbatim intent):** "I want a working model on
my phone to see where we are at and to continue adjustments from there …
something like a PWA … we will delay the app store bit."

Next session: START HERE. This is the next unit of work — a brainstorm →
spec → plan cycle for getting the CURRENT app (story engine + conversational
co-creation + the audio slice) running in the owner's hand, iterable, without
any app-store step. The facts below were verified this session; don't
re-derive them, but DO verify the flagged "verify at design time" items.

## The one question to ask FIRST

**What phone does the owner have?** Still unanswered after two sessions. It
branches everything: Android Chrome behaves like desktop Chrome (mic,
MediaRecorder/webm, autoplay all familiar); iOS Safari is the strict case
(MediaRecorder emits audio/mp4 not webm; autoplay policy blocks
`audio.play()` outside a user gesture — see "known risks" below; PWA installs
via Share → Add to Home Screen with its own quirks).

## Why a PWA/browser route is the RIGHT call for this codebase (agree with the owner)

- The client is Expo WEB first — everything shipped (feed, bubbles, voice in,
  narration out) runs in a mobile BROWSER using the exact web
  implementations. `VoiceIn`/`VoiceOut` on native Expo Go are `available:
  false` stubs — so Expo Go on a phone today = text-only, mic-less, mute.
  The phone BROWSER, by contrast, gets the full experience with ZERO new
  voice code. PWA ≈ the fastest path to "the real product in my hand."
- `npx expo export --platform web` already produces a clean static bundle
  (verified green in every slice ship task). What it lacks for
  "install-to-home-screen" PWA polish: a web manifest + icons (+ optionally a
  service worker). Expo SDK 57 uses Metro web — check current Expo docs for
  the manifest story at design time (context7), don't assume the old
  webpack-era PWA support.

## The hard constraint everything hinges on: HTTPS (secure context)

`getUserMedia` (the mic) is BLOCKED by browsers on plain `http://` for any
origin except `localhost`. The phone reaching the dev PC over LAN
(`http://192.168.x.x:8081`) is NOT a secure context → **voice input will
silently be unavailable** (our `available: false` stub path — button just
doesn't render). Any phone plan must serve BOTH the client and the backend
over https (or use a trusted tunnel). Three options, in increasing
durability:

1. **Tunnels (recommended v1 — zero deploy, iterate live):**
   - Client: `npx expo start --tunnel` serves the dev app over an https
     `*.exp.direct` URL (needs `@expo/ngrok` — Expo prompts to install;
     verify current mechanics at design time).
   - Backend: a Cloudflare Tunnel (`cloudflared tunnel --url
     http://localhost:8000`, free, no account for quick tunnels) or ngrok →
     https URL; put it in `client/.env` `EXPO_PUBLIC_API_URL`.
   - Result: the owner's phone loads the live dev server, hot-reloads on
     every edit — "continue adjustments from there" with the tightest loop.
   - Catch: tunnel URLs rotate per run (quick tunnels); .env needs updating
     each session unless a named tunnel/reserved domain is set up.
2. **Static deploy of the client + tunneled backend:** export the web bundle
   to Netlify/Vercel/Cloudflare Pages (free, https, stable URL, PWA
   manifest works, installable) while the backend stays on the dev PC behind
   a tunnel. Stable app URL in the hand; backend still free.
3. **Full deploy (backend too — Fly/Render/Railway):** durable, works when
   the PC is off — but SEE SECURITY below before exposing the backend.

## Security facts the next session MUST carry into any public exposure

- CORS is wide-open (`allow_origins=["*"]`) — a documented DEV-ONLY stance
  (Phase 6 locks it down).
- There is NO auth on any endpoint. `/narrate` and `/continue` SPEND MONEY
  per call (TTS ≈ 3–8¢/scene). A publicly reachable backend URL = anyone who
  finds it can drain quota/budget. `NARRATE_CHAR_CAP`/`MAX_AUDIO_BYTES` are
  abuse armor, not access control.
- For options 1–2 (tunnel), risk is low (unguessable URL, PC-hours only) but
  real; for option 3 it's unacceptable without at least a shared-secret
  header the client sends (a 10-line dependency-free stopgap — design it in
  the brainstorm, don't ship a public unauthenticated backend).
- The Gemini key stays server-side in all options — architecture rule
  unchanged. Never bake it into the web bundle.

## Known risks that become load-bearing on a phone (from the final review's ledger)

- **iOS autoplay (TOP RISK if iPhone):** `voiceOut`'s `void audio.play()`
  rejection is unhandled (ledger minor, destination Phase 4). On iOS Safari,
  auto-narration WILL hit autoplay policy (playback outside a direct user
  gesture) → `speaking` lingers true with no sound until ■ Stop. The phone
  slice likely needs: handle `play()` rejection (flip state false + optional
  device-voice fallback), and possibly a one-time "tap to enable sound"
  unlock interaction (the standard iOS dance). Android Chrome is more
  permissive but not guaranteed.
- **MediaRecorder mime:** phone browsers may emit `audio/mp4`/`audio/aac`
  instead of webm/opus. `/transcribe` passes the client's content type
  through already, and the upload names the file `utterance.webm` regardless
  (cosmetic). Gemini's acceptance of mp4/aac audio parts is UNVERIFIED live —
  fold into the phone gut-check.
- **The owner's Chrome mic-and-ear gut-check never happened** (desktop). The
  phone preview session naturally becomes that acceptance test — first
  transcription quality check with the owner's real voice, first narration
  listen. Free-tier daily quota was EXHAUSTED on 2026-07-04; budget the
  gut-check for a fresh-quota day or flip the paid tier first (recommended
  twice already; audio doubles per-turn calls).
- `PushToTalk`'s 8s stuck-phase timeout vs slower phone networks + retries
  (ledger minor — may need ~15s or a real in-flight signal).

## What does NOT need building (avoid re-scoping into the old plan)

- No expo-speech-recognition, no EAS dev build, no Apple Developer account —
  server-side STT killed that dependency (docs/superpowers/notes/
  native-dev-build.md predates this and is now the DEFERRED path; the PWA
  route supersedes it for the preview goal).
- No app store anything (owner: explicitly delayed).
- Native Expo Go voice impls: only needed if the PWA route disappoints;
  they'd slot behind the same interfaces.

## Session-start checklist for the next chat

1. Ask the phone OS question (above).
2. Brainstorm the option choice (tunnel-live vs static-client vs full deploy)
   + PWA polish scope (manifest/icons/install) + the iOS autoplay handling if
   iPhone + the shared-secret question if anything goes public.
3. Verify at design time (context7/web, not memory): Expo SDK 57 Metro-web
   PWA/manifest story; `expo start --tunnel` current mechanics; cloudflared
   quick-tunnel current behavior; iOS Safari MediaRecorder/autoplay current
   state.
4. Then spec → plan → subagent-driven execution as usual (ledger:
   `.superpowers/sdd/progress.md`; suites at handoff: backend 117, client 98,
   all green, everything pushed at `ab843ce`).
