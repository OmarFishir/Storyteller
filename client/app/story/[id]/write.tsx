import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import {
  streamTurn,
  converse,
  StoryLength,
  TurnRequest,
} from "../../../lib/api";
import { StreamingText } from "../../../components/StreamingText";
import { PushToTalk } from "../../../components/PushToTalk";
import { matchCard } from "../../../lib/matchCard";
import { getVoiceOut, VoiceOut } from "../../../lib/voiceOut";
import { useStories } from "../../../lib/store";

type StreamError = { status: number; detail: string };

function errorMessage(error: StreamError): string {
  if (error.status === 429) return "Out of muse for today. Try again tomorrow.";
  if (error.status === 503) return "The muse is busy — tap to retry.";
  if (error.status === 0) return error.detail;
  return "Something went wrong — tap to retry.";
}

const LENGTHS = ["short", "medium", "long"] as const;

// Story records round-trip through localStorage, so length is an unchecked
// string at runtime. Total fallback to "short" for anything unexpected.
export function resolveStoryLength(raw: unknown): StoryLength {
  return typeof raw === "string" && (LENGTHS as readonly string[]).includes(raw)
    ? (raw as StoryLength)
    : "short";
}

export default function Write() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getStory, updateStory } = useStories();
  const story = getStory(id);

  const [currentScene, setCurrentScene] = useState("");
  const [currentReply, setCurrentReply] = useState("");
  const [replyCount, setReplyCount] = useState(0); // keys StreamingText per reply
  const [pendingTurn, setPendingTurn] = useState<TurnRequest | null>(null);
  const [pendingConverse, setPendingConverse] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<StreamError | null>(null);
  const [turnCount, setTurnCount] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const startedRef = useRef(false);
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const voiceOutRef = useRef<VoiceOut | null>(null);
  if (voiceOutRef.current === null) {
    voiceOutRef.current = getVoiceOut();
  }
  const voiceOut = voiceOutRef.current;

  useEffect(() => {
    voiceOut.onSpeakingChange(setIsSpeaking);
  }, [voiceOut]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort(); // stop billing a screen nobody is watching
      voiceOut.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A FRESH story (no scenes, nothing streamed yet) opens with its first
  // turn. A story being revisited just renders its feed — no auto-run.
  useEffect(() => {
    if (startedRef.current || !story || story.scenes.length > 0) return;
    startedRef.current = true;
    runTurn({
      template_id: story.templateId,
      summary: story.premise,
      chosen_scenario: "Open the story.",
      turn: 1,
      length: resolveStoryLength(story.length),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id]);

  if (!story) {
    return (
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backButtonText}>← Home</Text>
          </Pressable>
        </View>
        <Text style={styles.missingText}>This story isn't here anymore.</Text>
      </View>
    );
  }
  const storyId = story.id;

  async function runTurn(req: TurnRequest) {
    // Guard against overlapping turns (one busy flag shared with runConverse)
    if (streamingRef.current || !story) return;
    streamingRef.current = true;
    voiceOut.stop(); // a new turn silences whatever scene/reply was narrating
    setIsStreaming(true);
    setStopped(false);
    setPendingConverse(null); // choosing a card or retrying a scene abandons a failed conversation
    const controller = new AbortController();
    abortRef.current = controller;

    setError(null);
    setCurrentScene("");
    setPendingTurn(req);
    setTurnCount((n) => n + 1);
    // An offer is consumed by the next turn — drop any leftover cards.
    updateStory(storyId, (prev) => ({
      options: [],
      feed: prev.feed.filter((i) => i.kind !== "cards"),
    }));

    let sceneText = "";
    let gotTurnComplete = false;
    let gotError = false;

    try {
      for await (const ev of streamTurn(
        { ...req, notes: story.notes },
        { signal: controller.signal }
      )) {
        if (ev.type === "token") {
          sceneText += ev.t;
          setCurrentScene(sceneText);
        } else if (ev.type === "turn_complete") {
          gotTurnComplete = true;
          updateStory(storyId, (prev) => ({
            scenes: [...prev.scenes, sceneText],
            feed: [
              ...prev.feed,
              { kind: "scene", text: sceneText },
              { kind: "cards", options: ev.scenarios },
            ],
            summary: ev.summary,
            options: ev.scenarios,
          }));
          setCurrentScene("");
          setPendingTurn(null);
          voiceOut.speak(sceneText, { kind: "scene" });
        } else if (ev.type === "stream_error") {
          gotError = true;
          setError({ status: ev.status, detail: ev.detail });
        }
      }
      // A deliberate stop (not an error, not a natural completion) leaves the
      // scene mid-flight — surface a neutral resume affordance, not an error.
      if (controller.signal.aborted && !gotTurnComplete && !gotError) {
        setStopped(true);
      }
    } finally {
      streamingRef.current = false;
      setIsStreaming(false);
      abortRef.current = null;
    }
  }

  async function runConverse(utterance: string, isRetry = false) {
    if (streamingRef.current || !story) return;
    streamingRef.current = true;
    voiceOut.stop(); // a new turn silences whatever scene/reply was narrating
    setIsStreaming(true);
    setStopped(false);
    setPendingConverse(null);
    const controller = new AbortController();
    abortRef.current = controller;

    if (!isRetry) {
      updateStory(storyId, (prev) => ({
        feed: [...prev.feed, { kind: "user_bubble", text: utterance }],
        discussion: [
          ...prev.discussion,
          { role: "user" as const, text: utterance },
        ].slice(-6),
      }));
    }
    setError(null);
    setCurrentReply("");
    setReplyCount((n) => n + 1);

    let routed:
      | { intent: "pick"; index: number }
      | { intent: "steer" }
      | { intent: "options"; scenarios: string[] }
      | null = null;
    let replyText = "";
    let completed = false;

    try {
      for await (const ev of converse(
        {
          template_id: story.templateId,
          utterance,
          summary: story.summary,
          notes: story.notes,
          options: story.options,
          discussion: isRetry
            ? [...story.discussion].slice(-6)
            : [
                ...story.discussion,
                { role: "user" as const, text: utterance },
              ].slice(-6),
          turn: story.scenes.length + 1,
          length: resolveStoryLength(story.length),
        },
        { signal: controller.signal }
      )) {
        if (ev.type === "reply_token") {
          replyText += ev.t;
          setCurrentReply(replyText);
        } else if (ev.type === "discussion_complete") {
          completed = true;
          const notes = ev.notes;
          const reply = replyText;
          updateStory(storyId, (prev) => ({
            notes,
            ...(reply.trim()
              ? {
                  feed: [...prev.feed, { kind: "ai_bubble" as const, text: reply }],
                  discussion: [
                    ...prev.discussion,
                    { role: "ai" as const, text: reply },
                  ].slice(-6),
                }
              : {}),
          }));
          if (replyText.trim()) {
            voiceOut.speak(replyText, { kind: "reply" });
          }
          setCurrentReply("");
        } else if (ev.type === "route") {
          routed = ev;
        } else if (ev.type === "stream_error") {
          setError({ status: ev.status, detail: ev.detail });
          setPendingConverse(utterance);
        }
      }
    } finally {
      // An aborted or failed reply keeps whatever streamed (you can't un-say
      // it), but notes stay unchanged — canon only updates through
      // discussion_complete.
      if (!completed && replyText.trim()) {
        const reply = replyText;
        updateStory(storyId, (prev) => ({
          feed: [...prev.feed, { kind: "ai_bubble" as const, text: reply }],
          discussion: [
            ...prev.discussion,
            { role: "ai" as const, text: reply },
          ].slice(-6),
        }));
        setCurrentReply("");
      }
      streamingRef.current = false;
      setIsStreaming(false);
      abortRef.current = null;
    }

    // Act on the route AFTER the loop + guard release, so it can safely kick
    // off the next turn (which re-acquires the same guard). A route captured
    // just before Stop was pressed must not fire — the user braked, and
    // handleChoose would otherwise launch a fresh turn behind their back.
    if (routed && !controller.signal.aborted) {
      if (routed.intent === "pick") handleChoose(story.options[routed.index]);
      else if (routed.intent === "steer") handleChoose(utterance);
      else if (routed.intent === "options") {
        const scenarios = routed.scenarios;
        updateStory(storyId, (prev) => ({
          options: scenarios,
          feed: [
            ...prev.feed.filter((i) => i.kind !== "cards"),
            { kind: "cards", options: scenarios },
          ],
        }));
      }
    }
  }

  const handleChoose = (scenario: string) => {
    if (!story) return;
    runTurn({
      template_id: story.templateId,
      summary: story.summary,
      chosen_scenario: scenario,
      turn: story.scenes.length + 1,
      length: resolveStoryLength(story.length),
    });
  };

  const handleRetry = () => {
    if (pendingConverse) runConverse(pendingConverse, true);
    else if (pendingTurn) runTurn(pendingTurn);
  };

  // Push-to-talk: EVERY utterance echoes on screen first — the app must
  // never look like it disregarded the user (the Samuel lesson: a garbled
  // transcript that silently fired a turn was indistinguishable from being
  // ignored). An ordinal match ("the second one") then picks a card straight
  // away; anything else goes to /converse, where a model decides
  // pick / steer / discuss / options with context.
  const handleUtterance = (utterance: string) => {
    if (!story) return;
    const idx = matchCard(utterance, story.options);
    if (idx !== null) {
      const chosen = story.options[idx];
      updateStory(storyId, (prev) => ({
        feed: [...prev.feed, { kind: "user_bubble", text: utterance }],
      }));
      handleChoose(chosen);
      return;
    }
    runConverse(utterance);
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.replace(`/story/${storyId}`)}
          style={styles.backButton}
        >
          <Text style={styles.backButtonText}>← {story.title}</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.screen}
        contentContainerStyle={styles.content}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {story.feed.map((item, idx) => {
          if (item.kind === "scene") {
            return (
              <Text key={idx} style={styles.sceneText}>
                {item.text}
              </Text>
            );
          }
          if (item.kind === "user_bubble") {
            return (
              <View key={idx} style={[styles.bubble, styles.userBubble]}>
                <Text style={styles.bubbleText}>{item.text}</Text>
              </View>
            );
          }
          if (item.kind === "ai_bubble") {
            return (
              <View key={idx} style={[styles.bubble, styles.aiBubble]}>
                <Text style={styles.bubbleText}>{item.text}</Text>
              </View>
            );
          }
          // item.kind === "cards"
          return (
            <View key={idx} style={styles.optionsSection}>
              {item.options.map((option) => (
                <Pressable
                  key={option}
                  onPress={() => {
                    voiceOut.unlock(); // a real tap: bless iOS audio before narration needs it
                    handleChoose(option);
                  }}
                  style={styles.card}
                >
                  <Text style={styles.cardTitle}>{option}</Text>
                </Pressable>
              ))}
            </View>
          );
        })}

        {!error && <StreamingText key={turnCount} text={currentScene} />}

        {!error && currentReply.length > 0 && (
          <View style={[styles.bubble, styles.aiBubble]}>
            <StreamingText key={`reply-${replyCount}`} text={currentReply} />
          </View>
        )}

        {error && (
          <View style={styles.errorBox}>
            {currentScene.length > 0 && (
              <Text style={styles.sceneText}>{currentScene}</Text>
            )}
            <Pressable onPress={handleRetry} style={styles.retry}>
              <Text style={styles.retryText}>{errorMessage(error)}</Text>
            </Pressable>
          </View>
        )}

        {!error && stopped && pendingTurn && (
          <Pressable onPress={handleRetry} style={styles.stopped}>
            <Text style={styles.stoppedText}>
              Stopped — tap to continue the scene
            </Text>
          </Pressable>
        )}
      </ScrollView>

      <View style={styles.pttArea}>
        {(isStreaming || isSpeaking) && (
          <Pressable
            testID="stop-button"
            onPress={() => {
              abortRef.current?.abort();
              voiceOut.stop();
            }}
            style={styles.stopButton}
          >
            <Text style={styles.stopButtonText}>■ Stop</Text>
          </Pressable>
        )}
        <PushToTalk
          onActivate={() => {
            voiceOut.unlock(); // a real tap: bless iOS audio
            voiceOut.stop();
          }}
          disabled={isStreaming}
          onUtterance={handleUtterance}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#121212",
  },
  header: {
    flexDirection: "row",
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
  },
  backButton: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  backButtonText: {
    color: "#7aa2f7",
    fontSize: 15,
    fontWeight: "bold",
  },
  missingText: {
    color: "#a0a0a0",
    fontSize: 15,
    padding: 20,
  },
  screen: {
    flex: 1,
    backgroundColor: "#121212",
  },
  content: {
    padding: 20,
    paddingBottom: 60,
  },
  sceneText: {
    fontSize: 17,
    lineHeight: 26,
    color: "#f2f2f2",
    marginBottom: 14,
  },
  bubble: {
    maxWidth: "85%",
    padding: 14,
    borderRadius: 14,
    marginBottom: 12,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#1a2333",
    borderWidth: 1,
    borderColor: "#2e3a50",
    borderBottomRightRadius: 4,
  },
  aiBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#1e1e1e",
    borderWidth: 1,
    borderColor: "#2e2e2e",
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    color: "#f2f2f2",
    fontSize: 15,
    lineHeight: 22,
  },
  errorBox: {
    marginTop: 8,
  },
  retry: {
    padding: 16,
    borderRadius: 8,
    backgroundColor: "#2a1414",
    borderWidth: 1,
    borderColor: "#5a2a2a",
  },
  retryText: {
    color: "#e08080",
    fontSize: 15,
  },
  stopped: {
    padding: 16,
    borderRadius: 8,
    backgroundColor: "#1e1e1e",
    borderWidth: 1,
    borderColor: "#3a3f4f",
    marginTop: 8,
  },
  stoppedText: {
    color: "#a0a8c0",
    fontSize: 15,
  },
  optionsSection: {
    marginTop: 12,
  },
  card: {
    padding: 16,
    borderRadius: 10,
    backgroundColor: "#1e1e1e",
    borderWidth: 1,
    borderColor: "#2e2e2e",
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#f2f2f2",
  },
  pttArea: {
    borderTopWidth: 1,
    borderTopColor: "#2e2e2e",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
    backgroundColor: "#121212",
  },
  stopButton: {
    alignSelf: "center",
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 16,
    backgroundColor: "#1e1e1e",
    borderWidth: 1,
    borderColor: "#3a3f4f",
    marginBottom: 10,
  },
  stopButtonText: {
    color: "#c0c4d0",
    fontSize: 13,
    fontWeight: "bold",
  },
});
