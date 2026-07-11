import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { Text } from "react-native";
import Home from "../index";
import * as api from "../../lib/api";
import { StoriesProvider, StoryRecord, useStories } from "../../lib/store";

jest.mock("expo-router", () => ({
  router: { push: jest.fn() },
}));

// --- voice fake: capture callbacks so tests can drive recognition ---
// (named with a "mock" prefix — see write.test.tsx for why bare "voiceFake"
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

// Exposes the provider's stories so tests can pin what createStory recorded.
function StoreProbe() {
  const { stories } = useStories();
  return (
    <Text testID="store-probe">
      {stories.map((s) => `${s.templateId}|${s.length}|${s.premise}`).join(";")}
    </Text>
  );
}

const renderHome = (initialStories: StoryRecord[] = []) =>
  render(
    <StoriesProvider initialStories={initialStories}>
      <Home />
      <StoreProbe />
    </StoriesProvider>
  );

const savedStory = (over: Partial<StoryRecord> = {}): StoryRecord => ({
  id: "saved-1",
  title: "The lighthouse keeper's secret",
  templateId: "noir",
  premise: "The lighthouse keeper's secret",
  length: "short",
  scenes: ["Scene one.", "Scene two."],
  summary: "sum",
  notes: "",
  options: [],
  feed: [],
  discussion: [],
  topicChats: { characters: [], environment: [], history: [] },
  bible: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

beforeEach(() => {
  mockVoiceOutFake.unlock.mockClear();
});

describe("Home", () => {
  it("renders a card per template", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText } = renderHome();
    await waitFor(() => expect(getByText("Fantasy Adventure")).toBeTruthy());
    expect(getByText("Mystery / Noir")).toBeTruthy();
  });

  it("tapping a seed fills the premise input", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByPlaceholderText } = renderHome();
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));
    fireEvent.press(getByText("A dragon egg hatches."));
    expect(getByPlaceholderText(/premise/i).props.value).toBe("A dragon egg hatches.");
  });

  it("shows a retry state when templates fail to load", async () => {
    jest.spyOn(api, "getTemplates").mockRejectedValue(new Error("down"));
    const { getByText } = renderHome();
    await waitFor(() => expect(getByText(/tap to retry/i)).toBeTruthy());
  });

  it("Begin creates a persistent story and routes into its write page", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByPlaceholderText, getByTestId } = renderHome();
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));
    fireEvent.changeText(getByPlaceholderText(/premise/i), "a premise");
    fireEvent.press(getByText(/^Long$/));
    fireEvent.press(getByText(/begin the story/i));

    // The story record carries what the route used to: template, length, premise.
    expect(getByTestId("store-probe").props.children).toBe(
      "fantasy|long|a premise"
    );
    const { router } = require("expo-router");
    expect(router.push).toHaveBeenCalledWith(
      expect.stringMatching(/^\/story\/.+\/write$/)
    );
  });

  it("lists saved stories and opens the hub on tap", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText } = renderHome([savedStory()]);
    await waitFor(() => getByText("Fantasy Adventure"));
    expect(getByText("The lighthouse keeper's secret")).toBeTruthy();
    expect(getByText("2 scenes")).toBeTruthy();
    fireEvent.press(getByText("The lighthouse keeper's secret"));
    const { router } = require("expo-router");
    expect(router.push).toHaveBeenCalledWith("/story/saved-1");
  });

  it("mic fills the premise input with the spoken transcript", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByTestId, getByPlaceholderText } = renderHome();
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
    const { getByText, getByPlaceholderText } = renderHome();
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));
    fireEvent.changeText(getByPlaceholderText(/premise/i), "a premise");
    fireEvent.press(getByText(/begin the story/i));
    expect(mockVoiceOutFake.unlock).toHaveBeenCalled();
  });

  it("pressing the premise mic blesses audio for iOS", async () => {
    jest.spyOn(api, "getTemplates").mockResolvedValue(TEMPLATES);
    const { getByText, getByTestId } = renderHome();
    await waitFor(() => getByText("Fantasy Adventure"));
    fireEvent.press(getByText("Fantasy Adventure"));
    fireEvent(getByTestId("premise-mic"), "pressIn");
    expect(mockVoiceOutFake.unlock).toHaveBeenCalled();
  });
});
