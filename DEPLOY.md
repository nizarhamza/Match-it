# Deploying Match It

One Cloudflare **Worker with Static Assets** — Cloudflare's current recommended
pattern (successor to a separate Pages + Worker split): the same deployment
serves `public/index.html` and friends *and* runs `src/index.js` for
everything under `/api/*`, including the Durable Object behind each room. One
project, one command, no CORS to think about, since the site and the API are
the same origin.

## 0. One-time setup

```bash
npm install -g wrangler
wrangler login
```

`wrangler login` opens a browser to authorize against your Cloudflare
account. If you'd rather use an API token (e.g. to deploy from a script or
from Claude's sandbox), create one instead — Cloudflare dashboard → **My
Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template
covers everything this project needs — then:

```bash
export CLOUDFLARE_API_TOKEN=your-token-here
export CLOUDFLARE_ACCOUNT_ID=your-account-id-here   # dashboard → Workers & Pages → Overview, right sidebar
```

## 1. Deploy

From the repo root:

```bash
wrangler deploy
```

This one command:

- Applies the Durable Object migration (creates the `Room` class on the free
  **SQLite-backed** Durable Objects, same as Answer It).
- Uploads everything in `public/` as static assets (free, unlimited, served
  from Cloudflare's edge — no separate Pages project).
- Deploys `src/index.js` to handle `/api/*`.

You'll get one URL:

```
https://match-it.<your-subdomain>.workers.dev
```

Open it, create a room, open it again in a second tab/device to join — that's
the whole test.

## 2. Custom domain (optional)

Cloudflare dashboard → **Workers & Pages → match-it → Settings → Domains &
Routes → Add Custom Domain**. Once attached, the same single deployment
serves the site and the API on your domain — nothing else to configure.

## 3. Lock down CORS (optional, mostly moot now)

`wrangler.toml` ships `ALLOWED_ORIGIN = "*"`. Since the site and the API are
now the same Worker (same origin), this header barely matters in practice —
it's only relevant if you ever split the API back out to its own Worker. Safe
to leave as-is.

## Redeploying after a code change

```bash
wrangler deploy
```

That's it — same command for a `src/*.js` change, a `public/index.html`
change, or both.

## Rooms don't survive a Worker code change that touches the Durable Object's data shape

Durable Object storage is separate from the Worker's code, so shipping a new
`room.js` doesn't wipe live rooms — but changing the **shape** of what's
stored in `state.storage` (e.g. renaming a field) will confuse any room whose
DO instance is still holding the old shape. For a party game with 2-hour room
TTLs, this is rarely worth worrying about: worst case, tell people to make a
fresh room.

## If you'd rather keep the old Pages + separate Worker split

Nothing here stops you — put `public/*` in its own Pages project, keep
`src/*` as a standalone Worker (drop the `[assets]` block from
`wrangler.toml`), and route `/api/*` to the Worker via a Worker Route or
Service Binding. The unified model above is just less to maintain for a
project this size.
