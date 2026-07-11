import { useEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { converse, getBible } from "../lib/api";
import { StreamingText } from "./StreamingText";
import { PushToTalk } from "./PushToTalk";
import { getVoiceOut, VoiceOut } from "../lib/voiceOut";
import { Bible, TopicKey, useStories } from "../lib/store";

/**
 * One story-bible page: a section extracted from the story (characters /
 * environment / history & places) plus a conversation scoped to that topic.
 * Talking here can NEVER advance the plot — a steer/pick/options intent from
 * the model is answered with a nudge toward the Story page instead of a
 * turn. Facts established here still flow into the shared notes canon, so
 * the story itself picks them up on the next scene.
 */

const TOPIC_CONFIG: Record<
  TopicKey,
  { title: string; icon: string; preamble: string; empty: string }
> = {
  characters: {
    title: "Characters",
    icon: "👤",
    preamble:
      "(We are on the Characters page, discussing the story's characters as collaborators. Do not advance the plot.)",
    empty: "No characters established yet — write some story first.",
  },
  environment: {
    title: "Environment",
    icon: "🌍",
    preamble:
      "(We are on the Environment page, discussing the story's world, atmosphere and setting as collaborators. Do not advance the plot.)",
    empty: "The world hasn't taken shape yet — write some story first.",
  },
  history: {
    title: "History & Places",
    icon: "📜",
    preamble:
      "(We are on the History & Places page, discussing the story's locations, lore and past events as collaborators. Do not advance the plot.)",
    empty: "No places or history established yet — write some story first.",
  },
};

const ROUTE_NUDGE =
  "That sounds like a story move — head to the Story page and say it there, and I'll write it.";

function BibleSection({ topic, bible }: { topic: TopicKey; bible: Bible }) {
  if (topic === "environment") {
    return bible.environment.trim() ? (
      <Text style={styles.bibleParagraph}>{bible.environment}</Text>
    ) : (
      <Text style={styles.bibleEmpty}>{TOPIC_CONFIG.environment.empty}</Text>
    );
  }
  const entries = topic === "characters" ? bible.characters : bible.places;
  if (entries.length === 0) {
    return <Text style={styles.bibleEmpty}>{TOPIC_CONFIG[topic].empty}</Text>;
  }
  return (
    <View>
      {entries.map((entry) => (
        <View key={entry.name} style={styles.bibleCard}>
          <Text style={styles.bibleName}>{entry.name}</Text>
          <Text style={styles.bibleDescription}>{entry.description}</Text>
        </View>
      ))}
    </View>
  );
}

export function TopicPage({ topic }: { topic: TopicKey }) {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getStory, updateStory } = useStories();
  const story = getStory(id);
  const config = TOPIC_CONFIG[topic];

  const [draft, setDraft] = useState("");
  const [currentReply, setCurrentReply] = useState("");
  const [replyCount, setReplyCount] = useState(0);
  const [bibleLoading, setBibleLoading] = useState(false);
  const [bibleError, setBibleError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const bibleRequestedRef = useRef(false);
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
      abortRef.current?.abort();
      voiceOut.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bibleStale =
    !!story &&
    story.scenes.length > 0 &&
    (story.bible === null || story.bible.forSummary !== story.summary);

  async function refreshBible() {
    if (!story || bibleLoading) return;
    setBibleLoading(true);
    setBibleError(false);
    try {
      const result = await getBible(story.summary, story.notes);
      updateStory(story.id, () => ({
        bible: { ...result, forSummary: story.summary },
      }));
    } catch {
      setBibleError(true);
    } finally {
      setBibleLoading(false);
    }
  }

  // Build the bible the first time a bible page is opened on a story that
  // has scenes (and rebuild when the summary moved on) — once per visit.
  useEffect(() => {
    if (bibleStale && !bibleRequestedRef.current) {
      bibleRequestedRef.current = true;
      refreshBible();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bibleStale, story?.id]);

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
  const chat = story.topicChats[topic] ?? [];

  async function runChat(utterance: string) {
    if (streamingRef.current || !story) return;
    streamingRef.current = true;
    voiceOut.stop();
    setIsStreaming(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;

    // The echo: the user's words appear on screen IMMEDIATELY — a reply,
    // an error, or a nudge always follows. Never a silent shrug.
    updateStory(storyId, (prev) => ({
      topicChats: {
        ...prev.topicChats,
        [topic]: [
          ...(prev.topicChats[topic] ?? []),
          { kind: "user_bubble" as const, text: utterance },
        ],
      },
    }));
    setCurrentReply("");
    setReplyCount((n) => n + 1);

    const discussion = [
      ...(story.topicChats[topic] ?? []),
      { kind: "user_bubble" as const, text: utterance },
    ]
      .filter((i) => i.kind === "user_bubble" || i.kind === "ai_bubble")
      .map((i) => ({
        role: i.kind === "user_bubble" ? ("user" as const) : ("ai" as const),
        text: i.text,
      }))
      .slice(-6);

    let replyText = "";
    let completed = false;
    let sawRoute = false;

    const commitAiBubble = (text: string, notes?: string) => {
      updateStory(storyId, (prev) => ({
        ...(notes !== undefined ? { notes } : {}),
        topicChats: {
          ...prev.topicChats,
          [topic]: [
            ...(prev.topicChats[topic] ?? []),
            { kind: "ai_bubble" as const, text },
          ],
        },
      }));
    };

    try {
      for await (const ev of converse(
        {
          template_id: story.templateId,
          utterance: `${config.preamble} ${utterance}`,
          summary: story.summary,
          notes: story.notes,
          options: [], // no cards here: this page is discussion-only
          discussion,
          turn: story.scenes.length + 1,
          length: story.length,
        },
        { signal: controller.signal }
      )) {
        if (ev.type === "reply_token") {
          replyText += ev.t;
          setCurrentReply(replyText);
        } else if (ev.type === "discussion_complete") {
          completed = true;
          if (replyText.trim()) {
            commitAiBubble(replyText, ev.notes);
            voiceOut.speak(replyText, { kind: "reply" });
          } else {
            updateStory(storyId, () => ({ notes: ev.notes }));
          }
          setCurrentReply("");
        } else if (ev.type === "route") {
          // Steer/pick/options don't belong on a bible page — nudge instead
          // of silently doing something to the story. Notes stay unchanged.
          sawRoute = true;
        } else if (ev.type === "stream_error") {
          setError(ev.detail);
        }
      }
    } finally {
      if (!completed && replyText.trim()) {
        commitAiBubble(replyText); // keep whatever streamed; notes unchanged
        setCurrentReply("");
      }
      streamingRef.current = false;
      setIsStreaming(false);
      abortRef.current = null;
    }

    if (sawRoute && !controller.signal.aborted) {
      commitAiBubble(ROUTE_NUDGE);
    }
  }

  const handleSend = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    setDraft("");
    runChat(text);
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
        onContentSizeChange={() =>
          scrollRef.current?.scrollToEnd({ animated: true })
        }
      >
        <Text style={styles.pageTitle}>
          {config.icon} {config.title}
        </Text>

        {story.scenes.length === 0 && (
          <Text style={styles.bibleEmpty}>{config.empty}</Text>
        )}
        {bibleLoading && (
          <Text style={styles.bibleStatus}>Reading the story…</Text>
        )}
        {bibleError && (
          <Pressable onPress={refreshBible} style={styles.retry}>
            <Text style={styles.retryText}>
              Couldn't build this page from the story — tap to retry.
            </Text>
          </Pressable>
        )}
        {!bibleLoading && story.bible && (
          <BibleSection topic={topic} bible={story.bible} />
        )}
        {!bibleLoading && story.scenes.length > 0 && (
          <Pressable
            testID="refresh-bible"
            onPress={refreshBible}
            style={styles.refreshButton}
          >
            <Text style={styles.refreshButtonText}>↻ Update from the story</Text>
          </Pressable>
        )}

        <View style={styles.chatDivider} />

        {chat.map((item, idx) =>
          item.kind === "user_bubble" ? (
            <View key={idx} style={[styles.bubble, styles.userBubble]}>
              <Text style={styles.bubbleText}>{item.text}</Text>
            </View>
          ) : item.kind === "ai_bubble" ? (
            <View key={idx} style={[styles.bubble, styles.aiBubble]}>
              <Text style={styles.bubbleText}>{item.text}</Text>
            </View>
          ) : null
        )}

        {currentReply.length > 0 && (
          <View style={[styles.bubble, styles.aiBubble]}>
            <StreamingText key={`reply-${replyCount}`} text={currentReply} />
          </View>
        )}

        {error && (
          <View style={[styles.bubble, styles.aiBubble]}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
      </ScrollView>

      <View style={styles.inputArea}>
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
        <View style={styles.inputRow}>
          <TextInput
            testID="topic-input"
            style={styles.input}
            placeholder={`Talk about the ${config.title.toLowerCase()}…`}
            placeholderTextColor="#888"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={handleSend}
            editable={!isStreaming}
          />
          <Pressable
            testID="topic-send"
            onPress={handleSend}
            disabled={isStreaming || draft.trim().length === 0}
            style={[
              styles.sendButton,
              (isStreaming || draft.trim().length === 0) &&
                styles.sendButtonDisabled,
            ]}
          >
            <Text style={styles.sendButtonText}>➤</Text>
          </Pressable>
          <PushToTalk
            testID="topic-mic"
            compact
            disabled={isStreaming}
            onUtterance={runChat}
            onActivate={() => {
              voiceOut.unlock();
              voiceOut.stop();
            }}
          />
        </View>
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
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  pageTitle: {
    fontSize: 22,
    fontWeight: "bold",
    color: "#f2f2f2",
    marginBottom: 14,
  },
  bibleCard: {
    padding: 14,
    borderRadius: 10,
    backgroundColor: "#1e1e1e",
    borderWidth: 1,
    borderColor: "#2e2e2e",
    marginBottom: 10,
  },
  bibleName: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#f2f2f2",
  },
  bibleDescription: {
    fontSize: 14,
    lineHeight: 21,
    color: "#c0c0c0",
    marginTop: 4,
  },
  bibleParagraph: {
    fontSize: 15,
    lineHeight: 23,
    color: "#c0c0c0",
  },
  bibleEmpty: {
    fontSize: 14,
    color: "#888",
    fontStyle: "italic",
  },
  bibleStatus: {
    fontSize: 14,
    color: "#a0a8c0",
    fontStyle: "italic",
  },
  refreshButton: {
    alignSelf: "flex-start",
    marginTop: 10,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: "#232733",
    borderWidth: 1,
    borderColor: "#3a3f4f",
  },
  refreshButtonText: {
    color: "#c8ccd8",
    fontSize: 13,
  },
  retry: {
    padding: 14,
    borderRadius: 8,
    backgroundColor: "#2a1414",
    borderWidth: 1,
    borderColor: "#5a2a2a",
  },
  retryText: {
    color: "#e08080",
    fontSize: 14,
  },
  chatDivider: {
    borderBottomWidth: 1,
    borderBottomColor: "#2e2e2e",
    marginVertical: 18,
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
  errorText: {
    color: "#e08080",
    fontSize: 14,
  },
  inputArea: {
    borderTopWidth: 1,
    borderTopColor: "#2e2e2e",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
    backgroundColor: "#121212",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  input: {
    flex: 1,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#2e2e2e",
    backgroundColor: "#1e1e1e",
    color: "#f2f2f2",
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#7aa2f7",
  },
  sendButtonDisabled: {
    backgroundColor: "#3a3f4f",
  },
  sendButtonText: {
    color: "#121212",
    fontSize: 16,
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
