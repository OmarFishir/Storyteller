import { render, fireEvent } from "@testing-library/react-native";
import StoryHub from "../story/[id]/index";
import { StoriesProvider, StoryRecord } from "../../lib/store";

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "s1" }),
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn() },
}));

const story = (over: Partial<StoryRecord> = {}): StoryRecord => ({
  id: "s1",
  title: "The map that draws itself",
  templateId: "fantasy",
  premise: "p",
  length: "short",
  scenes: ["Scene one.", "Scene two.", "Scene three."],
  summary: "Mira found the door.",
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

const renderHub = (s: StoryRecord = story()) =>
  render(
    <StoriesProvider initialStories={[s]}>
      <StoryHub />
    </StoriesProvider>
  );

describe("StoryHub", () => {
  it("shows the story's name, summary, and all four sections", () => {
    const { getByTestId, getByText } = renderHub();
    expect(getByTestId("story-title").props.value).toBe(
      "The map that draws itself"
    );
    expect(getByText("Mira found the door.")).toBeTruthy();
    expect(getByText("Story")).toBeTruthy();
    expect(getByText("3 scenes — continue")).toBeTruthy();
    expect(getByText("Characters")).toBeTruthy();
    expect(getByText("Environment")).toBeTruthy();
    expect(getByText("History & Places")).toBeTruthy();
  });

  it("each section card navigates to its page", () => {
    const { getByTestId } = renderHub();
    const { router } = require("expo-router");
    fireEvent.press(getByTestId("hub-write"));
    expect(router.push).toHaveBeenLastCalledWith("/story/s1/write");
    fireEvent.press(getByTestId("hub-characters"));
    expect(router.push).toHaveBeenLastCalledWith("/story/s1/characters");
    fireEvent.press(getByTestId("hub-environment"));
    expect(router.push).toHaveBeenLastCalledWith("/story/s1/environment");
    fireEvent.press(getByTestId("hub-history"));
    expect(router.push).toHaveBeenLastCalledWith("/story/s1/history");
  });

  it("renaming the story sticks", () => {
    const { getByTestId } = renderHub();
    fireEvent.changeText(getByTestId("story-title"), "The Cartographer's Debt");
    expect(getByTestId("story-title").props.value).toBe(
      "The Cartographer's Debt"
    );
  });

  it("a fresh story invites the first scene", () => {
    const { getByText } = renderHub(story({ scenes: [], summary: "p" }));
    expect(getByText("Begin the first scene")).toBeTruthy();
  });
});
