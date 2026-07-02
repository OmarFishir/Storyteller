# Phase 2 Slice B: Expo App + Signature Animation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Storyteller client is born: an Expo (React Native + web) app where you pick a genre, give a premise, and watch scenes materialize word-by-word from the backend's SSE stream, steering with tappable option cards.

**Architecture:** One Expo Router app in `client/` (NOT `app/` — Expo Router uses `app/` internally for routes; `client/app/` beats `app/app/`). All backend talk lives in `client/lib/api.ts` (typed fetch + an incremental SSE parser in `client/lib/sse.ts`). The signature animation is `StreamingText` — a network-ignorant component that animates newly appended words. Two screens: Home (genre cards + premise) and Story (streaming view + option cards + failure UX). The app is developed against the backend's mock mode (`?mock=true`, zero AI cost).

**Tech Stack:** Expo SDK (latest via `create-expo-app@latest`, default template: TypeScript + Expo Router + Reanimated), `expo/fetch` (streaming response bodies on native AND web), jest-expo + @testing-library/react-native, `EXPO_PUBLIC_*` env vars.

## Global Constraints

- Client dir: `client/` at repo root. Backend stays at root, untouched (exception: none — zero backend edits in this slice).
- Backend contract (amended spec `2026-07-02-phase2-vertical-slice-design.md` governs):
  - Error frames ride HTTP **200**: once streaming starts, parse frames — never branch on HTTP status. Only 404 (template), 403 (mock gate), 422 (validation) arrive as plain HTTP errors (map them into the same error channel client-side).
  - Error-frame status enum is OPEN: 503 → "The muse is busy — tap to retry."; 429 → "Out of muse for today."; anything else → generic "Something went wrong — tap to retry."
  - Do NOT hardcode 3 option cards; render whatever count arrives.
  - `POST /continue/stream` is POST ⇒ native `EventSource` is impossible; streaming `fetch` + incremental parse is the only approach. Do not "simplify" to EventSource.
  - Mid-stream error: KEEP all text already shown; the retry re-runs the whole turn (streams a fresh scene replacing the partial).
- The first story turn: `POST /continue/stream` with `summary = premise` and `chosen_scenario = "Open the story."` — the opening scene streams immediately (the magic moment comes first; `/suggest` is not used by the app in this slice).
- Client state carried per the backend's statless design: `{templateId, summary, scenes[], options[]}`; summary is replaced by each `turn_complete`.
- Config: `EXPO_PUBLIC_API_URL` (default `http://localhost:8000`), `EXPO_PUBLIC_USE_MOCK` (`"1"` appends `?mock=true` to stream calls). Backend must be running either way — mock mode goes through the backend.
- All component/unit tests run with jest-expo; no test may hit a network (fetch is always mocked/fixture-fed).
- Windows. Client commands run inside `client/` (e.g. `cd client && npx jest`). Backend suite (`venv/Scripts/python.exe -m pytest tests/ -v` at root, 45 tests) must stay green — it should be untouched, verify once at the end.
- Commits: conventional style + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Implementers MAY adapt exact code to the scaffolded template's conventions (import aliases like `@/`, component locations, current SDK API names) — the *interfaces and behaviors* specified here are binding; report any adaptation in the task report.

---

### Task 1: Scaffold the Expo app + test harness

**Files:**
- Create: `client/` via `npx create-expo-app@latest client --template default` (run at repo root)
- Modify: `client/package.json` (jest preset + test script)
- Create: `client/lib/__tests__/smoke.test.ts`

**Interfaces:**
- Produces: a running Expo project where `npx jest` works (jest-expo preset) and `npx tsc --noEmit` passes. Later tasks add `client/lib/` modules and screens under `client/app/`.

- [ ] **Step 1: Scaffold**

At repo root: `npx create-expo-app@latest client --template default` (accept defaults; no interactive prompts expected). Then inside `client/`: if the template includes the `reset-project` script, run `npm run reset-project` (answers: move/delete example code — choose delete or delete `app-example/` after) so `client/app/` contains only a minimal `index.tsx` and `_layout.tsx`. If the script doesn't exist, manually reduce `client/app/` to a minimal index+layout. Verify `client/.gitignore` covers `node_modules/`.

- [ ] **Step 2: Type-check baseline**

