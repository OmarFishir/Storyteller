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
  const REQ = { template_id: "fantasy", summary: "s", chosen_scenario: "c", turn: 1, length: "short" as const };

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

  it("maps a mid-stream read failure into stream_error status 0", async () => {
    let readCount = 0;
    const fakeRes = {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => {
            readCount += 1;
            if (readCount === 1) {
              return Promise.resolve({
                done: false,
                value: new TextEncoder().encode('event: scene_token\ndata: {"t": "First "}\n\n'),
              });
            }
            return Promise.reject(new Error("connection reset"));
          },
        }),
      },
    } as unknown as Response;
    jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(fakeRes);

    const events = [];
    for await (const ev of streamTurn(REQ)) events.push(ev);
    expect(events[0]).toEqual({ type: "token", t: "First " });
    expect(events[events.length - 1]).toMatchObject({ type: "stream_error", status: 0 });
  });

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
          // Rejected on purpose: exercises the finally block's swallow of a
          // cancel() rejection (the stream already errored/aborted upstream),
          // proving it never surfaces as an unhandled promise rejection.
          cancel: jest.fn(() => Promise.reject(new Error("stream already errored"))),
        }),
      },
    } as unknown as Response;
    jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(fakeRes);

    const events = [];
    for await (const ev of streamTurn(REQ)) events.push(ev);
    expect(events).toEqual([{ type: "token", t: "First " }]); // tokens kept, NO error event
  });

  it("passes the AbortSignal through to fetch and cancels the reader on early exit", async () => {
    const cancel = jest.fn(() => Promise.resolve());
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
});
