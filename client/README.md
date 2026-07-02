# Storyteller client

The Expo app for **Storyteller**, an AI-assisted, voice-first story maker. This
is the vertical-slice UI: it streams AI-generated scenes turn by turn and lets
the user pick what happens next.

For the project story, architecture, and current status, see the root
[`CLAUDE.md`](../CLAUDE.md) and `docs/superpowers/` in the repo root.

## Run it

1. `cp .env.example .env` and fill in `EXPO_PUBLIC_API_URL` (the backend must
   already be running — see the root `CLAUDE.md` for how to start it).
2. `npx expo start --web`

## Test it

```bash
npx jest --watchAll=false
```
