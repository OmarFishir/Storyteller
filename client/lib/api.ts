import { SSEParser, StreamEvent } from "./sse";
import { streamingFetch } from "./fetch";

export type Template = {
  id: string;
  name: string;
  description: string;
  premise_seeds: string[];
};
export type StoryLength = "short" | "medium" | "long";
export type TurnRequest = {
  template_id: string;
  summary: string;
  chosen_scenario: string;
  turn: number;
  length: StoryLength;
  notes?: string;
};
export type DiscussionEntry = { role: "user" | "ai"; text: string };
export type ConverseRequest = {
  template_id: string;
  utterance: string;
  summary: string;
  notes: string;
  options: string[];
  discussion: DiscussionEntry[];
  turn: number;
  length: StoryLength;
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
 * Shared SSE POST driver. Error policy (per spec): once streaming starts,
 * errors arrive as frames over HTTP 200. Plain HTTP errors (404/403/422
 * before the stream) are mapped into the SAME stream_error channel so the UI
 * has ONE error path.
 */
async function* streamPost(
  url: string,
  body: unknown,
  opts?: { signal?: AbortSignal }
): AsyncGenerator<StreamEvent> {
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
    // Flush any buffered partial multi-byte character at stream end.
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
      reader?.cancel()?.catch?.(() => {});
    } catch {}
  }
}

/** Run one story turn against POST /continue/stream, yielding StreamEvents. */
export function streamTurn(
  body: TurnRequest,
  opts?: { signal?: AbortSignal }
): AsyncGenerator<StreamEvent> {
  return streamPost(
    `${API_URL}/continue/stream${USE_MOCK ? "?mock=true" : ""}`,
    body,
    opts
  );
}

/** Run one discussion turn against POST /converse/stream, yielding StreamEvents. */
export function converse(
  body: ConverseRequest,
  opts?: { signal?: AbortSignal }
): AsyncGenerator<StreamEvent> {
  return streamPost(
    `${API_URL}/converse/stream${USE_MOCK ? "?mock=true" : ""}`,
    body,
    opts
  );
}

export type BibleEntry = { name: string; description: string };
export type BibleResponse = {
  characters: BibleEntry[];
  places: BibleEntry[];
  environment: string;
};

// Mock mode never spends AI on the bible either — a canned extraction that
// matches the canned mock story (Mira, the iron door, the lower stacks).
const MOCK_BIBLE: BibleResponse = {
  characters: [
    {
      name: "Mira",
      description:
        "An apprentice mapmaker following a corridor that appears on no map, stubborn enough to open doors she shouldn't.",
    },
  ],
  places: [
    {
      name: "The forbidden lower stacks",
      description:
        "The library's deep levels, where a cold iron door hides a map of the kingdom that draws itself.",
    },
  ],
  environment:
    "A vast library-city of candlelight and ink, where maps misbehave and corridors exist only for those who walk them.",
};

/** One-shot story-bible extraction from the running summary + notes canon. */
export async function getBible(
  summary: string,
  notes: string
): Promise<BibleResponse> {
  if (USE_MOCK) return MOCK_BIBLE;
  const res = await streamingFetch(`${API_URL}/bible`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary, notes }),
  });
  if (!res.ok) throw new Error(`Story bible failed (${res.status})`);
  return (await res.json()) as BibleResponse;
}
