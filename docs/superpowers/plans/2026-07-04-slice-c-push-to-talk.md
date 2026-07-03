# Phase 2 Slice C: Push-to-Talk — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Speak to steer the story in the browser: hold-to-talk with live transcript, "the second one" picks card 2 via a rules-based matcher, anything else steers the story free-form — plus the cancellation plumbing the reviews mandated first.

**Architecture:** Task 1 retrofits `streamTurn` with AbortSignal support (deliberate aborts are silent — never the "Connection lost" error) and gives Story an unmount-abort plus a reactive `isStreaming` state. `VoiceIn` (`client/lib/voice.ts`) wraps the browser's built-in SpeechRecognition behind the project's voice abstraction — zero new dependencies this slice; `expo-speech-recognition` enters only in the final native-build task behind the same interface. `matchCard` (`client/lib/matchCard.ts`) is a pure guarded-ordinal + word-overlap function; null falls through to free-form steering. All voice choices route through the existing `runTurn` (turn clock, frozen retry, overlap guard inherited).

**Tech Stack:** Existing Expo client (`client/`, SDK 57). Backend untouched this slice. No new npm dependencies until Task 6 (native).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-04-slice-c-push-to-talk-design.md` governs. Web-first: Tasks 1–5 are browser-complete; Task 6 (native build) may legitimately end "documented + blocked on user input".
- Client commands (run in `client/`): `npx jest --watchAll=false` (30 tests now) and `npx tsc --noEmit`. Backend suite (`venv/Scripts/python.exe -m pytest tests/ -v`, 69 tests) must stay untouched-green; verify once in Task 5.
- HARD-WON CLIENT FACTS (respect them): `@testing-library/react-native` pinned EXACT 13.3.3 + `react-test-renderer` 19.2.3 — never change; `client/.npmrc` has legacy-peer-deps; `client/jest-setup.js` Reanimated mock covers ONLY `Animated.Text`/`Animated.View` + `FadeInDown.duration()` — use plain RN components for all new UI (no new Reanimated primitives); jest config has `restoreMocks: true` (per-test `jest.spyOn` only; module factories unaffected).
- Deliberate abort ≠ failure: an `AbortError` in `streamTurn` must yield NO event (silent end). The status-0 `detail` strings render verbatim in the UI since slice B's fix — a cancel painting "Connection lost mid-story" is a bug.
- Voice choices/steering must call the existing `runTurn` — no parallel request path (turn/beat clock derives from `scenes.length + 1`).
- Interim transcripts render as plain `Text` — NEVER `StreamingText` (append-only contract; interim speech rewrites itself).
- PTT bar lives OUTSIDE the ScrollView: wrap screens in a flex `View` with the ScrollView inside.
- Commits: conventional style + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Push at slice end (Task 5) and after Task 6.
- SDD ledger: `.superpowers/sdd/progress.md` (append per-task status as established).

---

### Task 1: Cancellation plumbing + reactive streaming state

**Files:**
- Modify: `client/lib/api.ts` (streamTurn signature + abort semantics + reader.cancel)
- Modify: `client/app/story.tsx` (AbortController ref, unmount abort, `isStreaming` state)
- Test: `client/lib/__tests__/api.test.ts`, `client/app/__tests__/story.test.tsx`

**Interfaces:**
- Produces: `streamTurn(body: TurnRequest, opts?: { signal?: AbortSignal }): AsyncGenerator<StreamEvent>` — on `AbortError` (from fetch OR mid-read) the generator ENDS silently, yielding nothing further; `reader.cancel()` best-effort in a `finally`. Story exposes `isStreaming: boolean` state (mirrors `streamingRef`) — Task 4's PTT bar consumes it.

- [ ] **Step 1: Write the failing tests**

Add to `client/lib/__tests__/api.test.ts`:

```ts
  it("ends silently when the initial fetch is aborted (no stream_error)", async () => {
    const abortErr = new Error("Aborted");
    abortErr.name = "AbortError";
    jest.spyOn(require("../fetch"), "streamingFetch").mockRejectedValue(abortErr);

    const events = [];
    for await (const ev of streamTurn(REQ)) events.push(ev);
    expect(events).toEqual([]); // a deliberate cancel is not a failure
  });

  it("ends silently when a mid-stream read is aborted", async () => {
    let reads = 0;
    const abortErr = new Error("Aborted");
    abortErr.name = "AbortError";
    const fakeRes = {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => {
            reads += 1;
            if (reads === 1) {
              return Promise.resolve({
                done: false,
                value: new TextEncoder().encode('event: scene_token\ndata: {"t": "First "}\n\n'),
              });
            }
            return Promise.reject(abortErr);
          },
          cancel: jest.fn(),
        }),
      },
    } as unknown as Response;
    jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(fakeRes);

    const events = [];
    for await (const ev of streamTurn(REQ)) events.push(ev);
    expect(events).toEqual([{ type: "token", t: "First " }]); // tokens kept, NO error event
  });

  it("passes the AbortSignal through to fetch and cancels the reader on early exit", async () => {
    const cancel = jest.fn();
    const fakeRes = {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            Promise.resolve({
              done: false,
              value: new TextEncoder().encode('event: scene_token\ndata: {"t": "x"}\n\n'),
            }),
          cancel,
        }),
      },
    } as unknown as Response;
    const spy = jest
      .spyOn(require("../fetch"), "streamingFetch")
      .mockResolvedValue(fakeRes);

    const controller = new AbortController();
    const gen = streamTurn(REQ, { signal: controller.signal });
    await gen.next(); // one token
    await gen.return(undefined as never); // consumer walks away
    expect(cancel).toHaveBeenCalled();
    expect(spy.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
  });
