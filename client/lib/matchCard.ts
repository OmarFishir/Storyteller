/**
 * matchCard — decide whether a spoken utterance picks one of the option
 * cards, with NO network and NO LLM (approved cheap path; upgradeable in
 * isolation later).
 *
 * Rules, in order:
 *  1. GUARDED ordinals: "second", "option 2", "number two", "the last one"...
 *     Ordinals only fire when the utterance looks like a pick — short
 *     (<= 4 words) OR containing a pick-verb/noun (pick/take/choose/go with/
 *     option/number/card). Guard exists because bare words like "first" and
 *     "two" appear constantly in narrative steering sentences.
 *  2. Word overlap: content words (len > 3, minus stopwords) shared with each
 *     card; a card wins only with >= 2 overlaps AND a strictly higher score
 *     than the runner-up. Ties/ambiguity -> null.
 *  3. null -> the caller treats the utterance as free-form steering.
 */

// Checked most-specific-first: "the second one" must hit "second", not "one".
const ORDINALS: Array<[RegExp, number]> = [
  [/\b(fourth|four|4)\b/, 3],
  [/\b(third|three|3)\b/, 2],
  [/\b(second|two|2)\b/, 1],
  [/\b(first|one|1)\b/, 0],
];

const PICK_WORDS = /\b(pick|take|choose|select|option|number|card|go with)\b/;

const STOPWORDS = new Set([
  "the", "that", "this", "with", "into", "from", "they", "their", "them",
  "then", "have", "will", "would", "could", "should", "about", "there",
  "where", "when", "what", "your", "over", "under", "after", "before",
]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function contentWords(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  );
}

export function matchCard(utterance: string, cards: string[]): number | null {
  const text = normalize(utterance);
  if (!text) return null;

  // 1. Guarded ordinals
  const wordCount = text.split(" ").length;
  const looksLikeAPick = wordCount <= 4 || PICK_WORDS.test(text);
  if (looksLikeAPick) {
    if (/\blast\b/.test(text)) return cards.length > 0 ? cards.length - 1 : null;
    for (const [re, idx] of ORDINALS) {
      if (re.test(text)) {
        return idx < cards.length ? idx : null;
      }
    }
  }

  // 2. Word overlap
  const spoken = contentWords(utterance);
  if (spoken.size === 0) return null;
  const scores = cards.map((card) => {
    const cw = contentWords(card);
    let n = 0;
    for (const w of spoken) if (cw.has(w)) n++;
    return n;
  });
  const best = Math.max(...scores);
  if (best < 2) return null;
  if (scores.filter((s) => s === best).length > 1) return null;
  return scores.indexOf(best);
}
