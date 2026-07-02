import { Text, View, StyleSheet } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";

/**
 * The signature animation: words materialize as they arrive.
 *
 * Contract: pass the FULL accumulated text each render; newly appended words
 * animate in (fade + rise), earlier words keep their identity (stable keys)
 * so they don't re-animate. The component knows nothing about networking —
 * feed it from live SSE, the mock stream, or a test fixture.
 */
export function StreamingText({ text }: { text: string }) {
  const paragraphs = text.split("\n\n");
  let wordKey = 0;
  return (
    <View>
      {paragraphs.map((para, pIdx) => (
        <Text key={pIdx} testID="paragraph" style={styles.paragraph}>
          {para
            .split(" ")
            .filter((w) => w.length > 0)
            .map((word) => {
              const key = wordKey++;
              return (
                <Animated.Text
                  key={key}
                  entering={FadeInDown.duration(260)}
                  style={styles.word}
                >
                  {word + " "}
                </Animated.Text>
              );
            })}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  paragraph: { fontSize: 17, lineHeight: 26, marginBottom: 14 },
  word: { fontSize: 17, lineHeight: 26 },
});
