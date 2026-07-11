import { render, screen, fireEvent, act } from "@testing-library/react-native";
import { PushToTalk } from "../PushToTalk";

// mock-prefixed for jest.mock hoisting (same convention as the app tests)
const mockVoiceFake = {
  available: true,
  start: jest.fn(),
  stop: jest.fn(),
  abort: jest.fn(),
};
jest.mock("../../lib/voice", () => ({
  getVoiceIn: () => mockVoiceFake,
}));

describe("PushToTalk stuck-phase timeout", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("holds 'transcribing' past 8s (slow phone networks) but recovers by 15s", () => {
    render(<PushToTalk onUtterance={jest.fn()} />);
    fireEvent(screen.getByTestId("ptt-button"), "pressIn");
    fireEvent(screen.getByTestId("ptt-button"), "pressOut");
    act(() => {
      jest.advanceTimersByTime(8000);
    });
    // 8s was too eager for a phone network + server-side retries.
    expect(screen.getByText("…")).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(7000);
    });
    // The empty-clip guard still recovers, just later.
    expect(screen.queryByText("…")).toBeNull();
  });
});
