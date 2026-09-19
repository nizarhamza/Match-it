# Deploying Match It

One Worker, serving both the static site and the room API — no separate
Pages project needed.

## Prerequisites

- Node.js installed
- A Cloudflare account (free plan is enough — the Durable Object class is
  SQLite-backed, which runs on the free tier)
- `npx wrangler login` once, to authorize the CLI against your account
  (opens a browser to approve it)

## 1. Install dependencies

```
npm install
```

## 2. Deploy

```
npx wrangler deploy
```

That's it. This publishes `match-it` to
`https://match-it.<your-subdomain>.workers.dev`, serves `public/` as static
assets, and provisions the `ROOMS` Durable Object binding from
`wrangler.toml` automatically.

Open the URL it prints, create a room, send the 6-digit code to whoever
you're playing with.

## Sanity-check locally first (optional)

```
npx wrangler dev
```

Runs the whole thing — static site and Durable Object — on
`http://localhost:8787` before you deploy for real.

## If you ever split the site onto its own domain

v1 assumes the client and the Worker share an origin (same-origin
WebSocket, no CORS needed). If you later move the static site elsewhere —
a different Pages project, another CDN — point the client at the Worker
explicitly once, and it remembers it:

```
https://your-static-site.example/?api=https://match-it.<your-subdomain>.workers.dev
```

That sets `localStorage.matchit_api_base`, used for every connection after.
You'd also want to set `ALLOWED_ORIGIN` in `wrangler.toml`'s `[vars]` to the
static site's real origin (it defaults to `"*"`) and redeploy the Worker.

## Redeploying after a code change

```
npx wrangler deploy
```

Same command every time — it picks up changes to both `src/` and `public/`.
