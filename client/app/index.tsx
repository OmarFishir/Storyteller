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
import { getTemplates, Template } from "../lib/api";

type LoadState = "loading" | "error" | "ready";

export default function Home() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [selected, setSelected] = useState<Template | null>(null);
  const [premise, setPremise] = useState("");

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
    router.push({
      pathname: "/story",
      params: { templateId: selected.id, premise },
    });
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Storyteller</Text>
      <Text style={styles.subtitle}>Pick a genre, then set the scene.</Text>

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
          <TextInput
            style={styles.input}
            placeholder="Your story premise..."
            placeholderTextColor="#888"
            multiline
            value={premise}
            onChangeText={setPremise}
          />
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
  },
  subtitle: {
    fontSize: 15,
    color: "#a0a0a0",
    marginTop: 4,
    marginBottom: 20,
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
