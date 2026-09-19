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
  history: [ { round, words: {playerId: word}, matched } ]
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

sameWord(a, b):
  normalize(a) === normalize(b)
  OR levenshtein(normalize(a), normalize(b)) <= ceil(maxLen / 6)
    -- the same typo-tolerance rule Answer It uses for open-answer checking
```

All-pairs `sameWord` -> **matched**, room status becomes `matched`, game over
(host can rematch). Otherwise -> a fresh round begins with the same player
set; submissions clear, everyone's word from the round that just resolved
stays in `history` forever.

A disconnect is treated the same as a submission for completion purposes: if
a round was only waiting on a player who then closes their tab, the round
resolves as soon as they drop rather than hanging forever. (They just won't
have a word in that round's `history` entry.)

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
| `state`   | Full room snapshot: status, round, hostId, players, submittedCount/activeCount, history |
| `reveal`  | `{ round, words, matched, nicknames }` -- sent once, the moment a round resolves    |
| `error`   | `{ code, message }`                                                                  |
| `pong`    | `{ t, serverNow }`                                                                   |

`state` always carries the full `history`; an in-progress round's words are
never in it -- only `submittedCount` -- so nobody sees a partial round before
they've locked in their own word.

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
| Host disconnects                                    | Host role passes to the next connected player                                     |
| Two people submit near-identical words with a typo   | Matched anyway -- `sameWord`'s Levenshtein tolerance covers it                    |
| Room idle for 2 hours                                | Durable Object storage cleared on the TTL alarm, same as Answer It                |

## 8. Open questions / parked ideas

- **Mid-game promotion.** A spectator who wants to jump in mid-round has to
  wait for `rematch`. Worth revisiting if that friction shows up in playtesting.
- **Reconnect grace window.** A refresh mid-round currently just reconnects
  and picks up where it left off; there's no "N seconds before you're
  dropped" timer. Not currently a real risk (see §3's disconnect handling),
  but worth another look if that ever feels wrong in practice.
- **Big-screen / spectator-focused view**, like Answer It's, for playing with
  a shared screen instead of everyone on their own phone.
- **Room size cap.** None enforced beyond ">=2 to start." Fine at
  friend-group scale; worth a cap before sharing a room link publicly.
