import { Stack } from "expo-router";
import { StoriesProvider } from "../lib/store";

export default function RootLayout() {
  return (
    <StoriesProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </StoriesProvider>
  );
}
