import { getVoiceIn, VoiceCallbacks } from "../voice";

// --- fakes: MediaRecorder + getUserMedia + fetch seam -----------------------
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = jest.fn(() => true);
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: unknown, public options?: { mimeType?: string }) {
    FakeMediaRecorder.instances.push(this);
    if (options?.mimeType) this.mimeType = options.mimeType;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["chunk"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const mockTrack = { stop: jest.fn() };
const mockStream = { getTracks: () => [mockTrack] };

function installMediaGlobals(getUserMedia = jest.fn(() => Promise.resolve(mockStream))) {
  (globalThis as never as { MediaRecorder: unknown }).MediaRecorder =
    FakeMediaRecorder;
  (globalThis as never as { navigator: unknown }).navigator = {
    mediaDevices: { getUserMedia },
  };
  return getUserMedia;
}

function cleanupMediaGlobals() {
  delete (globalThis as never as { MediaRecorder?: unknown }).MediaRecorder;
  delete (globalThis as never as { navigator?: unknown }).navigator;
}

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

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("getVoiceIn (web v2: record -> upload -> transcribe)", () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    mockTrack.stop.mockClear();
  });
  afterEach(cleanupMediaGlobals);

  it("is unavailable without mediaDevices or MediaRecorder", () => {
    cleanupMediaGlobals();
    expect(getVoiceIn().available).toBe(false);
  });

  it("stop() uploads the clip and delivers the transcript; tracks released", async () => {
    installMediaGlobals();
    const fetchSpy = jest
      .spyOn(require("../fetch"), "streamingFetch")
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ transcript: " she walks in " }),
      } as never);

    const voice = getVoiceIn();
    const c = cb();
    voice.start(c);
    await flush(); // getUserMedia resolves, recorder starts
    expect(FakeMediaRecorder.instances[0].state).toBe("recording");

    voice.stop();
    await flush(); // onstop -> upload -> json
    await flush();

    expect(c.finals).toEqual(["she walks in"]); // trimmed
    expect(c.interims).toEqual([]); // web v2 never emits interim words
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/transcribe");
    expect((fetchSpy.mock.calls[0][1] as { body: FormData }).body).toBeInstanceOf(
      FormData
    );
    expect(mockTrack.stop).toHaveBeenCalled(); // no hot mic
  });

  it("abort() discards: no upload, no callbacks, tracks released", async () => {
    installMediaGlobals();
    const fetchSpy = jest.spyOn(require("../fetch"), "streamingFetch");

    const voice = getVoiceIn();
    const c = cb();
    voice.start(c);
    await flush();
    voice.abort();
    await flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(c.finals).toEqual([]);
    expect(c.errors).toEqual([]);
    expect(mockTrack.stop).toHaveBeenCalled();
  });

  it("permission denial maps to the friendly message", async () => {
    installMediaGlobals(jest.fn(() => Promise.reject(new Error("denied"))));
    const voice = getVoiceIn();
    const c = cb();
    voice.start(c);
    await flush();
    expect(c.errors[0]).toMatch(/microphone permission/i);
  });

  it("a failed transcription surfaces via onError, not onFinal", async () => {
    installMediaGlobals();
    jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ detail: "The AI model is busy right now." }),
    } as never);

    const voice = getVoiceIn();
    const c = cb();
    voice.start(c);
    await flush();
    voice.stop();
    await flush();
    await flush();

    expect(c.finals).toEqual([]);
    expect(c.errors[0]).toMatch(/busy/i);
  });

  it("an empty transcript delivers nothing (no onFinal, no error)", async () => {
    installMediaGlobals();
    jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ transcript: "   " }),
    } as never);

    const voice = getVoiceIn();
    const c = cb();
    voice.start(c);
    await flush();
    voice.stop();
    await flush();
    await flush();

    expect(c.finals).toEqual([]);
    expect(c.errors).toEqual([]);
  });

  it("a second start() discards the superseded session (no upload from it)", async () => {
    installMediaGlobals();
    const fetchSpy = jest.spyOn(require("../fetch"), "streamingFetch");
    const voice = getVoiceIn();
    voice.start(cb());
    await flush();
    voice.start(cb()); // supersede
    await flush();
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled(); // first session discarded silently
    expect(FakeMediaRecorder.instances[1].state).toBe("recording");
  });
});
