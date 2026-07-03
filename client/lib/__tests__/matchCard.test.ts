import { matchCard } from "../matchCard";

const CARDS = [
  "Mira forces the iron door and finds a room where maps draw themselves.",
  "A voice behind the door asks her, by name, to slide the map underneath.",
  "The dripping stops and footsteps begin, approaching from the corridor.",
];

describe("matchCard - ordinals (guarded)", () => {
  it.each([
    ["the first one", 0],
    ["first", 0],
    ["the second one", 1],
    ["pick number two", 1],
    ["option 3", 2],
    ["take the third", 2],
    ["the last one", 2],
  ])("%s -> card %i", (utterance, expected) => {
    expect(matchCard(utterance, CARDS)).toBe(expected);
  });

  it("bare ordinal words inside long sentences do NOT match (guard)", () => {
    expect(matchCard("at first she hesitated, then she slowly ran away", CARDS)).toBeNull();
    expect(matchCard("the two of them walk toward the bright harbor gates", CARDS)).toBeNull();
  });

  it("pick-verbs unlock ordinals even in longer utterances", () => {
    expect(matchCard("let's go with option two on this one", CARDS)).toBe(1);
  });

  it("out-of-bounds ordinal is null", () => {
    expect(matchCard("the fourth one", CARDS)).toBeNull();
  });

  it("'last' with no cards is null, not -1", () => {
    expect(matchCard("the last one", [])).toBeNull();
  });
});

describe("matchCard - word overlap", () => {
  it("two+ distinctive shared words pick the clear winner", () => {
    expect(matchCard("she forces the iron door open", CARDS)).toBe(0);
    expect(matchCard("follow the footsteps in the corridor", CARDS)).toBe(2);
  });

  it("ambiguity returns null instead of guessing", () => {
    // "door" appears in cards 0 and 1; one shared word each - no clear winner
    expect(matchCard("the door", CARDS)).toBeNull();
  });

  it("gibberish and unrelated free-form steering return null", () => {
    expect(matchCard("she sets fire to the archive and flees north", CARDS)).toBeNull();
    expect(matchCard("blorp fizzle", CARDS)).toBeNull();
  });

  it("empty utterance is null", () => {
    expect(matchCard("", CARDS)).toBeNull();
    expect(matchCard("   ", CARDS)).toBeNull();
  });
});
