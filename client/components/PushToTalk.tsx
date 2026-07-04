import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { getVoiceIn, VoiceIn } from "../lib/voice";

type PushToTalkProps = {
  disabled?: boolean;
  onUtterance: (text: string) => void;
  /** Override the default testID — lets Home reuse this component under its
   * own "premise-mic" testID instead of Story's "ptt-button". */
  testID?: string;
  /** Compact rendering (icon-only button) for embedding beside the premise
   * input on Home, vs. the full "Hold to talk" bar on the Story screen. */
  compact?: boolean;
};

/**
 * PushToTalk — hold-to-talk affordance behind the VoiceIn abstraction
 * (architecture rule #3: never call a speech service directly).
 *
 * Renders nothing when voice input isn't available on this platform/browser.
 * Interim transcript renders as plain Text (NEVER StreamingText — its
 * append-only contract breaks on interim speech that rewrites itself).
 */
export function PushToTalk({
  disabled = false,
  onUtterance,
  testID = "ptt-button",
  compact = false,
}: PushToTalkProps) {
  const voiceRef = useRef<VoiceIn | null>(null);
  if (voiceRef.current === null) {
    voiceRef.current = getVoiceIn();
  }
  const voice = voiceRef.current;

  const [phase, setPhase] = useState<"idle" | "listening" | "transcribing">(
    "idle"
  );
  const [error, setError] = useState<string | null>(null);
  const phaseTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unmount cleanup: abort any in-flight recognition session so it doesn't
  // outlive the component (mic hot on a dead screen) and so a late onFinal
  // can't fire onUtterance into an unmounted screen. abort() is a safe no-op
  // when idle.
  useEffect(() => {
    return () => {
      voice.abort();
      if (phaseTimeout.current) clearTimeout(phaseTimeout.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!voice.available) return null;

  const handlePressIn = () => {
    setError(null);
    setPhase("listening");
    voice.start({
      onInterim: () => {},
      onFinal: (transcript) => {
        if (phaseTimeout.current) clearTimeout(phaseTimeout.current);
        setPhase("idle");
        if (transcript.trim().length > 0) onUtterance(transcript);
      },
      onError: (message) => {
        if (phaseTimeout.current) clearTimeout(phaseTimeout.current);
        setPhase("idle");
        setError(message);
      },
    });
  };

  const handlePressOut = () => {
    setPhase("transcribing");
    voice.stop();
    // Guard against a stuck "transcribing…" if the clip was empty (no
    // callback fires in that case).
    if (phaseTimeout.current) clearTimeout(phaseTimeout.current);
    phaseTimeout.current = setTimeout(() => setPhase("idle"), 8000);
  };

  return (
    <View style={compact ? styles.containerCompact : styles.container}>
      {phase !== "idle" && (
        <Text style={styles.interim}>
          {phase === "listening" ? "listening…" : "…"}
        </Text>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable
        testID={testID}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={disabled}
        accessibilityState={{ disabled }}
        style={[
          compact ? styles.buttonCompact : styles.button,
          disabled && styles.buttonDisabled,
        ]}
      >
        <Text style={compact ? styles.buttonTextCompact : styles.buttonText}>
          {compact ? "🎤" : "🎤 Hold to talk"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    paddingVertical: 10,
  },
  containerCompact: {
    alignItems: "center",
  },
  interim: {
    color: "#a0a0a0",
    fontSize: 14,
    fontStyle: "italic",
    marginBottom: 6,
    textAlign: "center",
  },
  error: {
    color: "#e08080",
    fontSize: 13,
    marginBottom: 6,
    textAlign: "center",
  },
  button: {
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 24,
    backgroundColor: "#7aa2f7",
  },
  buttonCompact: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#7aa2f7",
  },
  buttonDisabled: {
    backgroundColor: "#3a3f4f",
  },
  buttonText: {
    color: "#121212",
    fontSize: 16,
    fontWeight: "bold",
    textAlign: "center",
  },
  buttonTextCompact: {
    fontSize: 18,
  },
});
