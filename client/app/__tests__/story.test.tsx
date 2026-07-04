import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import Story, { resolveStoryLength } from "../story";
import * as api from "../../lib/api";
import type { StreamEvent } from "../../lib/sse";

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({
    templateId: "fantasy",
    premise: "A dragon egg hatches.",
    length: "short",
  }),
  router: { back: jest.fn() },
}));

// --- voice fake: capture callbacks so tests can drive recognition ---
// (named with a "mock" prefix so Jest's babel hoisting allows referencing it
// from inside the jest.mock factory below — bare "voiceFake" throws
// "Invalid variable access" under out-of-scope-variable hoisting rules.)
const mockVoiceFake = {
  available: true,
  start: jest.fn(),
  stop: jest.fn(),
  abort: jest.fn(),
};
jest.mock("../../lib/voice", () => ({
  getVoiceIn: () => mockVoiceFake,
}));

// --- voiceOut fake: capture narration calls (mock-prefixed for the same
// hoisting reason as mockVoiceFake above). ---
const mockVoiceOutFake = {
  available: true,
  speak: jest.fn(),
  stop: jest.fn(),
  onSpeakingChange: jest.fn(),
};
jest.mock("../../lib/voiceOut", () => ({
  getVoiceOut: () => mockVoiceOutFake,
}));

beforeEach(() => {
  mockVoiceOutFake.speak.mockClear();
  mockVoiceOutFake.stop.mockClear();
  // Also cleared (beyond the brief's two lines): onSpeakingChange is a plain
  // jest.fn(), so its call history otherwise accumulates across tests in this
  // file (restoreMocks only restores jest.spyOn spies) — an uncleared history
  // makes `mock.calls[0][0]` in the "isSpeaking" test grab a stale callback
  // from an earlier, already-unmounted Story instance instead of the current
  // render's.
  mockVoiceOutFake.onSpeakingChange.mockClear();
});

async function* fixtureStream(events: StreamEvent[]) {
  for (const ev of events) yield ev;
}

const happyTurn = () =>
  fixtureStream([
    { type: "token", t: "Scene. " },
    {
      type: "turn_complete",
      summary: "s",
      scenarios: [
        "Force the iron door open now",
        "Ask the voice its name",
        "Run from the footsteps",
      ],
    },
  ]);

