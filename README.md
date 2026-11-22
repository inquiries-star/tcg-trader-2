# TCG Trader (Netlify edition)

A marketplace and trading platform for trading card games. Each game (Pokémon, One Piece, Magic, Yu-Gi-Oh!, Riftbound, Lorcana, Gundam, Other) is its own community with its own listings, discussion board, want lists, messages and trades. Listings in one community never appear in another.

## What's inside

| Piece | Where | Notes |
|---|---|---|
| Frontend | `public/index.html` | Static page, no build step |
| API | `netlify/functions/api.mts` | One function serving `/api/*` |
| Database | `netlify/database/migrations/` | Netlify Database (Postgres), applied on deploy |
| Photos | Netlify Blobs (store `photos`) | Uploaded through the API, resized in the browser |
| Accounts | Netlify Identity | Sign-up, sign-in and sessions |
| Privacy gate | `netlify/edge-functions/gate.mts` | Password for the whole site, locked by default |
| Courier (Shippo) | `netlify/lib/shippo.mts` | Rates, label purchase, tracking webhook |
| Trade rules | `netlify/lib/sweep.mts`, `netlify/functions/sweep.mts` | Deadlines, auto-confirm and deposit release, run lazily and hourly |

Account area (Account tab): profile, settings (notifications, vacation mode, default ship-from and shipping), payment methods (nickname and last 4 digits only, never full numbers), earnings after the 5% fee, trades with shipping and deposit status, and saved listings. My listings shows views, unique visitors, saves, conversations and trade offers per listing (a visitor counts once per 30 minutes; your own visits are ignored). Added by migration `20261121140000_account.sql`, so redeploy with the Netlify CLI or Git so migrations run.

Features: sealed products (boxes, packs, decks) alongside single cards, trade deposits (demo ledger), accounts and display names, listings with required front/back/corner photos, shipping cost, 5% fee preview, buyer–seller messaging (private to the two people), trade offers with each trader paying their own shipping, trade tracker (tracking numbers, receipt confirmation), ratings from completed trades, want lists with matching, per-community discussion boards.

## Trade deposits (demo ledger)

When a trade offer is made, the deposit is fixed at **25% of the higher declared card value, $5 minimum, $500 cap** (change `depositFor` in `api.mts`). Sellers declare an estimated value on trade listings; people making an offer declare the value of the card they offer (or pick one of their own listings, whose value is used).

1. Seller accepts. Each trader has **5 days** to ship (`SHIP_DAYS` in `netlify/lib/sweep.mts`).
2. Each trader pays their deposit (a button in this demo, **no real money moves**), then enters a tracking number. Shipping is blocked until the deposit is held.
3. Each trader confirms receipt. When both have, the trade completes and both deposits are **released**.
4. If only one trader confirms, the other's receipt is assumed after **72 hours** and the trade completes.
5. If the ship-by date passes: nobody shipped, the trade is cancelled and deposits are returned. One trader shipped, the other didn't: the trade is cancelled and the non-shipper's deposit is **forfeited** to the other trader.
6. Either trader can **report a problem**. The trade becomes `disputed` and deposits stay held. Moderator resolution is not built yet.

Rules run when a conversation is opened and hourly from `netlify/functions/sweep.mts` (scheduled functions only run on published deploys).

To make it real: replace the "Pay deposit" step with a payment provider that can hold funds on your behalf (for example Stripe Connect), and confirm money-handling rules with a lawyer first. Card authorization holds typically last about a week, so a longer trade usually means charging the deposit and refunding it.

## Courier integration (Shippo)

Traders can buy their shipping label inside the trade instead of typing a tracking number.

