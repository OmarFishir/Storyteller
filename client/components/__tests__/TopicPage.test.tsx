import { render, fireEvent, waitFor, act } from "@testing-library/react-native";
import { TopicPage } from "../TopicPage";
import { StoriesProvider, StoryRecord } from "../../lib/store";
import * as api from "../../lib/api";
import type { StreamEvent } from "../../lib/sse";

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "s1" }),
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn() },
}));

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

async function* fixtureStream(events: StreamEvent[]) {
  for (const ev of events) yield ev;
}

const BIBLE = {
  characters: [{ name: "Samuel", description: "A quiet archivist with a debt." }],
  places: [{ name: "The lower stacks", description: "Forbidden depths." }],
  environment: "A candlelit library-city where maps misbehave.",
};

const storyWithScenes = (over: Partial<StoryRecord> = {}): StoryRecord => ({
  id: "s1",
  title: "The map that draws itself",
  templateId: "fantasy",
  premise: "p",
  length: "short",
  scenes: ["Scene one."],
  summary: "Mira found the door.",
  notes: "Maps are alive.",
  options: ["Old card"],
  feed: [],
  discussion: [],
  topicChats: { characters: [], environment: [], history: [] },
  bible: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const renderTopic = (
  topic: "characters" | "environment" | "history",
  story: StoryRecord = storyWithScenes()
) =>
  render(
    <StoriesProvider initialStories={[story]}>
      <TopicPage topic={topic} />
    </StoriesProvider>
  );

beforeEach(() => {
  mockVoiceFake.start.mockClear();
  mockVoiceOutFake.speak.mockClear();
  mockVoiceOutFake.stop.mockClear();
  mockVoiceOutFake.unlock.mockClear();
});

describe("TopicPage", () => {
  it("builds the bible from the story and lists characters", async () => {
    const bibleSpy = jest.spyOn(api, "getBible").mockResolvedValue(BIBLE);
    const { getByText } = renderTopic("characters");
    await waitFor(() => getByText("Samuel"));
    expect(getByText(/quiet archivist/)).toBeTruthy();
    expect(bibleSpy).toHaveBeenCalledWith("Mira found the door.", "Maps are alive.");
  });

  it("shows places on the history page and prose on the environment page", async () => {
    jest.spyOn(api, "getBible").mockResolvedValue(BIBLE);
    const history = renderTopic("history");
    await waitFor(() => history.getByText("The lower stacks"));

    jest.spyOn(api, "getBible").mockResolvedValue(BIBLE);
    const environment = renderTopic("environment");
    await waitFor(() => environment.getByText(/candlelit library-city/));
  });

  it("a story with no scenes yet asks for writing first and never fetches", () => {
    const bibleSpy = jest.spyOn(api, "getBible");
    const { getByText } = renderTopic(
      "characters",
      storyWithScenes({ scenes: [], summary: "p" })
    );
    expect(getByText(/write some story first/i)).toBeTruthy();
    expect(bibleSpy).not.toHaveBeenCalled();
  });

  it("chat echoes the user, scopes the utterance to the topic, and streams the reply", async () => {
    jest.spyOn(api, "getBible").mockResolvedValue(BIBLE);
    const converseSpy = jest.spyOn(api, "converse").mockReturnValueOnce(
      fixtureStream([
        { type: "reply_token", t: "Samuel owes " },
        { type: "reply_token", t: "the cartographers." },
        { type: "discussion_complete", notes: "Samuel owes the cartographers." },
      ])
    );

    const { getByText, getByTestId } = renderTopic("characters");
    await waitFor(() => getByText("Samuel"));

    fireEvent.changeText(getByTestId("topic-input"), "tell me about Samuel");
    fireEvent.press(getByTestId("topic-send"));

    await waitFor(() => getByText(/tell me about Samuel/)); // the echo — never a silent shrug
    await waitFor(() => getByText(/Samuel owes the cartographers./));

    expect(converseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining("tell me about Samuel"),
        options: [], // discussion-only: a bible page can never fire a turn by accident
        summary: "Mira found the door.",
        notes: "Maps are alive.",
      }),
      expect.anything()
    );
    const sent = (converseSpy.mock.calls[0][0] as { utterance: string }).utterance;
    expect(sent).toContain("Characters page"); // topic scoping preamble
    // The reply narrates, voice-first as everywhere else.
    expect(mockVoiceOutFake.speak).toHaveBeenCalledWith(
      "Samuel owes the cartographers.",
      expect.objectContaining({ kind: "reply" })
    );
  });

  it("a steer/pick route becomes a nudge toward the Story page, never a turn", async () => {
    jest.spyOn(api, "getBible").mockResolvedValue(BIBLE);
    const turnSpy = jest.spyOn(api, "streamTurn");
    jest
      .spyOn(api, "converse")
      .mockReturnValueOnce(fixtureStream([{ type: "route", intent: "steer" }]));

    const { getByText, getByTestId } = renderTopic("characters");
    await waitFor(() => getByText("Samuel"));

    fireEvent.changeText(getByTestId("topic-input"), "Samuel betrays them all");
    fireEvent.press(getByTestId("topic-send"));

    await waitFor(() => getByText(/head to the Story page/i));
    expect(turnSpy).not.toHaveBeenCalled();
  });

  it("a converse failure surfaces inline instead of vanishing", async () => {
    jest.spyOn(api, "getBible").mockResolvedValue(BIBLE);
    jest.spyOn(api, "converse").mockReturnValueOnce(
      fixtureStream([{ type: "stream_error", status: 503, detail: "The AI model is busy right now. Please try again in a moment." }])
    );

    const { getByText, getByTestId } = renderTopic("characters");
    await waitFor(() => getByText("Samuel"));

    fireEvent.changeText(getByTestId("topic-input"), "who is Samuel");
    fireEvent.press(getByTestId("topic-send"));

    await waitFor(() => getByText(/who is Samuel/)); // echo stays
    await waitFor(() => getByText(/busy right now/i)); // failure is VISIBLE
  });

  it("the spoken mic path unlocks iOS audio and runs the same chat", async () => {
    jest.spyOn(api, "getBible").mockResolvedValue(BIBLE);
    jest.spyOn(api, "converse").mockReturnValueOnce(
      fixtureStream([
        { type: "reply_token", t: "He keeps the door." },
        { type: "discussion_complete", notes: "n" },
      ])
    );

    const { getByText, getByTestId } = renderTopic("characters");
    await waitFor(() => getByText("Samuel"));

    fireEvent(getByTestId("topic-mic"), "pressIn");
    expect(mockVoiceOutFake.unlock).toHaveBeenCalled();
    const cb = mockVoiceFake.start.mock.calls[0][0];
    fireEvent(getByTestId("topic-mic"), "pressOut");
    act(() => cb.onFinal("what does Samuel guard"));

    await waitFor(() => getByText(/what does Samuel guard/)); // the echo
    await waitFor(() => getByText(/He keeps the door./));
  });
});
