import type { Config, Context } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { getStore } from "@netlify/blobs";
import { getUser, signup, login, logout, verifyRequestOrigin } from "@netlify/identity";
import { sweep, SHIP_DAYS } from "../lib/sweep.mts";
import { getRates, buyLabel, refundLabel, ShippoError } from "../lib/shippo.mts";

export const config: Config = {
  path: "/api/*",
  rateLimit: { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 300 },
};

const GAMES = ["Pokémon", "One Piece", "Magic: The Gathering", "Yu-Gi-Oh!", "Riftbound", "Disney Lorcana", "Gundam", "Other TCG"];
const CONDS = ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged", "Graded (PSA/BGS/CGC)"];
const CONDS_SEALED = ["Factory sealed", "Sealed, box damaged", "Opened or incomplete"];
const PRODUCT_TYPES = ["Booster box", "Booster pack", "Booster bundle", "Elite trainer or collection box", "Starter or structure deck", "Tin or mini tin", "Case", "Other sealed product"];
const TYPES = ["sale", "both", "trade"];
const FEE_RATE = 0.05;
const PAY_TYPES = ["Credit or debit card", "Bank account (payouts)", "PayPal"];
const SETTING_FLAGS = ["notifyMessages", "notifyOffers", "notifyShipping", "notifyDigest"];
const SETTINGS_DEFAULT = { notifyMessages: true, notifyOffers: true, notifyShipping: true, notifyDigest: false, defaultLocation: "", defaultShipping: null as number | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Demo deposit: 25% of the higher card value, $5 minimum, $500 cap (no real money moves).
const depositFor = (a: number, b: number) => Math.min(500, Math.max(5, Math.round(Math.max(a, b) * 25) / 100));
const ZIP: Record<string, RegExp> = { US: /^\d{5}(-\d{4})?$/, CA: /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/ };
function cleanAddress(a: any) {
  const o = { name: str(a?.name, 60), street1: str(a?.street1, 80), street2: str(a?.street2, 60), city: str(a?.city, 50),
    state: str(a?.state, 30), zip: str(a?.zip, 12), country: str(a?.country, 2).toUpperCase(), phone: str(a?.phone, 20) };
  if (!ZIP[o.country]) return "Shipping is available within the US and Canada for now.";
  if (!o.name || !o.street1 || !o.city || !o.state || !ZIP[o.country].test(o.zip)) return "Enter your full name, street, city, state or province, and a valid postal code.";
  return o;
}
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const bad = (message: string, status = 400) => json({ error: message }, status);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const amount = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const sellerOf = (r: any) => ({
  id: r.seller_id,
  name: r.seller_name,
  rating: r.rating_count ? Math.round((r.rating_sum / r.rating_count) * 10) / 10 : null,
  count: r.rating_count,
});
const listingOut = (r: any) => ({
  id: r.id, soldAt: r.sold_at, game: r.game, kind: r.kind, productType: r.product_type, title: r.title, set: r.set_name, condition: r.condition, type: r.type,
  lookingFor: r.looking_for, price: Number(r.price), shipping: Number(r.shipping), value: Number(r.value), location: r.location,
  desc: r.description, photos: r.photos, sold: r.sold, created: r.created_at, seller: sellerOf(r),
});
const LISTING_COLS = `l.id, l.seller_id, l.game, l.kind, l.product_type, l.title, l.set_name, l.condition, l.type, l.looking_for, l.price,
  l.shipping, l.value, l.location, l.description, l.photos, l.sold, l.sold_at, l.created_at,
  s.name AS seller_name, s.rating_sum, s.rating_count`;

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const p = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const m = req.method;

  try {
    if (p[0] === "shippo-webhook" && m === "POST") return await shippoWebhook(req, url);

    // Block cross-site form posts: every state-changing request must carry this header.
    if (m !== "GET" && m !== "HEAD" && req.headers.get("x-requested-with") !== "tt") return bad("Bad request", 403);

    if (p[0] === "auth") return await auth(req, p[1]);
    if (p[0] === "photo" && m === "GET") return await photoGet(p[1]);

    const db = getDatabase();
    const user = await getUser();
    const prof = user ? (await db.sql`SELECT id, name FROM profiles WHERE id = ${user.id}`)[0] : null;
    const must = () => {
      if (!user) throw bad("Please sign in first.", 401);
      if (!prof) throw bad("Choose a display name first.", 403);
      return prof as { id: string; name: string };
    };
    const body = async (): Promise<any> => (await req.json().catch(() => ({}))) || {};
    const game = url.searchParams.get("game");
    if (game && !GAMES.includes(game)) return bad("Unknown game.");

    // ---------- session / profile ----------
    if (p[0] === "me" && m === "GET") return json({ signedIn: !!user, user: prof || null });
    if (p[0] === "profile" && m === "POST") {
      if (!user) return bad("Please sign in first.", 401);
      const name = str((await body()).name, 30);
      if (name.length < 2) return bad("Display name must be 2 to 30 characters.");
      await db.sql`INSERT INTO profiles (id, name) VALUES (${user.id}, ${name})
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`;
      return json({ user: { id: user.id, name } });
    }

    // ---------- stats ----------
    if (p[0] === "stats" && m === "GET") {
      const l = await db.sql`SELECT game, count(*)::int AS listings, count(DISTINCT seller_id)::int AS sellers
        FROM listings WHERE NOT sold GROUP BY game`;
      const po = await db.sql`SELECT game, count(*)::int AS posts FROM posts GROUP BY game`;
      const games: Record<string, any> = {};
      for (const g of GAMES) games[g] = { listings: 0, sellers: 0, posts: 0 };
      l.forEach((r: any) => games[r.game] && Object.assign(games[r.game], { listings: r.listings, sellers: r.sellers }));
      po.forEach((r: any) => games[r.game] && (games[r.game].posts = r.posts));
      return json({ games });
    }

    // ---------- photos ----------
    if (p[0] === "photos" && m === "POST") {
      const me = must();
      const type = (req.headers.get("content-type") || "").split(";")[0];
      if (!["image/jpeg", "image/png", "image/webp"].includes(type)) return bad("Photos must be JPEG, PNG or WebP.");
      const buf = await req.arrayBuffer();
      if (buf.byteLength < 200 || buf.byteLength > 3_500_000) return bad("Photo is too small or too large (max 3.5 MB).");
      const id = crypto.randomUUID();
      await getStore("photos").set(id, buf, { metadata: { owner: me.id, type } });
      return json({ id });
    }

    // ---------- listings ----------
    if (p[0] === "listings") {
      if (!p[1] && m === "GET") {
        const mineOnly = url.searchParams.get("mine") === "1";
        const me = mineOnly ? must() : null;
        const rows = mineOnly
          ? await db.sql`SELECT ${db.sql.raw(LISTING_COLS)} FROM listings l JOIN profiles s ON s.id = l.seller_id
              WHERE l.seller_id = ${me!.id} AND (${game}::text IS NULL OR l.game = ${game}) ORDER BY l.created_at DESC`
          : await db.sql`SELECT ${db.sql.raw(LISTING_COLS)} FROM listings l JOIN profiles s ON s.id = l.seller_id
              WHERE NOT l.sold AND NOT s.vacation AND (${game}::text IS NULL OR l.game = ${game}) ORDER BY l.created_at DESC LIMIT 200`;
        const items = rows.map(listingOut) as any[];
        if (mineOnly) {
          const st = await db.sql`SELECT l.id,
              (SELECT COALESCE(sum(v.views), 0)::int FROM listing_views v WHERE v.listing_id = l.id) AS views,
              (SELECT count(*)::int FROM listing_views v WHERE v.listing_id = l.id) AS visitors,
              (SELECT max(v.last_at) FROM listing_views v WHERE v.listing_id = l.id) AS last_view,
              (SELECT count(*)::int FROM listing_saves sv WHERE sv.listing_id = l.id) AS saves,
              (SELECT count(*)::int FROM threads t WHERE t.listing_id = l.id) AS convs,
              (SELECT count(*)::int FROM messages mm JOIN threads t ON t.id = mm.thread_id WHERE t.listing_id = l.id AND mm.kind = 'offer') AS offers
            FROM listings l WHERE l.seller_id = ${me!.id}`;
          const by = new Map(st.map((r: any) => [r.id, r]));
          for (const it of items) {
            const r: any = by.get(it.id) || {};
            it.stats = { views: r.views || 0, visitors: r.visitors || 0, lastView: r.last_view || null, saves: r.saves || 0, conversations: r.convs || 0, offers: r.offers || 0 };
          }
        } else if (user) {
          const sv = await db.sql`SELECT listing_id FROM listing_saves WHERE user_id = ${user.id}`;
          const set = new Set(sv.map((r: any) => r.listing_id));
          for (const it of items) it.saved = set.has(it.id);
        }
        return json({ items });
      }
      if (!p[1] && m === "POST") {
        const me = must();
        const b = await body();
        const type = str(b.type, 10), price = amount(b.price), shipping = amount(b.shipping ?? 0);
        const title = str(b.title, 90), photos = Array.isArray(b.photos) ? [...new Set(b.photos)] : [];
        const value = type === "sale" ? price : amount(b.value ?? b.price);
        if (!GAMES.includes(b.game)) return bad("Choose a card game.");
        const kind = b.kind === undefined ? "card" : b.kind;
        if (kind !== "card" && kind !== "sealed") return bad("Choose card or sealed product.");
        const sealed = kind === "sealed";
        if (title.length < 2) return bad(sealed ? "Enter the product name." : "Enter the card name.");
        if (!(sealed ? CONDS_SEALED : CONDS).includes(b.condition)) return bad("Choose a condition.");
        if (sealed && !PRODUCT_TYPES.includes(b.productType)) return bad("Choose a product type.");
        if (!TYPES.includes(type)) return bad("Choose a listing type.");
        if (type !== "trade" && !(price > 0 && price <= 100000)) return bad("Enter a price greater than 0.");
        if (!(shipping >= 0 && shipping <= 1000)) return bad("Enter a valid shipping cost.");
        if (type !== "sale" && !(value > 0 && value <= 100000)) return bad("Enter an estimated value so trade deposits can be set.");
        if (photos.length < 3 || photos.length > 6 || !photos.every(isId)) return bad("Add front, back and corner photos (3 to 6).");
        const store = getStore("photos");
        for (const id of photos) {
          const md = await store.getMetadata(id as string);
          if (!md || md.metadata.owner !== me.id) return bad("One of the photos is invalid. Please re-upload.");
        }
        const [row] = await db.sql`INSERT INTO listings
          (seller_id, game, kind, product_type, title, set_name, condition, type, looking_for, price, shipping, value, location, description, photos)
          VALUES (${me.id}, ${b.game}, ${kind}, ${sealed ? b.productType : ""}, ${title}, ${str(b.set, 60)}, ${b.condition}, ${type}, ${str(b.lookingFor, 120)},
          ${type === "trade" && !(price > 0) ? 0 : price}, ${shipping}, ${value}, ${str(b.location, 50)}, ${str(b.desc, 500)}, ${photos})
          RETURNING id`;
        return json({ id: row.id }, 201);
      }
      if (isId(p[1]) && p[2] === "view" && m === "POST") {
        if (!user) return json({ ok: false });
        const [l] = await db.sql`SELECT seller_id FROM listings WHERE id = ${p[1]}`;
        if (!l) return bad("Listing not found.", 404);
        if (l.seller_id === user.id) return json({ ok: false });
        await db.sql`INSERT INTO listing_views (listing_id, viewer_id) VALUES (${p[1]}, ${user.id})
          ON CONFLICT (listing_id, viewer_id) DO UPDATE SET views = listing_views.views + 1, last_at = now()
          WHERE listing_views.last_at < now() - interval '30 minutes'`;
        return json({ ok: true });
      }
      if (isId(p[1]) && p[2] === "save" && m === "POST") {
        const me = must();
        const saved = !!(await body()).saved;
        const [l] = await db.sql`SELECT seller_id FROM listings WHERE id = ${p[1]}`;
        if (!l) return bad("Listing not found.", 404);
        if (l.seller_id === me.id) return bad("You can’t save your own listing.");
        if (saved) await db.sql`INSERT INTO listing_saves (listing_id, user_id) VALUES (${p[1]}, ${me.id}) ON CONFLICT DO NOTHING`;
        else await db.sql`DELETE FROM listing_saves WHERE listing_id = ${p[1]} AND user_id = ${me.id}`;
        return json({ saved });
      }
      if (isId(p[1]) && (m === "PATCH" || m === "DELETE")) {
        const me = must();
        const sold = m === "PATCH" ? !!(await body()).sold : false;
        const rows = m === "DELETE"
          ? await db.sql`DELETE FROM listings WHERE id = ${p[1]} AND seller_id = ${me.id} RETURNING id`
          : await db.sql`UPDATE listings SET sold = ${sold}, sold_at = CASE WHEN ${sold} THEN now() ELSE NULL END WHERE id = ${p[1]} AND seller_id = ${me.id} RETURNING id`;
        return rows.length ? json({ ok: true }) : bad("Listing not found.", 404);
      }
    }

    // ---------- saved listings ----------
    if (p[0] === "saves" && m === "GET") {
      const me = must();
      const rows = await db.sql`SELECT ${db.sql.raw(LISTING_COLS)} FROM listing_saves sv JOIN listings l ON l.id = sv.listing_id
        JOIN profiles s ON s.id = l.seller_id WHERE sv.user_id = ${me.id} ORDER BY sv.created_at DESC LIMIT 200`;
      return json({ items: rows.map((r: any) => ({ ...listingOut(r), saved: true })) });
    }

    // ---------- account: profile, settings, payment methods, earnings, trades ----------
    if (p[0] === "account") {
      const me = must();
      if (!p[1] && m === "GET") {
        const [pr] = await db.sql`SELECT id, name, bio, location, vacation, settings, created_at FROM profiles WHERE id = ${me.id}`;
        const pay = await db.sql`SELECT id, type, label, last4, is_payout FROM payment_methods WHERE user_id = ${me.id} ORDER BY created_at`;
        return json({
          profile: { id: pr.id, name: pr.name, bio: pr.bio, location: pr.location, vacation: pr.vacation, since: pr.created_at, settings: { ...SETTINGS_DEFAULT, ...(pr.settings || {}) } },
          payments: pay.map((x: any) => ({ id: x.id, type: x.type, label: x.label, last4: x.last4, payout: x.is_payout })),
        });
      }
      if (!p[1] && m === "PATCH") {
        const b = await body();
        let name: string | null = null, bio: string | null = null, location: string | null = null, vacation: boolean | null = null, settings: string | null = null;
        if (b.name !== undefined) { name = str(b.name, 30); if (name.length < 2) return bad("Name must be 2 to 30 characters."); }
        if (b.bio !== undefined) bio = str(b.bio, 300);
        if (b.location !== undefined) location = str(b.location, 50);
        if (b.vacation !== undefined) vacation = !!b.vacation;
        if (b.settings !== undefined) {
          const s = b.settings || {}, [cur] = await db.sql`SELECT settings FROM profiles WHERE id = ${me.id}`;
          const next: Record<string, unknown> = { ...SETTINGS_DEFAULT, ...(cur.settings || {}) };
          for (const k of SETTING_FLAGS) if (s[k] !== undefined) next[k] = !!s[k];
          if (s.defaultLocation !== undefined) next.defaultLocation = str(s.defaultLocation, 50);
          if (s.defaultShipping !== undefined) {
            if (s.defaultShipping === null || s.defaultShipping === "") next.defaultShipping = null;
            else { const v = amount(s.defaultShipping); if (!(v >= 0 && v <= 1000)) return bad("Enter a valid default shipping cost."); next.defaultShipping = v; }
          }
          settings = JSON.stringify(next);
        }
        await db.sql`UPDATE profiles SET name = COALESCE(${name}::text, name), bio = COALESCE(${bio}::text, bio),
          location = COALESCE(${location}::text, location), vacation = COALESCE(${vacation}::boolean, vacation),
          settings = COALESCE(${settings}::jsonb, settings) WHERE id = ${me.id}`;
        return json({ ok: true });
      }
      if (p[1] === "payment-methods") {
        if (!p[2] && m === "POST") {
          const b = await body();
          const label = str(b.label, 30), last4 = typeof b.last4 === "string" ? b.last4.trim() : "";
          if (!PAY_TYPES.includes(b.type)) return bad("Choose a payment type.");
          if (!label) return bad("Give it a nickname.");
          if (last4 && !/^[0-9]{4}$/.test(last4)) return bad("Last 4 digits must be exactly 4 numbers. Never enter a full card or account number.");
          const [c] = await db.sql`SELECT count(*)::int AS n FROM payment_methods WHERE user_id = ${me.id}`;
          if (c.n >= 5) return bad("You can keep up to 5 payment methods.");
          const [row] = await db.sql`INSERT INTO payment_methods (user_id, type, label, last4, is_payout)
            VALUES (${me.id}, ${b.type}, ${label}, ${last4}, ${c.n === 0}) RETURNING id`;
          return json({ id: row.id }, 201);
        }
        if (isId(p[2]) && !p[3] && m === "DELETE") {
          const del = await db.sql`DELETE FROM payment_methods WHERE id = ${p[2]} AND user_id = ${me.id} RETURNING is_payout`;
          if (!del.length) return bad("Payment method not found.", 404);
          if (del[0].is_payout) await db.sql`UPDATE payment_methods SET is_payout = true WHERE id = (SELECT id FROM payment_methods WHERE user_id = ${me.id} ORDER BY created_at LIMIT 1)`;
          return json({ ok: true });
        }
        if (isId(p[2]) && p[3] === "payout" && m === "POST") {
          const [own] = await db.sql`SELECT 1 AS x FROM payment_methods WHERE id = ${p[2]} AND user_id = ${me.id}`;
          if (!own) return bad("Payment method not found.", 404);
          await db.sql`UPDATE payment_methods SET is_payout = (id = ${p[2]}) WHERE user_id = ${me.id}`;
          return json({ ok: true });
        }
      }
      if (p[1] === "earnings" && m === "GET") {
        const rows = await db.sql`SELECT id, title, game, kind, price, sold_at FROM listings
          WHERE seller_id = ${me.id} AND sold AND type <> 'trade' AND price > 0 ORDER BY sold_at DESC NULLS LAST LIMIT 500`;
        const cents = (n: number) => Math.round(n * 100) / 100;
        const items = rows.map((r: any) => { const gross = Number(r.price), fee = cents(gross * FEE_RATE); return { id: r.id, title: r.title, game: r.game, kind: r.kind, soldAt: r.sold_at, gross, fee, net: cents(gross - fee) }; });
        const since = Date.now() - 30 * 864e5, sum = (a: any[], k: string) => cents(a.reduce((s, x) => s + x[k], 0));
        const r30 = items.filter((x) => x.soldAt && new Date(x.soldAt).getTime() >= since);
        return json({ feeRate: FEE_RATE, items, totals: { gross: sum(items, "gross"), fees: sum(items, "fee"), net: sum(items, "net"), net30: sum(r30, "net"), sold30: r30.length } });
      }
      if (p[1] === "trades" && m === "GET") {
        await sweep(db, null);
        const rows = await db.sql`SELECT m.id, m.created_at, t.id AS thread_id, t.buyer_id, t.seller_id, bp.name AS buyer_name, sp.name AS seller_name,
            o.card, o.their_title, o.status, o.buyer_tracking, o.seller_tracking, o.buyer_received, o.seller_received,
            o.deposit, o.buyer_deposit, o.seller_deposit, o.ship_by, o.buyer_track_status, o.seller_track_status,
            o.buyer_delivered_at, o.seller_delivered_at
          FROM offers o JOIN messages m ON m.id = o.message_id JOIN threads t ON t.id = m.thread_id
          JOIN profiles bp ON bp.id = t.buyer_id JOIN profiles sp ON sp.id = t.seller_id
          WHERE t.buyer_id = ${me.id} OR t.seller_id = ${me.id} ORDER BY m.created_at DESC LIMIT 100`;
        const trades = rows.map((r: any) => {
          const buyer = r.buyer_id === me.id;
          return {
            id: r.id, threadId: r.thread_id, at: r.created_at, status: r.status, with: buyer ? r.seller_name : r.buyer_name,
            iOffered: buyer ? r.card : r.their_title, theyOffered: buyer ? r.their_title : r.card,
            myTracking: buyer ? r.buyer_tracking : r.seller_tracking, theirTracking: buyer ? r.seller_tracking : r.buyer_tracking,
            myTrackStatus: buyer ? r.buyer_track_status : r.seller_track_status, theirTrackStatus: buyer ? r.seller_track_status : r.buyer_track_status,
            myReceived: buyer ? r.buyer_received : r.seller_received, theirReceived: buyer ? r.seller_received : r.buyer_received,
            deposit: Number(r.deposit), myDeposit: buyer ? r.buyer_deposit : r.seller_deposit, theirDeposit: buyer ? r.seller_deposit : r.buyer_deposit,
            shipBy: r.ship_by,
          };
        });
        const live = trades.filter((t: any) => t.status === "pending" || t.status === "accepted");
        const summary = {
          open: live.length,
          depositsHeld: Math.round(trades.filter((t: any) => t.myDeposit === "held").reduce((s: number, t: any) => s + t.deposit, 0) * 100) / 100,
          toShip: trades.filter((t: any) => t.status === "accepted" && !t.myTracking).length,
          toConfirm: trades.filter((t: any) => t.status === "accepted" && t.theirTracking && !t.myReceived).length,
          pendingAnswer: rows.filter((r: any) => r.status === "pending" && r.seller_id === me.id).length,
        };
        return json({ trades, summary });
      }
      return bad("Not found.", 404);
    }

    // ---------- threads, messages and trade offers ----------
    if (p[0] === "threads") {
      const me = must();
      if (!p[1] && m === "GET") {
        const rows = await db.sql`SELECT t.id, t.listing_title, t.game, t.buyer_id, t.seller_id, bp.name AS buyer_name, sp.name AS seller_name,
            lm.kind AS last_kind, lm.body AS last_body, lm.created_at AS last_at,
            (lm.sender_id <> ${me.id} AND lm.created_at > COALESCE(r.read_at, 'epoch'::timestamptz)) AS unread
          FROM threads t
          JOIN profiles bp ON bp.id = t.buyer_id JOIN profiles sp ON sp.id = t.seller_id
          JOIN LATERAL (SELECT kind, body, created_at, sender_id FROM messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) lm ON true
          LEFT JOIN thread_reads r ON r.thread_id = t.id AND r.user_id = ${me.id}
          WHERE (t.buyer_id = ${me.id} OR t.seller_id = ${me.id}) AND (${game}::text IS NULL OR t.game = ${game})
          ORDER BY lm.created_at DESC LIMIT 100`;
        return json({ threads: rows.map((r: any) => ({
          id: r.id, title: r.listing_title, game: r.game, unread: r.unread, lastAt: r.last_at,
          last: r.last_kind === "offer" ? "Trade offer" : r.last_body.slice(0, 60),
          other: r.buyer_id === me.id ? { id: r.seller_id, name: r.seller_name } : { id: r.buyer_id, name: r.buyer_name },
        })) });
      }
      if (!p[1] && m === "POST") {
        const b = await body();
        if (!isId(b.listingId)) return bad("Listing not found.", 404);
        const [l] = await db.sql`SELECT id, seller_id, game, title, type, shipping, value, sold FROM listings WHERE id = ${b.listingId}`;
        if (!l || l.sold) return bad("Listing is no longer available.", 404);
        if (l.seller_id === me.id) return bad("You can’t message yourself.");
        const text = str(b.text, 500);
        let offer: any = null;
        if (b.offer) {
          if (l.type === "sale") return bad("This listing isn’t open to trades.");
          const card = str(b.offer.card, 120), ship = amount(b.offer.ship ?? 0);
          if (card.length < 2) return bad("Say which card or sealed product you’re offering.");
          if (!(ship >= 0 && ship <= 1000)) return bad("Enter a valid shipping cost.");
          let photos: string[] = [], offerValue = amount(b.offer.value);
          if (b.offer.ownListingId) {
            if (!isId(b.offer.ownListingId)) return bad("Invalid listing.");
            const [own] = await db.sql`SELECT photos, value FROM listings WHERE id = ${b.offer.ownListingId} AND seller_id = ${me.id} AND NOT sold`;
            if (!own) return bad("Choose one of your own listings.");
            photos = own.photos.slice(0, 3);
            offerValue = Number(own.value);
          } else {
            photos = Array.isArray(b.offer.photos) ? [...new Set<string>(b.offer.photos)] : [];
            if (photos.length < 2 || photos.length > 4 || !photos.every(isId)) return bad("Add front and back photos of your card.");
            const store = getStore("photos");
            for (const id of photos) {
              const md = await store.getMetadata(id);
              if (!md || md.metadata.owner !== me.id) return bad("A photo is invalid. Please re-upload.");
            }
          }
          if (!(offerValue > 0 && offerValue <= 100000)) return bad("Enter the estimated value of your card.");
          offer = { card, ship, photos, theirShip: Number(l.shipping), theirTitle: l.title,
            buyerValue: offerValue, sellerValue: Number(l.value), deposit: depositFor(offerValue, Number(l.value)) };
        } else if (!text) return bad("Type a message.");
        const [t] = await db.sql`INSERT INTO threads (listing_id, listing_title, game, buyer_id, seller_id)
          VALUES (${l.id}, ${l.title}, ${l.game}, ${me.id}, ${l.seller_id})
          ON CONFLICT (listing_id, buyer_id) DO UPDATE SET listing_title = EXCLUDED.listing_title RETURNING id`;
        await addMessage(db, t.id, me.id, offer ? "offer" : "text", text, offer);
        return json({ id: t.id }, 201);
      }
      if (isId(p[1])) {
        const [t] = await db.sql`SELECT t.id, t.listing_title, t.game, t.buyer_id, t.seller_id, bp.name AS buyer_name, sp.name AS seller_name,
            sp.rating_sum AS s_sum, sp.rating_count AS s_cnt, bp.rating_sum AS b_sum, bp.rating_count AS b_cnt
          FROM threads t JOIN profiles bp ON bp.id = t.buyer_id JOIN profiles sp ON sp.id = t.seller_id
          WHERE t.id = ${p[1]} AND (t.buyer_id = ${me.id} OR t.seller_id = ${me.id})`;
        if (!t) return bad("Conversation not found.", 404);

        if (!p[2] && m === "GET") {
          await sweep(db, t.id);
          const msgs = await db.sql`SELECT m.id, m.sender_id, m.kind, m.body, m.created_at, o.card, o.photos, o.buyer_ship, o.seller_ship,
              o.their_title, o.status, o.buyer_tracking, o.seller_tracking, o.buyer_received, o.seller_received,
              o.buyer_value, o.seller_value, o.deposit, o.buyer_deposit, o.seller_deposit, o.ship_by,
              o.buyer_verified, o.seller_verified, o.buyer_carrier, o.seller_carrier, o.buyer_label_url, o.seller_label_url,
              o.buyer_track_status, o.seller_track_status, o.buyer_delivered_at, o.seller_delivered_at
            FROM messages m LEFT JOIN offers o ON o.message_id = m.id WHERE m.thread_id = ${t.id} ORDER BY m.created_at, m.id LIMIT 500`;
          const addrs = await db.sql`SELECT ta.message_id, ta.user_id, ta.name, ta.street1, ta.street2, ta.city, ta.state, ta.zip, ta.country, ta.phone
            FROM trade_addresses ta JOIN messages m ON m.id = ta.message_id WHERE m.thread_id = ${t.id}`;
          const ids = msgs.filter((x: any) => x.kind === "offer").map((x: any) => x.id);
          const rats = ids.length ? await db.sql`SELECT message_id, rater_id, stars FROM offer_ratings WHERE message_id = ANY(${ids}::uuid[])` : [];
          await db.sql`INSERT INTO thread_reads (thread_id, user_id, read_at) VALUES (${t.id}, ${me.id}, now())
            ON CONFLICT (thread_id, user_id) DO UPDATE SET read_at = now()`;
          const rating = (sum: number, cnt: number) => (cnt ? Math.round((sum / cnt) * 10) / 10 : null);
          return json({
            me: me.id,
            thread: {
              id: t.id, title: t.listing_title, game: t.game,
              buyer: { id: t.buyer_id, name: t.buyer_name, rating: rating(t.b_sum, t.b_cnt), count: t.b_cnt },
              seller: { id: t.seller_id, name: t.seller_name, rating: rating(t.s_sum, t.s_cnt), count: t.s_cnt },
            },
            messages: msgs.map((x: any) => ({
              id: x.id, from: x.sender_id, at: x.created_at, kind: x.kind, text: x.body,
              offer: x.kind === "offer" ? {
                card: x.card, photos: x.photos, buyerShip: Number(x.buyer_ship), sellerShip: Number(x.seller_ship), theirTitle: x.their_title,
                status: x.status, buyerTracking: x.buyer_tracking, sellerTracking: x.seller_tracking,
                buyerReceived: x.buyer_received, sellerReceived: x.seller_received,
                buyerValue: Number(x.buyer_value), sellerValue: Number(x.seller_value), deposit: Number(x.deposit),
                buyerDeposit: x.buyer_deposit, sellerDeposit: x.seller_deposit, shipBy: x.ship_by,
                buyerVerified: x.buyer_verified, sellerVerified: x.seller_verified, buyerCarrier: x.buyer_carrier, sellerCarrier: x.seller_carrier,
                buyerTrack: x.buyer_track_status, sellerTrack: x.seller_track_status,
                buyerDelivered: x.buyer_delivered_at, sellerDelivered: x.seller_delivered_at,
                // A label link is only ever shown to the trader it belongs to.
                myLabel: me.id === t.buyer_id ? x.buyer_label_url : x.seller_label_url,
                hasMyAddress: addrs.some((a: any) => a.message_id === x.id && a.user_id === me.id),
                hasTheirAddress: addrs.some((a: any) => a.message_id === x.id && a.user_id !== me.id),
                myAddress: addrs.filter((a: any) => a.message_id === x.id && a.user_id === me.id).map((a: any) => ({ name: a.name, street1: a.street1, street2: a.street2, city: a.city, state: a.state, zip: a.zip, country: a.country, phone: a.phone }))[0] || null,
                ratings: rats.filter((r: any) => r.message_id === x.id).map((r: any) => ({ rater: r.rater_id, stars: r.stars })),
              } : null,
            })),
          });
        }
        if (p[2] === "messages" && m === "POST") {
          const text = str((await body()).text, 500);
          if (!text) return bad("Type a message.");
          await addMessage(db, t.id, me.id, "text", text, null);
          return json({ ok: true }, 201);
        }
        if (p[2] === "offers" && isId(p[3]) && m === "POST") {
          const b = await body();
          const role = me.id === t.buyer_id ? "buyer" : "seller";
          const mid = p[3];
          const [o] = await db.sql`SELECT o.* FROM offers o JOIN messages m ON m.id = o.message_id WHERE o.message_id = ${mid} AND m.thread_id = ${t.id}`;
          if (!o) return bad("Offer not found.", 404);
          const denied = () => bad("That isn’t possible right now.", 409);
          let rows: any[] = [];
          switch (b.action) {
            case "accept": case "decline":
              if (role !== "seller") return bad("Only the listing owner can do that.", 403);
              rows = await db.sql`UPDATE offers SET status = ${b.action === "accept" ? "accepted" : "declined"},
                ship_by = CASE WHEN ${b.action === "accept"}::boolean THEN now() + make_interval(days => ${SHIP_DAYS}::int) ELSE NULL END
                WHERE message_id = ${mid} AND status = 'pending' RETURNING message_id`;
              break;
            case "withdraw":
              if (role !== "buyer") return bad("Only the person who made the offer can withdraw it.", 403);
              rows = await db.sql`UPDATE offers SET status = 'withdrawn' WHERE message_id = ${mid} AND status = 'pending' RETURNING message_id`;
              break;
            case "deposit":
              rows = role === "buyer"
                ? await db.sql`UPDATE offers SET buyer_deposit = 'held' WHERE message_id = ${mid} AND status = 'accepted' AND buyer_deposit = 'due' AND ship_by > now() RETURNING message_id`
                : await db.sql`UPDATE offers SET seller_deposit = 'held' WHERE message_id = ${mid} AND status = 'accepted' AND seller_deposit = 'due' AND ship_by > now() RETURNING message_id`;
              break;
            case "address": {
              if (o.status !== "accepted") return denied();
              const a = cleanAddress(b.address);
              if (typeof a === "string") return bad(a);
              await db.sql`INSERT INTO trade_addresses (message_id, user_id, name, street1, street2, city, state, zip, country, phone)
                VALUES (${mid}, ${me.id}, ${a.name}, ${a.street1}, ${a.street2}, ${a.city}, ${a.state}, ${a.zip}, ${a.country}, ${a.phone})
                ON CONFLICT (message_id, user_id) DO UPDATE SET name = EXCLUDED.name, street1 = EXCLUDED.street1, street2 = EXCLUDED.street2,
                city = EXCLUDED.city, state = EXCLUDED.state, zip = EXCLUDED.zip, country = EXCLUDED.country, phone = EXCLUDED.phone`;
              return json({ ok: true });
            }
            case "rates": {
              const mineShipped = role === "buyer" ? o.buyer_tracking : o.seller_tracking, myDep = role === "buyer" ? o.buyer_deposit : o.seller_deposit;
              if (o.status !== "accepted" || mineShipped || myDep !== "held") return denied();
              const ad = await db.sql`SELECT user_id, name, street1, street2, city, state, zip, country, phone FROM trade_addresses WHERE message_id = ${mid}`;
              const from = ad.find((x: any) => x.user_id === me.id), to = ad.find((x: any) => x.user_id !== me.id);
              if (!from || !to) return bad("Both traders need to add a shipping address first.", 409);
              const quotes = await getRates(from, to);
              if (!quotes.length) return bad("No courier services are available for these addresses.", 409);
              await db.sql`DELETE FROM label_quotes WHERE message_id = ${mid} AND user_id = ${me.id}`;
              for (const q of quotes) await db.sql`INSERT INTO label_quotes (message_id, user_id, rate_id, carrier, service, amount) VALUES (${mid}, ${me.id}, ${q.id}, ${q.carrier}, ${q.service}, ${q.amount})`;
              return json({ rates: quotes });
            }
            case "label": {
              const mineShipped = role === "buyer" ? o.buyer_tracking : o.seller_tracking, myDep = role === "buyer" ? o.buyer_deposit : o.seller_deposit;
              if (o.status !== "accepted" || mineShipped || myDep !== "held" || typeof b.rateId !== "string") return denied();
              const [q] = await db.sql`SELECT rate_id, carrier, amount FROM label_quotes WHERE message_id = ${mid} AND user_id = ${me.id} AND rate_id = ${b.rateId}`;
              if (!q) return bad("Pick a courier service from the list.", 409);
              const label = await buyLabel(q.rate_id, mid);
              rows = role === "buyer"
                ? await db.sql`UPDATE offers SET buyer_tracking = ${label.tracking}, buyer_verified = true, buyer_carrier = ${q.carrier}, buyer_label_url = ${label.labelUrl}, buyer_label_tx = ${label.id}
                    WHERE message_id = ${mid} AND status = 'accepted' AND buyer_tracking IS NULL AND ship_by > now() RETURNING message_id`
                : await db.sql`UPDATE offers SET seller_tracking = ${label.tracking}, seller_verified = true, seller_carrier = ${q.carrier}, seller_label_url = ${label.labelUrl}, seller_label_tx = ${label.id}
                    WHERE message_id = ${mid} AND status = 'accepted' AND seller_tracking IS NULL AND ship_by > now() RETURNING message_id`;
              if (!rows.length) { await refundLabel(label.id).catch(() => {}); return denied(); }
              await db.sql`DELETE FROM label_quotes WHERE message_id = ${mid} AND user_id = ${me.id}`;
              return json({ ok: true });
            }
            case "ship": {
              const trk = str(b.trk, 40);
              if (trk.length < 4) return bad("Enter a tracking number.");
              const [dup] = await db.sql`SELECT 1 AS x FROM offers WHERE buyer_tracking = ${trk} OR seller_tracking = ${trk} LIMIT 1`;
              if (dup) return bad("That tracking number has already been used on a trade.", 409);
              rows = role === "buyer"
                ? await db.sql`UPDATE offers SET buyer_tracking = ${trk} WHERE message_id = ${mid} AND status = 'accepted' AND buyer_tracking IS NULL AND buyer_deposit = 'held' AND ship_by > now() RETURNING message_id`
                : await db.sql`UPDATE offers SET seller_tracking = ${trk} WHERE message_id = ${mid} AND status = 'accepted' AND seller_tracking IS NULL AND seller_deposit = 'held' AND ship_by > now() RETURNING message_id`;
              break;
            }
            case "recv":
              rows = role === "buyer"
                ? await db.sql`UPDATE offers SET buyer_received = true, buyer_received_at = now(),
                    status = CASE WHEN seller_received THEN 'completed' ELSE status END,
                    buyer_deposit = CASE WHEN seller_received AND buyer_deposit = 'held' THEN 'released' ELSE buyer_deposit END,
                    seller_deposit = CASE WHEN seller_received AND seller_deposit = 'held' THEN 'released' ELSE seller_deposit END
                    WHERE message_id = ${mid} AND status = 'accepted' AND seller_tracking IS NOT NULL AND NOT buyer_received RETURNING message_id`
                : await db.sql`UPDATE offers SET seller_received = true, seller_received_at = now(),
                    status = CASE WHEN buyer_received THEN 'completed' ELSE status END,
                    buyer_deposit = CASE WHEN buyer_received AND buyer_deposit = 'held' THEN 'released' ELSE buyer_deposit END,
                    seller_deposit = CASE WHEN buyer_received AND seller_deposit = 'held' THEN 'released' ELSE seller_deposit END
                    WHERE message_id = ${mid} AND status = 'accepted' AND buyer_tracking IS NOT NULL AND NOT seller_received RETURNING message_id`;
              break;
            case "dispute":
              rows = await db.sql`UPDATE offers SET status = 'disputed' WHERE message_id = ${mid} AND status = 'accepted' RETURNING message_id`;
              break;
            case "rate": {
              const stars = Math.round(Number(b.stars));
              if (!(stars >= 1 && stars <= 5)) return bad("Choose 1 to 5 stars.");
              if (o.status !== "completed") return denied();
              const ratee = role === "buyer" ? t.seller_id : t.buyer_id;
              const client = await db.pool.connect();
              try {
                await client.query("BEGIN");
                const ins = await client.query(
                  "INSERT INTO offer_ratings (message_id, rater_id, ratee_id, stars) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING message_id",
                  [mid, me.id, ratee, stars]);
                if (ins.rowCount) await client.query("UPDATE profiles SET rating_sum = rating_sum + $1, rating_count = rating_count + 1 WHERE id = $2", [stars, ratee]);
                await client.query("COMMIT");
                rows = ins.rows;
              } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
              break;
            }
            default: return bad("Unknown action.");
          }
          return rows.length ? json({ ok: true }) : denied();
        }
      }
    }

    // ---------- want lists ----------
    if (p[0] === "wants") {
      const me = must();
      if (!p[1] && m === "GET") {
        if (!game) return bad("Choose a game.");
        const list = await db.sql`SELECT id, card FROM wants WHERE user_id = ${me.id} AND game = ${game} ORDER BY created_at DESC`;
        const matches = await db.sql`SELECT ${db.sql.raw(LISTING_COLS)}, w.card AS want
          FROM wants w JOIN listings l ON l.game = w.game AND NOT l.sold AND l.seller_id <> w.user_id AND position(lower(w.card) in lower(l.title)) > 0
          JOIN profiles s ON s.id = l.seller_id WHERE w.user_id = ${me.id} AND w.game = ${game} ORDER BY l.created_at DESC LIMIT 50`;
        const interest = await db.sql`SELECT w.card, p.name AS wanter, l.title
          FROM wants w JOIN profiles p ON p.id = w.user_id
          JOIN listings l ON l.seller_id = ${me.id} AND NOT l.sold AND l.game = w.game AND position(lower(w.card) in lower(l.title)) > 0
          WHERE w.game = ${game} AND w.user_id <> ${me.id} LIMIT 50`;
        return json({ list, matches: matches.map((r: any) => ({ ...listingOut(r), want: r.want })), interest });
      }
      if (!p[1] && m === "POST") {
        const b = await body();
        const card = str(b.card, 80);
        if (!GAMES.includes(b.game)) return bad("Choose a game.");
        if (card.length < 2) return bad("Enter a card or product name.");
        const [c] = await db.sql`SELECT count(*)::int AS n FROM wants WHERE user_id = ${me.id}`;
        if (c.n >= 50) return bad("Your want list is full (50 cards).");
        await db.sql`INSERT INTO wants (user_id, game, card) VALUES (${me.id}, ${b.game}, ${card})`;
        return json({ ok: true }, 201);
      }
      if (isId(p[1]) && m === "DELETE") {
        await db.sql`DELETE FROM wants WHERE id = ${p[1]} AND user_id = ${me.id}`;
        return json({ ok: true });
      }
    }

    // ---------- community boards ----------
    if (p[0] === "board") {
      if (!p[1] && m === "GET") {
        if (!game) return bad("Choose a game.");
        const posts = await db.sql`SELECT po.id, po.title, po.body, po.created_at, po.author_id, a.name AS author_name
          FROM posts po JOIN profiles a ON a.id = po.author_id WHERE po.game = ${game} ORDER BY po.created_at DESC LIMIT 50`;
        const ids = posts.map((x: any) => x.id);
        const reps = ids.length ? await db.sql`SELECT r.id, r.post_id, r.body, r.created_at, r.author_id, a.name AS author_name
          FROM replies r JOIN profiles a ON a.id = r.author_id WHERE r.post_id = ANY(${ids}::uuid[]) ORDER BY r.created_at` : [];
        return json({ posts: posts.map((x: any) => ({
          id: x.id, title: x.title, text: x.body, at: x.created_at, author: { id: x.author_id, name: x.author_name },
          replies: reps.filter((r: any) => r.post_id === x.id).map((r: any) => ({ id: r.id, text: r.body, at: r.created_at, author: { id: r.author_id, name: r.author_name } })),
        })) });
      }
      if (!p[1] && m === "POST") {
        const me = must();
        const b = await body();
        const title = str(b.title, 90), text = str(b.text, 600);
        if (!GAMES.includes(b.game)) return bad("Choose a game.");
        if (!title || !text) return bad("Add a title and some text.");
        await db.sql`INSERT INTO posts (author_id, game, title, body) VALUES (${me.id}, ${b.game}, ${title}, ${text})`;
        return json({ ok: true }, 201);
      }
      if (isId(p[1]) && p[2] === "replies" && m === "POST") {
        const me = must();
        const text = str((await body()).text, 300);
        if (!text) return bad("Type a reply.");
        const rows = await db.sql`INSERT INTO replies (post_id, author_id, body) SELECT id, ${me.id}::text, ${text}::text FROM posts WHERE id = ${p[1]} RETURNING id`;
        return rows.length ? json({ ok: true }, 201) : bad("Post not found.", 404);
      }
      if (isId(p[1]) && !p[2] && m === "DELETE") {
        const me = must();
        await db.sql`DELETE FROM posts WHERE id = ${p[1]} AND author_id = ${me.id}`;
        return json({ ok: true });
      }
    }

    return bad("Not found", 404);
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof ShippoError) return bad(e.message, e.status);
    console.error("api error", e);
    return bad("Something went wrong on our side.", 500);
  }
};

