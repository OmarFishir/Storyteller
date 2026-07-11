import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import Home from "../index";
import * as api from "../../lib/api";

jest.mock("expo-router", () => ({
  router: { push: jest.fn() },
}));

// --- voice fake: capture callbacks so tests can drive recognition ---
// (named with a "mock" prefix — see story.test.tsx for why bare "voiceFake"
// fails Jest's babel hoisting check inside the jest.mock factory below.)
const mockVoiceFake = {
  available: true,
  start: jest.fn(),
  stop: jest.fn(),
  abort: jest.fn(),
};
jest.mock("../../lib/voice", () => ({
  getVoiceIn: () => mockVoiceFake,
}));

const mockVoiceOutFake = {
  available: true,
  speak: jest.fn(),
  stop: jest.fn(),
  unlock: jest.fn(),
  onSpeakingChange: jest.fn(),
};
jest.mock("../../lib/voiceOut", () => ({
  getVoiceOut: () => mockVoiceOutFake,
}));

const TEMPLATES = [
  { id: "fantasy", name: "Fantasy Adventure", description: "d1", premise_seeds: ["A dragon egg hatches."] },
  { id: "noir", name: "Mystery / Noir", description: "d2", premise_seeds: ["One last case."] },
];

describe("Home", () => {
  beforeEach(() => {
    mockVoiceOutFake.unlock.mockClear();
  });

  it("renders a card per template", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText } = render(<Home />);
    await waitFor(() => expect(getByText("Fantasy Adventure")).toBeTruthy());
    expect(getByText("Mystery / Noir")).toBeTruthy();
  });

  it("tapping a seed fills the premise input", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByPlaceholderText } = render(<Home />);
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));
    fireEvent.press(getByText("A dragon egg hatches."));
    expect(getByPlaceholderText(/premise/i).props.value).toBe("A dragon egg hatches.");
  });

  it("shows a retry state when templates fail to load", async () => {
    jest.spyOn(api, "getTemplates").mockRejectedValue(new Error("down"));
    const { getByText } = render(<Home />);
    await waitFor(() => expect(getByText(/tap to retry/i)).toBeTruthy());
  });

  it("passes the chosen length to the story route", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByPlaceholderText } = render(<Home />);
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));
    fireEvent.changeText(getByPlaceholderText(/premise/i), "a premise");
    fireEvent.press(getByText(/^Long$/));
    fireEvent.press(getByText(/begin the story/i));
    const { router } = require("expo-router");
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/story",
      params: { templateId: "fantasy", premise: "a premise", length: "long" },
    });
  });

  it("mic fills the premise input with the spoken transcript", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByTestId, getByPlaceholderText } = render(<Home />);
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));

    fireEvent(getByTestId("premise-mic"), "pressIn");
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("premise-mic"), "pressOut");
    act(() => cb.onFinal("a dragon egg hatches in a city without magic"));

    expect(getByPlaceholderText(/premise/i).props.value).toBe(
      "a dragon egg hatches in a city without magic"
    );
  });

  it("Begin the story blesses audio for iOS (the session's first tap)", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByPlaceholderText } = render(<Home />);
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));
    fireEvent.changeText(getByPlaceholderText(/premise/i), "a premise");
    fireEvent.press(getByText(/begin the story/i));
    expect(mockVoiceOutFake.unlock).toHaveBeenCalled();
  });

  it("pressing the premise mic blesses audio for iOS", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByTestId } = render(<Home />);
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));
    fireEvent(getByTestId("premise-mic"), "pressIn");
    expect(mockVoiceOutFake.unlock).toHaveBeenCalled();
  });
});
