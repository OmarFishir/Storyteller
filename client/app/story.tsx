import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { streamTurn, StoryLength, TurnRequest } from "../lib/api";
import { StreamingText } from "../components/StreamingText";

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
  const scrollRef = useRef<ScrollView>(null);
  const startedRef = useRef(false);
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  async function runTurn(req: TurnRequest) {
    // Guard against overlapping turns
    if (streamingRef.current) return;
    streamingRef.current = true;
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

  return (
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
          {options.map((option) => (
            <Pressable
              key={option}
              onPress={() => handleChoose(option)}
              style={styles.card}
            >
              <Text style={styles.cardTitle}>{option}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
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
  cardTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#f2f2f2",
  },
});
