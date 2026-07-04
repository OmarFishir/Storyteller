# The Audio Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app hears you correctly and talks back — server-side Gemini STT replaces Chrome's garbling recognizer behind the same `VoiceIn` interface, and a new `VoiceOut` abstraction auto-narrates every scene and reply with a quality Gemini voice, falling back to the device voice so the story is never silent.

**Architecture:** Two new backend endpoints on the EXISTING Gemini key: `POST /transcribe` (multipart audio → `{"transcript"}`; audio bills as ordinary input tokens so the existing meter captures it) and `POST /narrate` (`{"text","kind"}` → WAV bytes; new `TTS_MODEL` + `tts` usage label; raw PCM from the API is wrapped in a WAV header with the stdlib `wave` module). Client: `VoiceIn` v2 records via `MediaRecorder` and uploads on release (Chrome's `SpeechRecognition` impl is retired); new `lib/voiceOut.ts` plays `/narrate` audio, downgrades to `speechSynthesis` on any failure, and is always stoppable mid-word; Story speaks each completed scene/reply, the ■ Stop control silences audio too, and holding the mic interrupts narration. `isSpeaking` is deliberately separate from `isStreaming`.

**Tech Stack:** Existing FastAPI backend + `google-genai` SDK (multimodal input + TTS models, verified against current SDK docs); ONE new backend dependency: `python-multipart` (FastAPI's `UploadFile` requires it). Existing Expo SDK 57 client; zero new client dependencies (browser `MediaRecorder`, `Audio`, `speechSynthesis`).

## Global Constraints

- Spec governs: `docs/superpowers/specs/2026-07-04-audio-slice-design.md`. Owner decisions binding: everything speaks automatically (scenes AND replies), always stoppable; browser-first with phone-ready seams; all-Gemini on the existing key; device voice is the automatic fallback (never silence); mock mode (`EXPO_PUBLIC_USE_MOCK=1`) always uses the device voice and never calls `/narrate`.
- Audio can never block or damage the story: no error banner for a mute narrator (fallback or stderr log); a failed transcription uses the existing inline PTT error spot; audio never touches the turn/beat clock, summary, notes, or canonical `scenes`.
- Commands: backend `venv/Scripts/python.exe -m pytest tests/ -v` (103 now); client (in `client/`) `npx jest --watchAll=false` (80 now) and `npx tsc --noEmit`.
- HARD-WON CLIENT FACTS: RNTL pinned EXACT `13.3.3` + `react-test-renderer` `19.2.3`; `client/.npmrc` legacy-peer-deps; jest-setup Reanimated mock covers only `Animated.Text`/`View` + `FadeInDown.duration()`; jest `restoreMocks: true` (module-factory `jest.fn()`s persist — clear in `beforeEach`; mock-factory variables must be `mock`-prefixed).
- Gemini is NEVER reached from tests (conftest tripwire backend; interface mocks client-side).
- Usage labels exactly `stt` and `tts`; budgets/constants exactly as defined in Tasks 1–2. All Gemini calls retry 5xx with 1s/2s/4s backoff, map 429 → clean 429 (`DETAIL_QUOTA`), exhaustion → 503 (`DETAIL_MODEL_BUSY`), empty output → 502 (established contract).
- `VoiceIn`'s public interface (`available/start/stop/abort`, `VoiceCallbacks{onInterim,onFinal,onError}`) does NOT change — the web v2 impl simply never calls `onInterim`; `PushToTalk` renders "listening…"/"transcribing…" from press state instead.
- Commits: conventional style + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Push at Task 6.
- SDD ledger: `.superpowers/sdd/progress.md` (append per-task status as established).

---

### Task 1: `POST /transcribe` — the ears

**Files:**
- Modify: `main.py`, `requirements.txt` (add `python-multipart`)
- Test: `tests/test_audio.py` (new file)

**Interfaces:**
- Produces (Task 3 consumes over HTTP): `POST /transcribe`, multipart field name `audio` → `{"transcript": "<stripped text>"}`; 413 over `MAX_AUDIO_BYTES = 2_000_000`; 422 when the field is missing; Gemini errors surface via the established 429/503/502 mapping. Constants: `TRANSCRIBE_PROMPT`, `STT_BUDGET = 200`, `MAX_AUDIO_BYTES`. Usage label `stt`.
- Modifies: `call_gemini`'s `contents` parameter type widens from `str` to `str | list` (pure pass-through to the SDK; no behavior change — pinned by the existing suite staying green).

- [ ] **Step 1: Install the dependency**

Add `python-multipart` on its own line to `requirements.txt`, then run:
`venv/Scripts/python.exe -m pip install python-multipart`
(FastAPI's `UploadFile`/`File` form handling imports it lazily; without it the endpoint 500s at request time.)

- [ ] **Step 2: Write the failing tests**

Create `tests/test_audio.py`:

```python
"""
Tests for the audio slice: /transcribe (ears) and /narrate (mouth).

parse-helpers/TestClient duplicated from test_api.py on purpose (tests aren't
a package; consolidation rides with the Phase-3 split). Gemini is never
called — conftest's tripwire enforces it.
"""

import io
import wave

import pytest
from fastapi.testclient import TestClient

import main

client = TestClient(main.app)


def _post_audio(data: bytes, filename="clip.webm", mime="audio/webm"):
    return client.post("/transcribe", files={"audio": (filename, data, mime)})


def test_transcribe_returns_stripped_transcript(monkeypatch):
    captured = {}

    def fake_gemini(contents, **kwargs):
        captured["kwargs"] = kwargs
        captured["contents"] = contents
        return "  she walks into the rain \n"

    monkeypatch.setattr(main, "call_gemini", fake_gemini)
    resp = _post_audio(b"fake-webm-bytes")
    assert resp.status_code == 200
    assert resp.json() == {"transcript": "she walks into the rain"}
    assert captured["kwargs"]["label"] == "stt"
    assert captured["kwargs"]["max_tokens"] == main.STT_BUDGET
    assert captured["kwargs"]["temperature"] == 0.0
    # contents = [static prompt, audio part] — order pinned (static first)
    assert captured["contents"][0] == main.TRANSCRIBE_PROMPT
    part = captured["contents"][1]
    assert part.inline_data.data == b"fake-webm-bytes"
    assert part.inline_data.mime_type == "audio/webm"


def test_transcribe_passes_client_mime_through(monkeypatch):
    captured = {}
    monkeypatch.setattr(
        main,
        "call_gemini",
        lambda contents, **kw: captured.update(part=contents[1]) or "hi",
    )
    resp = _post_audio(b"x", filename="clip.m4a", mime="audio/mp4")
    assert resp.status_code == 200
    assert captured["part"].inline_data.mime_type == "audio/mp4"


def test_transcribe_oversized_audio_is_413(monkeypatch):
    def tripwire(*a, **kw):  # oversize must be rejected BEFORE any model call
        raise AssertionError("call_gemini must not be reached")

    monkeypatch.setattr(main, "call_gemini", tripwire)
    resp = _post_audio(b"x" * (main.MAX_AUDIO_BYTES + 1))
    assert resp.status_code == 413


def test_transcribe_missing_file_is_422():
    resp = client.post("/transcribe")
    assert resp.status_code == 422


def test_transcribe_maps_gemini_errors(monkeypatch):
    from fastapi import HTTPException

    def busy(contents, **kw):
        raise HTTPException(status_code=503, detail=main.DETAIL_MODEL_BUSY)

    monkeypatch.setattr(main, "call_gemini", busy)
    resp = _post_audio(b"x")
    assert resp.status_code == 503
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_audio.py -v`
Expected: FAIL — 404 (no `/transcribe` route) and `AttributeError` on the new constants.

- [ ] **Step 4: Implement**

In `main.py`:

Add to the imports from fastapi: `from fastapi import FastAPI, HTTPException, UploadFile, File` and add `from fastapi.responses import StreamingResponse, Response` (Response is used by Task 2; adding it now is harmless). Add `from google.genai import types` below the existing `from google.genai import errors`.

Widen `call_gemini`'s signature (annotation only — the body already passes `contents` straight to the SDK):

```python
def call_gemini(
    contents: str | list, max_tokens: int, temperature: float, label: str = "unlabeled"
) -> str:
```

Add after the `/expand` endpoint (constants near the other prompt constants):

```python
# --- Audio slice: the ears -------------------------------------------------
# Audio input bills as ordinary input tokens (~30/sec of speech), so the
# existing token meter captures STT cost with no schema change.
TRANSCRIBE_PROMPT = """Transcribe this audio recording verbatim.
Output ONLY the words that were spoken — no punctuation editorializing beyond
normal sentence punctuation, no commentary, no labels, no quotes. If the
audio contains no discernible speech, output nothing."""

STT_BUDGET = 200  # a push-to-talk utterance is a sentence or two
MAX_AUDIO_BYTES = 2_000_000  # ~2MB; a PTT clip is seconds, not minutes


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    """Speech-to-text for push-to-talk: one short clip in, its words out."""
    data = await audio.read()
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Audio clip too large. Push-to-talk clips are seconds long.",
        )
    text = call_gemini(
        [
            TRANSCRIBE_PROMPT,
            types.Part.from_bytes(
                data=data, mime_type=audio.content_type or "audio/webm"
            ),
        ],
        max_tokens=STT_BUDGET,
        temperature=0.0,  # transcription is mechanical: no creativity wanted
        label="stt",
    )
    return {"transcript": text.strip()}
```

(An empty/unusable clip surfaces as `call_gemini`'s existing empty-response 502 — the established contract; no new handling needed.)

- [ ] **Step 5: Run the full backend suite**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (103 + 5 = 108). The widened `contents` annotation changes no behavior — every existing test stays green.

- [ ] **Step 6: Commit**

```bash
git add main.py requirements.txt tests/test_audio.py
git commit -m "feat: POST /transcribe - server-side STT on the existing Gemini key"
```

---

### Task 2: `POST /narrate` — the mouth

**Files:**
- Modify: `main.py`
- Test: `tests/test_audio.py`

**Interfaces:**
- Produces (Task 4 consumes over HTTP): `POST /narrate` with `{"text": str, "kind": "scene"|"reply"}` → `audio/wav` bytes; 413 over `NARRATE_CHAR_CAP = 6000`; Gemini errors via the established mapping. Constants: `TTS_MODEL = "gemini-2.5-flash-preview-tts"` (the id documented in the current SDK; if the live API reports the model unavailable at the Task 6 checkpoint, the newer `gemini-3.1-flash-tts` — Google's April 2026 launch — is the drop-in replacement in this ONE constant), `VOICE_NAME = "charon"`, `TTS_BUDGET = 4000`. Pure helper `pcm_to_wav(pcm: bytes, sample_rate: int = 24000) -> bytes`. Usage label `tts`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_audio.py`:

```python
# --- /narrate ---------------------------------------------------------------

class _FakeInline:
    def __init__(self, data, mime="audio/L16;rate=24000"):
        self.data = data
        self.mime_type = mime


class _FakePart:
    def __init__(self, data):
        self.inline_data = _FakeInline(data)


class _FakeResponse:
    def __init__(self, data, usage=None):
        self.parts = [_FakePart(data)]
        self.usage_metadata = usage


def test_pcm_to_wav_wraps_a_valid_riff_container():
    pcm = b"\x00\x01" * 240  # 10ms of fake 24kHz 16-bit mono
    wav_bytes = main.pcm_to_wav(pcm)
    with wave.open(io.BytesIO(wav_bytes)) as w:
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2
        assert w.getframerate() == 24000
        assert w.readframes(w.getnframes()) == pcm


def test_narrate_returns_wav_and_logs_tts(monkeypatch):
    captured = {}

    def fake_tts(text, **kwargs):
        captured["text"] = text
        return b"PCMBYTES"

    monkeypatch.setattr(main, "call_gemini_tts", fake_tts)
    resp = client.post("/narrate", json={"text": "The rain fell.", "kind": "scene"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("audio/wav")
    assert resp.content == main.pcm_to_wav(b"PCMBYTES")
    assert captured["text"] == "The rain fell."


def test_narrate_char_cap_is_413(monkeypatch):
    def tripwire(*a, **kw):
        raise AssertionError("call_gemini_tts must not be reached")

    monkeypatch.setattr(main, "call_gemini_tts", tripwire)
    resp = client.post(
        "/narrate", json={"text": "x" * (main.NARRATE_CHAR_CAP + 1), "kind": "scene"}
    )
    assert resp.status_code == 413


def test_narrate_missing_text_is_422():
    assert client.post("/narrate", json={"kind": "scene"}).status_code == 422


def test_call_gemini_tts_extracts_pcm_and_logs_usage(monkeypatch):
    calls = {}

    class FakeUsage:
        prompt_token_count = 12
        candidates_token_count = 340

    def fake_generate(model, contents, config):
        calls["model"] = model
        calls["contents"] = contents
        calls["voice"] = (
            config.speech_config.voice_config.prebuilt_voice_config.voice_name
        )
        return _FakeResponse(b"RAWPCM", usage=FakeUsage())

    monkeypatch.setattr(main.client.models, "generate_content", fake_generate)
    logged = {}
    monkeypatch.setattr(
        main.usage_log,
        "log_usage",
        lambda **kw: logged.update(kw),
    )

    pcm = main.call_gemini_tts("Hello there.")
    assert pcm == b"RAWPCM"
    assert calls["model"] == main.TTS_MODEL
    assert calls["voice"] == main.VOICE_NAME
    assert "Hello there." in calls["contents"]
    assert logged["label"] == "tts"
    assert logged["input_tokens"] == 12
    assert logged["output_tokens"] == 340


def test_call_gemini_tts_no_audio_part_is_502(monkeypatch):
    class Empty:
        parts = []
        usage_metadata = None

    monkeypatch.setattr(
        main.client.models, "generate_content", lambda **kw: Empty()
    )
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        main.call_gemini_tts("Hello")
    assert exc.value.status_code == 502


def test_call_gemini_tts_429_maps_clean(monkeypatch):
    from google.genai import errors as genai_errors

    def quota(**kw):
        e = genai_errors.ClientError.__new__(genai_errors.ClientError)
        e.code = 429
        raise e

    monkeypatch.setattr(main.client.models, "generate_content", quota)
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        main.call_gemini_tts("Hello")
    assert exc.value.status_code == 429
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `venv/Scripts/python.exe -m pytest tests/test_audio.py -v`
Expected: the new tests FAIL (`pcm_to_wav`/`call_gemini_tts` missing; 404 on `/narrate`).

- [ ] **Step 3: Implement**

In `main.py`, add `import io` and `import wave` to the stdlib imports, then after the `/transcribe` block:

```python
# --- Audio slice: the mouth --------------------------------------------------
TTS_MODEL = "gemini-2.5-flash-preview-tts"  # swap-in-one-place, like MODEL
VOICE_NAME = "charon"  # v1: one narrator voice; per-genre voices are Phase 4
TTS_BUDGET = 4000  # audio tokens ceiling (~25/sec => ~2.5min of speech)
NARRATE_CHAR_CAP = 6000  # scenes are budget-bounded; this is abuse armor


class NarrateRequest(BaseModel):
    text: str
    kind: Literal["scene", "reply"] = "scene"


def pcm_to_wav(pcm: bytes, sample_rate: int = 24000) -> bytes:
    """Wrap raw 16-bit mono PCM in a WAV container (browsers can't play bare PCM)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def call_gemini_tts(text: str, label: str = "tts") -> bytes:
    """
    ONE TTS request: text in, raw PCM bytes out. Mirrors call_gemini's error
    contract (retry 5xx w/ backoff; clean 429; empty output -> 502) — the
    retry block is now duplicated a third time; extraction is queued for the
    Phase 3 main.py split, consistency wins until then.
    """
    delays = [1, 2, 4]
    for attempt in range(len(delays) + 1):
        try:
            response = client.models.generate_content(
                model=TTS_MODEL,
                contents=text,
                config=types.GenerateContentConfig(
                    response_modalities=["audio"],
                    speech_config=types.SpeechConfig(
                        voice_config=types.VoiceConfig(
                            prebuilt_voice_config=types.PrebuiltVoiceConfig(
                                voice_name=VOICE_NAME
                            )
                        )
                    ),
                    max_output_tokens=TTS_BUDGET,
                ),
            )
            usage = getattr(response, "usage_metadata", None)
            try:
                usage_log.log_usage(
                    label=label,
                    model=TTS_MODEL,
                    input_tokens=(usage.prompt_token_count or 0) if usage else 0,
                    output_tokens=(usage.candidates_token_count or 0) if usage else 0,
                )
            except Exception as e:
                print(f"WARNING: usage logging failed: {e}", file=sys.stderr)
            parts = getattr(response, "parts", None) or []
            for part in parts:
                inline = getattr(part, "inline_data", None)
                if inline is not None and inline.data:
                    return inline.data
            raise HTTPException(
                status_code=502,
                detail="Model returned no audio. Try again.",
            )
        except errors.ClientError as e:
            if getattr(e, "code", None) == 429:
                raise HTTPException(status_code=429, detail=DETAIL_QUOTA)
            raise
        except errors.ServerError:
            if attempt < len(delays):
                time.sleep(delays[attempt])

    raise HTTPException(status_code=503, detail=DETAIL_MODEL_BUSY)


@app.post("/narrate")
def narrate(req: NarrateRequest):
    """Text-to-speech for narration: a finished scene or reply in, WAV out."""
    if len(req.text) > NARRATE_CHAR_CAP:
        raise HTTPException(
            status_code=413,
            detail="Narration text too long.",
        )
    pcm = call_gemini_tts(req.text)
    return Response(content=pcm_to_wav(pcm), media_type="audio/wav")
```

- [ ] **Step 4: Run the full backend suite**

Run: `venv/Scripts/python.exe -m pytest tests/ -v`
Expected: ALL PASS (108 + 7 = 115).

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_audio.py
git commit -m "feat: POST /narrate - Gemini TTS narration, WAV-wrapped, metered as tts"
```

---

### Task 3: `VoiceIn` v2 — record, upload, transcribe

**Files:**
- Rewrite: `client/lib/voice.ts` (same exported interface, new engine)
- Modify: `client/components/PushToTalk.tsx` (status text from press state)
- Test: `client/lib/__tests__/voice.test.ts` (rewrite), `client/components/__tests__/` (PushToTalk status assertions live in the story/index suites' existing coverage — no new component test file)

**Interfaces:**
- Consumes: `streamingFetch` (`client/lib/fetch.ts`), `API_URL` (`client/lib/api.ts`).
- Produces: `getVoiceIn(): VoiceIn` — INTERFACE UNCHANGED (`available`, `start(cb)`, `stop()`, `abort()`; `VoiceCallbacks{onInterim,onFinal,onError}`). Behavior contract: web v2 NEVER calls `onInterim`; `stop()` finishes the recording, uploads, and delivers `onFinal(transcript)` (non-empty only); `abort()` discards with no upload and no callbacks; permission denial → the existing friendly message via `onError`; HTTP/network transcription failure → `onError` with a human message; mic tracks are ALWAYS released (no hot mic — slice C's hard-won lesson).

- [ ] **Step 1: Rewrite the voice tests first**

Replace the entire contents of `client/lib/__tests__/voice.test.ts` with:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `client/`): `npx jest --watchAll=false lib/__tests__/voice.test.ts`
Expected: FAIL — the current implementation looks for `SpeechRecognition`, never `MediaRecorder`.

- [ ] **Step 3: Implement**

Replace the entire contents of `client/lib/voice.ts` with:

```ts
/**
 * VoiceIn v2 — the project's voice-input abstraction (architecture rule #3),
 * now powered by RECORD-THEN-TRANSCRIBE: hold-to-talk records a clip
 * (MediaRecorder), release uploads it to POST /transcribe, and the server's
 * Gemini call returns the words. The Chrome SpeechRecognition engine from
 * slice C is retired — live play showed it garbling natural speech, and
 * recognition quality is exactly what this interface exists to let us swap.
 *
 * Interface contract (unchanged from slice C):
 *   stop()  = finish: upload the clip, deliver onFinal (non-empty only)
 *   abort() = discard: no upload, no callbacks
 * Web v2 NEVER calls onInterim (no live words from server STT) — PushToTalk
 * renders "listening…"/"transcribing…" from press state instead. The
 * callback stays in the interface for future streaming STT and native impls.
 *
 * The phone implementation (record via Expo's audio module, upload the same
 * way — works in plain Expo Go, no dev build) slots in behind this same
 * interface as a follow-up.
 */

import { API_URL } from "./api";
import { streamingFetch } from "./fetch";

export type VoiceCallbacks = {
  onInterim: (transcript: string) => void;
  onFinal: (transcript: string) => void;
  onError: (message: string) => void;
};

export type VoiceIn = {
  available: boolean;
  start: (cb: VoiceCallbacks) => void;
  stop: () => void;
  abort: () => void;
};

type MediaGlobals = {
  navigator?: {
    mediaDevices?: {
      getUserMedia?: (c: { audio: boolean }) => Promise<{
        getTracks: () => Array<{ stop: () => void }>;
      }>;
    };
  };
  MediaRecorder?: {
    new (stream: unknown, options?: { mimeType?: string }): {
      state: string;
      mimeType: string;
      ondataavailable: ((e: { data: Blob }) => void) | null;
      onstop: (() => void) | null;
      start: () => void;
      stop: () => void;
    };
    isTypeSupported?: (mime: string) => boolean;
  };
};

const UNAVAILABLE: VoiceIn = {
  available: false,
  start: () => {},
  stop: () => {},
  abort: () => {},
};

export function getVoiceIn(): VoiceIn {
  const g = globalThis as never as MediaGlobals;
  if (!g.navigator?.mediaDevices?.getUserMedia || !g.MediaRecorder) {
    return UNAVAILABLE;
  }

  type Session = {
    recorder: InstanceType<NonNullable<MediaGlobals["MediaRecorder"]>> | null;
    tracks: Array<{ stop: () => void }>;
    chunks: Blob[];
    discarded: boolean;
    stopRequested: boolean;
  };
  let session: Session | null = null;

  const releaseTracks = (s: Session) => {
    s.tracks.forEach((t) => t.stop());
    s.tracks = [];
  };

  const finishSession = (s: Session, cb: VoiceCallbacks) => {
    // Runs from recorder.onstop: the clip is complete.
    releaseTracks(s);
    if (s.discarded) return;
    const mime = s.recorder?.mimeType || "audio/webm";
    const blob = new Blob(s.chunks, { type: mime });
    if (blob.size === 0) return; // nothing recorded: nothing to deliver
    const form = new FormData();
    form.append("audio", blob, "utterance.webm");
    streamingFetch(`${API_URL}/transcribe`, { method: "POST", body: form })
      .then(async (res) => {
        if (!res.ok) {
          let detail = `Transcription failed (${res.status})`;
          try {
            detail = (await res.json()).detail ?? detail;
          } catch {}
          cb.onError(detail);
          return;
        }
        const transcript = String((await res.json()).transcript ?? "").trim();
        if (transcript) cb.onFinal(transcript);
      })
      .catch(() => {
        cb.onError("Couldn't reach the storyteller to transcribe. Is the backend running?");
      });
  };

  return {
    available: true,
    start(cb: VoiceCallbacks) {
      // Supersede any live session silently (slice C's double-start guard).
      if (session) {
        session.discarded = true;
        try {
          session.recorder?.stop();
        } catch {}
        releaseTracks(session);
      }
      const s: Session = {
        recorder: null,
        tracks: [],
        chunks: [],
        discarded: false,
        stopRequested: false,
      };
      session = s;

      g.navigator!.mediaDevices!.getUserMedia!({ audio: true })
        .then((stream) => {
          if (s.discarded) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          s.tracks = stream.getTracks();
          const MR = g.MediaRecorder!;
          const mime = MR.isTypeSupported?.("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : undefined;
          const recorder = mime ? new MR(stream, { mimeType: mime }) : new MR(stream);
          s.recorder = recorder;
          recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) s.chunks.push(e.data);
          };
          recorder.onstop = () => finishSession(s, cb);
          recorder.start();
          // Released before the mic warmed up? Finish immediately.
          if (s.stopRequested) recorder.stop();
        })
        .catch(() => {
          cb.onError(
            "Microphone permission denied. Enable the mic to speak your story."
          );
        });
    },
    stop() {
      if (!session) return;
      session.stopRequested = true;
      try {
        session.recorder?.stop();
      } catch {}
    },
    abort() {
      if (!session) return;
      session.discarded = true;
      session.stopRequested = true;
      try {
        session.recorder?.stop();
      } catch {}
      releaseTracks(session);
    },
  };
}
```

`client/components/PushToTalk.tsx` — replace the interim-transcript rendering with press-state status. Change the state block and render:

- Replace `const [interim, setInterim] = useState("");` with `const [phase, setPhase] = useState<"idle" | "listening" | "transcribing">("idle");`
- `handlePressIn`: `setError(null); setPhase("listening"); voice.start({ onInterim: () => {}, onFinal: (transcript) => { setPhase("idle"); if (transcript.trim().length > 0) onUtterance(transcript); }, onError: (message) => { setPhase("idle"); setError(message); } });`
- `handlePressOut`: `setPhase("transcribing"); voice.stop();` — and to avoid a stuck "transcribing…" when the clip was empty (no callback fires), ALSO clear it on a short timer: `if (phaseTimeout.current) clearTimeout(phaseTimeout.current); phaseTimeout.current = setTimeout(() => setPhase("idle"), 8000);` with a `phaseTimeout` ref cleared on unmount alongside the existing `voice.abort()` cleanup, and cleared inside both `onFinal` and `onError`.
- Render, replacing the interim line: `{phase !== "idle" && (<Text style={styles.interim}>{phase === "listening" ? "listening…" : "…"}</Text>)}` (reuse the existing `interim` style).

- [ ] **Step 4: Run tests + types**

Run (in `client/`): `npx jest --watchAll=false && npx tsc --noEmit`
Expected: the voice suite passes (7 tests, was 6 — net +1). Story/index suites still pass — they mock `getVoiceIn` at the module seam (`mockVoiceFake`), so the engine change is invisible to them; PushToTalk's status text renders only mid-press, which no existing test observes. Report the actual total (~81).

- [ ] **Step 5: Commit**

```bash
git add client/lib client/components
git commit -m "feat(client): VoiceIn v2 - record-then-transcribe via /transcribe, SpeechRecognition retired"
```

---

### Task 4: `VoiceOut` — the narrator abstraction

**Files:**
- Create: `client/lib/voiceOut.ts`
- Test: `client/lib/__tests__/voiceOut.test.ts`

**Interfaces:**
- Consumes: `streamingFetch`, `API_URL`.
- Produces (Task 5 consumes):

```ts
export type VoiceOut = {
  available: boolean;
  speak: (text: string, opts?: { kind?: "scene" | "reply" }) => void; // new speak stops the previous
  stop: () => void; // always halts mid-word (architecture rule #2)
  onSpeakingChange: (cb: (speaking: boolean) => void) => void;
};
export function getVoiceOut(): VoiceOut;
```

Behavior contract: primary path POSTs `/narrate` and plays the returned WAV via an `Audio` element; ANY failure (HTTP error, network, playback error) downgrades to the device voice (`speechSynthesis`) for that utterance; `EXPO_PUBLIC_USE_MOCK=1` skips `/narrate` entirely and always uses the device voice; no `speechSynthesis` and no `Audio` global → `available: false` stub; a stale narration (stopped or superseded while its fetch was in flight) never plays.

- [ ] **Step 1: Write the failing tests**

Create `client/lib/__tests__/voiceOut.test.ts`:

```ts
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
```

Note on the mock-mode path (`EXPO_PUBLIC_USE_MOCK=1` → device voice, no `/narrate`): env is baked in at import time, same as `USE_MOCK` in `api.ts` — cover it the way `api.test.ts` covers its mock URL if an isolateModules pattern already exists there; otherwise assert the branch by code review in the task report (the existing suite made the same trade for `USE_MOCK`).

- [ ] **Step 2: Run tests to verify they fail**

Run (in `client/`): `npx jest --watchAll=false lib/__tests__/voiceOut.test.ts`
Expected: FAIL (`Cannot find module '../voiceOut'`).

- [ ] **Step 3: Implement**

Create `client/lib/voiceOut.ts`:

```ts
/**
 * VoiceOut — the narrator abstraction (architecture rule #3's twin; rule #2:
 * playback is ALWAYS stoppable mid-word). Primary engine: POST /narrate
 * (Gemini TTS via our backend) played through an Audio element. ANY failure
 * downgrades to the device's built-in voice for that utterance — the story
 * is never silent because a quota ran out. Mock mode always uses the device
 * voice: the full loop demos at zero cost.
 */

import { API_URL } from "./api";
import { streamingFetch } from "./fetch";

export type VoiceOut = {
  available: boolean;
  speak: (text: string, opts?: { kind?: "scene" | "reply" }) => void;
  stop: () => void;
  onSpeakingChange: (cb: (speaking: boolean) => void) => void;
};

const USE_MOCK = process.env.EXPO_PUBLIC_USE_MOCK === "1";

type AudioGlobals = {
  Audio?: new (src: string) => {
    paused: boolean;
    onended: (() => void) | null;
    onerror: (() => void) | null;
    play: () => Promise<void> | void;
    pause: () => void;
  };
  speechSynthesis?: { speak: (u: unknown) => void; cancel: () => void };
  SpeechSynthesisUtterance?: new (text: string) => {
    onend: (() => void) | null;
    onerror: (() => void) | null;
  };
  URL?: { createObjectURL: (b: Blob) => string; revokeObjectURL: (u: string) => void };
};

const UNAVAILABLE: VoiceOut = {
  available: false,
  speak: () => {},
  stop: () => {},
  onSpeakingChange: () => {},
};

export function getVoiceOut(): VoiceOut {
  const g = globalThis as never as AudioGlobals;
  const hasDevice = !!g.speechSynthesis && !!g.SpeechSynthesisUtterance;
  const hasAudio = !!g.Audio && !!g.URL;
  if (!hasDevice && !hasAudio) return UNAVAILABLE;

  let speakingCb: (speaking: boolean) => void = () => {};
  let speaking = false;
  let generation = 0; // bumped on every speak/stop: stale async work no-ops
  let currentAudio: InstanceType<NonNullable<AudioGlobals["Audio"]>> | null = null;
  let currentUrl: string | null = null;

  const setSpeaking = (s: boolean) => {
    if (speaking === s) return;
    speaking = s;
    speakingCb(s);
  };

  const halt = () => {
    generation += 1;
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    if (currentUrl && g.URL) {
      g.URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
    g.speechSynthesis?.cancel();
    setSpeaking(false);
  };

  const deviceSpeak = (text: string, gen: number) => {
    if (!hasDevice || gen !== generation) return;
    const utterance = new g.SpeechSynthesisUtterance!(text);
    utterance.onend = () => {
      if (gen === generation) setSpeaking(false);
    };
    utterance.onerror = utterance.onend;
    setSpeaking(true);
    g.speechSynthesis!.speak(utterance);
  };

  return {
    available: true,
    speak(text, opts) {
      halt(); // one voice at a time
      const gen = generation;
      if (USE_MOCK || !hasAudio) {
        deviceSpeak(text, gen);
        return;
      }
      streamingFetch(`${API_URL}/narrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, kind: opts?.kind ?? "scene" }),
      })
        .then(async (res) => {
          if (gen !== generation) return; // stopped/superseded while in flight
          if (!res.ok) {
            deviceSpeak(text, gen); // quota/failure -> never silent
            return;
          }
          const blob = await res.blob();
          if (gen !== generation) return;
          currentUrl = g.URL!.createObjectURL(blob);
          const audio = new g.Audio!(currentUrl);
          currentAudio = audio;
          audio.onended = () => {
            if (gen === generation) {
              currentAudio = null;
              setSpeaking(false);
            }
          };
          audio.onerror = () => {
            if (gen === generation) {
              currentAudio = null;
              deviceSpeak(text, gen);
            }
          };
          setSpeaking(true);
          void audio.play();
        })
        .catch(() => {
          if (gen === generation) deviceSpeak(text, gen);
        });
    },
    stop: halt,
    onSpeakingChange(cb) {
      speakingCb = cb;
    },
  };
}
```

- [ ] **Step 4: Run tests + types**

Run (in `client/`): `npx jest --watchAll=false && npx tsc --noEmit`
Expected: ALL PASS (~81 + 6 = ~87 — report actual), types clean.

- [ ] **Step 5: Commit**

```bash
git add client/lib
git commit -m "feat(client): VoiceOut - /narrate playback with device-voice fallback, always stoppable"
```

---

### Task 5: Story wiring — the app speaks

**Files:**
- Modify: `client/app/story.tsx`, `client/components/PushToTalk.tsx` (one new optional prop)
- Test: `client/app/__tests__/story.test.tsx`

**Interfaces:**
- Consumes: `getVoiceOut`/`VoiceOut` (Task 4 — mock at the module seam like voice: `jest.mock("../../lib/voiceOut")` with a `mock`-prefixed fake).
- Produces: the shipped behavior. `PushToTalk` gains ONE optional prop: `onActivate?: () => void`, called at the top of `handlePressIn` (Story uses it to silence narration when you start talking).

**Binding behavior:**
- Story acquires one `VoiceOut` via a first-render ref (the `voiceRef` pattern PushToTalk already uses) and subscribes `onSpeakingChange` → new `isSpeaking` state. `isSpeaking` NEVER gates PTT; `isStreaming` still does (previous final review's warning, honored).
- `turn_complete` → `voiceOut.speak(sceneText, { kind: "scene" })`. `discussion_complete` with a non-empty reply → `voiceOut.speak(replyText, { kind: "reply" })`. Nothing else speaks.
- ■ Stop now ALSO calls `voiceOut.stop()` (it silences both the text stream and the voice). The stop control renders while `isStreaming || isSpeaking` (so a long narration can be silenced after streaming ends).
- `<PushToTalk onActivate={() => voiceOut.stop()} …>` — holding the mic interrupts narration.
- Unmount cleanup: `voiceOut.stop()` joins the existing abort effect.

- [ ] **Step 1: Write the failing tests**

In `client/app/__tests__/story.test.tsx`, add beside `mockVoiceFake`:

```tsx
const mockVoiceOutFake = {
  available: true,
  speak: jest.fn(),
  stop: jest.fn(),
  onSpeakingChange: jest.fn(),
};
jest.mock("../../lib/voiceOut", () => ({
  getVoiceOut: () => mockVoiceOutFake,
}));
```

Add a `beforeEach` clearing inside the existing setup: `mockVoiceOutFake.speak.mockClear(); mockVoiceOutFake.stop.mockClear();`

Add a new describe block:

```tsx
describe("narration", () => {
  it("speaks the scene when the turn completes", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    const { getByText } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));
    expect(mockVoiceOutFake.speak).toHaveBeenCalledWith(
      "Scene. ",
      expect.objectContaining({ kind: "scene" })
    );
  });

  it("speaks the reply when a discussion completes", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    jest.spyOn(api, "converse").mockReturnValueOnce(
      fixtureStream([
        { type: "reply_token", t: "She is stubborn." },
        { type: "discussion_complete", notes: "n" },
      ])
    );
    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("tell me about her"));

    await waitFor(() => getByText(/She is stubborn./));
    expect(mockVoiceOutFake.speak).toHaveBeenCalledWith(
      "She is stubborn.",
      expect.objectContaining({ kind: "reply" })
    );
  });

  it("the stop control silences narration too", async () => {
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    jest.spyOn(api, "streamTurn").mockReturnValue(
      (async function* () {
        yield { type: "token", t: "Slow " } as const;
        await gate;
      })() as never
    );
    const { getByTestId, getByText } = render(<Story />);
    await waitFor(() => getByText(/Slow/));
    fireEvent.press(getByTestId("stop-button"));
    expect(mockVoiceOutFake.stop).toHaveBeenCalled();
    await act(async () => release!());
  });

  it("holding the mic interrupts narration", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));
    fireEvent(getByTestId("ptt-button"), "pressIn");
    expect(mockVoiceOutFake.stop).toHaveBeenCalled();
  });

  it("speaking never disables the mic (isSpeaking is not isStreaming)", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));
    // Simulate narration in progress via the subscribed callback:
    const subscribed = mockVoiceOutFake.onSpeakingChange.mock.calls[0][0];
    act(() => subscribed(true));
    expect(
      getByTestId("ptt-button").props.accessibilityState?.disabled
    ).toBe(false);
    expect(getByTestId("stop-button")).toBeTruthy(); // silence control available
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `client/`): `npx jest --watchAll=false app/__tests__/story.test.tsx`
Expected: new tests FAIL (no voiceOut wiring, stop-button absent while only speaking).

- [ ] **Step 3: Implement**

`client/components/PushToTalk.tsx`: add `onActivate?: () => void;` to the props type and call `onActivate?.();` as the first line of `handlePressIn`.

`client/app/story.tsx`:
- Import `getVoiceOut, VoiceOut` from `"../lib/voiceOut"`.
- First-render ref: `const voiceOutRef = useRef<VoiceOut | null>(null); if (voiceOutRef.current === null) voiceOutRef.current = getVoiceOut(); const voiceOut = voiceOutRef.current;`
- State: `const [isSpeaking, setIsSpeaking] = useState(false);` and one subscribe effect: `useEffect(() => { voiceOut.onSpeakingChange(setIsSpeaking); }, [voiceOut]);`
- In `runTurn`'s `turn_complete` branch, after archiving the scene: `voiceOut.speak(sceneText, { kind: "scene" });`
- In `runConverse`'s `discussion_complete` branch, when `replyText.trim()` is non-empty: `voiceOut.speak(replyText, { kind: "reply" });`
- Unmount effect gains `voiceOut.stop();`
- Stop control: render condition becomes `{(isStreaming || isSpeaking) && (<Pressable testID="stop-button" onPress={() => { abortRef.current?.abort(); voiceOut.stop(); }} …>…)}`
- PTT: `<PushToTalk onActivate={() => voiceOut.stop()} disabled={isStreaming} onUtterance={handleUtterance} />`

- [ ] **Step 4: Run tests + types**

Run (in `client/`): `npx jest --watchAll=false && npx tsc --noEmit`
Expected: ALL PASS (~87 + 5 = ~92 — report actual), types clean, output pristine.

- [ ] **Step 5: Commit**

```bash
git add client
git commit -m "feat(client): auto-narration - scenes and replies speak, mic interrupts, stop silences"
```

---

### Task 6: Live checkpoint, docs, ship

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full suites** — backend `venv/Scripts/python.exe -m pytest tests/ -v` (~115); client `npx jest --watchAll=false && npx tsc --noEmit` (~92); `npx expo export --platform web` clean. Report exact counts. If ANY fails → BLOCKED, no docs.

- [ ] **Step 2: Live smoke (quota permitting; failures here are reportable findings, not blockers)** — run one real `/transcribe` and one real `/narrate` in-process (the TestClient-with-real-.env pattern from the ledger): for `/transcribe`, synthesize a WAV of spoken-word audio is NOT possible offline — instead POST a short silent WAV (stdlib-generated) and confirm the endpoint returns 200/502 CLEANLY (the contract, not the quality); for `/narrate`, POST a one-sentence text and verify `audio/wav` bytes come back and a `tts` row lands in `logs/usage.jsonl`. If Gemini reports `TTS_MODEL` unavailable, swap the constant to `gemini-3.1-flash-tts` (the April 2026 id) and re-run — this is the sanctioned one-constant fix. THE REAL QUALITY GUT-CHECK (owner speaking into Chrome; webm acceptance; transcription accuracy vs their voice) is the owner's hand-off in Step 4 — if Gemini rejects `audio/webm` live, the recorded contingency is a client-side WAV encoder (documented in the report as the named next fix; do NOT build it speculatively).
- [ ] **Step 3: CLAUDE.md** — backend section: `/transcribe` + `/narrate` bullets (constants, labels, caps, WAV wrap, error contract), `python-multipart` in the supporting-files line, new usage labels `stt`/`tts`; client section: VoiceIn v2 (record-then-transcribe, SpeechRecognition retired and WHY, no interim words — status from press state, hot-mic release), `lib/voiceOut.ts` (fallback ladder, mock = device voice, generation guard), Story narration wiring (what speaks when, mic interrupts, stop silences both, `isSpeaking` separate from `isStreaming`); both test counts; NEXT STEPS: audio slice browser-complete, phone follow-up (Expo Go recording impl behind the same interfaces) + owner's paid-tier flip still recommended + Phase 4 (streamed narration, per-genre voices) next on the audio track. Then commit `docs: record the audio slice in CLAUDE.md` + push.
- [ ] **Step 4: Hand the demo to the human** — backend restarted (`uvicorn main:app --reload`), client restarted (`npx expo start --web`), Chrome + mic. With `EXPO_PUBLIC_USE_MOCK=0`: speak a premise-steer; listen for the scene in the Gemini voice; interrupt it by holding the mic; ask a question, hear the reply; hit ■ Stop mid-narration. The owner judges: transcription accuracy (the slice's reason to exist) and voice quality. Mock mode (`=1`) demos the same flow with the device robot voice, free.

---

## Self-Review

**Spec coverage:** `/transcribe` (multipart, 413, 422, stt label, meter-for-free) → Task 1. `/narrate` (WAV wrap, TTS_MODEL/VOICE_NAME constants, tts label with audio tokens, 413, error mapping) → Task 2. VoiceIn v2 (same interface, no onInterim, hot-mic release, permission + HTTP errors inline, double-start guard preserved) → Task 3. VoiceOut (fallback ladder, mock = device voice, stoppable mid-word, stale-generation guard) → Task 4. Wiring (everything speaks automatically, mic interrupts, ■ Stop silences both, isSpeaking ≠ isStreaming, unmount stop) → Task 5. Live checkpoint incl. the TTS-model-id contingency and the webm contingency + owner gut-check + docs → Task 6. Failure philosophy (audio never blocks the story) is embedded in Tasks 4–5's contracts. ✓

**Placeholder scan:** Task 3's PushToTalk edit and Task 5's story.tsx edits are described as precise change-lists against files whose current shape earlier tasks/plans pinned — with binding tests carrying the contract (the established pattern from the previous two plans). The VoiceOut mock-mode test note explicitly names the accepted trade rather than hiding it. No TBDs. ✓

**Type consistency:** `VoiceCallbacks`/`VoiceIn` unchanged across Tasks 3/5; `VoiceOut`/`getVoiceOut` identical in Task 4's definition, Task 5's mock and wiring; `pcm_to_wav`/`call_gemini_tts`/`STT_BUDGET`/`TTS_BUDGET`/`NARRATE_CHAR_CAP` names match between implementation and tests; `onActivate` defined in Task 5's PushToTalk change and used in the same task. ✓

**Known context for the executing session:** run with subagent-driven-development; per-task briefs via `scripts/task-brief`; ledger `.superpowers/sdd/progress.md`. Counts are approximate on the client side (report actuals). The paid-tier flip remains an owner action — audio doubles per-turn calls on a free tier that already 503s.
