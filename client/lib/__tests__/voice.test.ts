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

  it("a second start aborts the superseded session - no orphaned mic", () => {
    const voice = getVoiceIn();
    const c1 = cb();
    voice.start(c1);
    FakeRecognition.instances[0].onresult!(
      resultEvent([{ text: "orphaned words", final: true }])
    );
    const c2 = cb();
    voice.start(c2);
    expect(FakeRecognition.instances[0].aborted).toBe(true);
    expect(c1.finals).toEqual([]); // superseded session delivers no final
    expect(FakeRecognition.instances[1].started).toBe(true);
  });
});
