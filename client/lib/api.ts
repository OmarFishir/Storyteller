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
