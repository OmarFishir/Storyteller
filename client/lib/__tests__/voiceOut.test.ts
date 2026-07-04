import { getVoiceOut } from "../voiceOut";

// --- fakes -------------------------------------------------------------------
class FakeAudio {
  static instances: FakeAudio[] = [];
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

const mockSpeechSynthesis = {
  speak: jest.fn(),
  cancel: jest.fn(),
};

class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

function installAudioGlobals() {
  const g = globalThis as never as Record<string, unknown>;
  g.Audio = FakeAudio;
  g.speechSynthesis = mockSpeechSynthesis;
  g.SpeechSynthesisUtterance = FakeUtterance;
  g.URL = { createObjectURL: jest.fn(() => "blob:fake"), revokeObjectURL: jest.fn() };
}

function cleanupAudioGlobals() {
  const g = globalThis as never as Record<string, unknown>;
  delete g.Audio;
  delete g.speechSynthesis;
  delete g.SpeechSynthesisUtterance;
  delete g.URL;
}

const okWav = () =>
  ({
    ok: true,
    status: 200,
    blob: () => Promise.resolve(new Blob(["RIFF"], { type: "audio/wav" })),
  }) as never;

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("getVoiceOut", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    mockSpeechSynthesis.speak.mockClear();
    mockSpeechSynthesis.cancel.mockClear();
    installAudioGlobals();
  });
  afterEach(cleanupAudioGlobals);

  it("speak() narrates via /narrate and plays the WAV; state flips on/off", async () => {
    const fetchSpy = jest
      .spyOn(require("../fetch"), "streamingFetch")
      .mockResolvedValue(okWav());
    const out = getVoiceOut();
    const states: boolean[] = [];
    out.onSpeakingChange((s) => states.push(s));

    out.speak("The rain fell.", { kind: "scene" });
    expect(states).toEqual([true]); // pipeline active before playback starts
    await flush();
    await flush();

    expect(String(fetchSpy.mock.calls[0][0])).toContain("/narrate");
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body)).toEqual({
      text: "The rain fell.",
      kind: "scene",
    });
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].paused).toBe(false);
    expect(states).toEqual([true]);

    FakeAudio.instances[0].onended?.();
    expect(states).toEqual([true, false]);
  });

  it("state flips true at speak() time, before the audio arrives (stop stays reachable)", async () => {
    let resolveFetch: (v: unknown) => void;
    jest
      .spyOn(require("../fetch"), "streamingFetch")
      .mockReturnValue(new Promise((r) => (resolveFetch = r)) as never);
    const out = getVoiceOut();
    const states: boolean[] = [];
    out.onSpeakingChange((s) => states.push(s));
    out.speak("Slow narration");
    expect(states).toEqual([true]); // pipeline active before playback
    out.stop();
    expect(states).toEqual([true, false]);
    resolveFetch!({ ok: true, status: 200, blob: () => Promise.resolve(new Blob(["RIFF"])) });
    await new Promise((r) => setTimeout(r, 0));
    expect(states).toEqual([true, false]); // stale narration stays dead
  });

  it("stop() halts playback mid-word and flips state off", async () => {
    jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(okWav());
    const out = getVoiceOut();
    const states: boolean[] = [];
    out.onSpeakingChange((s) => states.push(s));
    out.speak("Long narration");
    await flush();
    await flush();
    out.stop();
    expect(FakeAudio.instances[0].paused).toBe(true);
    expect(states).toEqual([true, false]);
  });

  it("a narrate failure falls back to the device voice", async () => {
    jest
      .spyOn(require("../fetch"), "streamingFetch")
      .mockResolvedValue({ ok: false, status: 429, json: () => Promise.resolve({}) } as never);
    const out = getVoiceOut();
    out.speak("Quota gone");
    await flush();
    await flush();
    expect(mockSpeechSynthesis.speak).toHaveBeenCalledTimes(1);
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("stop() while the fetch is in flight means the audio never plays", async () => {
    let resolveFetch: (v: unknown) => void;
    jest
      .spyOn(require("../fetch"), "streamingFetch")
      .mockReturnValue(new Promise((r) => (resolveFetch = r)) as never);
    const out = getVoiceOut();
    out.speak("Slow narration");
    out.stop(); // brake before the audio arrives
    resolveFetch!(okWav());
    await flush();
    await flush();
    expect(FakeAudio.instances).toHaveLength(0); // stale narration discarded
  });

  it("a second speak() supersedes the first", async () => {
    jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(okWav());
    const out = getVoiceOut();
    out.speak("First");
    await flush();
    await flush();
    out.speak("Second");
    await flush();
    await flush();
    expect(FakeAudio.instances[0].paused).toBe(true); // first halted
    expect(FakeAudio.instances[1].paused).toBe(false);
  });

  it("unavailable without any audio capability", () => {
    cleanupAudioGlobals();
    expect(getVoiceOut().available).toBe(false);
    installAudioGlobals(); // for afterEach symmetry
  });
});
