import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams, type Href } from "expo-router";
import { useStories } from "../../../lib/store";

/**
 * The story hub — one page per story, named after it. The title is editable
 * in place; the section cards fan out to the story itself and its bible
 * pages (characters / environment / history & places).
 */
export default function StoryHub() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getStory, updateStory, deleteStory } = useStories();
  const story = getStory(id);

  if (!story) {
    return (
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backButtonText}>← Home</Text>
          </Pressable>
        </View>
        <Text style={styles.missing}>This story isn't here anymore.</Text>
      </View>
    );
  }

  const sections: Array<{
    key: string;
    icon: string;
    label: string;
    detail: string;
    route: Href;
  }> = [
    {
      key: "write",
      icon: "✍",
      label: "Story",
      detail:
        story.scenes.length === 0
          ? "Begin the first scene"
          : `${story.scenes.length} ${story.scenes.length === 1 ? "scene" : "scenes"} — continue`,
      route: `/story/${story.id}/write`,
    },
    {
      key: "characters",
      icon: "👤",
      label: "Characters",
      detail: "Who they are — and talk about them",
      route: `/story/${story.id}/characters`,
    },
    {
      key: "environment",
      icon: "🌍",
      label: "Environment",
      detail: "The world, its atmosphere and setting",
      route: `/story/${story.id}/environment`,
    },
    {
      key: "history",
      icon: "📜",
      label: "History & Places",
      detail: "Locations, lore and what came before",
      route: `/story/${story.id}/history`,
    },
  ];

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backButtonText}>← Home</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <TextInput
          testID="story-title"
          style={styles.titleInput}
          value={story.title}
          onChangeText={(title) =>
            updateStory(story.id, () => ({ title: title }))
          }
          placeholder="Name your story"
          placeholderTextColor="#888"
        />
        {story.summary.trim().length > 0 && story.scenes.length > 0 && (
          <Text style={styles.summary}>{story.summary}</Text>
        )}

        {sections.map((section) => (
          <Pressable
            key={section.key}
            testID={`hub-${section.key}`}
            onPress={() => router.push(section.route)}
            style={styles.sectionCard}
          >
            <Text style={styles.sectionIcon}>{section.icon}</Text>
            <View style={styles.sectionBody}>
              <Text style={styles.sectionTitle}>{section.label}</Text>
              <Text style={styles.sectionDetail}>{section.detail}</Text>
            </View>
          </Pressable>
        ))}

        <Pressable
          testID="delete-story"
          onPress={() => {
            deleteStory(story.id);
            router.back();
          }}
          style={styles.deleteButton}
        >
          <Text style={styles.deleteButtonText}>Delete this story</Text>
        </Pressable>
      </ScrollView>
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
  },
  content: {
    padding: 20,
    paddingBottom: 60,
  },
  missing: {
    color: "#a0a0a0",
    fontSize: 15,
    padding: 20,
  },
  titleInput: {
    fontSize: 26,
    fontWeight: "bold",
    color: "#f2f2f2",
    paddingVertical: 4,
    marginBottom: 8,
  },
  summary: {
    fontSize: 14,
    lineHeight: 21,
    color: "#a0a0a0",
    marginBottom: 20,
  },
  sectionCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 18,
    borderRadius: 12,
    backgroundColor: "#1e1e1e",
    borderWidth: 1,
    borderColor: "#2e2e2e",
    marginBottom: 12,
  },
  sectionIcon: {
    fontSize: 24,
    marginRight: 14,
  },
  sectionBody: {
    flex: 1,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: "bold",
    color: "#f2f2f2",
  },
  sectionDetail: {
    fontSize: 13,
    color: "#a0a0a0",
    marginTop: 3,
  },
  deleteButton: {
    marginTop: 16,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#5a2a2a",
    alignItems: "center",
  },
  deleteButtonText: {
    color: "#e08080",
    fontSize: 14,
  },
});
