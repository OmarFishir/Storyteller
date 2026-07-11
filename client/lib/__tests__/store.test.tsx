import { act, render } from "@testing-library/react-native";
import { Text } from "react-native";
import {
  defaultTitle,
  StoriesApi,
  StoriesProvider,
  StoryRecord,
  useStories,
} from "../store";

// Render the provider and hand the hook's api out to the test.
function setup(initialStories?: StoryRecord[]) {
  const ref: { api: StoriesApi | null } = { api: null };
  function Grab() {
    ref.api = useStories();
    return <Text>{ref.api.stories.map((s) => s.title).join(",")}</Text>;
  }
  const utils = render(
    <StoriesProvider initialStories={initialStories}>
      <Grab />
    </StoriesProvider>
  );
  return { ref, ...utils };
}

const STORAGE_KEY = "storyteller.stories.v1";

// jest-expo's RN environment has no localStorage (the store's wrapper
// no-ops there) — install a Map-backed shim so these tests exercise the
// REAL persistence path the web build uses.
const backing = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
  setItem: (k: string, v: string) => {
    backing.set(k, String(v));
  },
  removeItem: (k: string) => {
    backing.delete(k);
  },
};

beforeAll(() => {
  (globalThis as { localStorage?: unknown }).localStorage = fakeLocalStorage;
});

afterAll(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

beforeEach(() => {
  backing.clear();
});

describe("story store", () => {
  it("creates a story with the premise as its starting summary and title", () => {
    const { ref } = setup([]);
    let created!: StoryRecord;
    act(() => {
      created = ref.api!.createStory({
        templateId: "fantasy",
        premise: "A dragon egg hatches in a city without magic",
        length: "medium",
      });
    });
    expect(created.summary).toBe("A dragon egg hatches in a city without magic");
    expect(created.title).toBe("A dragon egg hatches in a…");
    expect(created.scenes).toEqual([]);
    expect(ref.api!.getStory(created.id)?.length).toBe("medium");
  });

  it("updateStory applies a functional patch to the latest record", () => {
    const { ref } = setup([]);
    let id = "";
    act(() => {
      id = ref.api!.createStory({
        templateId: "noir",
        premise: "One last case",
        length: "short",
      }).id;
    });
    act(() => {
      ref.api!.updateStory(id, (prev) => ({
        scenes: [...prev.scenes, "Scene one."],
      }));
    });
    act(() => {
      ref.api!.updateStory(id, (prev) => ({
        scenes: [...prev.scenes, "Scene two."],
      }));
    });
    expect(ref.api!.getStory(id)?.scenes).toEqual(["Scene one.", "Scene two."]);
  });

  it("persists to localStorage and loads back on a fresh provider", () => {
    const { ref, unmount } = setup(); // no initialStories: real load path
    act(() => {
      ref.api!.createStory({
        templateId: "scifi",
        premise: "The last signal from Mars",
        length: "long",
      });
    });
    unmount();

    const second = setup(); // fresh provider, loads from localStorage
    expect(second.ref.api!.stories).toHaveLength(1);
    expect(second.ref.api!.stories[0].premise).toBe("The last signal from Mars");
  });

  it("survives corrupt localStorage without crashing", () => {
    localStorage.setItem(STORAGE_KEY, "{not json![");
    const { ref } = setup();
    expect(ref.api!.stories).toEqual([]);
  });

  it("deleteStory removes the record", () => {
    const { ref } = setup([]);
    let id = "";
    act(() => {
      id = ref.api!.createStory({
        templateId: "fairytale",
        premise: "Once upon a bridge",
        length: "short",
      }).id;
    });
    act(() => {
      ref.api!.deleteStory(id);
    });
    expect(ref.api!.getStory(id)).toBeUndefined();
  });
});

describe("defaultTitle", () => {
  it("keeps short premises whole", () => {
    expect(defaultTitle("One last case")).toBe("One last case");
  });
  it("truncates long premises at six words", () => {
    expect(defaultTitle("A dragon egg hatches in a city without magic")).toBe(
      "A dragon egg hatches in a…"
    );
  });
  it("falls back for an empty premise", () => {
    expect(defaultTitle("   ")).toBe("Untitled story");
  });
});
