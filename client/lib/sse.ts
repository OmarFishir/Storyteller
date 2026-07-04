export type StreamEvent =
  | { type: "token"; t: string }
  | { type: "turn_complete"; summary: string; scenarios: string[] }
  | { type: "reply_token"; t: string }
  | { type: "discussion_complete"; notes: string }
  | { type: "route"; intent: "pick"; index: number }
  | { type: "route"; intent: "steer" }
  | { type: "route"; intent: "options"; scenarios: string[] }
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
    // Last "data:" line wins — the backend emits single-line JSON payloads only.
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
    if (event === "reply_token")
      return { type: "reply_token", t: String(payload.t ?? "") };
    if (event === "discussion_complete")
      return { type: "discussion_complete", notes: String(payload.notes ?? "") };
    if (event === "route") {
      if (payload.intent === "pick")
        return { type: "route", intent: "pick", index: Number(payload.index ?? -1) };
      if (payload.intent === "steer") return { type: "route", intent: "steer" };
      if (payload.intent === "options")
        return {
          type: "route",
          intent: "options",
          scenarios: Array.isArray(payload.scenarios)
            ? payload.scenarios.map(String)
            : [],
        };
      // A route frame we can't act on is a broken contract, not forward-compat.
      return { type: "stream_error", status: 500, detail: "Malformed stream frame." };
    }
  } catch {
    return { type: "stream_error", status: 500, detail: "Malformed stream frame." };
  }
  return null; // unknown event → ignore
}
