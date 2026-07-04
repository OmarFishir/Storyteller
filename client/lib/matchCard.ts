/**
 * matchCard — the FREE fast-path of utterance routing: does this utterance
 * unambiguously pick a card by ordinal? ("the second one", "option 3",
 * "the last one"). Anything else returns null and routes to /converse,
 * where a model decides pick / steer / discuss / options with context.
 *
 * The old word-overlap tier was retired when the discussion channel arrived:
 * overlap can't tell "do the iron door one" (a pick) from "tell me more
 * about the iron door one" (a question), and auto-picking a question is the
 * exact rigidity the conversational redesign removes.
 *
 * Ordinals only fire when the utterance looks like a pick — short (<= 4
 * words) OR containing a pick-verb/noun — because bare words like "first"
 * and "two" appear constantly in narrative sentences. Checked
 * most-specific-first: "the second one" must hit "second", not "one".
 */

const ORDINALS: Array<[RegExp, number]> = [
  [/\b(fourth|four|4)\b/, 3],
  [/\b(third|three|3)\b/, 2],
  [/\b(second|two|2)\b/, 1],
  [/\b(first|one|1)\b/, 0],
];

const PICK_WORDS = /\b(pick|take|choose|select|option|number|card|go with)\b/;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function matchCard(utterance: string, cards: string[]): number | null {
  const text = normalize(utterance);
  if (!text) return null;

  const wordCount = text.split(" ").length;
  const looksLikeAPick = wordCount <= 4 || PICK_WORDS.test(text);
  if (!looksLikeAPick) return null;

  if (/\blast\b/.test(text)) return cards.length > 0 ? cards.length - 1 : null;
  for (const [re, idx] of ORDINALS) {
    if (re.test(text)) {
      return idx < cards.length ? idx : null;
    }
  }
  return null;
}