```

Add to `client/app/__tests__/story.test.tsx`:

```tsx
  it("aborts the in-flight stream on unmount", async () => {
    let capturedSignal: AbortSignal | undefined;
    let release: () => void;
    const gate = new Promise<void>((res) => (release = res));

    jest.spyOn(api, "streamTurn").mockImplementation(function (
      _req: unknown,
      opts?: { signal?: AbortSignal }
    ) {
      capturedSignal = opts?.signal;
      return (async function* () {
        yield { type: "token", t: "Slow " } as const;
        await gate; // stream stays open
      })() as never;
    });

    const { getByText, unmount } = render(<Story />);
    await waitFor(() => getByText(/Slow/));
    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
    release!();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `client/`): `npx jest --watchAll=false`
Expected: the abort tests FAIL — fetch-abort currently yields the status-0 "Can't reach" error, mid-read abort yields "Connection lost", streamTurn takes no opts, Story passes no signal.

- [ ] **Step 3: Implement**

`client/lib/api.ts` — change `streamTurn` to:

```ts
export async function* streamTurn(
  body: TurnRequest,
  opts?: { signal?: AbortSignal }
): AsyncGenerator<StreamEvent> {
  const url = `${API_URL}/continue/stream${USE_MOCK ? "?mock=true" : ""}`;
  let res: Response;
  try {
    res = await streamingFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return; // deliberate cancel: silent
    yield {
      type: "stream_error",
      status: 0,
      detail: "Can't reach the storyteller. Is the backend running?",
    };
    return;
  }

  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {}
    yield { type: "stream_error", status: res.status, detail };
    return;
  }

  const parser = new SSEParser();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    reader = res.body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
        yield ev;
      }
    }
    for (const ev of parser.feed(decoder.decode())) {
      yield ev;
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return; // aborted mid-stream: silent
    yield {
      type: "stream_error",
      status: 0,
      detail: "Connection lost mid-story. Tap to retry.",
    };
  } finally {
    // Best-effort: release the HTTP body if the consumer exits early or errors.
    try {
      reader?.cancel();
    } catch {}
  }
}
```

(Note the `decoder` declaration must stay in scope for the flush line — keep it inside the `try` exactly as shown; TypeScript will hoist correctly since both uses are within the same block.)

`client/app/story.tsx`:
- Add state + ref: `const [isStreaming, setIsStreaming] = useState(false);` and `const abortRef = useRef<AbortController | null>(null);`
- In `runTurn`, inside the guard (after `streamingRef.current = true;`): `setIsStreaming(true); const controller = new AbortController(); abortRef.current = controller;` — pass `{ signal: controller.signal }` as `streamTurn`'s second argument. In the `finally`: `streamingRef.current = false; setIsStreaming(false); abortRef.current = null;`
- Unmount cleanup — add one effect:

```tsx
  useEffect(() => {
    return () => {
      abortRef.current?.abort(); // stop billing a screen nobody is watching
    };
  }, []);
```

- [ ] **Step 4: Run tests + types**

Run (in `client/`): `npx jest --watchAll=false && npx tsc --noEmit`
Expected: ALL PASS (34 = 30 + 4 new), types clean. Existing abort-free tests unchanged and green.

- [ ] **Step 5: Commit**

```bash
git add client
git commit -m "feat(client): abortable streaming - silent cancels, reader release, unmount abort, isStreaming state"
```

---

### Task 2: `VoiceIn` — the voice abstraction + web implementation

**Files:**
- Create: `client/lib/voice.ts`
- Test: `client/lib/__tests__/voice.test.ts`

**Interfaces:**
- Produces (binding for Task 4):

```ts
export type VoiceCallbacks = {
  onInterim: (transcript: string) => void;
  onFinal: (transcript: string) => void;
  onError: (message: string) => void;
};
export type VoiceIn = {
  available: boolean;
  start: (cb: VoiceCallbacks) => void;
  stop: () => void;   // finish; onFinal fires with everything heard
  abort: () => void;  // discard; NO onFinal
};
export function getVoiceIn(): VoiceIn;
```

- [ ] **Step 1: Write the failing tests**

Create `client/lib/__tests__/voice.test.ts`:

```ts
import { getVoiceIn, VoiceCallbacks } from "../voice";

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  interimResults = false;
  continuous = false;
  lang = "";
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = false;
  aborted = false;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
    this.onend?.(); // real recognizers fire onend after stop
  }
  abort() {
    this.aborted = true;
    this.onend?.();
  }
}

function resultEvent(items: Array<{ text: string; final: boolean }>) {
  return {
    resultIndex: 0,
    results: items.map((i) => {
      const r = [{ transcript: i.text }] as Array<{ transcript: string }> & {
        isFinal?: boolean;
      };
      (r as never as { isFinal: boolean }).isFinal = i.final;
      return r;
    }),
  };
}

describe("getVoiceIn (web)", () => {
  const cb = (): VoiceCallbacks & {
    interims: string[];
    finals: string[];
    errors: string[];
  } => {
    const interims: string[] = [];
    const finals: string[] = [];
    const errors: string[] = [];
    return {
      interims,
      finals,
      errors,
      onInterim: (t) => interims.push(t),
      onFinal: (t) => finals.push(t),
      onError: (m) => errors.push(m),
    };
  };

  beforeEach(() => {
    FakeRecognition.instances = [];
    (globalThis as never as { SpeechRecognition: unknown }).SpeechRecognition =
      FakeRecognition;
  });
  afterEach(() => {
    delete (globalThis as never as { SpeechRecognition?: unknown })
      .SpeechRecognition;
  });

  it("is unavailable when the browser has no SpeechRecognition", () => {
    delete (globalThis as never as { SpeechRecognition?: unknown })
      .SpeechRecognition;
    expect(getVoiceIn().available).toBe(false);
  });

  it("streams interim transcripts and delivers the final on stop", () => {
    const voice = getVoiceIn();
    const c = cb();
    voice.start(c);
    const rec = FakeRecognition.instances[0];
    expect(rec.started).toBe(true);
    expect(rec.interimResults).toBe(true);

    rec.onresult!(resultEvent([{ text: "the second", final: false }]));
    rec.onresult!(resultEvent([{ text: "the second one", final: true }]));
    expect(c.interims).toContain("the second");

    voice.stop();
    expect(c.finals).toEqual(["the second one"]);
  });

  it("abort discards everything - no final transcript", () => {
    const voice = getVoiceIn();
    const c = cb();
    voice.start(c);
    FakeRecognition.instances[0].onresult!(
      resultEvent([{ text: "never mind", final: true }])
    );
    voice.abort();
    expect(c.finals).toEqual([]);
  });

  it("maps permission denial to a friendly message", () => {
    const voice = getVoiceIn();
    const c = cb();
    voice.start(c);
    FakeRecognition.instances[0].onerror!({ error: "not-allowed" });
    expect(c.errors[0]).toMatch(/microphone permission/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `client/`): `npx jest --watchAll=false`
Expected: FAIL (`Cannot find module '../voice'`).

- [ ] **Step 3: Implement**

Create `client/lib/voice.ts`:

```ts
/**
 * VoiceIn — the project's voice-input abstraction (architecture rule #3:
 * never call a speech service directly; web vs phone implementations swap
 * behind this interface).
 *
 * This slice ships the WEB implementation on the browser's built-in
 * SpeechRecognition (Chrome et al; works on localhost). The native
 * implementation (expo-speech-recognition, needs a dev build) arrives in the
 * slice's final task behind this same interface.
 *
 * Privacy note (recorded in the spec): Chrome's recognition sends audio to
 * Google's servers. Acceptable for dev; revisit wording before launch.
 */

export type VoiceCallbacks = {
  onInterim: (transcript: string) => void;
  onFinal: (transcript: string) => void;
  onError: (message: string) => void;
};

export type VoiceIn = {
  available: boolean;
  start: (cb: VoiceCallbacks) => void;
  stop: () => void;
  abort: () => void;
};

type RecognitionCtor = new () => {
  interimResults: boolean;
  continuous: boolean;
  lang: string;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechResultEvent = {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }>;
};

const UNAVAILABLE: VoiceIn = {
  available: false,
  start: () => {},
  stop: () => {},
  abort: () => {},
};

export function getVoiceIn(): VoiceIn {
  const g = globalThis as never as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  const Ctor = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  if (!Ctor) return UNAVAILABLE;

  let rec: InstanceType<RecognitionCtor> | null = null;

  return {
    available: true,
    start(cb: VoiceCallbacks) {
      rec = new Ctor();
      rec.interimResults = true;
      rec.continuous = true; // hold-to-talk: we decide when it ends, not silence
      rec.lang = "en-US";

      let finalText = "";
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const chunk = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText += chunk;
          else interim += chunk;
        }
        cb.onInterim((finalText + interim).trim());
      };
      rec.onerror = (e) => {
        cb.onError(
          e.error === "not-allowed" || e.error === "service-not-allowed"
            ? "Microphone permission denied. Enable the mic to speak your story."
            : `Speech recognition error: ${e.error}`
        );
      };
      rec.onend = () => {
        cb.onFinal(finalText.trim());
      };
      rec.start();
    },
    stop() {
      rec?.stop(); // recognizer fires onend -> onFinal
    },
    abort() {
      if (rec) {
        rec.onend = null; // discard: no final delivery
        rec.abort();
      }
    },
  };
}
```

- [ ] **Step 4: Run tests + types**

Run (in `client/`): `npx jest --watchAll=false && npx tsc --noEmit`
Expected: ALL PASS (38), types clean.

- [ ] **Step 5: Commit**

```bash
git add client/lib
git commit -m "feat(client): VoiceIn abstraction with web SpeechRecognition implementation"
```

---

### Task 3: `matchCard` — guarded ordinals + word overlap

**Files:**
- Create: `client/lib/matchCard.ts`
- Test: `client/lib/__tests__/matchCard.test.ts`

**Interfaces:**
- Produces: `matchCard(utterance: string, cards: string[]): number | null` (Task 4 calls it at the choose site).

- [ ] **Step 1: Write the failing tests**

Create `client/lib/__tests__/matchCard.test.ts`:

```ts
import { matchCard } from "../matchCard";

