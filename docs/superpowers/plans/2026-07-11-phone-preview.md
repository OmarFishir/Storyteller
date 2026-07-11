# Phone-in-Hand Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The current app running in the owner's iPhone 15 Pro Max Safari over HTTPS tunnels, with narration that survives iOS autoplay policy — one command to start a phone session.

**Architecture:** Two cloudflared quick tunnels (FastAPI :8000, Expo dev server :8081) driven by a `phone-preview.ps1` startup script. The one real code change: `lib/voiceOut.ts` moves to ONE module-scoped persistent `Audio` element that a new `unlock()` method "blesses" during any real tap (iOS only allows sound traceable to a user gesture, and it blesses individual elements permanently). Spec: `docs/superpowers/specs/2026-07-11-phone-preview-design.md`.

**Tech Stack:** Expo SDK 57 web (React Native 0.86), jest-expo, FastAPI backend (untouched), cloudflared, PowerShell 5.1, Python `segno` (QR).

## Global Constraints

- **Never modify** `client/lib/voice.ts` (iOS 18.4+ records webm/opus — verified, no change needed) or any backend endpoint/`main.py` code.
- Backend suite must stay green untouched: `venv\Scripts\python.exe -m pytest tests/ -v` → **117 passed**.
- Client suite baseline: **98 tests, 9 suites**, run with `cd client` then `npx jest --watchAll=false`. Type-check: `npx tsc --noEmit` (from `client/`). Every task leaves both green.
- `VoiceOut` gains EXACTLY one interface method: `unlock(): void`. No other interface changes.
- Exact constants: `SYNTH_WATCHDOG_MS = 1500` (voiceOut watchdog), `15000` ms (PushToTalk stuck-phase timeout, up from 8000).
- `phone-preview.ps1` must be Windows PowerShell 5.1-compatible: no `&&`/`||` pipeline chains, no ternary, no null-coalescing.
- Commit messages use this repo's conventional prefixes: `feat(client):`, `fix:`, `test:`, `docs:`, `chore:`.
- Tests mock the network at the `lib/fetch.ts` seam (`streamingFetch`) — never a real HTTP call from jest.

## File Structure

| File | Role |
|---|---|
| `client/lib/voiceOut.ts` (modify) | The rework: module-scoped shared element, `unlock()`, play-rejection handling, synth watchdog, ended-revoke |
| `client/lib/__tests__/voiceOut.test.ts` (modify) | Fakes updated for the shared element; new unlock/rejection/watchdog tests |
| `client/app/story.tsx` (modify) | `unlock()` on card tap + mic press |
| `client/app/__tests__/story.test.tsx` (modify) | unlock-wiring tests; fake gains `unlock` |
| `client/app/index.tsx` (modify) | `unlock()` on Begin button + premise mic |
| `client/app/__tests__/index.test.tsx` (modify) | unlock-wiring tests; new voiceOut mock |
| `client/components/PushToTalk.tsx` (modify) | timeout 8000 → 15000 |
| `client/components/__tests__/PushToTalk.test.tsx` (create) | pins the 15s timeout |
| `phone-preview.ps1` (create, repo root) | session startup script |
| `requirements.txt` (modify) | + `segno` (QR codes) |
| `CLAUDE.md` (modify) | run instructions + BUILT section |

---

### Task 1: SSE-through-tunnel smoke test (GATE — run before any code)

Cloudflare's docs say quick tunnels "do not support SSE"; community practice says they work. Prove it against OUR mock stream before building the session tooling on it. **No code changes in this task.**

**Files:** none (findings recorded in `.superpowers/sdd/progress.md`).

**Interfaces:**
- Consumes: the existing backend (`POST /continue/stream?mock=true`, needs `DEV_MOCK_ENABLED=1` in the repo-root `.env`).
- Produces: a GO/NO-GO decision for Task 7's cloudflared-based script.

- [ ] **Step 1: Ensure cloudflared is installed**

Run: `Get-Command cloudflared`
If missing: `winget install --id Cloudflare.cloudflared` (then open a fresh shell so PATH updates).
Expected: a path to `cloudflared.exe`.

- [ ] **Step 2: Confirm the mock gate is on**

Check the repo-root `.env` contains the line `DEV_MOCK_ENABLED=1` (add it if absent — it is git-ignored, dev-only).

- [ ] **Step 3: Start the backend and a quick tunnel**

In one terminal (or background process): `venv\Scripts\uvicorn.exe main:app`
In another: `cloudflared tunnel --url http://localhost:8000`
Expected: cloudflared prints a banner containing `https://<random-words>.trycloudflare.com` within ~10s. Note that URL.

- [ ] **Step 4: Stream the mock scene through the tunnel and watch the pacing**

Run (substitute the URL):

```powershell
curl.exe --% -N -s -X POST "https://<random>.trycloudflare.com/continue/stream?mock=true" -H "Content-Type: application/json" -d "{\"template_id\":\"fantasy\",\"summary\":\"x\",\"chosen_scenario\":\"y\"}"
```

