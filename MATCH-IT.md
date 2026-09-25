# Match It — Game Design & Product Spec

> A room-only word game. Same lineage as **Find It** and **Answer It**: no build
> step, no accounts, backed by one small Cloudflare Worker with a Durable
> Object per room. No solo mode — the whole point is other people.

**Status:** working v1. Lobby, the round loop, spectating, rematch, and host
controls (start / end / kick) are built and locally verified. Not yet shipped
to a live URL — see DEPLOY.md.

## 1. Product

**Users:** 2+ people who want a short, low-stakes party game — a call, a
group chat, a couple killing five minutes. Join with a link or a 6-digit
code, no account.

**The loop:** everyone privately writes one word. Once every active player is
in, all the words are shown. If they don't all match, everyone writes again —
seeing every word anyone's written this game so far — until the room
converges.

**Design principles:**
- **No pressure.** No timer, no score, no round cap. The only clock is the
  room's own patience, and the host can end it anytime.
- **The thread is the game.** Once a round completes, its words stay visible
  for the rest of the game, newest round first — the room reads the pattern
  in what's already been said rather than guessing blind each round.
- **Watching is a real option.** Anyone can toggle "Watching" instead of
  "Playing" in the lobby, before the round starts — not just an overflow
  state for late joiners.
- **The host is a referee.** Their only powers: start, end early, kick.
  Nobody scores anything, so there's nothing else to administer.

## 2. Core objects

### Room (Durable Object storage, one per 6-digit code)
```
{
  code: "042817",
  status: "lobby" | "playing" | "matched",
  hostId: "p_8f3c1a2b9d4e",
  round: 0,
  players: { [id]: Player },
  submissions: { [playerId]: "raw word" },  // this round only, cleared on advance
  history: [ { round, words: {playerId: word}, names: {playerId: nickname},
               groups: [[playerId, ...], ...], matched } ]
}
```

### Player
```
{ id, nickname, role: "player" | "spectator", connected: true }
```
No score, no streak, no stats — a player is a name, a role, and a connection
state.

## 3. Matching

A round resolves once every **active** player (`role: "player"`, `connected:
true`) has a submission in. At that point, for every pair of submitted words:

```
normalize(word):
  strip diacritics (NFD)
  -> lowercase
  -> strip punctuation/symbols (keep letters, numbers, space, hyphen, apostrophe)
  -> collapse whitespace, trim
  -> drop a leading article ("the moon" -> "moon")

sameWord(a, b):
  normalize(a) === normalize(b)
  OR singular(a) === singular(b)          -- "cloud" / "clouds", "berry" / "berries"
  OR levenshtein(a, b) <= tolerance(minLen)
       tolerance: <=5 chars -> 0, 6-11 -> 1, 12+ -> 2
```

Short words get no typo tolerance on purpose: "cat"/"bat" or "house"/"horse"
are different answers, and in a convergence game a false match ends the game.

Each history entry also carries `groups` -- the round's words clustered by
`sameWord`, largest first -- so the client can show partial convergence on a
miss ("2 of 3 said steam") instead of a flat list.

All-pairs `sameWord` -> **matched**, room status becomes `matched`, game over
(host can rematch). Otherwise -> a fresh round begins with the same player
set; submissions clear, everyone's word from the round that just resolved
stays in `history` forever.

A disconnect, `leave`, or `kick` is treated the same as a submission for
completion purposes: if a round was only waiting on that player, it resolves
as soon as they're gone rather than hanging forever. (They just won't have a
word in that round's `history` entry.)

**What counts as disconnected.** A player is connected iff they have a live
socket. Three paths keep that true:
- a normal close (`webSocketClose`) -- ignored if the same player already has
  a newer socket open, so a refresh that races its own close stays connected;
- a **heartbeat**: clients `ping` every 20s, and each ping sweeps out sockets
  silent for 90s (`STALE_SOCKET_MS`). This is how the room notices a phone
  that lost signal or locked its screen without ever sending a close;
- **reconciliation** on every connect and sweep: players marked connected
  with no socket at all (a deploy or runtime restart drops every socket
  without close events) are flipped to disconnected.

## 4. Room lifecycle

```
create        start              round loop             host ends / matches
------> lobby ------> playing ---------------------> lobby / matched
          ^                                                |
          +----------------- rematch ------------------------+
```

| Status    | Meaning                                                                  |
| --------- | --------------------------------------------------------------------------- |
| `lobby`   | Players joining, choosing Playing/Watching. Host needs >=2 players to start. |
| `playing` | Round loop: submit -> (wait) -> resolve -> next round, or `matched`.        |
| `matched` | The room converged. History is the full game. Host can rematch.             |

There's no separate "host force-ended" status -- `end` drops straight back to
`lobby`, keeping that round's history until the next `start` clears it. Only
`matched` gets its own screen, since it's the one outcome worth pausing on.

## 5. Wire protocol

WebSocket, JSON, one socket per player -- the Hibernation API
(`state.acceptWebSocket` / `serializeAttachment` / `getWebSockets()`), so an
idle room costs nothing between messages, same as Answer It / Find It.

