// game-core.js — pure, dependency-free. Mirrors the Answer It / Find It pattern of
// keeping game logic out of the transport code so it's easy to read, test, and (if we
// ever want client-side prediction) reuse in the browser unchanged.

/**
 * Normalize a submitted word for matching:
 * lowercase → strip diacritics (NFD) → strip punctuation/symbols → collapse
 * whitespace → trim. Same shape as Answer It's open-answer normaliser.
 */
export function normalize(word) {
  if (typeof word !== "string") return "";
  return word
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics: "café" -> "cafe"
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, "") // keep letters/numbers/space/hyphen/apostrophe
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(the|an|a) (?=\S)/, ""); // "the moon" and "moon" are the same answer
}

/**
 * How many edits two words may differ by and still count as a typo of each
 * other. Short words get none: "cat"/"bat" or "house"/"horse" are different
 * answers, not typos, and in a convergence game a false match ends the game.
 */
export function typoTolerance(len) {
  if (len <= 5) return 0;
  if (len <= 11) return 1;
  return 2;
}

/**
 * Crude English singular: "clouds" -> "cloud", "boxes" -> "box",
 * "berries" -> "berry". Only used to compare two words, never shown, so
 * being wrong on an odd word ("bus" -> "bu") is harmless as long as both
 * sides get the same treatment.
 */
export function singular(word) {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Levenshtein edit distance. Small-input only (single words, not paragraphs). */
export function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

/**
 * Are two words "the same" for match purposes? Exact match after normalising,
 * or within a small typo tolerance (see typoTolerance) so a stray typo in a
 * longer word doesn't cost a real match.
 */
export function sameWord(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (singular(na) === singular(nb)) return true; // "cloud" / "clouds"
  const tolerance = typoTolerance(Math.min(na.length, nb.length));
  return levenshtein(na, nb) <= tolerance;
}

/**
 * Cluster a round's words into groups of players who wrote the same word
 * ({ playerId: word } -> [[id, id], [id], ...]), largest group first. Lets the
 * client show partial convergence ("2 of you said moon") on a missed round.
 */
export function groupWords(words) {
  const groups = [];
  for (const [id, word] of Object.entries(words)) {
    const group = groups.find((g) => sameWord(words[g[0]], word));
    if (group) group.push(id);
    else groups.push([id]);
  }
  return groups.sort((x, y) => y.length - x.length);
}

/**
 * Given this round's submissions ({ playerId: word }) and the set of active
 * (non-spectator) player ids, decide whether the round is complete and, if so,
 * whether every player's word matches every other player's word.
 */
export function checkMatch(submissions, activePlayerIds) {
  if (activePlayerIds.length < 2) {
    return { complete: false, matched: false };
  }
  const complete = activePlayerIds.every((id) => submissions[id] !== undefined);
  if (!complete) {
    return { complete: false, matched: false };
  }
  const words = activePlayerIds.map((id) => submissions[id]);
  const reference = words[0];
  const matched = words.every((w) => sameWord(w, reference));
  return { complete: true, matched };
}

/** 6-digit room code, same shape as Answer It / Find It. */
export function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** Permanent-feeling per-device player id — no password, no account. */
export function newPlayerId() {
  const raw = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `p_${raw}`;
}