const CARDS = [
  "Mira forces the iron door and finds a room where maps draw themselves.",
  "A voice behind the door asks her, by name, to slide the map underneath.",
  "The dripping stops and footsteps begin, approaching from the corridor.",
];

describe("matchCard - ordinals (guarded)", () => {
  it.each([
    ["the first one", 0],
    ["first", 0],
    ["the second one", 1],
    ["pick number two", 1],
    ["option 3", 2],
    ["take the third", 2],
    ["the last one", 2],
  ])("%s -> card %i", (utterance, expected) => {
    expect(matchCard(utterance, CARDS)).toBe(expected);
  });

  it("bare ordinal words inside long sentences do NOT match (guard)", () => {
    expect(matchCard("at first she hesitated, then she slowly ran away", CARDS)).toBeNull();
    expect(matchCard("the two of them walk toward the bright harbor gates", CARDS)).toBeNull();
  });

  it("pick-verbs unlock ordinals even in longer utterances", () => {
    expect(matchCard("let's go with option two on this one", CARDS)).toBe(1);
  });

  it("out-of-bounds ordinal is null", () => {
    expect(matchCard("the fourth one", CARDS)).toBeNull();
  });
});

describe("matchCard - word overlap", () => {
  it("two+ distinctive shared words pick the clear winner", () => {
    expect(matchCard("she forces the iron door open", CARDS)).toBe(0);
    expect(matchCard("follow the footsteps in the corridor", CARDS)).toBe(2);
  });

  it("ambiguity returns null instead of guessing", () => {
    // "door" appears in cards 0 and 1; one shared word each - no clear winner
    expect(matchCard("the door", CARDS)).toBeNull();
  });

  it("gibberish and unrelated free-form steering return null", () => {
    expect(matchCard("she sets fire to the archive and flees north", CARDS)).toBeNull();
    expect(matchCard("blorp fizzle", CARDS)).toBeNull();
  });

  it("empty utterance is null", () => {
    expect(matchCard("", CARDS)).toBeNull();
    expect(matchCard("   ", CARDS)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `client/`): `npx jest --watchAll=false`
Expected: FAIL (`Cannot find module '../matchCard'`).

- [ ] **Step 3: Implement**

Create `client/lib/matchCard.ts`:

```ts
/**
 * matchCard — decide whether a spoken utterance picks one of the option
 * cards, with NO network and NO LLM (approved cheap path; upgradeable in
 * isolation later).
 *
 * Rules, in order:
 *  1. GUARDED ordinals: "second", "option 2", "number two", "the last one"...
 *     Ordinals only fire when the utterance looks like a pick — short
 *     (<= 4 words) OR containing a pick-verb/noun (pick/take/choose/go with/
 *     option/number/card). Guard exists because bare words like "first" and
 *     "two" appear constantly in narrative steering sentences.
 *  2. Word overlap: content words (len > 3, minus stopwords) shared with each
 *     card; a card wins only with >= 2 overlaps AND a strictly higher score
 *     than the runner-up. Ties/ambiguity -> null.
 *  3. null -> the caller treats the utterance as free-form steering.
 */

const ORDINALS: Array<[RegExp, number]> = [
  [/\b(first|one|1)\b/, 0],
  [/\b(second|two|2)\b/, 1],
  [/\b(third|three|3)\b/, 2],
  [/\b(fourth|four|4)\b/, 3],
];

const PICK_WORDS = /\b(pick|take|choose|select|option|number|card|go with)\b/;

const STOPWORDS = new Set([
  "the", "that", "this", "with", "into", "from", "they", "their", "them",
  "then", "have", "will", "would", "could", "should", "about", "there",
  "where", "when", "what", "your", "over", "under", "after", "before",
]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function contentWords(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  );
}

export function matchCard(utterance: string, cards: string[]): number | null {
  const text = normalize(utterance);
  if (!text) return null;

  // 1. Guarded ordinals
  const wordCount = text.split(" ").length;
  const looksLikeAPick = wordCount <= 4 || PICK_WORDS.test(text);
  if (looksLikeAPick) {
    if (/\blast\b/.test(text)) return cards.length - 1;
    for (const [re, idx] of ORDINALS) {
      if (re.test(text)) {
        return idx < cards.length ? idx : null;
      }
    }
  }

  // 2. Word overlap
  const spoken = contentWords(utterance);
  if (spoken.size === 0) return null;
  const scores = cards.map((card) => {
    const cw = contentWords(card);
    let n = 0;
    for (const w of spoken) if (cw.has(w)) n++;
    return n;
  });
  const best = Math.max(...scores);
  if (best < 2) return null;
  if (scores.filter((s) => s === best).length > 1) return null;
  return scores.indexOf(best);
}
```

- [ ] **Step 4: Run tests + types**

Run (in `client/`): `npx jest --watchAll=false && npx tsc --noEmit`
Expected: ALL PASS (~52), types clean. If an overlap-test expectation fails, inspect whether the *test's* linguistic assumption or the *rule constants* (stopwords, length threshold) is wrong — adjust constants, not the contract (>=2 overlaps + strict winner + guarded ordinals). Report any constant adjusted.

- [ ] **Step 5: Commit**

```bash
git add client/lib
git commit -m "feat(client): matchCard - guarded ordinals + word-overlap card matching"
```

---

### Task 4: The push-to-talk experience (Story + Home wiring)

**Files:**
- Create: `client/components/PushToTalk.tsx`
- Modify: `client/app/story.tsx` (flex wrapper, PTT bar, confirm bar, exit control)
- Modify: `client/app/index.tsx` (mic affordance on premise box)
- Test: `client/app/__tests__/story.test.tsx`, `client/app/__tests__/index.test.tsx`

**Interfaces:**
- Consumes: `getVoiceIn`/`VoiceIn` (Task 2 — mock at this seam: `jest.mock("../../lib/voice")`), `matchCard` (Task 3), `isStreaming` (Task 1).
- Produces: `<PushToTalk disabled={boolean} onUtterance={(text: string) => void} />` — renders nothing when voice is unavailable; hold-to-talk (onPressIn/onPressOut → VoiceIn start/stop); shows live interim transcript (plain Text) while held; mic-permission errors render inline; `onUtterance` fires with the final transcript (non-empty only).

**Binding behavior (Story):**
- Layout: root becomes flex `View`; ScrollView inside; PTT bar pinned below; a back control ("← Home", `router.back()`) at top.
- On utterance: `matchCard(utterance, options)` → a **confirm bar** appears: matched → "Heard: '…' → choosing option N" with card N visually highlighted; null → "Heard: '…' → steering the story". Cancel button discards. After **1.5s** (setTimeout; cleared on cancel/unmount) the action fires through the SAME `handleChoose` path (matched → the card's text; null → the utterance itself).
- PTT `disabled` while `isStreaming` OR while a confirm bar is pending.
- Voice unavailable → no PTT bar, everything else unchanged.

**Binding behavior (Home):** a mic button beside the premise input (only when voice available + a template selected); hold-to-talk; final transcript **replaces** the premise input value (the input itself is the confirm step — no bar).

- [ ] **Step 1: Write the failing tests**

Add to `client/app/__tests__/story.test.tsx` (top of file gains `jest.mock("../../lib/voice")` with a controllable fake; use jest fake timers where noted):

```tsx
// --- voice fake: capture callbacks so tests can drive recognition ---
const voiceFake = {
  available: true,
  start: jest.fn(),
  stop: jest.fn(),
  abort: jest.fn(),
};
jest.mock("../../lib/voice", () => ({
  getVoiceIn: () => voiceFake,
}));

const happyTurn = () =>
  fixtureStream([
    { type: "token", t: "Scene. " },
    { type: "turn_complete", summary: "s", scenarios: ["Force the iron door open now", "Ask the voice its name", "Run from the footsteps"] },
  ]);

describe("push-to-talk", () => {
  beforeEach(() => {
    voiceFake.start.mockClear();
    voiceFake.stop.mockClear();
  });

  it("spoken ordinal picks a card after the confirm window", async () => {
    jest.useFakeTimers();
    const spy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(happyTurn())
      .mockReturnValueOnce(happyTurn());

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = voiceFake.start.mock.calls[0][0];
    act(() => cb.onInterim("the second"));
    expect(getByText(/the second/)).toBeTruthy(); // live transcript visible
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("the second one"));

    expect(getByText(/choosing option 2/i)).toBeTruthy();
    act(() => jest.advanceTimersByTime(1600));
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith(
        expect.objectContaining({ chosen_scenario: "Ask the voice its name" }),
        expect.anything()
      )
    );
    jest.useRealTimers();
  });

  it("unmatched speech steers the story free-form", async () => {
    jest.useFakeTimers();
    const spy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(happyTurn())
      .mockReturnValueOnce(happyTurn());

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = voiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("she sets fire to the archive and flees north"));

    expect(getByText(/steering the story/i)).toBeTruthy();
    act(() => jest.advanceTimersByTime(1600));
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          chosen_scenario: "she sets fire to the archive and flees north",
        }),
        expect.anything()
      )
    );
    jest.useRealTimers();
  });

  it("cancel inside the confirm window discards the utterance", async () => {
    jest.useFakeTimers();
    const spy = jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = voiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("the second one"));
    fireEvent.press(getByText(/cancel/i));
    act(() => jest.advanceTimersByTime(2000));
    expect(spy).toHaveBeenCalledTimes(1); // only the opening turn
    jest.useRealTimers();
  });

  it("PTT is disabled while a turn is streaming", async () => {
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    jest.spyOn(api, "streamTurn").mockReturnValue(
      (async function* () {
        yield { type: "token", t: "Slow " } as const;
        await gate;
        yield {
          type: "turn_complete",
          summary: "s",
          scenarios: ["A"],
        } as const;
      })() as never
    );

    const { getByTestId, getByText } = render(<Story />);
    await waitFor(() => getByText(/Slow/));
    expect(
      getByTestId("ptt-button").props.accessibilityState?.disabled
    ).toBe(true);
    release!();
  });

  it("mic permission error shows inline", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = voiceFake.start.mock.calls[0][0];
    act(() => cb.onError("Microphone permission denied. Enable the mic to speak your story."));
    expect(getByText(/microphone permission denied/i)).toBeTruthy();
  });

  it("back control exists", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    const { getByText } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));
    expect(getByText(/home/i)).toBeTruthy();
  });
});
```

(The expo-router mock must gain `router.back: jest.fn()` if not present. The two existing call-shape tests asserting `toHaveBeenCalledWith(req)` need their expectation extended to `toHaveBeenCalledWith(req, expect.anything())` — streamTurn now receives an options argument; list this edit in the report.)

Add to `client/app/__tests__/index.test.tsx` (same `jest.mock("../../lib/voice")` fake pattern):

```tsx
  it("mic fills the premise input with the spoken transcript", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByTestId, getByPlaceholderText } = render(<Home />);
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));

    fireEvent(getByTestId("premise-mic"), "pressIn");
    const cb = voiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("premise-mic"), "pressOut");
    act(() => cb.onFinal("a dragon egg hatches in a city without magic"));

    expect(getByPlaceholderText(/premise/i).props.value).toBe(
      "a dragon egg hatches in a city without magic"
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `client/`): `npx jest --watchAll=false`
Expected: new tests FAIL (no ptt-button testID, no confirm bar, no mic).

- [ ] **Step 3: Implement**

`client/components/PushToTalk.tsx` per the Produces contract: `getVoiceIn()` acquired once (useRef or module call in component body is fine — the mock makes it deterministic); render nothing if `!voice.available`; a `Pressable` with `testID="ptt-button"`, `onPressIn` → `voice.start({...})` capturing interim into state, `onPressOut` → `voice.stop()`; `onFinal` → if transcript non-empty call `props.onUtterance(transcript)`, clear interim; `onError` → set inline error state (plain Text under the button); `disabled` prop → Pressable disabled + dimmed styling + `accessibilityState={{disabled}}`. Interim transcript = plain `Text` (NEVER StreamingText). Label the button "🎤 Hold to talk" (any similar copy).

`client/app/story.tsx`: flex-wrapper layout (root `View style={{flex:1}}`, ScrollView inside, PTT area below); "← Home" Pressable at top calling `router.back()`; confirm-bar state `{utterance: string, matchedIndex: number | null} | null` + a timeout ref (1500ms, cleared on cancel and on unmount); on fire: matched → `handleChoose(options[matchedIndex])`, else `handleChoose(utterance)`; matched card gets highlight styling while pending; `<PushToTalk disabled={isStreaming || confirmPending} onUtterance={...} />`.

`client/app/index.tsx`: `testID="premise-mic"` hold-to-talk Pressable beside the premise input (render when voice available AND a template is selected); final transcript → `setPremise(transcript)`.

Styling: plain RN, match existing screens. No new Reanimated primitives.

- [ ] **Step 4: Run tests + types**

Run (in `client/`): `npx jest --watchAll=false && npx tsc --noEmit`
Expected: ALL PASS (~59), types clean.

- [ ] **Step 5: Commit**

```bash
git add client
git commit -m "feat(client): push-to-talk - hold to speak, card matching, confirm bar, free-form steering"
```

---

### Task 5: Browser hand-off, docs, ship

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full suites** — client `npx jest --watchAll=false && npx tsc --noEmit` (report count); backend `venv/Scripts/python.exe -m pytest tests/ -v` (69, untouched). `npx expo export --platform web` builds clean.

- [ ] **Step 2: CLAUDE.md** — add slice C to the client section: VoiceIn abstraction (web SpeechRecognition now, expo-speech-recognition later behind the same interface; privacy note), matchCard rules (guarded ordinals + overlap, null → free-form steering), PTT bar + confirm-bar flow, abort plumbing (silent cancels, unmount abort, isStreaming), Story back control, Home mic. Update client test count. Update roadmap NEXT STEPS (slice C browser-complete; native build pending; slice D narration next).

- [ ] **Step 3: Commit + push**

```bash
git add client CLAUDE.md
git commit -m "docs: record slice C push-to-talk in CLAUDE.md"
git push
```

- [ ] **Step 4: Hand the demo to the human** — instructions: backend up (`uvicorn main:app --reload`, DEV_MOCK_ENABLED=1), `cd client && npx expo start --web`, use **Chrome** (SpeechRecognition support), allow the mic. Try: hold the bar, say "the second one" → card 2 highlights → auto-sends; say a free-form sentence → steers; Cancel during the confirm window; navigate away mid-stream (stream stops). Mock mode = all free.

---

### Task 6: Native dev build (final; "documented + blocked" is an acceptable outcome)

**Files:**
- Modify: `client/lib/voice.ts` (native branch), `client/app.json` (config plugin), `client/package.json` (expo-speech-recognition)
- Create: `docs/superpowers/notes/native-dev-build.md` (whatever the outcome, record the state)

- [ ] **Step 1: ASK THE USER** their phone OS before anything (Android → EAS cloud APK or local build; iPhone from Windows → requires a paid Apple Developer account — a budget decision that is THEIRS).
- [ ] **Step 2:** `npx expo install expo-speech-recognition` (in client/); add its config plugin to `client/app.json` plugins with mic/speech permission strings per the package README (read the README via context7/web — verify current plugin syntax, don't guess).
- [ ] **Step 3:** Extend `getVoiceIn()`: `Platform.OS !== "web"` branch using `ExpoSpeechRecognitionModule` + `ExpoWebSpeechRecognition`-equivalent events mapped to the same `VoiceCallbacks`; web path and all existing tests unchanged.
- [ ] **Step 4:** Dev build: `npx eas build --profile development --platform android` (or per OS decision; `eas.json` dev profile with `developmentClient: true`). Requires an Expo account — the user may need to log in interactively; if blocked, WRITE the exact remaining commands into the notes doc and stop cleanly.
- [ ] **Step 5:** Whatever happened: notes doc records outcome + next steps; commit + push.

---

## Self-Review

**Spec coverage:** C0 abort plumbing (silent AbortError, reader.cancel, unmount abort, isStreaming) → Task 1. VoiceIn interface + web impl + unavailable stub + privacy note → Task 2. Matcher rules (guarded ordinals incl. "at first she hesitated" counterexample, ≥2-overlap strict-winner, null fallthrough) → Task 3. PTT bar outside ScrollView, plain-Text interim, one confirm bar for both outcomes (Cancel + 1.5s), same-runTurn routing, busy/disabled states, mic-denied message, Home mic, Story back control → Task 4. Browser hand-off + docs → Task 5. Native last with both acceptable outcomes + OS question → Task 6. ✓

**Placeholder scan:** Task 4 Step 3 delegates JSX with binding behavior + complete test code (established pattern); Task 6 Steps 2-4 explicitly instruct verifying current package docs rather than trusting this plan — deliberate, since native tooling drifts. No TBDs. ✓

**Type consistency:** `VoiceCallbacks`/`VoiceIn`/`getVoiceIn` (Task 2) consumed by Task 4's mock + component; `matchCard(utterance, cards) → number | null` (Task 3) at the choose site; `streamTurn(body, opts?)` (Task 1) → Task 4's updated call-shape expectations (`expect.anything()` second arg). `isStreaming` (Task 1) → Task 4's disabled logic. ✓

**Known context for the executing session:** run with subagent-driven-development; per-task briefs via `scripts/task-brief`; ledger at `.superpowers/sdd/progress.md` (slice C section to be added at start; ledger carries the hard-won client facts repeated in Global Constraints).