describe("Story", () => {
  it("streams the opening scene and then shows option cards", async () => {
    const spy = jest.spyOn(api, "streamTurn").mockReturnValue(
      fixtureStream([
        { type: "token", t: "The egg " },
        { type: "token", t: "cracked." },
        { type: "turn_complete", summary: "s2", scenarios: ["Go north", "Go south"] },
      ])
    );

    const { getByText } = render(<Story />);
    await waitFor(() => expect(getByText(/cracked/)).toBeTruthy());
    expect(getByText("Go north")).toBeTruthy();
    expect(getByText("Go south")).toBeTruthy();
    expect(spy).toHaveBeenCalledWith(
      {
        template_id: "fantasy",
        summary: "A dragon egg hatches.",
        chosen_scenario: "Open the story.",
        turn: 1,
        length: "short",
        notes: "",
      },
      expect.anything()
    );
  });

  it("tapping an option runs the next turn with the updated summary", async () => {
    const spy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(
        fixtureStream([
          { type: "token", t: "Scene one." },
          { type: "turn_complete", summary: "sum-1", scenarios: ["Option A"] },
        ])
      )
      .mockReturnValueOnce(
        fixtureStream([
          { type: "token", t: "Scene two." },
          { type: "turn_complete", summary: "sum-2", scenarios: ["Option B"] },
        ])
      );

    const { getByText } = render(<Story />);
    await waitFor(() => getByText("Option A"));
    fireEvent.press(getByText("Option A"));
    await waitFor(() => getByText("Option B"));
    expect(spy).toHaveBeenLastCalledWith(
      {
        template_id: "fantasy",
        summary: "sum-1",
        chosen_scenario: "Option A",
        turn: 2,
        length: "short",
        notes: "",
      },
      expect.anything()
    );
    // scene one is still on screen (finished scenes persist)
    expect(getByText(/Scene one/)).toBeTruthy();
  });

  it("keeps partial text and offers retry on a mid-stream error", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValue(
      fixtureStream([
        { type: "token", t: "Half a scene " },
        { type: "stream_error", status: 503, detail: "busy" },
      ])
    );

    const { getByText } = render(<Story />);
    await waitFor(() => expect(getByText(/muse is busy/i)).toBeTruthy());
    expect(getByText(/Half a scene/)).toBeTruthy(); // partial text preserved
  });

  it("shows the daily-quota message for 429 frames", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValue(
      fixtureStream([{ type: "stream_error", status: 429, detail: "quota" }])
    );
    const { getByText } = render(<Story />);
    await waitFor(() => expect(getByText(/out of muse for today/i)).toBeTruthy());
  });

  it("shows the connection-loss detail for status-0 errors", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValue(
      fixtureStream([
        { type: "stream_error", status: 0, detail: "Connection lost mid-story. Tap to retry." },
      ])
    );
    const { getByText } = render(<Story />);
    await waitFor(() => expect(getByText(/connection lost mid-story/i)).toBeTruthy());
  });

  it("retry re-runs the same turn", async () => {
    const spy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(
        fixtureStream([{ type: "stream_error", status: 503, detail: "busy" }])
      )
      .mockReturnValueOnce(
        fixtureStream([
          { type: "token", t: "Fresh scene." },
          { type: "turn_complete", summary: "s2", scenarios: ["A"] },
        ])
      );

    const { getByText } = render(<Story />);
    await waitFor(() => getByText(/tap to retry/i));
    fireEvent.press(getByText(/tap to retry/i));
    await waitFor(() => getByText(/Fresh scene/));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toEqual(spy.mock.calls[1][0]); // identical request
  });

  it("ignores a second tap while a turn is already streaming", async () => {
    let releaseFirst: () => void;
    const firstTurnGate = new Promise<void>((res) => (releaseFirst = res));

    async function* slowFirstTurn(): AsyncGenerator<StreamEvent> {
      // Hold open until released — no events yet
      await firstTurnGate;
      yield { type: "token", t: "Scene one." };
      yield { type: "turn_complete", summary: "sum-1", scenarios: ["Option A"] };
    }

    const spy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(
        fixtureStream([
          { type: "token", t: "Opening." },
          { type: "turn_complete", summary: "s1", scenarios: ["Tap me"] },
        ])
      )
      .mockReturnValueOnce(slowFirstTurn())
      .mockReturnValueOnce(
        fixtureStream([
          { type: "token", t: "Should never appear." },
          { type: "turn_complete", summary: "x", scenarios: ["Y"] },
        ])
      );

    const { getByText } = render(<Story />);
    await waitFor(() => getByText("Tap me"));

    // Capture button, then press twice synchronously
    const btn = getByText("Tap me");
    fireEvent.press(btn);
    fireEvent.press(btn);

    // Release the slow stream to let it complete
    releaseFirst!();
    await waitFor(() => getByText("Option A"));

    // With streaming guard fix: only 2 calls (mount + first tap; second tap ignored)
    // This test confirms the guard prevents overlapping streams
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("retry does not advance the turn number", async () => {
    const spy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(
        fixtureStream([{ type: "stream_error", status: 503, detail: "busy" }])
      )
      .mockReturnValueOnce(
        fixtureStream([
          { type: "token", t: "Fresh." },
          { type: "turn_complete", summary: "s", scenarios: ["A"] },
        ])
      );
    const { getByText } = render(<Story />);
    await waitFor(() => getByText(/tap to retry/i));
    fireEvent.press(getByText(/tap to retry/i));
    await waitFor(() => getByText(/Fresh/));
    expect(spy.mock.calls[0][0].turn).toBe(1);
    expect(spy.mock.calls[1][0].turn).toBe(1); // retry re-sends the SAME turn
  });

  it("aborts the in-flight stream on unmount", async () => {
    let capturedSignal: AbortSignal | undefined;
    let release: () => void;
    const gate = new Promise<void>((res) => (release = res));

    jest.spyOn(api, "streamTurn").mockImplementation(function (
      _req: unknown,
      opts?: { signal?: AbortSignal }
    ) {
      capturedSignal = opts?.signal;
      return (async function* () {
        yield { type: "token", t: "Slow " } as const;
        await gate; // stream stays open
      })() as never;
    });

    const { getByText, unmount } = render(<Story />);
    await waitFor(() => getByText(/Slow/));
    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
    release!();
  });
});