Run (in `client/`): `npx tsc --noEmit`
Expected: clean exit (the fresh template type-checks).

- [ ] **Step 3: Test harness**

In `client/`: `npx expo install jest-expo jest @types/jest --dev` and `npm install --save-dev @testing-library/react-native`. In `client/package.json` add:

```json
  "scripts": { "test": "jest --watchAll=false" },
  "jest": { "preset": "jest-expo" }
```

Create `client/lib/__tests__/smoke.test.ts`:

```ts
describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Run tests**

Run (in `client/`): `npx jest --watchAll=false`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add client
git commit -m "feat(client): scaffold Expo app (Router + TS) with jest-expo harness"
```

---

### Task 2: `lib/sse.ts` + `lib/api.ts` — the backend bridge

**Files:**
- Create: `client/lib/sse.ts`, `client/lib/api.ts`
- Test: `client/lib/__tests__/sse.test.ts`, `client/lib/__tests__/api.test.ts`

**Interfaces:**
- Produces (binding for Tasks 3–5):

```ts
// lib/sse.ts
export type StreamEvent =
  | { type: "token"; t: string }
  | { type: "turn_complete"; summary: string; scenarios: string[] }
  | { type: "stream_error"; status: number; detail: string };
export class SSEParser { feed(chunk: string): StreamEvent[]; }

// lib/api.ts
export type Template = { id: string; name: string; description: string; premise_seeds: string[] };
export type TurnRequest = { template_id: string; summary: string; chosen_scenario: string };
export const API_URL: string;
export function getTemplates(): Promise<Template[]>;
export function streamTurn(body: TurnRequest): AsyncGenerator<StreamEvent>;
```

- [ ] **Step 1: Write the failing tests**

`client/lib/__tests__/sse.test.ts`:

```ts
import { SSEParser } from "../sse";

const frame = (event: string, data: object) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("SSEParser", () => {
  it("parses a complete scene_token frame", () => {
    const p = new SSEParser();
    expect(p.feed(frame("scene_token", { t: "Once " }))).toEqual([
      { type: "token", t: "Once " },
    ]);
  });

  it("parses multiple frames in one chunk", () => {
    const p = new SSEParser();
    const events = p.feed(
      frame("scene_token", { t: "a" }) +
        frame("turn_complete", { summary: "s", scenarios: ["x", "y"] })
    );
    expect(events).toEqual([
      { type: "token", t: "a" },
      { type: "turn_complete", summary: "s", scenarios: ["x", "y"] },
    ]);
  });

  it("buffers frames split across chunks (the wire is not polite)", () => {
    const p = new SSEParser();
    const whole = frame("scene_token", { t: "hello world" });
    const first = p.feed(whole.slice(0, 15));
    const second = p.feed(whole.slice(15));
    expect(first).toEqual([]);
    expect(second).toEqual([{ type: "token", t: "hello world" }]);
  });

  it("maps error frames", () => {
    const p = new SSEParser();
    expect(p.feed(frame("error", { status: 503, detail: "busy" }))).toEqual([
      { type: "stream_error", status: 503, detail: "busy" },
    ]);
  });

  it("ignores unknown event names (forward compatibility)", () => {
    const p = new SSEParser();
    expect(p.feed(frame("narration_started", { x: 1 }))).toEqual([]);
  });
});
```

`client/lib/__tests__/api.test.ts` (fixture-driven; no network):