async function auth(req: Request, action?: string) {
  try {
    verifyRequestOrigin(req);
  } catch {
    return bad("Bad request origin.", 403);
  }
  if (req.method !== "POST") return bad("POST only.", 405);
  if (action === "logout") {
    await logout();
    return json({ ok: true });
  }
  const b: any = await req.json().catch(() => ({}));
  const email = str(b.email, 200).toLowerCase();
  const password = typeof b.password === "string" ? b.password : "";
  if (!EMAIL.test(email) || password.length < 8 || password.length > 200) return bad("Enter a valid email and a password of at least 8 characters.");
  try {
    if (action === "signup") {
      await signup(email, password);
      return json({ ok: true, message: "Account created. If email confirmation is on, check your inbox, then sign in." });
    }
    if (action === "login") {
      await login(email, password);
      return json({ ok: true });
    }
  } catch (e: any) {
    return bad(e?.message || "Authentication failed.", 401);
  }
  return bad("Not found", 404);
}

async function photoGet(id?: string) {
  if (!isId(id)) return bad("Not found", 404);
  const entry = await getStore("photos").getWithMetadata(id, { type: "arrayBuffer" });
  if (!entry) return bad("Not found", 404);
  return new Response(entry.data, {
    headers: { "content-type": String(entry.metadata.type || "image/jpeg"), "cache-control": "public, max-age=31536000, immutable" },
  });
}

