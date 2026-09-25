import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, sameWord, checkMatch, groupWords, levenshtein } from "../src/game-core.js";

test("normalize strips case, accents, punctuation, articles", () => {
  assert.equal(normalize("  Café! "), "cafe");
  assert.equal(normalize("The Moon"), "moon");
  assert.equal(normalize("a  apple"), "apple");
  assert.equal(normalize("an"), "an"); // a lone article is still a word
  assert.equal(normalize("rock-n'roll"), "rock-n'roll");
  assert.equal(normalize(42), "");
});

test("levenshtein", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("", "abc"), 3);
  assert.equal(levenshtein("same", "same"), 0);
});

test("short words must match exactly — no false matches", () => {
  for (const [a, b] of [["cat", "bat"], ["house", "horse"], ["sun", "son"], ["plane", "planet"], ["glass", "glas"]]) {
    assert.equal(sameWord(a, b), false, `${a} vs ${b}`);
  }
});

test("longer words forgive a typo", () => {
  assert.equal(sameWord("banana", "bananna"), true);
  assert.equal(sameWord("elephant", "elephnat"), false); // transposition = 2 edits
  assert.equal(sameWord("elephant", "elefant"), false); // 2 edits
  assert.equal(sameWord("elephant", "elephan"), true);
  assert.equal(sameWord("constellation", "constelation"), true);
});

test("singular and plural forms match", () => {
  for (const [a, b] of [["cloud", "Clouds"], ["box", "boxes"], ["berry", "berries"], ["tree", "trees"], ["church", "churches"]]) {
    assert.equal(sameWord(a, b), true, `${a} vs ${b}`);
  }
  assert.equal(sameWord("glass", "glasses"), true);
  assert.equal(sameWord("gas", "ga"), false); // too short to strip
});

test("sameWord treats case/accents/articles as equal and rejects empties", () => {
  assert.equal(sameWord("MOON", "the moon"), true);
  assert.equal(sameWord("Crème", "creme"), true);
  assert.equal(sameWord("!!!", "!!!"), false);
});

test("checkMatch needs 2+ active players, all submitted", () => {
  assert.deepEqual(checkMatch({ a: "x" }, ["a"]), { complete: false, matched: false });
  assert.deepEqual(checkMatch({ a: "moon" }, ["a", "b"]), { complete: false, matched: false });
  assert.deepEqual(checkMatch({ a: "moon", b: "Moon" }, ["a", "b"]), { complete: true, matched: true });
  assert.deepEqual(checkMatch({ a: "moon", b: "sun" }, ["a", "b"]), { complete: true, matched: false });
  // A submission from someone no longer active is ignored.
  assert.deepEqual(checkMatch({ a: "moon", b: "moon", c: "sun" }, ["a", "b"]), { complete: true, matched: true });
});

test("groupWords clusters by sameWord, largest first", () => {
  assert.deepEqual(groupWords({ a: "sun", b: "moon", c: "The Moon" }), [["b", "c"], ["a"]]);
  assert.deepEqual(groupWords({ a: "x", b: "y" }), [["a"], ["b"]]);
});
