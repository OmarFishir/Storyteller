# Native dev build — state of play (Slice C, Task 6)

**Status: BLOCKED ON USER INPUT — phone OS decision.** This is the outcome the
plan explicitly sanctions ("documented + blocked on user input"); nothing here
is a defect. Slice C is browser-complete and shipped (Tasks 1–5, pushed).

## The question only the owner can answer

**What phone do you have?**

- **Android** → we can build a dev APK two ways: EAS cloud build (needs a free
  Expo account, builds on Expo's servers, installs via QR/download link) or a
  local build (needs Android Studio + SDK installed — heavier setup, no
  account). EAS cloud is the recommended first path.
- **iPhone** → building from Windows requires an **Apple Developer account
  ($99/year)** for a dev build on a physical device. That's a budget decision
  against the ~$20/month dev budget, so it is YOURS to make, not something a
  session should assume.

## Why a dev build at all

The browser gets speech recognition for free (Chrome's built-in
SpeechRecognition — that's what slice C ships on). Phones do not: Expo Go
cannot load native speech-recognition modules, so push-to-talk on a real phone
needs `expo-speech-recognition` compiled into a **development build** of the
app. Everything is already shaped for this: `client/lib/voice.ts` hides speech
input behind the `VoiceIn` interface (architecture rule #3), so the native
implementation slots in behind the exact same interface with zero changes to
`PushToTalk`, Story, or Home.

## Exact remaining steps (from the approved plan, Task 6)

Run these once the OS decision is made:

1. **Install** (in `client/`): `npx expo install expo-speech-recognition`
2. **Config plugin**: add `expo-speech-recognition` to `client/app.json`'s
   `plugins` array with mic/speech permission strings. **Do not trust any
   remembered syntax — read the package README at execution time** (context7
   or the GitHub page) and copy the current plugin block; native tooling
   drifts. (Plan mandates this verification explicitly.)
3. **Native branch in `getVoiceIn()`** (`client/lib/voice.ts`): a
   `Platform.OS !== "web"` branch using `ExpoSpeechRecognitionModule`, mapping
   its events to the same `VoiceCallbacks` (`onInterim`/`onFinal`/`onError`);
   web path and all existing tests stay unchanged.
4. **Dev build**:
   - `eas.json` dev profile with `developmentClient: true`
   - Android: `npx eas build --profile development --platform android`
   - Requires an Expo account login (`npx eas login`) — interactive, so the
     owner runs this part.
5. **Record the outcome in this file** (built / installed / what worked, or
   what blocked), commit + push.

## What already works without any of this

- Web (Chrome): full push-to-talk — hold the bar, speak, card matching,
  free-form steering. Demo instructions are in CLAUDE.md / the slice C plan
  (backend with `DEV_MOCK_ENABLED=1`, `npx expo start --web`).
- Phone via Expo Go: everything EXCEPT voice input — `getVoiceIn()` returns
  the `available: false` stub on native today, so the PTT bar simply doesn't
  render (graceful, by design).