async function addMessage(db: ReturnType<typeof getDatabase>, threadId: string, senderId: string, kind: "text" | "offer", text: string, offer: any) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("INSERT INTO messages (thread_id, sender_id, kind, body) VALUES ($1,$2,$3,$4) RETURNING id", [threadId, senderId, kind, text]);
    if (offer) {
      await client.query(
        "INSERT INTO offers (message_id, card, photos, buyer_ship, seller_ship, their_title, buyer_value, seller_value, deposit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [rows[0].id, offer.card, offer.photos, offer.ship, offer.theirShip, offer.theirTitle, offer.buyerValue, offer.sellerValue, offer.deposit]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function shippoWebhook(req: Request, url: URL) {
  const expected = Netlify.env.get("SHIPPO_WEBHOOK_TOKEN") || "";
  const given = url.searchParams.get("token") || "";
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= (given.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  if (!expected || diff !== 0) return bad("Forbidden", 403);
  const evt: any = await req.json().catch(() => ({}));
  if (evt?.event !== "track_updated") return json({ ok: true });
  const num = typeof evt.data?.tracking_number === "string" ? evt.data.tracking_number : "";
  const status = String(evt.data?.tracking_status?.status || "").toUpperCase().slice(0, 20);
  if (!num || !status) return json({ ok: true });
  const db = getDatabase();
  // Only labels bought through the site are carrier-verified; manual tracking numbers are never updated here.
  await db.sql`UPDATE offers SET buyer_track_status = ${status},
      buyer_delivered_at = CASE WHEN ${status} = 'DELIVERED' AND buyer_delivered_at IS NULL THEN now() ELSE buyer_delivered_at END
    WHERE buyer_tracking = ${num} AND buyer_verified`;
  await db.sql`UPDATE offers SET seller_track_status = ${status},
      seller_delivered_at = CASE WHEN ${status} = 'DELIVERED' AND seller_delivered_at IS NULL THEN now() ELSE seller_delivered_at END
    WHERE seller_tracking = ${num} AND seller_verified`;
  return json({ ok: true });
}
