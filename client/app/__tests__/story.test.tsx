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

  it("spoken ordinal picks a card after the confirm window", async () => {
    jest.useFakeTimers();
    const spy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(happyTurn())
      .mockReturnValueOnce(happyTurn());

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    act(() => cb.onInterim("the second"));
    expect(getByText(/the second/)).toBeTruthy(); // live transcript visible
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("the second one"));

    expect(getByText(/choosing option 2/i)).toBeTruthy();
    act(() => jest.advanceTimersByTime(1600));
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith(
        expect.objectContaining({ chosen_scenario: "Ask the voice its name" }),
        expect.anything()
      )
    );
    jest.useRealTimers();
  });

  it("unmatched speech steers the story free-form", async () => {
    jest.useFakeTimers();
    const spy = jest
      .spyOn(api, "streamTurn")
      .mockReturnValueOnce(happyTurn())
      .mockReturnValueOnce(happyTurn());

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("she sets fire to the archive and flees north"));

    expect(getByText(/steering the story/i)).toBeTruthy();
    act(() => jest.advanceTimersByTime(1600));
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          chosen_scenario: "she sets fire to the archive and flees north",
        }),
        expect.anything()
      )
    );
    jest.useRealTimers();
  });

  it("cancel inside the confirm window discards the utterance", async () => {
    jest.useFakeTimers();
    const spy = jest.spyOn(api, "streamTurn").mockReturnValueOnce(happyTurn());

    const { getByText, getByTestId } = render(<Story />);
    await waitFor(() => getByText(/Force the iron door/));

    fireEvent(getByTestId("ptt-button"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("ptt-button"), "pressOut");
    act(() => cb.onFinal("the second one"));
    fireEvent.press(getByText(/cancel/i));
    act(() => jest.advanceTimersByTime(2000));
    expect(spy).toHaveBeenCalledTimes(1); // only the opening turn
    jest.useRealTimers();
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