describe("push-to-talk", () => {
  beforeEach(() => {
    mockVoiceFake.start.mockClear();
    mockVoiceFake.stop.mockClear();
  });

  it("spoken ordinal picks a card immediately - no confirm window, no converse", async () => {
    const turnSpy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(happyTurn())
      .mockReturnValueOnce(happyTurn());
    const converseSpy = jest.spyOn(api, "converse");

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("the second one"));

    await waitFor(() =>
      expect(turnSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ chosen_scenario: "Ask the voice its name" }),
        expect.anything()
      )
    );
    expect(converseSpy).not.toHaveBeenCalled();
  });

  it("non-ordinal speech goes to converse with notes, options, and tail", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    const converseSpy = jest.spyOn(api, "converse").mockReturnValueOnce(
      fixtureStream([
        { type: "reply_token", t: "She is " },
        { type: "reply_token", t: "stubborn." },
        { type: "discussion_complete", notes: "Mira is stubborn." },
      ])
    );

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("tell me more about the voice"));

    await waitFor(() => getByText(/She is stubborn./)); // AI bubble streamed
    expect(getByText(/tell me more about the voice/)).toBeTruthy(); // user bubble
    expect(converseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: "tell me more about the voice",
        notes: "",
        options: [
          "Force the iron door open now",
          "Ask the voice its name",
          "Run from the footsteps",
        ],
        discussion: [{ role: "user", text: "tell me more about the voice" }],
        template_id: "fantasy",
      }),
      expect.anything()
    );
  });

  it("notes and the discussion tail carry into the NEXT converse call", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    const converseSpy = jest
      .spyOn(api, "converse")
      .mockReturnValueOnce(
        fixtureStream([
          { type: "reply_token", t: "A stubborn mapmaker." },
          { type: "discussion_complete", notes: "Mira is stubborn." },
        ])
      )
      .mockReturnValueOnce(
        fixtureStream([
          { type: "reply_token", t: "Fire, when she was nine." },
          { type: "discussion_complete", notes: "Mira is stubborn; fears fire." },
        ])
      );

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    const speak = (text: string) => {
      fireEvent(getByTestId("ptt-button"), "pressIn");
      const calls = mockVoiceFake.start.mock.calls;
      const cb = calls[calls.length - 1][0];
      fireEvent(getByTestId("ptt-button"), "pressOut");
      act(() => cb.onFinal(text));
    };

    speak("who is she really");
    await waitFor(() => getByText(/A stubborn mapmaker./));
    speak("what is she afraid of");
    await waitFor(() => getByText(/Fire, when she was nine./));

    expect(converseSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        notes: "Mira is stubborn.",
        discussion: [
          { role: "user", text: "who is she really" },
          { role: "ai", text: "A stubborn mapmaker." },
          { role: "user", text: "what is she afraid of" },
        ],
      }),
      expect.anything()
    );
  });

  it("route steer fires the turn with the utterance verbatim", async () => {
    const turnSpy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(happyTurn())
      .mockReturnValueOnce(happyTurn());
    jest
      .spyOn(api, "converse")
      .mockReturnValueOnce(fixtureStream([{ type: "route", intent: "steer" }]));

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("she burns the letter and runs north"));

    await waitFor(() =>
      expect(turnSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          chosen_scenario: "she burns the letter and runs north",
        }),
        expect.anything()
      )
    );
  });

  it("route pick fires the turn with the picked card", async () => {
    const turnSpy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(happyTurn())
      .mockReturnValueOnce(happyTurn());
    jest
      .spyOn(api, "converse")
      .mockReturnValueOnce(
        fixtureStream([{ type: "route", intent: "pick", index: 2 }])
      );

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("the one where someone is coming"));

    await waitFor(() =>
      expect(turnSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ chosen_scenario: "Run from the footsteps" }),
        expect.anything()
      )
    );
  });

  it("route options replaces the cards without running a turn", async () => {
    const turnSpy = jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    jest.spyOn(api, "converse").mockReturnValueOnce(
      fixtureStream([
        {
          type: "route",
          intent: "options",
          scenarios: ["Fresh idea one", "Fresh idea two", "Fresh idea three"],
        },
      ])
    );

    const { getByText, getByTestId, queryByText } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("give me some different ideas"));

    await waitFor(() => getByText("Fresh idea one"));
    expect(queryByText(/Force the iron door/)).toBeNull(); // old cards replaced
    expect(turnSpy).toHaveBeenCalledTimes(1); // opening turn only
  });

  it("stop pressed before the stream closes suppresses a captured route", async () => {
    const turnSpy = jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    jest.spyOn(api, "converse").mockImplementation(
      () =>
        (async function* () {
          yield { type: "route", intent: "steer" } as const;
          await gate; // stream stays open past the route frame
        })() as never
    );

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("she walks into the rain"));

    await waitFor(() => getByTestId("stop-button"));
    fireEvent.press(getByTestId("stop-button"));
    await act(async () => release!());
    await waitFor(() =>
      expect(getByTestId("ptt-button").props.accessibilityState?.disabled).toBe(false)
    );
    expect(turnSpy).toHaveBeenCalledTimes(1); // opening turn only — braked route never fired
  });

  it("stop aborts a streaming reply silently and keeps the partial bubble", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    let capturedSignal: AbortSignal | undefined;
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    jest.spyOn(api, "converse").mockImplementation(function (
      _req: unknown,
      opts?: { signal?: AbortSignal }
    ) {
      capturedSignal = opts?.signal;
      return (async function* () {
        yield { type: "reply_token", t: "Partial thought " } as const;
        await gate; // reply never finishes on its own
      })() as never;
    });

    const { getByText, getByTestId, queryByText } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("tell me about the dripping water"));

    await waitFor(() => getByText(/Partial thought/));
    fireEvent.press(getByTestId("stop-button"));
    expect(capturedSignal?.aborted).toBe(true);
    await act(async () => release!());
    await waitFor(() => expect(queryByText(/tap to retry/i)).toBeNull()); // no error painted
    expect(getByText(/Partial thought/)).toBeTruthy(); // partial bubble kept
  });

  it("retry after a converse failure re-runs the conversation, not a turn", async () => {
    const turnSpy = jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    const converseSpy = jest
      .spyOn(api, "converse")
      .mockReturnValueOnce(
        fixtureStream([
          { type: "reply_token", t: "Half a " },
          { type: "stream_error", status: 503, detail: "model went away" },
        ])
      )
      .mockReturnValueOnce(
        fixtureStream([
          { type: "reply_token", t: "She is stubborn." },
          { type: "discussion_complete", notes: "Mira is stubborn." },
        ])
      );

    const { getByText, getByTestId, getAllByText } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("tell me about the voice"));

    await waitFor(() => getByText(/tap to retry/i));
    fireEvent.press(getByText(/tap to retry/i));

    await waitFor(() => getByText(/She is stubborn./));
    expect(converseSpy).toHaveBeenCalledTimes(2);
    expect(converseSpy.mock.calls[1][0]).toEqual(
      expect.objectContaining({ utterance: "tell me about the voice" })
    );
    // The retry must not duplicate the optimistic user entry:
    expect(getAllByText(/tell me about the voice/)).toHaveLength(1);
    const retryDiscussion = (converseSpy.mock.calls[1][0] as { discussion: { role: string; text: string }[] }).discussion;
    expect(
      retryDiscussion.filter((d) => d.text === "tell me about the voice")
    ).toHaveLength(1);
    expect(turnSpy).toHaveBeenCalledTimes(1); // opening turn only — retry never ran a turn
  });

  it("consumed cards disappear when the next turn starts", async () => {
    jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(happyTurn())
      .mockReturnValueOnce(
        fixtureStream([
          { type: "token", t: "Next scene." },
          { type: "turn_complete", summary: "s2", scenarios: ["Only new option"] },
        ])
      );

    const { getByText, queryByText } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));
    fireEvent.press(getByText("Ask the voice its name"));
    await waitFor(() => getByText("Only new option"));
    expect(queryByText(/Force the iron door/)).toBeNull();
  });

  it("PTT is disabled while a turn is streaming", async () => {
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    jest.spyOn(api, "streamTurn").mockReturnValue(
      (async function* () {
        yield { type: "token", t: "Slow " } as const;
        await gate;
        yield {
          type: "turn_complete",
          summary: "s",
          scenarios: ["A"],
        } as const;
      })() as never
    );

    const { getByTestId, getByText } = render(<Story />);
    await waitFor(() => getByText(/Slow/));
    expect(
      getByTestId("ptt-button").props.accessibilityState?.disabled
    ).toBe(true);
    // Flush the generator's remaining state updates under act() so releasing
    // the gate doesn't produce an "update not wrapped in act" warning — the
    // test only cares about the disabled assertion above, not this cleanup.
    await act(async () => {
      release!();
    });
  });

  it("mic permission error shows inline", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    act(() => cb.onError("Microphone permission denied. Enable the mic to speak your story."));
    expect(getByText(/microphone permission denied/i)).toBeTruthy();
  });

  it("back control exists", async () => {
    jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());
    const { getByText } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));
    expect(getByText(/home/i)).toBeTruthy();
  });
});

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

  it("starting a new turn silences the previous narration", async () => {
    jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(happyTurn())
      .mockReturnValueOnce(happyTurn());
    const { getByText } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));
    mockVoiceOutFake.stop.mockClear();
    fireEvent.press(getByText("Ask the voice its name"));
    await waitFor(() =>
      expect(mockVoiceOutFake.stop).toHaveBeenCalled()
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

describe("resolveStoryLength", () => {
  // The route param is URL-editable on web and can arrive as an array if the
  // query string duplicates the key — this must always fall back to "short"
  // rather than pass an unchecked cast through to the backend.
  it("passes through a valid length", () => {
    expect(resolveStoryLength("medium")).toBe("medium");
    expect(resolveStoryLength("long")).toBe("long");
  });

  it("falls back to short for an invalid string", () => {
    expect(resolveStoryLength("epic")).toBe("short");
  });

  it("falls back to short for an array (duplicated query param)", () => {
    expect(resolveStoryLength(["long", "medium"])).toBe("short");
  });

  it("falls back to short when missing", () => {
    expect(resolveStoryLength(undefined)).toBe("short");
  });
});
