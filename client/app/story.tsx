import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { streamTurn, StoryLength, TurnRequest } from "../lib/api";
import { StreamingText } from "../components/StreamingText";
import { PushToTalk } from "../components/PushToTalk";
import { matchCard } from "../lib/matchCard";

type ConfirmPending = { utterance: string; matchedIndex: number | null };

type StreamError = { status: number; detail: string };

function errorMessage(error: StreamError): string {
  if (error.status === 429) return "Out of muse for today. Try again tomorrow.";
  if (error.status === 503) return "The muse is busy — tap to retry.";
  if (error.status === 0) return error.detail;
  return "Something went wrong — tap to retry.";
}

const LENGTHS = ["short", "medium", "long"] as const;

// The route param is an unchecked cast from useLocalSearchParams — it's
// URL-editable on web and can arrive as an array if the query string
// duplicates the key. Total fallback to "short" for anything that isn't
// exactly one of the three known lengths.
export function resolveStoryLength(raw: unknown): StoryLength {
  return typeof raw === "string" && (LENGTHS as readonly string[]).includes(raw)
    ? (raw as StoryLength)
    : "short";
}

export default function Story() {
  const { templateId, premise, length } = useLocalSearchParams<{
    templateId: string;
    premise: string;
    length: StoryLength;
  }>();
  const storyLength: StoryLength = resolveStoryLength(length);

  const [scenes, setScenes] = useState<string[]>([]);
  const [currentScene, setCurrentScene] = useState("");
  const [options, setOptions] = useState<string[]>([]);
  const [summary, setSummary] = useState(premise);
  const [pendingTurn, setPendingTurn] = useState<TurnRequest | null>(null);
  const [error, setError] = useState<StreamError | null>(null);
  const [turnCount, setTurnCount] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [confirmPending, setConfirmPending] = useState<ConfirmPending | null>(
    null
  );
  const scrollRef = useRef<ScrollView>(null);
  const startedRef = useRef(false);
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function runTurn(req: TurnRequest) {
    // Guard against overlapping turns
    if (streamingRef.current) return;
    streamingRef.current = true;
    // A card tap or retry starting a fresh turn must discard any pending
    // spoken-utterance confirm timer — otherwise it fires 1.5s later and
    // double-spends a Gemini call via a second handleChoose.
    cancelConfirm();
    setIsStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      setError(null);
      setCurrentScene("");
      setOptions([]);
      setPendingTurn(req);
      setTurnCount((n) => n + 1);

      let sceneText = "";
      for await (const ev of streamTurn(req, { signal: controller.signal })) {
        if (ev.type === "token") {
          sceneText += ev.t;
          setCurrentScene(sceneText);
        } else if (ev.type === "turn_complete") {
          setScenes((prev) => [...prev, sceneText]);
          setCurrentScene("");
          setSummary(ev.summary);
          setOptions(ev.scenarios);
          setPendingTurn(null);
        } else if (ev.type === "stream_error") {
          setError({ status: ev.status, detail: ev.detail });
        }
      }
    } finally {
      streamingRef.current = false;
      setIsStreaming(false);
      abortRef.current = null;
    }
  }

  useEffect(() => {
    return () => {
      abortRef.current?.abort(); // stop billing a screen nobody is watching
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    runTurn({
      template_id: templateId,
      summary: premise,
      chosen_scenario: "Open the story.",
      turn: scenes.length + 1,
      length: storyLength,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChoose = (scenario: string) => {
    runTurn({
      template_id: templateId,
      summary,
      chosen_scenario: scenario,
      turn: scenes.length + 1,
      length: storyLength,
    });
  };

  const handleRetry = () => {
    if (pendingTurn) runTurn(pendingTurn);
  };

  // Push-to-talk: a spoken utterance either picks a card (matchCard finds an
  // ordinal/overlap match) or steers the story free-form (no match). Either
  // way it fires through handleChoose — the SAME path option-card taps use —
  // after a 1.5s confirm window the speaker can cancel.
  const handleUtterance = (utterance: string) => {
    // Optional hardening: discard any prior pending confirm timer before
    // arming a new one, so two utterances in quick succession can't both
    // end up with a live timeout.
    if (confirmTimeoutRef.current) {
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
    const matchedIndex = matchCard(utterance, options);
    setConfirmPending({ utterance, matchedIndex });
    confirmTimeoutRef.current = setTimeout(() => {
      confirmTimeoutRef.current = null;
      setConfirmPending(null);
      handleChoose(matchedIndex !== null ? options[matchedIndex] : utterance);
    }, 1500);
  };

  const cancelConfirm = () => {
    if (confirmTimeoutRef.current) {
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
    setConfirmPending(null);
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backButtonText}>← Home</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.screen}
        contentContainerStyle={styles.content}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {scenes.map((scene, idx) => (
          <Text key={idx} style={styles.sceneText}>
            {scene}
          </Text>
        ))}

        {!error && <StreamingText key={turnCount} text={currentScene} />}

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

        {!error && options.length > 0 && (
          <View style={styles.optionsSection}>
            {options.map((option, idx) => (
              <Pressable
                key={option}
                onPress={() => handleChoose(option)}
                style={[
                  styles.card,
                  confirmPending?.matchedIndex === idx && styles.cardHighlighted,
                ]}
              >
                <Text style={styles.cardTitle}>{option}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>

      <View style={styles.pttArea}>
        {confirmPending && (
          <View style={styles.confirmBar}>
            <Text style={styles.confirmText}>
              Heard: "{confirmPending.utterance}" →{" "}
              {confirmPending.matchedIndex !== null
                ? `choosing option ${confirmPending.matchedIndex + 1}`
                : "steering the story"}
            </Text>
            <Pressable onPress={cancelConfirm} style={styles.cancelButton}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
          </View>
        )}
        <PushToTalk
          disabled={isStreaming || confirmPending !== null}
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
  cardHighlighted: {
    borderColor: "#7aa2f7",
    backgroundColor: "#1a2333",
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
  confirmBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    borderRadius: 8,
    backgroundColor: "#1e1e1e",
    borderWidth: 1,
    borderColor: "#3a3f4f",
    marginBottom: 8,
    gap: 12,
  },
  confirmText: {
    flex: 1,
    color: "#f2f2f2",
    fontSize: 14,
  },
  cancelButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: "#2a1414",
    borderWidth: 1,
    borderColor: "#5a2a2a",
  },
  cancelButtonText: {
    color: "#e08080",
    fontSize: 13,
    fontWeight: "bold",
  },
});
