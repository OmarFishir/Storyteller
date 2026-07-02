import { fetch as expoFetch } from "expo/fetch";

// Single seam for all streaming HTTP. expo/fetch streams response bodies on
// native (regular web fetch also streams); tests mock THIS function.
export const streamingFetch: typeof globalThis.fetch = expoFetch as never;
