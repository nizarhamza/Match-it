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
    .trim();
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
 * or within a small typo tolerance (ceil(len/6) edits — the same rule Answer It
 * uses for open-answer checking) so a stray typo doesn't cost a real match.
 */
export function sameWord(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const tolerance = Math.ceil(Math.max(na.length, nb.length) / 6);
  return levenshtein(na, nb) <= tolerance;
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
