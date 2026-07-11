import { getVoiceOut, __resetVoiceOutForTests } from "../voiceOut";

// --- fakes -------------------------------------------------------------------
class FakeAudio {
  static instances: FakeAudio[] = [];
  // Next play() returns this — set a rejected promise to simulate iOS
  // autoplay policy. Reset to resolved in beforeEach.
  static playResult: Promise<void> = Promise.resolve();
  src = "";
  muted = false;
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  playCalls: Array<{ src: string; muted: boolean }> = [];
  constructor() {
    FakeAudio.instances.push(this);
  }
  play() {
    this.paused = false;
    this.playCalls.push({ src: this.src, muted: this.muted });
    return FakeAudio.playResult;
  }
  pause() {
    this.paused = true;
  }
}

const mockSpeechSynthesis = {
  speak: jest.fn(),
  cancel: jest.fn(),
  speaking: undefined as boolean | undefined,
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
    FakeAudio.playResult = Promise.resolve();
    mockSpeechSynthesis.speaking = undefined;
    __resetVoiceOutForTests();
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

  it("a second speak() supersedes the first on the same shared element", async () => {
    jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(okWav());
    const out = getVoiceOut();
    out.speak("First");
    await flush();
    await flush();
    out.speak("Second");
    await flush();
    await flush();
    expect(FakeAudio.instances).toHaveLength(1); // ONE element, reused
    expect(FakeAudio.instances[0].playCalls).toHaveLength(2);
    expect(FakeAudio.instances[0].paused).toBe(false); // second is live
  });

  it("an autoplay-blocked play() flips speaking false and does NOT fall back", async () => {
    jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(okWav());
    FakeAudio.playResult = Promise.reject(new Error("NotAllowedError"));
    const out = getVoiceOut();
    const states: boolean[] = [];
    out.onSpeakingChange((s) => states.push(s));
    out.speak("Blocked narration");
    await flush();
    await flush();
    await flush();
    expect(states).toEqual([true, false]); // the UI never hangs in "speaking"
    // On iOS the device voice is equally gesture-gated and fails SILENTLY —
    // falling back would hang forever, so it must not be attempted.
    expect(mockSpeechSynthesis.speak).not.toHaveBeenCalled();
  });

  it("revokes the blob URL when playback ends naturally (leak fix)", async () => {
    jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(okWav());
    const out = getVoiceOut();
    out.speak("Short scene.");
    await flush();
    await flush();
    FakeAudio.instances[0].onended?.();
    const g = globalThis as never as { URL: { revokeObjectURL: jest.Mock } };
    expect(g.URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("unavailable without any audio capability", () => {
    cleanupAudioGlobals();
    expect(getVoiceOut().available).toBe(false);
    installAudioGlobals(); // for afterEach symmetry
  });

  describe("unlock()", () => {
    it("blesses the shared element with a muted silent play inside the tap", async () => {
      const out = getVoiceOut();
      out.unlock();
      expect(FakeAudio.instances).toHaveLength(1);
      const el = FakeAudio.instances[0];
      expect(el.playCalls).toEqual([
        { src: expect.stringContaining("data:audio/wav"), muted: true },
      ]);
      await flush();
      expect(el.paused).toBe(true); // parked again once the bless landed
      expect(el.muted).toBe(false); // ready for real narration
    });

    it("is idempotent — a second unlock() doesn't play again", () => {
      const out = getVoiceOut();
      out.unlock();
      out.unlock();
      expect(FakeAudio.instances[0].playCalls).toHaveLength(1);
    });

    it("swallows a no-gesture rejection and retries on the next call", async () => {
      FakeAudio.playResult = Promise.reject(new Error("NotAllowedError"));
      const out = getVoiceOut();
      out.unlock();
      await flush();
      FakeAudio.playResult = Promise.resolve();
      out.unlock(); // the failed bless didn't stick — this must try again
      expect(FakeAudio.instances[0].playCalls).toHaveLength(2);
    });

    it("no-ops without an Audio global (device-voice-only browsers)", () => {
      cleanupAudioGlobals();
      const g = globalThis as never as Record<string, unknown>;
      g.speechSynthesis = mockSpeechSynthesis;
      g.SpeechSynthesisUtterance = FakeUtterance;
      expect(() => getVoiceOut().unlock()).not.toThrow();
      installAudioGlobals(); // afterEach symmetry
    });

    it("the bless survives across getVoiceOut() instances (Home taps, Story plays)", async () => {
      getVoiceOut().unlock(); // Home's Begin button
      await flush();
      jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(okWav());
      getVoiceOut().speak("Scene one."); // Story narrates via a FRESH instance
      await flush();
      await flush();
      expect(FakeAudio.instances).toHaveLength(1); // reused, not re-minted
      expect(FakeAudio.instances[0].paused).toBe(false);
    });

    it("never hijacks a live narration to bless (post-rejection retry during playback)", async () => {
      FakeAudio.playResult = Promise.reject(new Error("NotAllowedError"));
      const out = getVoiceOut();
      out.unlock(); // rejected: unlocked resets, element parked
      await flush();
      FakeAudio.playResult = Promise.resolve();
      jest.spyOn(require("../fetch"), "streamingFetch").mockResolvedValue(okWav());
      out.speak("Live narration");
      await flush();
      await flush();
      const el = FakeAudio.instances[0];
      expect(el.paused).toBe(false); // narration is playing
      out.unlock(); // retry lands mid-playback: must be a no-op
      expect(el.src).toBe("blob:fake"); // narration NOT hijacked
      expect(el.muted).toBe(false);
      expect(el.playCalls).toHaveLength(2); // silent attempt + narration only
    });
  });
});
