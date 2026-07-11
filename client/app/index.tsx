import { useCallback, useEffect, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { getTemplates, StoryLength, Template } from "../lib/api";
import { PushToTalk } from "../components/PushToTalk";
import { getVoiceOut } from "../lib/voiceOut";
import { useStories } from "../lib/store";

type LoadState = "loading" | "error" | "ready";

const LENGTH_OPTIONS: StoryLength[] = ["short", "medium", "long"];
const LENGTH_LABELS: Record<StoryLength, string> = {
  short: "Short",
  medium: "Medium",
  long: "Long",
};

export default function Home() {
  const { stories, createStory } = useStories();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [selected, setSelected] = useState<Template | null>(null);
  const [premise, setPremise] = useState("");
  const [length, setLength] = useState<StoryLength>("short");

  const loadTemplates = useCallback(() => {
    setLoadState("loading");
    getTemplates()
      .then((loaded) => {
        setTemplates(loaded);
        setLoadState("ready");
      })
      .catch(() => setLoadState("error"));
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const canBegin = selected !== null && premise.trim().length > 0;

  const beginStory = () => {
    if (!selected || !canBegin) return;
    // A real tap: bless iOS audio now so the opening scene can auto-narrate.
    getVoiceOut().unlock();
    const story = createStory({
      templateId: selected.id,
      premise,
      length,
    });
    router.push(`/story/${story.id}/write`);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Storyteller</Text>

      {stories.length > 0 && (
        <View style={styles.librarySection}>
          <Text style={styles.sectionLabel}>Your stories</Text>
          {stories.map((story) => (
            <Pressable
              key={story.id}
              testID={`story-card-${story.id}`}
              onPress={() => router.push(`/story/${story.id}`)}
              style={styles.storyCard}
            >
              <Text style={styles.storyCardTitle}>{story.title}</Text>
              <Text style={styles.storyCardMeta}>
                {story.scenes.length}{" "}
                {story.scenes.length === 1 ? "scene" : "scenes"}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <Text style={styles.sectionLabel}>
        {stories.length > 0
          ? "Start a new story"
          : "Pick a genre, then set the scene."}
      </Text>

      {loadState === "loading" && (
        <Text style={styles.status}>Loading genres...</Text>
      )}

      {loadState === "error" && (
        <Pressable onPress={loadTemplates} style={styles.retry}>
          <Text style={styles.retryText}>
            Couldn't reach the storyteller — tap to retry.
          </Text>
        </Pressable>
      )}

      {loadState === "ready" &&
        templates.map((template) => {
          const isSelected = selected?.id === template.id;
          return (
            <Pressable
              key={template.id}
              onPress={() => setSelected(template)}
              style={[styles.card, isSelected && styles.cardSelected]}
            >
              <Text style={styles.cardTitle}>{template.name}</Text>
              <Text style={styles.cardDescription}>{template.description}</Text>
            </Pressable>
          );
        })}

      {selected && (
        <View style={styles.premiseSection}>
          <Text style={styles.sectionLabel}>Your premise</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={[styles.input, styles.inputWithMic]}
              placeholder="Your story premise..."
              placeholderTextColor="#888"
              multiline
              value={premise}
              onChangeText={setPremise}
            />
            <PushToTalk
              testID="premise-mic"
              compact
              onUtterance={setPremise}
              onActivate={() => getVoiceOut().unlock()}
            />
          </View>
          <View style={styles.chipRow}>
            {selected.premise_seeds.map((seed) => (
              <Pressable
                key={seed}
                onPress={() => setPremise(seed)}
                style={styles.chip}
              >
                <Text style={styles.chipText}>{seed}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={[styles.sectionLabel, styles.lengthLabel]}>
            Story length
          </Text>
          <View style={styles.chipRow}>
            {LENGTH_OPTIONS.map((option) => {
              const isSelected = length === option;
              return (
                <Pressable
                  key={option}
                  onPress={() => setLength(option)}
                  style={[
                    styles.lengthChip,
                    isSelected && styles.lengthChipSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.lengthChipText,
                      isSelected && styles.lengthChipTextSelected,
                    ]}
                  >
                    {LENGTH_LABELS[option]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Pressable
            onPress={beginStory}
            disabled={!canBegin}
            style={[styles.beginButton, !canBegin && styles.beginButtonDisabled]}
          >
            <Text style={styles.beginButtonText}>Begin the story</Text>
          </Pressable>
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
  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#f2f2f2",
    marginBottom: 20,
  },
  librarySection: {
    marginBottom: 24,
  },
  storyCard: {
    padding: 16,
    borderRadius: 10,
    backgroundColor: "#1a2333",
    borderWidth: 1,
    borderColor: "#2e3a50",
    marginBottom: 12,
  },
  storyCardTitle: {
    fontSize: 17,
    fontWeight: "bold",
    color: "#f2f2f2",
  },
  storyCardMeta: {
    fontSize: 13,
    color: "#a0a8c0",
    marginTop: 4,
  },
  status: {
    color: "#a0a0a0",
    fontSize: 15,
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
  card: {
    padding: 16,
    borderRadius: 10,
    backgroundColor: "#1e1e1e",
    borderWidth: 1,
    borderColor: "#2e2e2e",
    marginBottom: 12,
  },
  cardSelected: {
    borderColor: "#7aa2f7",
    backgroundColor: "#1a2333",
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: "bold",
    color: "#f2f2f2",
  },
  cardDescription: {
    fontSize: 14,
    color: "#a0a0a0",
    marginTop: 4,
  },
  premiseSection: {
    marginTop: 12,
  },
  sectionLabel: {
    fontSize: 15,
    fontWeight: "bold",
    color: "#f2f2f2",
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  input: {
    minHeight: 90,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2e2e2e",
    backgroundColor: "#1e1e1e",
    color: "#f2f2f2",
    padding: 12,
    fontSize: 15,
    textAlignVertical: "top",
  },
  inputWithMic: {
    flex: 1,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 10,
    gap: 8,
  },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: "#232733",
    borderWidth: 1,
    borderColor: "#3a3f4f",
  },
  chipText: {
    color: "#c8ccd8",
    fontSize: 13,
  },
  lengthLabel: {
    marginTop: 16,
  },
  lengthChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: "#232733",
    borderWidth: 1,
    borderColor: "#3a3f4f",
  },
  lengthChipSelected: {
    borderColor: "#7aa2f7",
    backgroundColor: "#1a2333",
  },
  lengthChipText: {
    color: "#c8ccd8",
    fontSize: 13,
  },
  lengthChipTextSelected: {
    color: "#f2f2f2",
    fontWeight: "bold",
  },
  beginButton: {
    marginTop: 20,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: "#7aa2f7",
    alignItems: "center",
  },
  beginButtonDisabled: {
    backgroundColor: "#3a3f4f",
  },
  beginButtonText: {
    color: "#121212",
    fontSize: 16,
    fontWeight: "bold",
  },
});
