// Protocol tests against a running `npm run dev` (default http://localhost:8787,
// override with MATCHIT_BASE). Every test gets a fresh room.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Client, createRoom, sleep } from "./harness.mjs";

const clients = [];
async function room(...names) {
  const code = await createRoom();
  const cs = names.map((n) => new Client(n));
  for (const c of cs) { clients.push(c); await c.connect(code); }
  return { code, cs };
}
async function started(...names) {
  const r = await room(...names);
  const host = r.cs[0];
  host.send({ type: "start" });
  await Promise.all(r.cs.map((c) => c.waitFor(() => c.state.status === "playing", "playing")));
  return r;
}
after(() => clients.forEach((c) => { try { c.close(); } catch {} }));

test("full game: miss, then match", async () => {
  const { cs: [a, b] } = await started("A", "B");
  a.send({ type: "submit", word: "sun" });
  await b.waitFor(() => b.state.submittedIds.includes(a.pid), "a in");
  assert.equal(b.state.history.length, 0, "no words leak before reveal");
  b.send({ type: "submit", word: "moon" });
  await a.waitFor(() => a.state.round === 2, "round 2");
  assert.equal(a.reveals[0].matched, false);
  assert.deepEqual(a.state.history[0].names, { [a.pid]: "A", [b.pid]: "B" });
  a.send({ type: "submit", word: "Star" });
  b.send({ type: "submit", word: "the star" });
  await a.waitFor(() => a.state.status === "matched", "matched");
  assert.equal(a.state.history.length, 2);
});

test("a player can't change their word mid-round", async () => {
  const { cs: [a, b] } = await started("A", "B");
  a.send({ type: "submit", word: "sun" });
  a.send({ type: "submit", word: "moon" });
  await sleep(200);
  b.send({ type: "submit", word: "moon" });
  await a.waitFor(() => a.reveals.length === 1, "reveal");
  assert.equal(a.reveals[0].words[a.pid], "sun");
  assert.equal(a.reveals[0].matched, false);
});

test("leaving mid-round resolves a round that was waiting on you", async () => {
  const { cs: [a, b, c] } = await started("A", "B", "C");
  a.send({ type: "submit", word: "moon" });
  b.send({ type: "submit", word: "moon" });
  await a.waitFor(() => a.state.submittedCount === 2, "2 in");
  c.send({ type: "leave" });
  await a.waitFor(() => a.state.status === "matched", "matched after leave");
});

test("kick mid-round resolves the round and closes the kicked socket", async () => {
  const { cs: [a, b, c] } = await started("A", "B", "C");
  a.send({ type: "submit", word: "moon" });
  b.send({ type: "submit", word: "sun" });
  await a.waitFor(() => a.state.submittedCount === 2, "2 in");
  a.send({ type: "kick", playerId: c.pid });
  await a.waitFor(() => a.state.round === 2, "next round");
  // Server sent its close frame (CLOSING or CLOSED from our side).
  await c.waitFor(() => c.ws.readyState >= 2, "kicked socket closing");
  assert.equal(c.errors[0].code, "kicked");
});

test("disconnect mid-round resolves the round", async () => {
  const { cs: [a, b, c] } = await started("A", "B", "C");
  a.send({ type: "submit", word: "moon" });
  b.send({ type: "submit", word: "moon" });
  await a.waitFor(() => a.state.submittedCount === 2, "2 in");
  c.close();
  await a.waitFor(() => a.state.status === "matched", "matched after drop");
});

test("joining a nonexistent room is refused with a final close code", async () => {
  const x = new Client("X"); clients.push(x);
  await x.connect("000001").catch(() => {});
  await x.waitFor(() => x.closed, "closed");
  assert.equal(x.closeCode, 4404);
  assert.equal(x.errors[0].code, "room_not_found");
});

test("a reconnect that races the old socket's close keeps the player connected", async () => {
  const { code, cs: [a] } = await room("A");
  const a2 = new Client("A"); clients.push(a2);
  await a2.connect(code, a.pid);
  a.close();
  await sleep(400);
  const me = a2.state.players.find((p) => p.id === a.pid);
  assert.equal(me.connected, true);
  assert.equal(a2.state.players.length, 1);
});

test("host passes to a newcomer when the old host is gone", async () => {
  const { code, cs: [a] } = await room("A");
  a.close();
  await sleep(300);
  const b = new Client("B"); clients.push(b);
  await b.connect(code);
  assert.equal(b.state.hostId, b.pid);
});

test("host keeps host through a refresh; others act while they're away", async () => {
  const { code, cs: [a, b] } = await room("A", "B");
  a.close(); // a refresh: old socket gone before the new one opens
  await b.waitFor(() => b.state.hostId === b.pid, "b acting host");
  const a2 = new Client("A"); clients.push(a2);
  await a2.connect(code, a.pid);
  await b.waitFor(() => b.state.hostId === a.pid, "a host again");
  b.send({ type: "start" }); // no longer host -> ignored
  await sleep(200);
  assert.equal(a2.state.status, "lobby");
});

test("late joiner watches; rematch brings them in; start drops the absent", async () => {
  const { code, cs: [a, b] } = await started("A", "B");
  const c = new Client("C"); clients.push(c);
  await c.connect(code);
  assert.equal(c.state.players.find((p) => p.id === c.pid).role, "spectator");
  c.send({ type: "submit", word: "moon" });
  await sleep(200);
  assert.equal(a.state.submittedCount, 0, "spectators can't submit");
  a.send({ type: "rematch" });
  await a.waitFor(() => a.state.status === "lobby", "lobby");
  assert.ok(a.state.players.every((p) => p.role === "player"));
  b.close();
  await a.waitFor(() => !a.state.players.find((p) => p.id === b.pid).connected, "b away");
  a.send({ type: "start" });
  await a.waitFor(() => a.state.status === "playing", "playing");
  assert.equal(a.state.players.length, 2, "disconnected B dropped at start");
});

test("start needs two connected players", async () => {
  const { cs: [a] } = await room("A");
  a.send({ type: "start" });
  await a.waitFor(() => a.errors.length === 1, "error");
  assert.equal(a.errors[0].code, "not_enough_players");
});

// Needs a server started with a short timeout, e.g.
//   npx wrangler dev --port 8788 --var STALE_SOCKET_MS:3000
// and MATCHIT_STALE_MS=3000 MATCHIT_BASE=http://localhost:8788 in the env.
const staleMs = Number(process.env.MATCHIT_STALE_MS);
test("a player who goes silent is swept out and stops blocking the round", { skip: !staleMs && "set MATCHIT_STALE_MS" }, async () => {
  const { cs: [a, b, c] } = await started("A", "B", "C");
  a.send({ type: "submit", word: "moon" });
  b.send({ type: "submit", word: "moon" });
  // C never says another word — like a phone that lost signal.
  await sleep(staleMs / 2);
  a.send({ type: "ping", t: 1 });
  b.send({ type: "ping", t: 1 });
  await sleep(staleMs / 2 + 500);
  assert.equal(a.state.status, "playing", "not swept before the limit");
  a.send({ type: "ping", t: 2 });
  await a.waitFor(() => a.state.status === "matched", "matched after sweep");
  assert.equal(a.state.players.find((p) => p.id === c.pid).connected, false);
  assert.ok(a.state.players.find((p) => p.id === b.pid).connected, "pinging player kept");
});