(`--%` is PowerShell's stop-parsing token — without it, PS 5.1 mangles the embedded `\"` quotes before curl sees them. Substitute the real tunnel URL before running; nothing after `--%` is variable-expanded.)

Expected PASS: `event: scene_token` frames appear **gradually over several seconds** (the mock streams word-by-word with realistic pacing), ending in one `event: turn_complete`. Incremental arrival is the whole test — if the entire output appears in one lump at the end, the tunnel buffered the SSE stream and the test FAILS.

- [ ] **Step 5: Record the verdict and gate**

Append the result (PASS/FAIL, date, tunnel URL shape) to `.superpowers/sdd/progress.md`.
**If PASS:** all later tasks proceed as written.
**If FAIL:** STOP before Task 7 and escalate to the human — the spec's documented fallback is a free ngrok account (SSE known-good, one stable domain) which changes Task 7's script and adds an `ngrok-skip-browser-warning` header to client fetches; that variant must be re-planned. Tasks 2–6 are unaffected either way and may proceed.

- [ ] **Step 6: Tear down** — stop the curl, cloudflared, and uvicorn processes.

---

### Task 2: voiceOut — module-scoped shared element + `unlock()`

**Files:**
- Modify: `client/lib/voiceOut.ts` (full rework below)
- Modify: `client/lib/__tests__/voiceOut.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `VoiceOut.unlock(): void` (Task 5 wires it into screens); `__resetVoiceOutForTests(): void` exported from `voiceOut.ts` (test-only reset of module state); the module-scope invariant that ONE `Audio` element is shared across all `getVoiceOut()` instances.

Why module scope (the spec's placement requirement): iOS blesses INDIVIDUAL media elements once played during a real tap. `getVoiceOut()` builds fresh closure state per call — Home and Story each call it — so a per-closure element would lose the bless between the Home tap and Story's narration. The element and its `unlocked` flag therefore live at module top level, with a tiny exported reset so tests stay isolated.

- [ ] **Step 1: Rewrite the test file's fakes and adjust the two affected tests**

In `client/lib/__tests__/voiceOut.test.ts`, replace the `FakeAudio` class (lines 4–19) with:

```ts
class FakeAudio {
  static instances: FakeAudio[] = [];
  // Next play() returns this — set a rejected promise to simulate iOS
  // autoplay policy. Reset to resolved in beforeEach.
  static playResult: Promise<void> = Promise.resolve();
  src = "";
  muted = false;
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  playCalls: Array<{ src: string; muted: boolean }> = [];
  constructor() {
    FakeAudio.instances.push(this);
  }
  play() {
    this.paused = false;
    this.playCalls.push({ src: this.src, muted: this.muted });
    return FakeAudio.playResult;
  }
  pause() {
    this.paused = true;
  }
}
```

Replace the `mockSpeechSynthesis` object (lines 21–24) with (the `speaking` field feeds Task 4's watchdog; harmless now):

```ts
const mockSpeechSynthesis = {
  speak: jest.fn(),
  cancel: jest.fn(),
  speaking: undefined as boolean | undefined,
};
```

Update the import line to also pull the reset helper:

```ts
import { getVoiceOut, __resetVoiceOutForTests } from "../voiceOut";
```

In the top-level `beforeEach` (lines 58–63), add these lines before `installAudioGlobals()`:

```ts
    FakeAudio.playResult = Promise.resolve();
    mockSpeechSynthesis.speaking = undefined;
    __resetVoiceOutForTests();
```

Rewrite the **"a second speak() supersedes the first"** test — with a shared element there is no second instance; supersession now means the SAME element gets a new play:

```ts
  it("a second speak() supersedes the first on the same shared element", async () => {
    jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(okWav());
    const out = getVoiceOut();
    out.speak("First");
    await flush();
    await flush();
    out.speak("Second");
    await flush();
    await flush();
    expect(FakeAudio.instances).toHaveLength(1); // ONE element, reused
    expect(FakeAudio.instances[0].playCalls).toHaveLength(2);
    expect(FakeAudio.instances[0].paused).toBe(false); // second is live
  });
```

All other existing tests stay as-is (they assert instance counts of 0 or 1 and state sequences, which the rework preserves).

- [ ] **Step 2: Add the new unlock tests**

Append inside the `describe("getVoiceOut", ...)` block:

```ts
  describe("unlock()", () => {
    it("blesses the shared element with a muted silent play inside the tap", async () => {
      const out = getVoiceOut();
      out.unlock();
      expect(FakeAudio.instances).toHaveLength(1);
      const el = FakeAudio.instances[0];
      expect(el.playCalls).toEqual([
        { src: expect.stringContaining("data:audio/wav"), muted: true },
      ]);
      await flush();
      expect(el.paused).toBe(true); // parked again once the bless landed
      expect(el.muted).toBe(false); // ready for real narration
    });

    it("is idempotent — a second unlock() doesn't play again", () => {
      const out = getVoiceOut();
      out.unlock();
      out.unlock();
      expect(FakeAudio.instances[0].playCalls).toHaveLength(1);
    });

    it("swallows a no-gesture rejection and retries on the next call", async () => {
      FakeAudio.playResult = Promise.reject(new Error("NotAllowedError"));
      const out = getVoiceOut();
      out.unlock();
      await flush();
      FakeAudio.playResult = Promise.resolve();
      out.unlock(); // the failed bless didn't stick — this must try again
      expect(FakeAudio.instances[0].playCalls).toHaveLength(2);
    });

    it("no-ops without an Audio global (device-voice-only browsers)", () => {
      cleanupAudioGlobals();
      const g = globalThis as never as Record<string, unknown>;
      g.speechSynthesis = mockSpeechSynthesis;
      g.SpeechSynthesisUtterance = FakeUtterance;
      expect(() => getVoiceOut().unlock()).not.toThrow();
      installAudioGlobals(); // afterEach symmetry
    });

    it("the bless survives across getVoiceOut() instances (Home taps, Story plays)", async () => {
      getVoiceOut().unlock(); // Home's Begin button
      await flush();
      jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(okWav());
      getVoiceOut().speak("Scene one."); // Story narrates via a FRESH instance
      await flush();
      await flush();
      expect(FakeAudio.instances).toHaveLength(1); // reused, not re-minted
      expect(FakeAudio.instances[0].paused).toBe(false);
    });
  });
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run (from `client/`): `npx jest lib/__tests__/voiceOut.test.ts --watchAll=false`
Expected: FAIL — `unlock is not a function` on the new tests; the rewritten supersede test fails on `toHaveLength(1)` (current code mints two elements); `__resetVoiceOutForTests` import fails first — that's the expected compile-level failure.

- [ ] **Step 4: Rework `client/lib/voiceOut.ts`**

Replace the whole file with:

```ts
/**
 * VoiceOut — the narrator abstraction (architecture rule #3's twin; rule #2:
 * playback is ALWAYS stoppable mid-word). Primary engine: POST /narrate
 * (Gemini TTS via our backend) played through ONE persistent Audio element.
 * ANY failure downgrades to the device's built-in voice for that utterance —
 * the story is never silent because a quota ran out. Mock mode always uses
 * the device voice for narration: story + narration demo at zero cost,
 * matching the backend's own mock stance. STT (the mic, see lib/voice.ts) is
 * NEVER mocked — it always POSTs a recorded clip to the real /transcribe
 * endpoint regardless of this flag, so a mic press in mock mode still costs
 * a fraction of a cent per utterance.
 *
 * iOS Safari only allows sound that traces back to a real tap, and it
 * blesses INDIVIDUAL media elements once played during a user gesture. So:
 * one element for the whole page load, blessed by unlock() (call it
 * synchronously from any tap handler), src-swapped per utterance. The
 * element and its bless live at MODULE scope — getVoiceOut() builds fresh
 * closures per call, and a per-call element would lose the bless between
 * Home (where the first tap happens) and Story (where narration plays).
 */

import { API_URL } from "./api";
import { streamingFetch } from "./fetch";

export type VoiceOut = {
  available: boolean;
  speak: (text: string, opts?: { kind?: "scene" | "reply" }) => void;
  stop: () => void;
  /** Bless the shared audio element for iOS autoplay. Call synchronously
   * from a real tap handler. Idempotent; harmless where not needed; its own
   * play() rejection (a no-gesture call) is swallowed and simply doesn't
   * bless — the next tap retries. */
  unlock: () => void;
  onSpeakingChange: (cb: (speaking: boolean) => void) => void;
};

const USE_MOCK = process.env.EXPO_PUBLIC_USE_MOCK === "1";

// A minimal valid WAV (PCM mono, two silent samples) as a data URI — what
// unlock() plays, muted, to bless the shared element inside a tap handler.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQQAAAAAAA==";

type AudioEl = {
  src: string;
  muted: boolean;
  paused: boolean;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play: () => Promise<void> | void;
  pause: () => void;
};

type AudioGlobals = {
  Audio?: new () => AudioEl;
  speechSynthesis?: {
    speak: (u: unknown) => void;
    cancel: () => void;
    speaking?: boolean;
  };
  SpeechSynthesisUtterance?: new (text: string) => {
    onend: (() => void) | null;
    onerror: (() => void) | null;
  };
  URL?: { createObjectURL: (b: Blob) => string; revokeObjectURL: (u: string) => void };
};

// Module scope on purpose — see the header comment.
let sharedAudio: AudioEl | null = null;
let unlocked = false;

/** Test-only: forget the shared element and its bless between tests. */
export function __resetVoiceOutForTests() {
  sharedAudio = null;
  unlocked = false;
}

const UNAVAILABLE: VoiceOut = {
  available: false,
  speak: () => {},
  stop: () => {},
  unlock: () => {},
  onSpeakingChange: () => {},
};

export function getVoiceOut(): VoiceOut {
  const g = globalThis as never as AudioGlobals;
  const hasDevice = !!g.speechSynthesis && !!g.SpeechSynthesisUtterance;
  const hasAudio = !!g.Audio && !!g.URL;
  if (!hasDevice && !hasAudio) return UNAVAILABLE;

  let speakingCb: (speaking: boolean) => void = () => {};
  let speaking = false;
  let generation = 0; // bumped on every speak/stop: stale async work no-ops
  let currentUrl: string | null = null;

  const ensureAudio = (): AudioEl | null => {
    if (!hasAudio) return null;
    if (!sharedAudio) sharedAudio = new g.Audio!();
    return sharedAudio;
  };

  const setSpeaking = (s: boolean) => {
    if (speaking === s) return;
    speaking = s;
    speakingCb(s);
  };

  const halt = () => {
    generation += 1;
    sharedAudio?.pause();
    if (currentUrl && g.URL) {
      g.URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
    g.speechSynthesis?.cancel();
    setSpeaking(false);
  };

  const deviceSpeak = (text: string, gen: number) => {
    if (gen !== generation) return; // stale generation: don't touch state
    if (!hasDevice) {
      setSpeaking(false); // no fallback voice available; pipeline dies here
      return;
    }
    const utterance = new g.SpeechSynthesisUtterance!(text);
    utterance.onend = () => {
      if (gen === generation) setSpeaking(false);
    };
    utterance.onerror = utterance.onend;
    g.speechSynthesis!.speak(utterance);
  };

  return {
    available: true,
    unlock() {
      if (unlocked) return;
      const el = ensureAudio();
      if (!el) return;
      unlocked = true;
      el.muted = true;
      el.src = SILENT_WAV;
      Promise.resolve(el.play()).then(
        () => {
          // Don't pause a real narration that started while this resolved.
          if (el.src === SILENT_WAV) {
            el.pause();
            el.muted = false;
          }
        },
        () => {
          // No gesture context: nothing was blessed. Swallowed on purpose —
          // the next tap's unlock() retries.
          unlocked = false;
          if (el.src === SILENT_WAV) el.muted = false;
        }
      );
    },
    speak(text, opts) {
      halt(); // one voice at a time
      const gen = generation;
      // "Speaking" means the narration PIPELINE is active, not that audio is
      // physically playing yet — flipped true here, synchronously, so the
      // "■ Stop" control stays reachable through the multi-second /narrate
      // fetch instead of only appearing once playback starts.
      setSpeaking(true);
      if (USE_MOCK || !hasAudio) {
        deviceSpeak(text, gen);
        return;
      }
      streamingFetch(`${API_URL}/narrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, kind: opts?.kind ?? "scene" }),
      })
        .then(async (res) => {
          if (gen !== generation) return; // stopped/superseded while in flight
          if (!res.ok) {
            deviceSpeak(text, gen); // quota/failure -> never silent
            return;
          }
          const blob = await res.blob();
          if (gen !== generation) return;
          const audio = ensureAudio()!; // hasAudio guaranteed on this path
          currentUrl = g.URL!.createObjectURL(blob);
          audio.muted = false;
          audio.src = currentUrl;
          audio.onended = () => {
            if (gen === generation) setSpeaking(false);
          };
          audio.onerror = () => {
            if (gen === generation) deviceSpeak(text, gen);
          };
          void audio.play();
        })
        .catch(() => {
          if (gen === generation) deviceSpeak(text, gen);
        });
    },
    stop: halt,
    onSpeakingChange(cb) {
      speakingCb = cb;
    },
  };
}
```

(Note: `void audio.play()` is still unhandled here — Task 3 fixes it. This task is only the shared element + unlock.)

- [ ] **Step 5: Run the voiceOut suite**

Run: `npx jest lib/__tests__/voiceOut.test.ts --watchAll=false`
Expected: PASS (12 tests: 7 existing/adjusted + 5 new).

- [ ] **Step 6: Run the full client suite + type-check** (story.test.tsx's fake lacks `unlock` but nothing calls it yet — must stay green)

Run: `npx jest --watchAll=false` then `npx tsc --noEmit`
Expected: all suites pass; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add client/lib/voiceOut.ts client/lib/__tests__/voiceOut.test.ts
git commit -m "feat(client): voiceOut shares one module-scoped audio element + unlock() for the iOS autoplay bless"
```

