import { render, fireEvent, waitFor } from "@testing-library/react-native";
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

async function* fixtureStream(events: StreamEvent[]) {
  for (const ev of events) yield ev;
}

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
