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
