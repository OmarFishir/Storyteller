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