```ts
import { streamTurn } from "../api";

function streamResponseFromString(body: string, status = 200): Response {
  const stream = new ReadableStream({
    start(controller) {
      // deliver in two chunks to prove incremental parsing end-to-end
      const mid = Math.floor(body.length / 2);
      controller.enqueue(new TextEncoder().encode(body.slice(0, mid)));
      controller.enqueue(new TextEncoder().encode(body.slice(mid)));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "Content-Type": "text/event-stream" } });
}

describe("streamTurn", () => {
  const REQ = { template_id: "fantasy", summary: "s", chosen_scenario: "c" };

  it("yields parsed events from the SSE body", async () => {
    const body =
      'event: scene_token\ndata: {"t": "Once "}\n\n' +
      'event: turn_complete\ndata: {"summary": "s2", "scenarios": ["a"]}\n\n';
    jest
      .spyOn(require("../fetch"), "streamingFetch")
      .mockResolvedValue(streamResponseFromString(body));

    const events = [];
    for await (const ev of streamTurn(REQ)) events.push(ev);
    expect(events).toEqual([
      { type: "token", t: "Once " },
      { type: "turn_complete", summary: "s2", scenarios: ["a"] },
    ]);
  });

  it("maps a plain HTTP error (pre-stream 404) into the same error channel", async () => {
    jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Unknown template_id" }), { status: 404 })
    );

    const events = [];
    for await (const ev of streamTurn(REQ)) events.push(ev);
    expect(events).toEqual([
      { type: "stream_error", status: 404, detail: "Unknown template_id" },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `client/`): `npx jest --watchAll=false`
Expected: both new suites FAIL (modules don't exist).

- [ ] **Step 3: Implement**

`client/lib/fetch.ts` — one indirection so `expo/fetch` (streaming on native) is used in the app but tests can mock a plain function:

```ts
import { fetch as expoFetch } from "expo/fetch";

// Single seam for all streaming HTTP. expo/fetch streams response bodies on
// native (regular web fetch also streams); tests mock THIS function.
export const streamingFetch: typeof globalThis.fetch = expoFetch as never;
```

`client/lib/sse.ts`:

```ts
export type StreamEvent =
  | { type: "token"; t: string }
  | { type: "turn_complete"; summary: string; scenarios: string[] }
  | { type: "stream_error"; status: number; detail: string };

/**
 * Incremental SSE parser. Network chunks don't respect frame boundaries, so
 * we buffer until a full frame ("\n\n") is available. Unknown event names are
 * ignored (forward compatibility with future backend events).
 */
export class SSEParser {
  private buffer = "";