1. After a trade is accepted and a trader's deposit is held, they add a shipping address (US or Canada). It is used only to print labels, is never shown to the other trader, and is deleted when the trade ends.
2. Once both addresses are in, they tap **Get courier rates**, pick a service and **Buy label**. The tracking number is saved automatically and marked **carrier-verified**. A manual tracking number is still allowed as a fallback and is labelled "not verified". Reused tracking numbers are rejected.
3. Shippo's `track_updated` webhook updates the status. When the carrier reports **DELIVERED** for a verified label, the recipient's receipt is assumed after 72 hours (the existing auto-confirm rule), which releases the deposits. Recipients can still confirm sooner.

Setup: create a Shippo account, then set these environment variables:
- `SHIPPO_API_KEY`: start with a `shippo_test_` key (free, simulated labels). Live keys are refused unless `ALLOW_LIVE_LABELS=true`, because the demo has no payments yet and labels cost real money.
- `SHIPPO_WEBHOOK_TOKEN`: any long random string. In the Shippo dashboard, add a webhook for `track_updated` pointing to `https://YOUR-SITE/api/shippo-webhook?token=YOUR_TOKEN`. That one path is exempt from the password gate and protected by the token instead.
- In test mode, tracking number `SHIPPO_DELIVERED` with carrier `shippo` simulates delivery.

Notes: the parcel is fixed at 9x6x1 in, 4 oz (one card in a top loader and mailer). Whoever buys the label is charged by Shippo; the demo does not collect that money from traders. Delivery updates arrive within about 2 hours on average.

## Setup

1. **Plan:** Netlify Database requires a credit-based Netlify plan.
2. **Install:** `npm install`
3. **Create the site** (Git-based deploy is easiest), then set these environment variables (scope: Functions and Runtime):
   - `SITE_PASSWORD`: the password visitors must enter. The site returns "locked" until this is set. Set `ALLOW_PUBLIC=true` instead only if you really want a public site.
4. **Enable Identity** in the Netlify dashboard (Project configuration, Identity). For a demo you can switch on autoconfirm so sign-ups don't need email confirmation.
5. **Deploy.** The database is provisioned and the migration applied automatically on deploy. Deploy a preview first (`netlify deploy`) before going to production (`netlify deploy --prod`).
6. Open the site, enter the password, create an account, choose a display name.

## Testing

`tests/run.sh` starts a throwaway local PostgreSQL, applies the migrations, and runs `tests/run.mjs`, which drives the real API handler, sweep rules and gate against it. Only the platform pieces are faked: sign-in, blob storage and Shippo's HTTP API (`tests/stubs/`). It needs the PostgreSQL server binaries and `psql` installed locally. Covers deposit amounts, the accept/deposit/ship/receive/release/rate lifecycle, forfeits, the 72-hour and carrier-delivery rules, disputes, concurrency, roles and access, messaging, couriers and the webhook, want lists, boards, photos, auth and the gate. Not covered: the frontend (no browser tests yet) and Netlify's hosted services.

## Local development

`netlify dev` runs the site, functions and local database (apply migrations with `netlify database migrations apply`). Netlify Identity does **not** run locally, so sign-in and sign-up only work on a deploy (previews work). Set `ALLOW_PUBLIC=true` in a local `.env` to skip the gate.

## Things to know

- **What has and hasn't been tested.** The API, trade/deposit rules, sweep, courier flow and password gate pass 271 automated checks against a real PostgreSQL 16 (see Testing). Not yet verified: the frontend in a browser, a real Netlify deploy (Identity, Blobs, Database as hosted), and real calls to Shippo (its HTTP API was faked from its docs).
- **Real card entry needs a payment provider.** The Payments tab stores only a nickname and last 4 digits. Use Stripe or similar for real card and payout details.
- **No payments.** Fees are shown, not charged. Trades settle shipping between the two people outside the site.
- **Manually typed tracking numbers are not verified.** Labels bought through the site are carrier-verified.
- **Photos are served by unguessable ID** and are not login-gated, but the whole site sits behind the password gate.
- **Moderation, password reset emails and account deletion** are Netlify Identity defaults or not built yet.
- Preview deploys get a copy of production data and have public URLs. Keep `SITE_PASSWORD` set for all contexts.
