# Match It

Everyone in the room writes a word. When everyone's in, every word is shown.
If they don't all match, you go again — you can see everything anyone's
written so far — until the whole room lands on the same word at the same
time.

No score, no timer, no race. Just: did the room click?

Same shape as [Find It](https://github.com/nizarhamza/answer-it/blob/find-it-site)
and [Answer It](https://github.com/nizarhamza/answer-it): a static,
installable web app, backed by one small Cloudflare Worker with a Durable
Object per room. Room-only this time — there's no solo mode, since the whole
point is other people.

One difference from Answer It's original split: this ships as a single
**Worker with Static Assets** — Cloudflare's current recommended pattern —
rather than a separate Pages project plus a Worker. Same idea, one fewer
moving part.

## Play it

Open `public/index.html` to look at the screens. Actual multiplayer needs the
Worker deployed (see below); the static file alone can't talk to a room.

## Status

Not yet deployed. Lobby, the round loop (submit → reveal → repeat until
unanimous), invite links, rematch, and host controls (start / end / kick) are
all built and covered by tests. Not yet done: real PWA icons (the shipped one
is a placeholder SVG), and a live deploy.

## Test

```
npm test              # matching rules (pure, no server)
npm run dev           # in one terminal
npm run test:room     # protocol tests against the dev server, in another
```

The heartbeat sweep test needs a server with a short timeout — see the
comment at the bottom of `test/room.test.mjs`.

## Stack

No build step, one Worker. `public/index.html` is the whole client —
markup, CSS, JS — served as a static asset. `src/game-core.js` is a pure,
dependency-free module (word normalisation, typo-tolerant matching, room
codes) imported by `src/room.js`, the Durable Object behind every room.
`src/index.js` is the thin HTTP entry: create a room, upgrade to its socket —
everything else falls through to the static assets automatically.

## Deploy

See [DEPLOY.md](DEPLOY.md).

## Design

- **Palette:** dark ink base (`#17151F`) with two purposeful accents — violet
  (`#6B5CE7`) for "still searching," reserved teal-green (`#2FBF8F`) for the
  moment everyone matches. Full light-mode parity via `prefers-color-scheme`
  plus a manual toggle.
- **Type:** Fraunces for the words themselves (the words are the whole game,
  so they're the one thing set in a characterful display face) and Inter for
  every UI chrome around them.
- **Layout:** a scrolling thread, newest round closest to the compose bar —
  the room's history reads like a conversation, not a scoreboard.

## Credits

Stack, patterns and hosting shape borrowed wholesale from Answer It / Find It.