**Client -> server**

| Type      | Payload                              | Who                        |
| --------- | --------------------------------------- | ----------------------------- |
| `role`    | `{ role: "player" \| "spectator" }`     | any player, lobby only        |
| `start`   | --                                      | host, lobby, >=2 players      |
| `submit`  | `{ word }`                              | active player, mid-round      |
| `end`     | --                                      | host, `playing`/`matched`     |
| `rematch` | --                                      | host                           |
| `kick`    | `{ playerId }`                          | host                           |
| `leave`   | --                                      | any                             |
| `ping`    | `{ t }`                                 | any                             |

**Server -> client**

| Type      | Payload                                                                        |
| --------- | ----------------------------------------------------------------------------------- |
| `welcome` | `{ playerId, code }` -- sent once on connect; client persists the id for reconnect |
| `state`   | Full room snapshot: status, round, hostId (effective), players, submittedIds, submittedCount/activeCount, history |
| `reveal`  | `{ round, words, names, groups, matched, nicknames }` -- sent once, the moment a round resolves |
| `error`   | `{ code, message }`                                                                  |
| `pong`    | `{ t, serverNow }`                                                                   |

`state` always carries the full `history`; an in-progress round's words are
never in it -- only `submittedIds` (who, not what) -- so nobody sees a
partial round before they've locked in their own word. A player's first
`submit` in a round is final; later ones are ignored.

**Refusals and close codes.** Joining a room that doesn't exist or is full
(16 players) still upgrades, then sends an `error` and closes with a code the
client treats as final, so it stops auto-reconnecting:

| Close | `error.code`     | Meaning                           |
| ----- | ---------------- | --------------------------------- |
| 4404  | `room_not_found` | No such room (or it expired)      |
| 4409  | `room_full`      | 16 players already                |
| 4403  | `kicked`         | Removed by the host               |
| 4000  | --               | Swept as stale; client reconnects |

The client acts on the `error` message rather than waiting for the close,
since a close handshake can sit in CLOSING.

## 6. Architecture

```
match-it/
├── public/                 # served as static assets — no build step
│   ├── index.html            # whole client: markup, CSS, JS
│   ├── manifest.webmanifest  # PWA
│   ├── sw.js                 # offline shell
│   └── icons/icon.svg
├── src/
│   ├── index.js               # HTTP entry: create room, upgrade to socket
│   ├── room.js                 # Durable Object: one room
│   └── game-core.js            # pure: normalize, levenshtein, sameWord, checkMatch
├── wrangler.toml
├── DEPLOY.md
└── README.md
```

**One Worker, not two.** Unlike Answer It's original Pages-site-plus-Worker
split, this ships as a single Worker with a Static Assets binding
(`[assets] directory = "./public"`) -- Cloudflare's current recommended
pattern for exactly this shape of app. The client talks to `/api/...` on its
own origin by default; no CORS setup needed unless you deliberately split the
static site onto a different domain later (the client supports that via a
one-time `?api=` override -- see DEPLOY.md).

`game-core.js` is pure and dependency-free, same property as Answer It's
`game-core.js`, even though v1 has no solo mode to mirror it into.

**Hosting:** SQLite-backed Durable Object class (`new_sqlite_classes`), runs
on Cloudflare's free plan.

## 7. Edge cases

| Situation                                          | Behaviour                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| A player disconnects mid-round, unsubmitted          | Round resolves without them, as if the round simply had fewer active players     |
| Everyone but one player disconnects                 | Round can't resolve below 2 active players -- waits until someone reconnects, or host ends it |
| A spectator wants in mid-game                       | Stays a spectator until `rematch` (which resets everyone to `player`) -- no mid-game promotion in v1 |
| Host disconnects or refreshes                       | `hostId` is the room's *owner* and survives a disconnect. While they're away, the longest-standing connected player acts as host; the owner gets control back on reconnect. Ownership only moves on `leave` or kick |
| Two people submit near-identical words with a typo   | Matched if the words are 6+ letters (see §3); short words must match exactly     |
| Singular vs plural ("cloud" / "clouds")             | Matched                                                                          |
| Host starts with someone disconnected in the lobby | Disconnected players are dropped at `start`; if they come back they join as watchers |
| Two rooms created with the same random code         | The Room answers `/create` with 409 and the Worker rolls a new code (5 tries)    |
| Room idle for 2 hours                                | Durable Object storage cleared on the TTL alarm, same as Answer It                |

## 8. Open questions / parked ideas

- **Mid-game promotion.** A spectator who wants to jump in mid-round has to
  wait for `rematch`. Worth revisiting if that friction shows up in playtesting.
- **Reconnect grace window.** A refresh mid-round drops you for the second
  it takes to reconnect; if you were the last one the round was waiting on,
  it resolves without you. Rare in practice, but a few seconds' grace before
  a close counts as a disconnect would fix it.
- **Big-screen / spectator-focused view**, like Answer It's, for playing with
  a shared screen instead of everyone on their own phone.
- **Nickname clashes.** Two players can both be "Sam". Harmless (ids are
  what matter) but confusing in the thread.
