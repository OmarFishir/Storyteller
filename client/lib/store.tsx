/**
 * The story store — every story the user has, as one global, persistent
 * source of truth. This exists because v1 kept story state inside the Story
 * screen: navigating away UNMOUNTED the screen and silently destroyed the
 * story (the first thing the owner hit on a real phone). Now screens are
 * views over this store; navigation can never lose a story.
 *
 * Persistence: localStorage on web (the phone preview runs in Safari).
 * Native has no localStorage — the wrapper no-ops and stories live for the
 * session only; a native storage impl slots into the same two functions
 * later (same swap-in-one-place philosophy as MODEL / VoiceIn / VoiceOut).
 *
 * The hard invariant lives here now: `scenes` is the canonical story —
 * verbatim, append-only. `summary`/`notes` are AI working memory.
 */

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { DiscussionEntry, StoryLength } from "./api";

export type FeedItem =
  | { kind: "scene"; text: string }
  | { kind: "user_bubble"; text: string }
  | { kind: "ai_bubble"; text: string }
  | { kind: "cards"; options: string[] };

export type TopicKey = "characters" | "environment" | "history";

export type BibleEntry = { name: string; description: string };
export type Bible = {
  characters: BibleEntry[];
  places: BibleEntry[];
  environment: string;
  /** The summary this bible was extracted from — differs => stale. */
  forSummary: string;
};

export type StoryRecord = {
  id: string;
  title: string;
  templateId: string;
  premise: string;
  length: StoryLength;
  /** Canonical story: verbatim scenes, append-only. */
  scenes: string[];
  summary: string;
  notes: string;
  options: string[];
  feed: FeedItem[];
  discussion: DiscussionEntry[];
  topicChats: Record<TopicKey, FeedItem[]>;
  bible: Bible | null;
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = "storyteller.stories.v1";

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function storage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null; // some privacy modes throw on ACCESS — treat as no storage
  }
}

function loadStories(): StoryRecord[] {
  const ls = storage();
  if (!ls) return [];
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoryRecord[]) : [];
  } catch {
    return []; // corrupt storage never blocks the app
  }
}

function saveStories(stories: StoryRecord[]) {
  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(stories));
  } catch {
    // quota/privacy failure: the app keeps working, just without persistence
  }
}

/** "A dragon egg hatches in a city without magic" -> "A dragon egg hatches in a…" */
export function defaultTitle(premise: string): string {
  const words = premise.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Untitled story";
  const head = words.slice(0, 6).join(" ");
  return words.length > 6 ? `${head}…` : head;
}

type CreateStoryInit = {
  templateId: string;
  premise: string;
  length: StoryLength;
};

export type StoriesApi = {
  stories: StoryRecord[];
  getStory: (id: string | undefined) => StoryRecord | undefined;
  createStory: (init: CreateStoryInit) => StoryRecord;
  /** Functional patch — always reads the LATEST record, safe from async/stale closures. */
  updateStory: (
    id: string,
    update: (prev: StoryRecord) => Partial<StoryRecord>
  ) => void;
  deleteStory: (id: string) => void;
};

const StoriesContext = createContext<StoriesApi | null>(null);

export function StoriesProvider({
  children,
  initialStories,
}: {
  children: ReactNode;
  /** Test seam: seed known records and skip localStorage load. */
  initialStories?: StoryRecord[];
}) {
  const [stories, setStories] = useState<StoryRecord[]>(
    initialStories ?? loadStories
  );

  useEffect(() => {
    saveStories(stories);
  }, [stories]);

  const getStory = useCallback(
    (id: string | undefined) => stories.find((s) => s.id === id),
    [stories]
  );

  const createStory = useCallback((init: CreateStoryInit): StoryRecord => {
    const now = Date.now();
    const story: StoryRecord = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title: defaultTitle(init.premise),
      templateId: init.templateId,
      premise: init.premise,
      length: init.length,
      scenes: [],
      summary: init.premise, // turn 1's "story so far" is the premise itself
      notes: "",
      options: [],
      feed: [],
      discussion: [],
      topicChats: { characters: [], environment: [], history: [] },
      bible: null,
      createdAt: now,
      updatedAt: now,
    };
    setStories((prev) => [story, ...prev]);
    return story;
  }, []);

  const updateStory = useCallback(
    (id: string, update: (prev: StoryRecord) => Partial<StoryRecord>) => {
      setStories((prev) =>
        prev.map((s) =>
          s.id === id
            ? { ...s, ...update(s), id: s.id, updatedAt: Date.now() }
            : s
        )
      );
    },
    []
  );

  const deleteStory = useCallback((id: string) => {
    setStories((prev) => prev.filter((s) => s.id !== id));
  }, []);

  return (
    <StoriesContext.Provider
      value={{ stories, getStory, createStory, updateStory, deleteStory }}
    >
      {children}
    </StoriesContext.Provider>
  );
}

export function useStories(): StoriesApi {
  const ctx = useContext(StoriesContext);
  if (!ctx) {
    throw new Error("useStories must be used inside <StoriesProvider>");
  }
  return ctx;
}