---

### Task 3: voiceOut — handle `play()` rejection + revoke blob URL on natural end

**Files:**
- Modify: `client/lib/voiceOut.ts` (two small edits to Task 2's file)
- Modify: `client/lib/__tests__/voiceOut.test.ts`

**Interfaces:**
- Consumes: Task 2's file exactly as written (the edits below quote it verbatim).
- Produces: the guarantee Story relies on — `isSpeaking` can never hang true after an autoplay block.

- [ ] **Step 1: Write the failing tests** (append inside `describe("getVoiceOut", ...)`)

```ts
  it("an autoplay-blocked play() flips speaking false and does NOT fall back", async () => {
    jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(okWav());
    FakeAudio.playResult = Promise.reject(new Error("NotAllowedError"));
    const out = getVoiceOut();
    const states: boolean[] = [];
    out.onSpeakingChange((s) => states.push(s));
    out.speak("Blocked narration");
    await flush();
    await flush();
    await flush();
    expect(states).toEqual([true, false]); // the UI never hangs in "speaking"
    // On iOS the device voice is equally gesture-gated and fails SILENTLY —
    // falling back would hang forever, so it must not be attempted.
    expect(mockSpeechSynthesis.speak).not.toHaveBeenCalled();
  });

  it("revokes the blob URL when playback ends naturally (leak fix)", async () => {
    jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(okWav());
    const out = getVoiceOut();
    out.speak("Short scene.");
    await flush();
    await flush();
    FakeAudio.instances[0].onended?.();
    const g = globalThis as never as { URL: { revokeObjectURL: jest.Mock } };
    expect(g.URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest lib/__tests__/voiceOut.test.ts --watchAll=false`
Expected: FAIL — the rejection test times out or sees `states` `[true]` (rejection ignored today); the revoke test sees `revokeObjectURL` not called.

- [ ] **Step 3: Implement — two edits in `client/lib/voiceOut.ts`**

Edit 1 — replace the `onended` handler:

```ts
          audio.onended = () => {
            if (gen === generation) setSpeaking(false);
          };
```

with:

```ts
          audio.onended = () => {
            if (gen !== generation) return;
            // Natural end: free the blob URL (previously a bounded leak —
            // only stop()/supersede ever revoked it).
            if (currentUrl && g.URL) {
              g.URL.revokeObjectURL(currentUrl);
              currentUrl = null;
            }
            setSpeaking(false);
          };
```

Edit 2 — replace:

```ts
          void audio.play();
```

with:

```ts
          Promise.resolve(audio.play()).catch(() => {
            // Autoplay policy block: no tap traces to this play(). Do NOT
            // fall back to the device voice — on iOS it's equally
            // gesture-gated and fails SILENTLY, which would hang "speaking"
            // forever. This utterance goes unspoken; the story continues.
            if (gen === generation) setSpeaking(false);
          });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest lib/__tests__/voiceOut.test.ts --watchAll=false` → PASS (14 tests).
Then the full check: `npx jest --watchAll=false` and `npx tsc --noEmit` → green/clean.

- [ ] **Step 5: Commit**

```bash
git add client/lib/voiceOut.ts client/lib/__tests__/voiceOut.test.ts
git commit -m "fix(client): narration play() rejection flips speaking false; blob URL revoked on natural end"
```

---

### Task 4: voiceOut — watchdog on the speechSynthesis fallback

iOS drops a gesture-less `speechSynthesis.speak()` with NO event at all (`onend`/`onerror` never fire) — the fallback path can hang `isSpeaking` exactly like the `play()` rejection did. A short watchdog checks whether the engine actually started.

**Files:**
- Modify: `client/lib/voiceOut.ts` (one constant + one function edit)
- Modify: `client/lib/__tests__/voiceOut.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3's file as written; the test fakes' `mockSpeechSynthesis.speaking` field added in Task 2.
- Produces: the last piece of the "isSpeaking can never hang" guarantee.

- [ ] **Step 1: Write the failing tests** (append inside `describe("getVoiceOut", ...)`; these use fake timers, hence their own describe with setup)

```ts
  describe("speechSynthesis watchdog", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    const failNarrate = () =>
      jest
        .spyOn(require("../fetch"), "streamingFetch")
        .mockResolvedValue({ ok: false, status: 429, json: () => Promise.resolve({}) } as never);

    it("flips speaking false when the engine never starts (iOS silent drop)", async () => {
      failNarrate();
      mockSpeechSynthesis.speaking = false;
      const out = getVoiceOut();
      const states: boolean[] = [];
      out.onSpeakingChange((s) => states.push(s));
      out.speak("Dropped utterance");
      await jest.advanceTimersByTimeAsync(0); // let the failed fetch resolve
      await jest.advanceTimersByTimeAsync(0);
      expect(mockSpeechSynthesis.speak).toHaveBeenCalled(); // fallback attempted
      await jest.advanceTimersByTimeAsync(1500);
      expect(states).toEqual([true, false]);
    });

    it("does not fire while the engine IS speaking", async () => {
      failNarrate();
      mockSpeechSynthesis.speaking = true;
      const out = getVoiceOut();
      const states: boolean[] = [];
      out.onSpeakingChange((s) => states.push(s));
      out.speak("Long device narration");
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1500);
      expect(states).toEqual([true]); // still narrating, untouched
    });

    it("an engine without a .speaking property is left alone", async () => {
      failNarrate();
      mockSpeechSynthesis.speaking = undefined; // older stub engines
      const out = getVoiceOut();
      const states: boolean[] = [];
      out.onSpeakingChange((s) => states.push(s));
      out.speak("Unknown engine");
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1500);
      expect(states).toEqual([true]); // only an explicit false may flip it
    });

    it("a stale watchdog can't kill a newer utterance", async () => {
      failNarrate();
      mockSpeechSynthesis.speaking = true; // engine looks healthy for both
      const out = getVoiceOut();
      const states: boolean[] = [];
      out.onSpeakingChange((s) => states.push(s));
      out.speak("First");
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(700);
      out.speak("Second"); // bumps the generation; halt() → false, then true
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(0);
      mockSpeechSynthesis.speaking = false; // even if the engine went quiet...
      await jest.advanceTimersByTimeAsync(800); // ...First's watchdog fires now
      expect(states).toEqual([true, false, true]); // and must not touch Second
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest lib/__tests__/voiceOut.test.ts --watchAll=false`
Expected: FAIL — "flips speaking false" sees `states` `[true]` (no watchdog exists).

- [ ] **Step 3: Implement — two edits in `client/lib/voiceOut.ts`**

Edit 1 — add below the `SILENT_WAV` constant:

```ts
// How long the device-voice fallback waits before checking the engine
// actually started — iOS drops a gesture-less speechSynthesis.speak() with
// NO event at all.
const SYNTH_WATCHDOG_MS = 1500;
```

Edit 2 — replace the whole `deviceSpeak` function:

```ts
  const deviceSpeak = (text: string, gen: number) => {
    if (gen !== generation) return; // stale generation: don't touch state
    if (!hasDevice) {
      setSpeaking(false); // no fallback voice available; pipeline dies here
      return;
    }
    const utterance = new g.SpeechSynthesisUtterance!(text);
    utterance.onend = () => {
      if (gen === generation) setSpeaking(false);
    };
    utterance.onerror = utterance.onend;
    g.speechSynthesis!.speak(utterance);
  };
```

with:

```ts
  const deviceSpeak = (text: string, gen: number) => {
    if (gen !== generation) return; // stale generation: don't touch state
    if (!hasDevice) {
      setSpeaking(false); // no fallback voice available; pipeline dies here
      return;
    }
    const utterance = new g.SpeechSynthesisUtterance!(text);
    let settled = false;
    utterance.onend = () => {
      settled = true;
      if (gen === generation) setSpeaking(false);
    };
    utterance.onerror = utterance.onend;
    g.speechSynthesis!.speak(utterance);
    // iOS drops a gesture-less speak() with NO event at all. If the engine
    // explicitly reports it is not speaking shortly after, flip the pipeline
    // off so the UI can't hang in "speaking". Only an explicit false counts —
    // an engine without a .speaking property gets the benefit of the doubt.
    setTimeout(() => {
      if (settled || gen !== generation) return;
      if (g.speechSynthesis!.speaking === false) setSpeaking(false);
    }, SYNTH_WATCHDOG_MS);
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest lib/__tests__/voiceOut.test.ts --watchAll=false` → PASS (18 tests).
Then: `npx jest --watchAll=false` and `npx tsc --noEmit` → green/clean.

- [ ] **Step 5: Commit**

```bash
git add client/lib/voiceOut.ts client/lib/__tests__/voiceOut.test.ts
git commit -m "fix(client): watchdog flips speaking false when iOS silently drops the device-voice fallback"
```

---

### Task 5: Wire `unlock()` into Story and Home gestures

`unlock()` must run SYNCHRONOUSLY inside a real tap handler. Four wiring points: Story's option-card tap, Story's mic press, Home's Begin button, Home's premise mic. (Story's `handleChoose` is also reached from `/converse` route frames — no gesture there — so unlock goes on the Pressable, not inside `handleChoose`.)

**Files:**
- Modify: `client/app/story.tsx`
- Modify: `client/app/__tests__/story.test.tsx`
- Modify: `client/app/index.tsx`
- Modify: `client/app/__tests__/index.test.tsx`

**Interfaces:**
- Consumes: `VoiceOut.unlock(): void` from Task 2.
- Produces: nothing downstream; this completes the iOS narration feature.

- [ ] **Step 1: Extend the story test fake and write the failing Story tests**

In `client/app/__tests__/story.test.tsx`, add `unlock: jest.fn(),` to `mockVoiceOutFake` (the object at lines 31–36) and `mockVoiceOutFake.unlock.mockClear();` to the file's `beforeEach`. Then append inside the main `describe("Story", ...)` block, matching the file's existing render/press idioms (see its other push-to-talk tests for the exact helpers in use):

```tsx
  it("tapping an option card blesses audio for iOS before the turn runs", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValue(happyTurn());
    render(<Story />);
    await screen.findByText("Force the iron door open now");
    mockVoiceOutFake.unlock.mockClear();
    jest.spyOn(api, "streamTurn").mockReturnValue(happyTurn());
    fireEvent.press(screen.getByText("Force the iron door open now"));
    expect(mockVoiceOutFake.unlock).toHaveBeenCalled();
  });

  it("pressing the mic blesses audio for iOS", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValue(happyTurn());
    render(<Story />);
    await screen.findByText("Force the iron door open now");
    mockVoiceOutFake.unlock.mockClear();
    fireEvent(screen.getByTestId("ptt-button"), "pressIn");
    expect(mockVoiceOutFake.unlock).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Write the failing Home tests**

In `client/app/__tests__/index.test.tsx`, add near the top (after the existing mocks, following the same `mock`-prefix hoisting convention the file already uses):

```tsx
const mockVoiceOutFake = {
  available: true,
  speak: jest.fn(),
  stop: jest.fn(),
  unlock: jest.fn(),
  onSpeakingChange: jest.fn(),
};
jest.mock("../../lib/voiceOut", () => ({
  getVoiceOut: () => mockVoiceOutFake,
}));
```

and a new `beforeEach` inside the `describe("Home", ...)` block:

```tsx
  beforeEach(() => {
    mockVoiceOutFake.unlock.mockClear();
  });
```

Then append two tests (they mirror the file's existing "passes the chosen length to the story route" and "mic fills the premise input" setups exactly — destructured render helpers + `waitFor`, the file's idiom):

```tsx
  it("Begin the story blesses audio for iOS (the session's first tap)", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByPlaceholderText } = render(<Home />);
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));
    fireEvent.changeText(getByPlaceholderText(/premise/i), "a premise");
    fireEvent.press(getByText(/begin the story/i));
    expect(mockVoiceOutFake.unlock).toHaveBeenCalled();
  });

  it("pressing the premise mic blesses audio for iOS", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByTestId } = render(<Home />);
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));
    fireEvent(getByTestId("premise-mic"), "pressIn");
    expect(mockVoiceOutFake.unlock).toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run to verify all four fail**

Run: `npx jest app/__tests__ --watchAll=false`
Expected: FAIL — `unlock` never called in all four.

- [ ] **Step 4: Implement the wiring**

In `client/app/story.tsx`:

The card Pressable (currently `onPress={() => handleChoose(option)}`):

```tsx
                <Pressable
                  key={option}
                  onPress={() => {
                    voiceOut.unlock(); // a real tap: bless iOS audio before narration needs it
                    handleChoose(option);
                  }}
                  style={styles.card}
                >
```

The PushToTalk element (currently `onActivate={() => voiceOut.stop()}`):

```tsx
        <PushToTalk
          onActivate={() => {
            voiceOut.unlock(); // a real tap: bless iOS audio
            voiceOut.stop();
          }}
          disabled={isStreaming}
          onUtterance={handleUtterance}
        />
```

In `client/app/index.tsx`, add the import:

```tsx
import { getVoiceOut } from "../lib/voiceOut";
```

extend `beginStory`:

```tsx
  const beginStory = () => {
    if (!selected || !canBegin) return;
    // A real tap: bless iOS audio now so the opening scene can auto-narrate.
    getVoiceOut().unlock();
    router.push({
      pathname: "/story",
      params: { templateId: selected.id, premise, length },
    });
  };
```

and give the premise mic an `onActivate`:

```tsx
            <PushToTalk
              testID="premise-mic"
              compact
              onUtterance={setPremise}
              onActivate={() => getVoiceOut().unlock()}
            />
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest --watchAll=false` then `npx tsc --noEmit`
Expected: all suites pass (113 tests total at this point: 98 baseline + 11 new voiceOut + these 4); tsc clean.

- [ ] **Step 6: Commit**

```bash
git add client/app/story.tsx client/app/index.tsx client/app/__tests__/story.test.tsx client/app/__tests__/index.test.tsx
git commit -m "feat(client): every real tap unlocks iOS audio - cards, mics, and Begin bless the shared element"
```

---

### Task 6: PushToTalk stuck-phase timeout 8s → 15s

Phone networks plus `/transcribe`'s server-side retries (up to ~7s of backoff alone) can exceed 8 seconds; the timeout's only job is recovering from an EMPTY clip (which fires no callbacks), so it can afford to be lazy.

**Files:**
- Create: `client/components/__tests__/PushToTalk.test.tsx`
- Modify: `client/components/PushToTalk.tsx:85`

**Interfaces:**
- Consumes: nothing from other tasks (independent of Tasks 2–5).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Create `client/components/__tests__/PushToTalk.test.tsx`:

```tsx
import { render, screen, fireEvent, act } from "@testing-library/react-native";
import { PushToTalk } from "../PushToTalk";

// mock-prefixed for jest.mock hoisting (same convention as the app tests)
const mockVoiceFake = {
  available: true,
  start: jest.fn(),
  stop: jest.fn(),
  abort: jest.fn(),
};
jest.mock("../../lib/voice", () => ({
  getVoiceIn: () => mockVoiceFake,
}));

describe("PushToTalk stuck-phase timeout", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("holds 'transcribing' past 8s (slow phone networks) but recovers by 15s", () => {
    render(<PushToTalk onUtterance={jest.fn()} />);
    fireEvent(screen.getByTestId("ptt-button"), "pressIn");
    fireEvent(screen.getByTestId("ptt-button"), "pressOut");
    act(() => {
      jest.advanceTimersByTime(8000);
    });
    // 8s was too eager for a phone network + server-side retries.
    expect(screen.getByText("…")).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(7000);
    });
    // The empty-clip guard still recovers, just later.
    expect(screen.queryByText("…")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest components/__tests__/PushToTalk.test.tsx --watchAll=false`
Expected: FAIL — at 8000ms the "…" is already gone (current timeout fires exactly then).

- [ ] **Step 3: Implement**

In `client/components/PushToTalk.tsx`, change line 85 from:

```tsx
    phaseTimeout.current = setTimeout(() => setPhase("idle"), 8000);
```

to:

```tsx
    // 15s, not 8: phone networks + /transcribe's server-side retries (up to
    // ~7s of backoff) can legitimately take that long before a callback.
    phaseTimeout.current = setTimeout(() => setPhase("idle"), 15000);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --watchAll=false` then `npx tsc --noEmit`
Expected: all suites pass (10 suites now, 114 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add client/components/PushToTalk.tsx client/components/__tests__/PushToTalk.test.tsx
git commit -m "fix(client): PushToTalk stuck-phase timeout 8s -> 15s for phone networks"
```

---

### Task 7: `phone-preview.ps1` + segno + run docs

Dev tooling, not product: best-effort, fail-loud, no jest/pytest coverage — verification is running it. **Prereq: Task 1 passed** (cloudflared SSE verdict recorded as PASS).

**Files:**
- Create: `phone-preview.ps1` (repo root)
- Modify: `requirements.txt` (append `segno`)
- Modify: `CLAUDE.md` ("Environment / how to run" section)

**Interfaces:**
- Consumes: the backend on :8000, the Expo dev server on :8081, `client/.env`'s `EXPO_PUBLIC_API_URL` key (Metro inlines it at start — the script MUST write it before starting Expo).
- Produces: the owner's one-command phone session.

- [ ] **Step 1: Add the QR dependency**

Append `segno` on its own line to `requirements.txt`, then run:

```powershell
venv\Scripts\pip.exe install segno
```

Expected: `Successfully installed segno-...`.

- [ ] **Step 2: Create `phone-preview.ps1`**

```powershell
# phone-preview.ps1 -- one-command phone-in-hand preview session.
# Starts the backend + two cloudflared quick tunnels + the Expo dev server,
# writes the (rotating) backend tunnel URL into client/.env BEFORE Expo
# starts (Metro inlines env vars at startup), and prints the phone URL as a
# terminal QR code. Ctrl+C in this window ends the session; spawned
# processes are cleaned up best-effort on exit.
#
# Prereq: cloudflared        winget install --id Cloudflare.cloudflared
# Mock vs real Gemini: this script does NOT touch EXPO_PUBLIC_USE_MOCK --
# set it in client/.env yourself (0/absent = real Gemini for the gut-check).

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function Fail($msg) {
    Write-Host "ERROR: $msg" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Fail "cloudflared not found. Install: winget install --id Cloudflare.cloudflared (then open a fresh shell)"
}

$spawned = @()

function Start-Tunnel($port) {
    $log = Join-Path $env:TEMP "cloudflared-$port.log"
    if (Test-Path $log) { Remove-Item $log -Force }
    $p = Start-Process cloudflared -ArgumentList "tunnel", "--url", "http://localhost:$port" `
        -RedirectStandardError $log -PassThru -WindowStyle Hidden
    $script:spawned += $p
    # cloudflared prints the quick-tunnel URL to stderr within a few seconds
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $log) {
            $m = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" |
                Select-Object -First 1
            if ($m) { return $m.Matches[0].Value }
        }
        Start-Sleep -Milliseconds 500
    }
    Fail "Tunnel for port $port never printed a trycloudflare.com URL (see $log)"
}

try {
    # 1. Backend (skip if something already listens on :8000)
    $backendUp = Test-NetConnection -ComputerName localhost -Port 8000 `
        -InformationLevel Quiet -WarningAction SilentlyContinue
    if (-not $backendUp) {
        Write-Host "Starting backend on :8000..."
        $p = Start-Process (Join-Path $root "venv\Scripts\uvicorn.exe") `
            -ArgumentList "main:app" -WorkingDirectory $root -PassThru
        $script:spawned += $p
        Start-Sleep -Seconds 3
    }
    else {
        Write-Host "Backend already running on :8000"
    }

    # 2. Tunnel the backend; wire the client to it BEFORE Expo starts
    Write-Host "Tunneling the backend..."
    $backendUrl = Start-Tunnel 8000
    $envPath = Join-Path $root "client\.env"
    $lines = @()
    if (Test-Path $envPath) {
        $lines = @(Get-Content $envPath | Where-Object { $_ -notmatch "^EXPO_PUBLIC_API_URL=" })
    }
    $lines = @("EXPO_PUBLIC_API_URL=$backendUrl") + $lines
    Set-Content -Path $envPath -Value $lines -Encoding ascii
    Write-Host "client/.env -> EXPO_PUBLIC_API_URL=$backendUrl"

    # 3. Tunnel the Expo port (server itself starts in step 5)
    Write-Host "Tunneling the Expo dev server..."
    $clientUrl = Start-Tunnel 8081

    # 4. The phone URL, as a QR code (plain text fallback if segno is missing)
    Write-Host ""
    Write-Host "  Phone URL: $clientUrl" -ForegroundColor Green
    Write-Host ""
    & (Join-Path $root "venv\Scripts\python.exe") -c "import segno; segno.make('$clientUrl').terminal(compact=True)"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "(QR failed -- type the URL by hand, or: venv\Scripts\pip.exe install segno)"
    }
    Write-Host ""
    Write-Host "Point the iPhone camera at the QR. Starting Expo (Ctrl+C here ends the session)..."

    # 5. Expo dev server, FOREGROUND -- its exit tears the session down
    Set-Location (Join-Path $root "client")
    npx expo start --port 8081
}
finally {
    Set-Location $root
    foreach ($p in $spawned) {
        if ($p -and -not $p.HasExited) {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host "Session ended; tunnels and spawned servers stopped."
}
```

- [ ] **Step 3: Verify by running it**

Run: `.\phone-preview.ps1` from the repo root.
Expected: backend starts (or is detected), two `trycloudflare.com` URLs print, `client/.env` contains the backend one as `EXPO_PUBLIC_API_URL`, a QR renders in the terminal, Expo starts. From a browser, open the CLIENT tunnel URL — the Home screen must load and list the 4 genres (proving the app reached the backend THROUGH its tunnel). Then Ctrl+C and confirm the cloudflared/uvicorn processes are gone (`Get-Process cloudflared -ErrorAction SilentlyContinue` → nothing).

- [ ] **Step 4: Document the run command**

In `CLAUDE.md`'s "Environment / how to run" section, add one bullet:

```markdown
- Phone preview session (tunnels + QR): `.\phone-preview.ps1` from the repo
  root (needs `cloudflared`: `winget install --id Cloudflare.cloudflared`).
  Writes the backend tunnel URL into `client/.env` each run; Ctrl+C ends the
  whole session. Design: `docs/superpowers/specs/2026-07-11-phone-preview-design.md`.
```

- [ ] **Step 5: Commit**

```bash
git add phone-preview.ps1 requirements.txt CLAUDE.md
git commit -m "feat: phone-preview.ps1 - one-command tunnel session with terminal QR (segno)"
```

---

### Task 8: Full verification + CLAUDE.md status update + push

**Files:**
- Modify: `CLAUDE.md` (the "What's BUILT and WORKING" client section + "NEXT STEPS")

**Interfaces:** none — this is the ship checkpoint.

- [ ] **Step 1: Run everything**

```powershell
venv\Scripts\python.exe -m pytest tests/ -v          # expect: 117 passed (untouched)
cd client
npx jest --watchAll=false                             # expect: 10 suites, 114 passed
npx tsc --noEmit                                      # expect: no output
npx expo export --platform web                        # expect: clean export to dist/
cd ..
```

Expected: all four green. If any fails, fix before proceeding (do NOT update docs claiming green).

- [ ] **Step 2: Update `CLAUDE.md`**

In the client section, document (follow the file's existing prose style): the voiceOut rework (module-scoped shared element, `unlock()` blessed by card taps / mic presses / Begin, `play()` rejection → speaking false with no device fallback, the `SYNTH_WATCHDOG_MS=1500` watchdog, ended-revoke leak fix), the four unlock wiring points, the 15s PushToTalk timeout, the new test counts (client 114 across 10 suites), `phone-preview.ps1` + segno, and the Task 1 SSE-through-tunnel verdict. In "NEXT STEPS", replace the phone-preview directive paragraph with a status line pointing at the spec and noting the owner gut-check (Task 9) as the open item.

- [ ] **Step 3: Commit and push**

```bash
git add CLAUDE.md
git commit -m "docs: record the phone-preview slice in CLAUDE.md"
git push
```

---

### Task 9: OWNER SESSION — paid tier, budget alert, on-phone gut-check

**Not agent-executable.** The owner runs this with the phone in hand; an agent may assist live.

- [ ] **Step 1 (owner): Flip the Gemini key to the paid tier** — in Google AI Studio / Cloud console, enable billing on the project behind `GEMINI_API_KEY`. No code change (same key, higher limits).
- [ ] **Step 2 (owner): Set a Google Cloud budget alert** (e.g. alert at $10, ~half the $20/month dev budget).
- [ ] **Step 3 (owner): Ensure real-Gemini mode** — `client/.env` has `EXPO_PUBLIC_USE_MOCK=0` (or the line removed).
- [ ] **Step 4 (owner): Run `.\phone-preview.ps1`, point the iPhone camera at the QR.**
- [ ] **Step 5 (owner): Run the 9-item gut-check checklist** from the spec (`docs/superpowers/specs/2026-07-11-phone-preview-design.md`, "On-phone gut-check checklist") — phone OFF silent mode; templates load; mic → transcription quality; SSE streaming; Gemini-voice narration; mic interrupt; ordinal pick + conversational reply; ■ Stop; `logs/usage.jsonl` spend sanity.
- [ ] **Step 6: Record outcomes** (transcription quality verdict, voice quality verdict, any iOS surprises — mic re-prompts, HMR-through-tunnel result) in `.superpowers/sdd/progress.md`; they seed the next unit of work.