  feed(chunk: string): StreamEvent[] {
    this.buffer += chunk;
    const events: StreamEvent[] = [];
    let sep: number;
    while ((sep = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const ev = parseBlock(block);
      if (ev) events.push(ev);
    }
    return events;
  }
}

function parseBlock(block: string): StreamEvent | null {
  let event = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  try {
    const payload = data ? JSON.parse(data) : {};
    if (event === "scene_token") return { type: "token", t: String(payload.t ?? "") };
    if (event === "turn_complete")
      return {
        type: "turn_complete",
        summary: String(payload.summary ?? ""),
        scenarios: Array.isArray(payload.scenarios) ? payload.scenarios.map(String) : [],
      };
    if (event === "error")
      return {
        type: "stream_error",
        status: Number(payload.status ?? 500),
        detail: String(payload.detail ?? "Something went wrong."),
      };
  } catch {
    return { type: "stream_error", status: 500, detail: "Malformed stream frame." };
  }
  return null; // unknown event → ignore
}
```

`client/lib/api.ts`:

```ts
import { SSEParser, StreamEvent } from "./sse";
import { streamingFetch } from "./fetch";

export type Template = {
  id: string;
  name: string;
  description: string;
  premise_seeds: string[];
};
export type TurnRequest = {
  template_id: string;
  summary: string;
  chosen_scenario: string;
};

export const API_URL =
  process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8000";

const USE_MOCK = process.env.EXPO_PUBLIC_USE_MOCK === "1";

export async function getTemplates(): Promise<Template[]> {
  const res = await streamingFetch(`${API_URL}/templates`);
  if (!res.ok) throw new Error(`Failed to load templates (${res.status})`);
  return (await res.json()).templates;
}

/**
 * Run one story turn against POST /continue/stream, yielding StreamEvents.
 * Error policy (per spec): once streaming starts, errors arrive as frames
 * over HTTP 200. Plain HTTP errors (404/403/422 before the stream) are
 * mapped into the SAME stream_error channel so the UI has ONE error path.
 */
export async function* streamTurn(body: TurnRequest): AsyncGenerator<StreamEvent> {
  const url = `${API_URL}/continue/stream${USE_MOCK ? "?mock=true" : ""}`;
  let res: Response;
  try {
    res = await streamingFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    yield { type: "stream_error", status: 0, detail: "Can't reach the storyteller. Is the backend running?" };
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

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
      yield ev;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (in `client/`): `npx jest --watchAll=false` and `npx tsc --noEmit`
Expected: all suites pass; types clean.

- [ ] **Step 5: Commit**

```bash
git add client/lib
git commit -m "feat(client): typed API bridge with incremental SSE parser"
```

---

### Task 3: `StreamingText` — the signature animation

**Files:**
- Create: `client/components/StreamingText.tsx`
- Test: `client/components/__tests__/StreamingText.test.tsx`

**Interfaces:**
- Produces: `<StreamingText text={string} />` — renders `text` as words; words present in a previous render appear statically, NEWLY APPENDED words animate in (soft fade + small rise). Pure presentation: no networking, no timers of its own — it animates whatever growth the parent feeds it (live SSE, mock, or test fixture).

- [ ] **Step 1: Write the failing test**

`client/components/__tests__/StreamingText.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";
import { StreamingText } from "../StreamingText";

describe("StreamingText", () => {
  it("renders all words of the text", () => {
    const { getByText } = render(<StreamingText text="Once upon a time" />);
    // words render individually (animation wraps each word)
    expect(getByText(/Once/)).toBeTruthy();
    expect(getByText(/time/)).toBeTruthy();
  });

  it("renders newly appended words on update", () => {
    const { rerender, getByText, queryByText } = render(
      <StreamingText text="The lantern" />
    );
    expect(queryByText(/guttered/)).toBeNull();
    rerender(<StreamingText text="The lantern guttered" />);
    expect(getByText(/guttered/)).toBeTruthy();
  });

  it("preserves paragraph breaks", () => {
    const { getAllByTestId } = render(
      <StreamingText text={"One.\n\nTwo."} />
    );
    expect(getAllByTestId("paragraph").length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `client/`): `npx jest --watchAll=false`
Expected: FAIL (component doesn't exist).

- [ ] **Step 3: Implement**

`client/components/StreamingText.tsx`:

```tsx
import { Text, View, StyleSheet } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";

/**
 * The signature animation: words materialize as they arrive.
 *
 * Contract: pass the FULL accumulated text each render; newly appended words
 * animate in (fade + rise), earlier words keep their identity (stable keys)
 * so they don't re-animate. The component knows nothing about networking —
 * feed it from live SSE, the mock stream, or a test fixture.
 */
export function StreamingText({ text }: { text: string }) {
  const paragraphs = text.split("\n\n");
  let wordKey = 0;
  return (
    <View>
      {paragraphs.map((para, pIdx) => (
        <Text key={pIdx} testID="paragraph" style={styles.paragraph}>
          {para
            .split(" ")
            .filter((w) => w.length > 0)
            .map((word) => {
              const key = wordKey++;
              return (
                <Animated.Text
                  key={key}
                  entering={FadeInDown.duration(260)}
                  style={styles.word}
                >
                  {word + " "}
                </Animated.Text>
              );
            })}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  paragraph: { fontSize: 17, lineHeight: 26, marginBottom: 14 },
  word: { fontSize: 17, lineHeight: 26 },
});
```

(Implementer note: jest-expo mocks Reanimated automatically; if the scaffold lacks `react-native-reanimated` — the default Router template includes it — `npx expo install react-native-reanimated`. Animation feel — duration/offset — is a starting value; visual tuning happens in Task 6 against the mock.)

- [ ] **Step 4: Run test to verify it passes**

Run (in `client/`): `npx jest --watchAll=false`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/components
git commit -m "feat(client): StreamingText word-materialize animation component"
```

---

### Task 4: Home screen — genre cards + premise

**Files:**
- Modify/Create: `client/app/index.tsx` (Home), `client/app/_layout.tsx` (if the scaffold's layout needs a title/stack tweak)
- Test: `client/app/__tests__/index.test.tsx`

**Interfaces:**
- Consumes: `getTemplates()` (Task 2).
- Produces: Home screen that loads templates, shows a card per genre (name + description), then premise entry (multiline input + tappable `premise_seeds` chips that fill the input), and a "Begin the story" button that navigates: `router.push({ pathname: "/story", params: { templateId, premise } })`.

- [ ] **Step 1: Write the failing tests**

`client/app/__tests__/index.test.tsx`:

```tsx
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import Home from "../index";
import * as api from "../../lib/api";

jest.mock("expo-router", () => ({
  router: { push: jest.fn() },
}));

const TEMPLATES = [
  { id: "fantasy", name: "Fantasy Adventure", description: "d1", premise_seeds: ["A dragon egg hatches."] },
  { id: "noir", name: "Mystery / Noir", description: "d2", premise_seeds: ["One last case."] },
];

describe("Home", () => {
  it("renders a card per template", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText } = render(<Home />);
    await waitFor(() => expect(getByText("Fantasy Adventure")).toBeTruthy());
    expect(getByText("Mystery / Noir")).toBeTruthy();
  });

  it("tapping a seed fills the premise input", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByPlaceholderText } = render(<Home />);
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));
    fireEvent.press(getByText("A dragon egg hatches."));
    expect(getByPlaceholderText(/premise/i).props.value).toBe("A dragon egg hatches.");
  });

  it("shows a retry state when templates fail to load", async () => {
    jest.spyOn(api, "getTemplates").mockRejectedValue(new Error("down"));
    const { getByText } = render(<Home />);
    await waitFor(() => expect(getByText(/tap to retry/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `client/`): `npx jest --watchAll=false`
Expected: FAIL (Home is the scaffold placeholder).

- [ ] **Step 3: Implement**

Replace `client/app/index.tsx` with a Home screen implementing exactly: load templates on mount (`useEffect` → `getTemplates()`); loading state; error state showing "Couldn't reach the storyteller — tap to retry." (pressable, re-runs the fetch); a card per template (name bold, description under it; selected card visually highlighted); once a template is selected, show a multiline `TextInput` with placeholder "Your story premise..." plus one tappable chip per `premise_seeds` entry (pressing a chip sets the input's value); a "Begin the story" button enabled when a template is selected AND the premise is non-empty, which calls `router.push({ pathname: "/story", params: { templateId: selected.id, premise } })`. Styling: simple, dark-friendly defaults; no styling library. (Exact JSX is the implementer's — the behaviors above and test-compatibility are binding.)

- [ ] **Step 4: Run tests to verify they pass**

Run (in `client/`): `npx jest --watchAll=false` and `npx tsc --noEmit`
Expected: PASS, types clean.

- [ ] **Step 5: Commit**

```bash
git add client/app
git commit -m "feat(client): Home screen — genre cards, premise seeds, begin story"
```

---

### Task 5: Story screen — the streaming loop + failure UX

**Files:**
- Create: `client/app/story.tsx`
- Test: `client/app/__tests__/story.test.tsx`

**Interfaces:**
- Consumes: `streamTurn(body)` (Task 2), `StreamingText` (Task 3), route params `{templateId, premise}`.
- Produces: the playable loop.

**Behavior (binding):**
- On mount: run turn 1 — `streamTurn({ template_id: templateId, summary: premise, chosen_scenario: "Open the story." })`.
- While streaming: accumulate tokens into `currentScene`; render finished scenes as plain `<Text>` above, `currentScene` via `<StreamingText>`.
- On `turn_complete`: push `currentScene` into `scenes[]`, clear it, set `summary` to the new value, render one tappable card per scenario (however many arrive).
- Tapping a card: run the next turn with `chosen_scenario` = card text and the CURRENT summary; cards disappear while streaming.
- On `stream_error`: keep all text already shown (including the partial `currentScene`); show a message + retry button. Message by status: 429 → "Out of muse for today. Try again tomorrow."; 503 → "The muse is busy — tap to retry."; anything else (incl. 0/404/500) → "Something went wrong — tap to retry.". Retry re-runs the SAME turn (same summary + chosen_scenario); on retry, the partial `currentScene` is reset (the fresh stream replaces it).
- The pending turn's request (summary + chosen_scenario) must therefore be kept in state until it completes.

- [ ] **Step 1: Write the failing tests**

`client/app/__tests__/story.test.tsx`:

```tsx
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import Story from "../story";
import * as api from "../../lib/api";
import type { StreamEvent } from "../../lib/sse";

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ templateId: "fantasy", premise: "A dragon egg hatches." }),
  router: { back: jest.fn() },
}));

async function* fixtureStream(events: StreamEvent[]) {
  for (const ev of events) yield ev;
}

describe("Story", () => {
  it("streams the opening scene and then shows option cards", async () => {
    const spy = jest.spyOn(api, "streamTurn").mockReturnValue(
      fixtureStream([
        { type: "token", t: "The egg " },
        { type: "token", t: "cracked." },
        { type: "turn_complete", summary: "s2", scenarios: ["Go north", "Go south"] },
      ])
    );

    const { getByText } = render(<Story />);
    await waitFor(() => expect(getByText(/cracked/)).toBeTruthy());
    expect(getByText("Go north")).toBeTruthy();
    expect(getByText("Go south")).toBeTruthy();
    expect(spy).toHaveBeenCalledWith({
      template_id: "fantasy",
      summary: "A dragon egg hatches.",
      chosen_scenario: "Open the story.",
    });
  });

  it("tapping an option runs the next turn with the updated summary", async () => {
    const spy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(
        fixtureStream([
          { type: "token", t: "Scene one." },
          { type: "turn_complete", summary: "sum-1", scenarios: ["Option A"] },
        ])
      )
      .mockReturnValueOnce(
        fixtureStream([
          { type: "token", t: "Scene two." },
          { type: "turn_complete", summary: "sum-2", scenarios: ["Option B"] },
        ])
      );

    const { getByText } = render(<Story />);
    await waitFor(() => getByText("Option A"));
    fireEvent.press(getByText("Option A"));
    await waitFor(() => getByText("Option B"));
    expect(spy).toHaveBeenLastCalledWith({
      template_id: "fantasy",
      summary: "sum-1",
      chosen_scenario: "Option A",
    });
    // scene one is still on screen (finished scenes persist)
    expect(getByText(/Scene one/)).toBeTruthy();
  });

  it("keeps partial text and offers retry on a mid-stream error", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValue(
      fixtureStream([
        { type: "token", t: "Half a scene " },
        { type: "stream_error", status: 503, detail: "busy" },
      ])
    );

    const { getByText } = render(<Story />);
    await waitFor(() => expect(getByText(/muse is busy/i)).toBeTruthy());
    expect(getByText(/Half a scene/)).toBeTruthy(); // partial text preserved
  });

  it("shows the daily-quota message for 429 frames", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValue(
      fixtureStream([{ type: "stream_error", status: 429, detail: "quota" }])
    );
    const { getByText } = render(<Story />);
    await waitFor(() => expect(getByText(/out of muse for today/i)).toBeTruthy());
  });

  it("retry re-runs the same turn", async () => {
    const spy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(
        fixtureStream([{ type: "stream_error", status: 503, detail: "busy" }])
      )
      .mockReturnValueOnce(
        fixtureStream([
          { type: "token", t: "Fresh scene." },
          { type: "turn_complete", summary: "s2", scenarios: ["A"] },
        ])
      );

    const { getByText } = render(<Story />);
    await waitFor(() => getByText(/tap to retry/i));
    fireEvent.press(getByText(/tap to retry/i));
    await waitFor(() => getByText(/Fresh scene/));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toEqual(spy.mock.calls[1][0]); // identical request
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `client/`): `npx jest --watchAll=false`
Expected: FAIL (no story route).

- [ ] **Step 3: Implement**

Create `client/app/story.tsx` implementing the binding behavior above. Suggested state shape:

```ts
const [scenes, setScenes] = useState<string[]>([]);
const [currentScene, setCurrentScene] = useState("");
const [options, setOptions] = useState<string[]>([]);
const [summary, setSummary] = useState(premise);
const [pendingTurn, setPendingTurn] = useState<TurnRequest | null>(null); // kept for retry
const [error, setError] = useState<{ status: number; detail: string } | null>(null);
```

One `runTurn(req: TurnRequest)` async function drives everything: clears error + currentScene, saves `pendingTurn = req`, then `for await (const ev of streamTurn(req))` switching on `ev.type` (token → append to currentScene; turn_complete → commit scene, set summary/options, clear pendingTurn; stream_error → set error, leave currentScene as-is). Kick off turn 1 in a `useEffect` with an empty dep array guarded against double-run (React strict mode) via a ref. Scenes scroll in a `ScrollView` that follows growth (`onContentSizeChange` → `scrollToEnd`). Error banner messages exactly as specified. (Exact JSX is the implementer's; behaviors and test-compat are binding.)

- [ ] **Step 4: Run tests to verify they pass**

Run (in `client/`): `npx jest --watchAll=false` and `npx tsc --noEmit`
Expected: ALL client tests pass; types clean.

- [ ] **Step 5: Commit**

```bash
git add client/app
git commit -m "feat(client): Story screen — streaming loop, option cards, failure UX"
```

---

### Task 6: Wire-up verification, docs, ship

**Files:**
- Create: `client/.env.example` (EXPO_PUBLIC_API_URL, EXPO_PUBLIC_USE_MOCK documented)
- Modify: `CLAUDE.md` (client section: how to run, what exists)

- [ ] **Step 1: Full client + backend suites green**

Run: `cd client && npx jest --watchAll=false && npx tsc --noEmit`, then at root `venv/Scripts/python.exe -m pytest tests/ -v`.
Expected: all client suites pass; backend still 45/45 (untouched).

- [ ] **Step 2: Static web build proves the app compiles for web**

Run (in `client/`): `npx expo export --platform web`
Expected: build completes without errors (output in `client/dist/`, git-ignored — verify it is; add to `client/.gitignore` if the template didn't).

- [ ] **Step 3: `client/.env.example`**

```
# Where the Storyteller backend lives. Browser dev: localhost. Phone (Expo Go):
# your PC's LAN IP, e.g. http://192.168.1.23:8000
EXPO_PUBLIC_API_URL=http://localhost:8000
# 1 = story turns use the backend's mock stream (zero AI cost; backend needs
# DEV_MOCK_ENABLED=1 in ITS .env). Unset for real Gemini.
EXPO_PUBLIC_USE_MOCK=1
```

- [ ] **Step 4: Update CLAUDE.md**

Add a "Client app (`client/`)" subsection under What's BUILT: Expo Router + TS; screens (Home: genre cards + premise seeds; Story: streaming loop); `lib/sse.ts` incremental parser + `lib/api.ts` (single error channel, plain-HTTP errors mapped to stream_error); `StreamingText` (word materialize animation; network-ignorant); env config (`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_USE_MOCK`); how to run — backend `uvicorn main:app --reload` + `cd client && npx expo start --web` (mock needs backend `DEV_MOCK_ENABLED=1`); client test command `cd client && npx jest --watchAll=false`. Update "Environment / how to run" with the client commands too.

- [ ] **Step 5: Commit + push**

```bash
git add client CLAUDE.md
git commit -m "feat(client): env example + docs; slice B complete"
git push
```

- [ ] **Step 6: Hand the demo to the human**

The visual/interactive proof is the project owner's moment, not an agent's: instructions to run backend + `npx expo start --web`, open the browser, play a full mock story loop, and (on fresh quota or paid tier) a real one. Report what to check: words materialize smoothly; options render; errors show friendly messages; nothing already-shown ever disappears.

---

## Self-Review

**Spec coverage:** Streaming story view + signature animation → Tasks 3/5. Template picker + premise seeds → Task 4. `lib/api.ts` one module for backend talk, SSE over streaming fetch, base URL config → Task 2. Failure UX exact messages + keep-shown-text → Task 5. Don't hardcode 3 cards → Task 5 renders arriving count (tests use 1- and 2-card fixtures deliberately). Error-frames-over-200 / open enum → Task 2 (single error channel) + Task 5 (message mapping incl. default). Mock-first development → `EXPO_PUBLIC_USE_MOCK`. Tests for StreamingText + parser → Tasks 2/3. Monorepo placement → Task 1 (with the `client/` naming deviation from the spec's `app/`, justified: Expo Router occupies `app/` inside the project; recorded here as an approved plan-level deviation). `/suggest` unused by the app — deliberate, noted in Global Constraints. ✓

**Placeholder scan:** Tasks 4/5 Step 3 delegate exact JSX to the implementer while binding behavior via complete test code — deliberate: tests are the spec, pixel styling is not. No TBDs. ✓

**Type consistency:** `StreamEvent` union defined once in `sse.ts`, imported by `api.ts` and tests; `streamTurn(body: TurnRequest)` consumed in Task 5's tests with exact call-shape assertions; `Template.premise_seeds` matches backend's `GET /templates`. `streamingFetch` seam defined in Task 2 and mocked in its tests. ✓

**Known accepted quirks:** scaffold internals (SDK version, template file names, `reset-project` availability) may drift from this plan — Global Constraints authorize adaptation with reporting. jest-expo mocks Reanimated, so animation behavior is verified visually in Task 6, not in unit tests.
