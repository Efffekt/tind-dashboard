# Tind Dashboard

Live order dashboard for **Tind Logistics AS** — a Norwegian 3PL warehouse running on ShipHero and Packiyo. Designed as a wall-mounted TV display showing active (pickable) orders, units to pick, and a live feed of incoming work across all tenants.

## Stack

- **Node.js + TypeScript** (dev-server via `tsx`, production on Vercel serverless)
- **Vanilla HTML/CSS/JS** frontend (no framework, no build step)
- **ShipHero** GraphQL + **Packiyo** JSON:API integrations
- **Vercel Cron** (every 3 min) keeps the CDN cache warm
- **Clash Display** + **Inter** type pairing, Swiss-editorial layout

## Quick start

```bash
npm install
cp .env.example .env     # fill in the four API keys below
npm run dev              # → http://localhost:3001
```

The dev server watches file changes via `tsx`. If `.env` has no tokens, it falls back to mock data with a yellow "Viser testdata" banner.

## Environment variables

| Key | What | Where from |
|---|---|---|
| `SHIPHERO_ACCESS_TOKEN` | ShipHero GraphQL bearer token (~28-day expiry) | ShipHero → Developer → API tokens |
| `SHIPHERO_REFRESH_TOKEN` | Long-lived refresh token used by auto-refresh | Same place; only visible once at generation |
| `PACKIYO_BASE_URL` | Tenant-specific Packiyo instance URL | `https://tindlogistics.app.packiyo.com` for Tind |
| `PACKIYO_TOKEN` | Packiyo bearer token (no expiry) | Packiyo → My Profile → Access Tokens |

The dashboard **auto-refreshes** the ShipHero access token on 401 using the refresh token — you shouldn't need to rotate it manually unless the refresh token itself gets revoked. The `SHIPHERO_ACCESS_TOKEN` env value is used only on cold starts to bootstrap the refresh flow; once refreshed, the new token lives in memory on the warm serverless instance.

## Deployment (Vercel)

1. Push this repo to GitHub (private)
2. Import it in the Vercel dashboard (or `vercel deploy`)
3. Set the four env vars in **Settings → Environment Variables** for *both* Production and Preview
4. Vercel picks up `vercel.json` automatically — cron runs every 3 min, cache headers pre-configured

After deploy, hit `https://<your-app>.vercel.app/api/data` and verify:

- HTTP 200
- `errors: { shiphero: null, packiyo: null }`
- `mock: false` (if you see `true`, the env vars aren't set)

## How it works

- **`api/data.ts`** — Vercel serverless handler. Queries both APIs in parallel, merges results, computes stats.
- **`src/services/shiphero.ts`** — GraphQL. Uses `ready_to_ship: true` as the pickable filter. Auto-refreshes expired tokens via `/auth/refresh`. Cursor-paginates `line_items` for orders with >25 SKUs.
- **`src/services/packiyo.ts`** — JSON:API. Filters `fulfilled=0 & cancelled=0`. Multi-page pagination via `page[number]`. Walks `customer → contact_information` for tenant names.
- **`dev-server.ts`** — Local dev-only HTTP server that mirrors the Vercel handler.
- **`public/`** — Static frontend. `app.js` polls `/api/data` every 60s.

### Key design decisions

- **`ready_to_ship: true`** is the authoritative "can be picked now" filter. Using `fulfillment_status: "pending"` misses every order with a custom 3PL status (`"Skinsecret B2C"`, `"Lager VM"`, `"Mesanin"`, etc.) — which is most of them.
- **3-min cron + 180s cache** ("Option A"). TV polls hit CDN cache, only the cron itself hits origin. ~480 function invocations/day regardless of how many TVs watch.
- **Soft-balanced display**: 15 orders per source, but backfills from the other if one side is empty. E.g., if all ShipHero orders are currently backordered, Packiyo fills all 30 display slots.
- **Stale highlight**: active orders older than 48h get a red left-border + red timestamp.
- **Custom ShipHero statuses normalized to `"pending"`** for the UI, so the status pill renders as "Ventende" uniformly across tenants.

## Banner meanings

| State | Meaning | Action |
|---|---|---|
| 🟡 Yellow "Viser testdata" | Mock mode — env vars missing | Set env vars in Vercel, redeploy |
| 🔴 Red "Sidetaket er nådd" | Data is incomplete (pagination cap, schema drift, or refetch failure) | Check Vercel function logs for the specific warning |
| 🔴 Red ⚠ on ShipHero stat cell | ShipHero API failed this refresh | Check logs; likely credit exhaustion or auth failure |
| 🔴 Red ⚠ on Packiyo stat cell | Packiyo API failed this refresh | Check logs; likely token or network issue |
| ⚫ Red dot + "Frakoblet" | Dashboard can't reach its own `/api/data` | Browser network issue, not API |

## Monitoring

`.github/workflows/uptime.yml` runs every 30 minutes and fails (→ GitHub sends an email) on any of:

- `/api/data` returns non-200
- `errors.shiphero` or `errors.packiyo` is set
- `mock: true` (env vars unexpectedly missing in production)

**One-time setup** after deploying:

1. Go to repo **Settings → Secrets and variables → Actions → Variables**
2. Add `DASHBOARD_URL = https://<your-app>.vercel.app` (no trailing slash)
3. The workflow picks it up automatically on the next scheduled run

Frequency is set to `*/30 * * * *` to stay within GitHub Actions' free tier on a private repo (~1,440 billed minutes/month vs. 2,000 included). See the top of `uptime.yml` for the trade-off table and how to increase frequency.

## Known limitations

- **ShipHero `orders` query has a 100-edge cap** with no cursor support. If Tind ever has >100 simultaneously pickable orders, some are missing from the count. The red banner fires so you'll know. Currently at ~30 pickable active, so 3× headroom.
- **`7e7f33.myshopify.com`**: one order currently appears from this shop. Unclear if it's a real tenant or another test store — if it should be hidden, add `'7e7f33'` to `IGNORED_SHOP_SLUGS` in `src/services/shiphero.ts` next to `'xserc9-vd'`.
- **Vercel cold start**: first request after idle takes ~1–2s extra. The 3-min cron keeps the function warm in practice.

## When things go wrong

- **Dashboard shows 0 for ShipHero** → Check ShipHero API credit pool (regenerates at 60/sec, max 4004) and verify the refresh token hasn't been revoked in ShipHero settings. Check Vercel function logs.
- **Dashboard shows 0 for Packiyo** → Verify `PACKIYO_TOKEN` is still valid (Packiyo tokens can be revoked from the user's profile in Packiyo).
- **Red "Sidetaket er nådd" fires** → Look in Vercel function logs for the specific warning. Common causes: an order with >5000 line items, Packiyo schema drift, or the ShipHero 100-order ceiling.
- **Both sources zero and live dot red** → Network issue between the TV browser and Vercel (not an API problem).
- **Uptime workflow failing** → Check the Actions tab. The log will say exactly which check failed (HTTP code, source error, mock mode, etc.).

## File layout

```
├── api/
│   └── data.ts            # Vercel serverless handler (production path)
├── src/
│   ├── config.ts          # Env var → config object
│   ├── types/index.ts     # Shared Order type
│   └── services/
│       ├── shiphero.ts    # GraphQL integration + token refresh
│       ├── packiyo.ts     # JSON:API integration
│       └── mock.ts        # Fallback mock data when tokens missing
├── public/
│   ├── index.html         # TV dashboard layout
│   ├── app.js             # Polling + render
│   └── styles.css         # Swiss-editorial design
├── dev-server.ts          # Local dev HTTP server
├── vercel.json            # Cron + cache headers
└── .github/workflows/
    └── uptime.yml         # 30-min health check
```

## License / ownership

Built for Tind Logistics AS. All rights reserved.
