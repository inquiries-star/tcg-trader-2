// Integration tests: the real API handler, sweep rules and gate, running real SQL on a throwaway Postgres.
// Faked: identity (who is signed in), blob storage, and Shippo's HTTP API. Run with tests/run.sh.
import { randomUUID } from "node:crypto";

const env = { SHIPPO_API_KEY: "shippo_test_abc", SHIPPO_WEBHOOK_TOKEN: "tok123", SITE_PASSWORD: "letmein" };
globalThis.Netlify = { env: { get: (k) => env[k] } };

const fetchLog = [];
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  fetchLog.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : null });
  const ok = (d) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
  if (path === "/shipments") return ok({ rates: [
    { object_id: "r-ups", provider: "UPS", servicelevel: { name: "Ground" }, amount: "9.10", estimated_days: 4 },
    { object_id: "r-usps", provider: "USPS", servicelevel: { name: "Ground Advantage" }, amount: "4.50", estimated_days: 3 }] });
  if (path === "/transactions") return ok({ object_id: "tx-" + fetchLog.length, status: "SUCCESS", tracking_number: "SHP" + randomUUID().slice(0, 8).toUpperCase(), label_url: "https://labels.test/l.pdf" });
  if (path === "/refunds") return ok({});
  return new Response("{}", { status: 404 });
};

const { default: api } = await import("../netlify/functions/api.mts");
const { default: gate, config: gateConfig } = await import("../netlify/edge-functions/gate.mts");
const { sweep, SHIP_DAYS, AUTO_CONFIRM_HOURS } = await import("../netlify/lib/sweep.mts");
const { getDatabase, endAll } = await import("@netlify/database");
const { ctl } = await import("@netlify/identity");
const { seedBlob } = await import("@netlify/blobs");
const db = getDatabase();

let fails = 0, total = 0;
const ok = (name, cond, detail = "") => { total++; if (!cond) fails++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + detail)); };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (t) => console.log("\n== " + t);

const A = "u-ash", B = "u-bo", C = "u-cy"; // A makes offers (buyer), B owns listings (seller), C is a stranger
const call = async (user, method, path, body, headers = {}) => {
  ctl.user = user ? { id: user } : null;
  const h = { "x-requested-with": "tt", "content-type": "application/json", ...headers };
  for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
  const r = await api(new Request("https://x.test" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), {});
  return { s: r.status, j: await r.json().catch(() => null) };
};
const photos = (owner, n = 3) => Array.from({ length: n }, () => { const id = randomUUID(); seedBlob(id, owner); return id; });
let seq = 0;
const newListing = async (o = {}) => {
  const r = await call(B, "POST", "/api/listings", { game: "Pokémon", title: "Charizard ex #" + ++seq, condition: "Near Mint", type: "trade", shipping: 3, value: 100, photos: photos(B), ...o });
  if (r.s !== 201) throw new Error("listing failed " + JSON.stringify(r));
  return r.j.id;
};
const offerRow = async (mid) => (await db.sql`SELECT * FROM offers WHERE message_id = ${mid}`)[0];
const newOffer = async (lid, o = {}) => {
  const r = await call(A, "POST", "/api/threads", { listingId: lid, offer: { card: "Blastoise", ship: 2, value: 40, photos: photos(A, 2), ...o } });
  if (r.s !== 201) throw new Error("offer failed " + JSON.stringify(r));
  const [m] = await db.sql`SELECT o.message_id FROM offers o JOIN messages m ON m.id = o.message_id WHERE m.thread_id = ${r.j.id} ORDER BY m.created_at DESC LIMIT 1`;
  return { tid: r.j.id, mid: m.message_id };
};
const act = (user, tid, mid, body) => call(user, "POST", `/api/threads/${tid}/offers/${mid}`, body);
const accepted = async (lo = {}, oo = {}) => {
  const lid = await newListing(lo), { tid, mid } = await newOffer(lid, oo);
  const r = await act(B, tid, mid, { action: "accept" });
  if (r.s !== 200) throw new Error("accept failed " + JSON.stringify(r));
  return { lid, tid, mid };
};
const bothHeld = async (tid, mid) => { await act(A, tid, mid, { action: "deposit" }); await act(B, tid, mid, { action: "deposit" }); };

// ------------------------------------------------------------------ setup
section("accounts and profiles");
let r = await call(null, "GET", "/api/me"); ok("signed-out /me", r.s === 200 && r.j.signedIn === false);
r = await call(A, "POST", "/api/profile", { name: "A" }); eq("one-letter display name rejected", r.s, 400);
for (const [u, n] of [[A, "Ash"], [B, "Bo"], [C, "Cy"]]) { r = await call(u, "POST", "/api/profile", { name: n }); eq("profile created: " + n, r.s, 200); }
r = await call(A, "GET", "/api/me"); eq("/me returns the profile", r.j.user, { id: A, name: "Ash" });
r = await call(B, "POST", "/api/profile", { name: "Bo2" }); r = await call(B, "POST", "/api/profile", { name: "Bo" }); eq("profile can be renamed", r.s, 200);
r = await call(A, "POST", "/api/listings", {}, { "x-requested-with": null }); eq("missing CSRF header rejected", r.s, 403);
r = await call(null, "POST", "/api/listings", {}); eq("listing requires sign-in", r.s, 401);
r = await call("u-nobody", "POST", "/api/listings", {}); eq("listing requires a display name", r.s, 403);
r = await call(A, "GET", "/api/nope"); eq("unknown route 404", r.s, 404);
r = await call(A, "GET", "/api/listings?game=Chess"); eq("unknown game rejected", r.s, 400);

// ------------------------------------------------------------------ listings
section("listings");
const base = { game: "Pokémon", title: "Umbreon VMAX", condition: "Near Mint", shipping: 2, photos: photos(B) };
for (const [name, patch] of [["bad game", { game: "Chess" }], ["short title", { title: "x" }], ["bad condition", { condition: "Mint-ish" }],
  ["sale needs a price", { type: "sale", price: 0 }], ["negative shipping", { type: "sale", price: 5, shipping: -1 }],
  ["only two photos", { type: "sale", price: 5, photos: photos(B, 2) }], ["non-uuid photos", { type: "sale", price: 5, photos: ["a", "b", "c"] }],
  ["photos owned by someone else", { type: "sale", price: 5, photos: photos(C) }], ["trade needs an estimated value", { type: "trade" }],
  ["bad listing type", { type: "auction", price: 5 }]]) {
  r = await call(B, "POST", "/api/listings", { ...base, ...patch }); eq("rejected: " + name, r.s, 400);
}
r = await call(B, "POST", "/api/listings", { ...base, type: "sale", price: 12.345 }); eq("sale listing created", r.s, 201);
let [l] = await db.sql`SELECT price, value, type FROM listings WHERE id = ${r.j.id}`; eq("price rounded to cents, value = price for sales", [l.price, l.value], [12.35, 12.35]);
const saleLid = r.j.id;
r = await call(B, "POST", "/api/listings", { ...base, photos: photos(B), type: "both", price: 80 }); [l] = await db.sql`SELECT value FROM listings WHERE id = ${r.j.id}`;
eq("sale-or-trade without a value uses the price as its value", l.value, 80);
r = await call(B, "POST", "/api/listings", { ...base, photos: photos(B), type: "trade", value: 55 }); [l] = await db.sql`SELECT price, value FROM listings WHERE id = ${r.j.id}`;
eq("trade-only listing stores value, price 0", [l.price, l.value], [0, 55]);
// sealed products
const sealedBase = { game: "Pokémon", kind: "sealed", productType: "Booster box", title: "Prismatic Evolutions Booster Bundle", condition: "Factory sealed", shipping: 8, type: "sale", price: 120, photos: photos(B) };
for (const [name, patch] of [["sealed needs a product type", { productType: "Pile of cards" }], ["sealed rejects a card condition", { condition: "Near Mint" }],
  ["card rejects a sealed condition", { kind: "card", condition: "Factory sealed" }], ["unknown kind", { kind: "mystery" }], ["sealed short name", { title: "x" }]]) {
  r = await call(B, "POST", "/api/listings", { ...sealedBase, ...patch }); eq("rejected: " + name, r.s, 400);
}
r = await call(B, "POST", "/api/listings", sealedBase); eq("sealed listing created", r.s, 201);
[l] = await db.sql`SELECT kind, product_type, condition FROM listings WHERE id = ${r.j.id}`; eq("sealed kind and product type stored", [l.kind, l.product_type, l.condition], ["sealed", "Booster box", "Factory sealed"]);
const sealedId = r.j.id;
r = await call(B, "POST", "/api/listings", { ...sealedBase, type: "both", photos: photos(B) }); eq("sealed can be sale-or-trade", r.s, 201);
r = await call(B, "POST", "/api/listings", { ...sealedBase, kind: undefined, productType: undefined, condition: "Near Mint", photos: photos(B) }); eq("kind defaults to card", r.s, 201);
[l] = await db.sql`SELECT kind, product_type FROM listings WHERE id = ${r.j.id}`; eq("default card has no product type", [l.kind, l.product_type], ["card", ""]);
r = await call(null, "GET", "/api/listings?game=" + encodeURIComponent("Pokémon")); const sOut = r.j.items.find((x) => x.id === sealedId);
eq("browse returns kind and productType", [sOut && sOut.kind, sOut && sOut.productType], ["sealed", "Booster box"]);
r = await call(null, "GET", "/api/listings?game=" + encodeURIComponent("Pokémon")); ok("anyone can browse listings", r.s === 200 && r.j.items.length >= 3 && r.j.items[0].seller.name === "Bo");
r = await call(null, "GET", "/api/listings?game=" + encodeURIComponent("Magic: The Gathering")); eq("communities don't overlap: other game is empty", r.j.items.length, 0);
r = await call(B, "GET", "/api/listings?mine=1"); ok("my listings", r.s === 200 && r.j.items.length >= 3);
r = await call(null, "GET", "/api/listings?mine=1"); eq("my listings needs sign-in", r.s, 401);
r = await call(C, "DELETE", "/api/listings/" + saleLid, {}); eq("stranger can't delete my listing", r.s, 404);
r = await call(C, "PATCH", "/api/listings/" + saleLid, { sold: true }); eq("stranger can't mark it sold", r.s, 404);
r = await call(B, "PATCH", "/api/listings/" + saleLid, { sold: true }); eq("owner marks sold", r.s, 200);
r = await call(null, "GET", "/api/listings?game=" + encodeURIComponent("Pokémon")); ok("sold listings leave the marketplace", !r.j.items.some((i) => i.id === saleLid));
r = await call(B, "DELETE", "/api/listings/" + saleLid, {}); eq("owner deletes listing", r.s, 200);
r = await call(null, "GET", "/api/stats"); ok("stats per game", r.s === 200 && r.j.games["Pokémon"].listings >= 2 && r.j.games["Pokémon"].sellers === 1 && r.j.games["Yu-Gi-Oh!"].listings === 0);

// ------------------------------------------------------------------ deposit amount
section("deposit amount (25% of the higher value, $5 min, $500 cap)");
for (const [name, sellerValue, offerValue, want] of [["$100 vs $40 -> $25", 100, 40, 25], ["uses the higher side: $40 vs $400 -> $100", 40, 400, 100],
  ["minimum $5", 10, 8, 5], ["cap $500", 5000, 40, 500], ["rounds to cents: $33.33 -> 8.33", 33.33, 10, 8.33]]) {
  const lid = await newListing({ value: sellerValue }), { mid } = await newOffer(lid, { value: offerValue }); const o = await offerRow(mid);
  eq(name, [o.deposit, o.buyer_value, o.seller_value, o.status, o.buyer_deposit, o.seller_deposit], [want, offerValue, sellerValue, "pending", "due", "due"]);
}
{
  const lid = await newListing({ value: 100 });
  r = await call(A, "POST", "/api/threads", { listingId: lid, offer: { card: "Blastoise", ship: 2, photos: photos(A, 2) } }); eq("offer without a value rejected", r.s, 400);
  r = await call(A, "POST", "/api/threads", { listingId: lid, offer: { card: "Blastoise", ship: 2, value: 0, photos: photos(A, 2) } }); eq("offer with value 0 rejected", r.s, 400);
  r = await call(A, "POST", "/api/threads", { listingId: lid, offer: { card: "B", ship: 2, value: 5, photos: photos(A, 2) } }); eq("one-letter card name rejected", r.s, 400);
  r = await call(A, "POST", "/api/threads", { listingId: lid, offer: { card: "Blastoise", ship: -1, value: 5, photos: photos(A, 2) } }); eq("negative offer shipping rejected", r.s, 400);
  r = await call(A, "POST", "/api/threads", { listingId: lid, offer: { card: "Blastoise", ship: 2, value: 5, photos: photos(A, 1) } }); eq("offer needs front and back photos", r.s, 400);
  r = await call(A, "POST", "/api/threads", { listingId: lid, offer: { card: "Blastoise", ship: 2, value: 5, photos: photos(C, 2) } }); eq("offer photos must be mine", r.s, 400);
  r = await call(B, "POST", "/api/threads", { listingId: lid, text: "hi" }); eq("can't message my own listing", r.s, 400);
  r = await call(A, "POST", "/api/threads", { listingId: lid }); eq("empty message rejected", r.s, 400);
  r = await call(A, "POST", "/api/threads", { listingId: randomUUID(), text: "hi" }); eq("unknown listing 404", r.s, 404);
  r = await call(A, "POST", "/api/threads", { listingId: saleLid, text: "hi" }); eq("deleted listing 404", r.s, 404);
  const sale = await call(B, "POST", "/api/listings", { ...base, photos: photos(B), type: "sale", price: 9 });
  r = await call(A, "POST", "/api/threads", { listingId: sale.j.id, offer: { card: "Blastoise", ship: 2, value: 5, photos: photos(A, 2) } }); eq("trade offer on a sale-only listing rejected", r.s, 400);
  r = await call(A, "POST", "/api/threads", { listingId: sale.j.id, text: "Is this available?" }); eq("plain message on a sale listing works", r.s, 201);
  // offering one of my own listings uses its photos and value
  const mineL = await call(A, "POST", "/api/listings", { ...base, photos: photos(A), type: "both", price: 60, value: 60 });
  r = await call(A, "POST", "/api/threads", { listingId: lid, offer: { card: "Venusaur", ship: 3, ownListingId: mineL.j.id } });
  const [m] = await db.sql`SELECT o.* FROM offers o JOIN messages m ON m.id = o.message_id WHERE m.thread_id = ${r.j.id} AND o.card = 'Venusaur'`;
  eq("offering my own listing uses its value for the deposit", [r.s, m.buyer_value, m.deposit, m.photos.length], [201, 60, 25, 3]);
  r = await call(A, "POST", "/api/threads", { listingId: lid, offer: { card: "Venusaur", ship: 3, ownListingId: await newListing() } }); eq("can't offer someone else's listing as mine", r.s, 400);
}

// ------------------------------------------------------------------ full happy path
section("full trade: accept -> deposits -> ship -> receive -> release -> rate");
let { lid, tid, mid } = await accepted();
let o = await offerRow(mid);
const days = (new Date(o.ship_by) - Date.now()) / 864e5;
ok("accepting sets the ship-by date 5 days out", o.status === "accepted" && Math.abs(days - 5) < 0.01, String(days));
r = await act(B, tid, mid, { action: "accept" }); eq("accepting twice -> 409", r.s, 409);
r = await act(A, tid, mid, { action: "withdraw" }); eq("can't withdraw an accepted offer", r.s, 409);
r = await act(A, tid, mid, { action: "ship", trk: "TRACKA001" }); eq("can't ship before paying the deposit", r.s, 409);
r = await act(A, tid, mid, { action: "recv" }); eq("can't confirm receipt before the other ships", r.s, 409);
r = await act(A, tid, mid, { action: "deposit" }); eq("buyer pays deposit", r.s, 200);
r = await act(A, tid, mid, { action: "deposit" }); eq("paying the deposit twice -> 409", r.s, 409);
o = await offerRow(mid); eq("only the buyer's deposit is held", [o.buyer_deposit, o.seller_deposit], ["held", "due"]);
r = await act(A, tid, mid, { action: "ship", trk: "12" }); eq("short tracking number rejected", r.s, 400);
r = await act(A, tid, mid, { action: "ship", trk: "TRACKA001" }); eq("buyer ships", r.s, 200);
r = await act(B, tid, mid, { action: "ship", trk: "TRACKA001" }); eq("seller can't reuse the buyer's tracking number", r.s, 409);
r = await act(B, tid, mid, { action: "ship", trk: "TRACKB001" }); eq("seller can't ship before paying their deposit", r.s, 409);
r = await act(B, tid, mid, { action: "deposit" }); r = await act(B, tid, mid, { action: "ship", trk: "TRACKB001" }); eq("seller pays and ships", r.s, 200);
r = await act(A, tid, mid, { action: "ship", trk: "TRACKA002" }); eq("can't ship twice", r.s, 409);
r = await act(A, tid, mid, { action: "recv" }); eq("buyer confirms receipt", r.s, 200);
o = await offerRow(mid); eq("one confirmation: still accepted, deposits still held", [o.status, o.buyer_deposit, o.seller_deposit, o.buyer_received, o.seller_received], ["accepted", "held", "held", true, false]);
r = await act(A, tid, mid, { action: "rate", stars: 5 }); eq("can't rate before completion", r.s, 409);
r = await act(A, tid, mid, { action: "recv" }); eq("confirming twice -> 409", r.s, 409);
r = await act(B, tid, mid, { action: "recv" }); eq("seller confirms receipt", r.s, 200);
o = await offerRow(mid); eq("both confirmed: completed, both deposits released", [o.status, o.buyer_deposit, o.seller_deposit], ["completed", "released", "released"]);
r = await act(B, tid, mid, { action: "dispute" }); eq("can't dispute a completed trade", r.s, 409);
r = await act(A, tid, mid, { action: "rate", stars: 9 }); eq("rating out of range rejected", r.s, 400);
r = await act(A, tid, mid, { action: "rate", stars: 5 }); eq("buyer rates seller", r.s, 200);
r = await act(A, tid, mid, { action: "rate", stars: 1 }); eq("rating twice -> 409", r.s, 409);
r = await act(B, tid, mid, { action: "rate", stars: 4 }); eq("seller rates buyer", r.s, 200);
let [pb] = await db.sql`SELECT rating_sum, rating_count FROM profiles WHERE id = ${B}`; eq("seller's rating counted once", [pb.rating_sum, pb.rating_count], [5, 1]);
let [pa] = await db.sql`SELECT rating_sum, rating_count FROM profiles WHERE id = ${A}`; eq("buyer's rating counted", [pa.rating_sum, pa.rating_count], [4, 1]);
r = await call(A, "GET", `/api/threads/${tid}`);
const off = r.j.messages.find((x) => x.kind === "offer").offer;
ok("thread view shows trade state and ratings", r.s === 200 && off.status === "completed" && off.buyerDeposit === "released" && off.deposit === 25 && r.j.thread.seller.rating === 5 && off.ratings.length === 2, JSON.stringify(off));

// ------------------------------------------------------------------ roles and access
section("roles and access control");
({ lid, tid, mid } = await newOffer(await newListing()).then(async (x) => ({ ...x })));
r = await act(A, tid, mid, { action: "accept" }); eq("buyer can't accept their own offer", r.s, 403);
r = await act(A, tid, mid, { action: "decline" }); eq("buyer can't decline", r.s, 403);
r = await act(B, tid, mid, { action: "withdraw" }); eq("seller can't withdraw the buyer's offer", r.s, 403);
r = await act(C, tid, mid, { action: "accept" }); eq("stranger can't act on a trade (404)", r.s, 404);
r = await call(C, "GET", `/api/threads/${tid}`); eq("stranger can't read the conversation", r.s, 404);
r = await call(C, "POST", `/api/threads/${tid}/messages`, { text: "hi" }); eq("stranger can't post into it", r.s, 404);
r = await act(B, tid, mid, { action: "nuke" }); eq("unknown action rejected", r.s, 400);
r = await act(B, tid, mid, { action: "deposit" }); eq("no deposit on a pending offer", r.s, 409);
r = await act(B, tid, mid, { action: "dispute" }); eq("can't dispute a pending offer", r.s, 409);
r = await act(B, tid, randomUUID(), { action: "accept" }); eq("unknown offer 404", r.s, 404);
r = await act(A, tid, mid, { action: "withdraw" }); eq("buyer withdraws a pending offer", r.s, 200);
r = await act(B, tid, mid, { action: "accept" }); eq("can't accept a withdrawn offer", r.s, 409);
{ const x = await newOffer(await newListing()); r = await act(B, x.tid, x.mid, { action: "decline" }); o = await offerRow(x.mid);
  eq("seller declines: status declined, no deadline", [r.s, o.status, o.ship_by], [200, "declined", null]);
  r = await act(A, x.tid, x.mid, { action: "withdraw" }); eq("can't withdraw a declined offer", r.s, 409); }

// ------------------------------------------------------------------ deadlines
section("deadline enforcement");
{
  const x = await accepted(); await db.sql`UPDATE offers SET ship_by = now() - interval '1 hour' WHERE message_id = ${x.mid}`;
  r = await act(A, x.tid, x.mid, { action: "deposit" }); eq("can't pay a deposit after the ship-by date", r.s, 409);
  const y = await accepted(); await bothHeld(y.tid, y.mid); await db.sql`UPDATE offers SET ship_by = now() - interval '1 hour' WHERE message_id = ${y.mid}`;
  r = await act(A, y.tid, y.mid, { action: "ship", trk: "LATE00001" }); eq("can't ship after the ship-by date", r.s, 409);
}

// ------------------------------------------------------------------ disputes
section("disputes");
{
  const x = await accepted(); await bothHeld(x.tid, x.mid);
  r = await act(A, x.tid, x.mid, { action: "dispute" }); o = await offerRow(x.mid); eq("buyer reports a problem", [r.s, o.status, o.buyer_deposit, o.seller_deposit], [200, "disputed", "held", "held"]);
  await db.sql`UPDATE offers SET ship_by = now() - interval '9 days', buyer_tracking = 'DISP0001', buyer_received = true, buyer_received_at = now() - interval '200 hours' WHERE message_id = ${x.mid}`;
  await call(A, "GET", `/api/threads/${x.tid}`); await sweep(db, null); o = await offerRow(x.mid);
  eq("disputed trades are never touched by the sweep (deposits stay held)", [o.status, o.buyer_deposit, o.seller_deposit, o.seller_received], ["disputed", "held", "held", false]);
  r = await act(B, x.tid, x.mid, { action: "recv" }); eq("can't confirm receipt on a disputed trade", r.s, 409);
}

// ------------------------------------------------------------------ sweep rules (real SQL)
section("sweep: ship-by deadline");
const scenario = async ({ bDep = "held", sDep = "held", bTrk = null, sTrk = null, shipByHours = -1, more = null }) => {
  const x = await accepted();
  await db.sql`UPDATE offers SET buyer_deposit = ${bDep}, seller_deposit = ${sDep}, buyer_tracking = ${bTrk}, seller_tracking = ${sTrk},
    ship_by = now() + make_interval(hours => ${shipByHours}::int) WHERE message_id = ${x.mid}`;
  if (more) await more(x.mid);
  return x;
};
const states = (o) => [o.status, o.buyer_deposit, o.seller_deposit];
{
  let x = await scenario({}); await call(A, "GET", `/api/threads/${x.tid}`); eq("nobody shipped by the deadline: cancelled, both deposits returned", states(await offerRow(x.mid)), ["cancelled", "released", "released"]);
  x = await scenario({ bTrk: "BUYER0001" }); await call(B, "GET", `/api/threads/${x.tid}`); eq("only the buyer shipped: seller forfeits, buyer's returned", states(await offerRow(x.mid)), ["cancelled", "released", "forfeited"]);
  await sweep(db, null); eq("running the sweep again doesn't change a forfeit", states(await offerRow(x.mid)), ["cancelled", "released", "forfeited"]);
  x = await scenario({ sTrk: "SELLR0001" }); await call(A, "GET", `/api/threads/${x.tid}`); eq("only the seller shipped: buyer forfeits, seller's returned", states(await offerRow(x.mid)), ["cancelled", "forfeited", "released"]);
  x = await scenario({ sDep: "due", bTrk: "BUYER0002" }); await call(A, "GET", `/api/threads/${x.tid}`); eq("a deposit that was never paid can't be forfeited", states(await offerRow(x.mid)), ["cancelled", "released", "due"]);
  x = await scenario({ bTrk: "BUYER0003", sTrk: "SELLR0003" }); await call(A, "GET", `/api/threads/${x.tid}`); eq("both shipped late-ish: not cancelled", states(await offerRow(x.mid)), ["accepted", "held", "held"]);
  x = await scenario({ shipByHours: 24 }); await call(A, "GET", `/api/threads/${x.tid}`); eq("before the deadline: untouched", states(await offerRow(x.mid)), ["accepted", "held", "held"]);
  x = await scenario({ bDep: "due", sDep: "due" }); await sweep(db, x.tid); eq("sweep(threadId) works directly; nothing held means nothing to move", states(await offerRow(x.mid)), ["cancelled", "due", "due"]);
}
section("sweep: 72-hour receipt assumption");
eq("the published rules: 5 days to ship, 72 hours to assume receipt", [SHIP_DAYS, AUTO_CONFIRM_HOURS], [5, 72]);
{
  const recv = (side, hours) => (mid) => db.sql`UPDATE offers SET ${db.sql.raw(side + "_received")} = true, ${db.sql.raw(side + "_received_at")} = now() - make_interval(hours => ${hours}::int) WHERE message_id = ${mid}`;
  let x = await scenario({ bTrk: "BUYER0010", sTrk: "SELLR0010", shipByHours: 24, more: recv("buyer", 80) });
  await call(A, "GET", `/api/threads/${x.tid}`); o = await offerRow(x.mid);
  eq("buyer confirmed 80h ago, seller never did: completes, deposits released", [...states(o), o.seller_received], ["completed", "released", "released", true]);
  x = await scenario({ bTrk: "BUYER0011", sTrk: "SELLR0011", shipByHours: 24, more: recv("seller", 80) });
  await call(A, "GET", `/api/threads/${x.tid}`); o = await offerRow(x.mid);
  eq("mirror case: seller confirmed 80h ago", [...states(o), o.buyer_received], ["completed", "released", "released", true]);
  x = await scenario({ bTrk: "BUYER0012", sTrk: "SELLR0012", shipByHours: 24, more: recv("buyer", 60) });
  await call(A, "GET", `/api/threads/${x.tid}`); eq("only 60h passed: not yet assumed", states(await offerRow(x.mid)), ["accepted", "held", "held"]);
  x = await scenario({ bTrk: null, sTrk: "SELLR0013", shipByHours: 24, more: recv("buyer", 80) });
  await call(A, "GET", `/api/threads/${x.tid}`); o = await offerRow(x.mid);
  eq("receipt isn't assumed for a package that was never shipped", [o.status, o.seller_received], ["accepted", false]);
}
section("sweep: carrier-verified delivery");
{
  let x = await scenario({ bTrk: "VERIF0001", sTrk: "SELLR0020", shipByHours: 24, more: (mid) => db.sql`UPDATE offers SET buyer_verified = true, buyer_delivered_at = now() - interval '80 hours' WHERE message_id = ${mid}` });
  await call(A, "GET", `/api/threads/${x.tid}`); o = await offerRow(x.mid);
  eq("buyer's package delivered 80h ago: seller's receipt assumed, trade still open until buyer confirms", [o.status, o.seller_received, o.buyer_received, o.buyer_deposit], ["accepted", true, false, "held"]);
  await act(A, x.tid, x.mid, { action: "recv" }); o = await offerRow(x.mid);
  eq("then the buyer confirms: completed and released", states(o), ["completed", "released", "released"]);
  x = await scenario({ bTrk: "BUYER0021", sTrk: "VERIF0002", shipByHours: 24, more: (mid) => db.sql`UPDATE offers SET seller_verified = true, seller_delivered_at = now() - interval '80 hours', seller_received = true, seller_received_at = now() WHERE message_id = ${mid}` });
  await call(A, "GET", `/api/threads/${x.tid}`); o = await offerRow(x.mid);
  eq("seller's package delivered 80h ago and seller already confirmed: buyer's receipt assumed, completed", [...states(o), o.buyer_received], ["completed", "released", "released", true]);
  x = await scenario({ bTrk: "VERIF0003", sTrk: "SELLR0022", shipByHours: 24, more: (mid) => db.sql`UPDATE offers SET buyer_verified = true, buyer_delivered_at = now() - interval '10 hours' WHERE message_id = ${mid}` });
  await call(A, "GET", `/api/threads/${x.tid}`); o = await offerRow(x.mid); eq("verified delivery only 10h ago: not yet assumed", [o.status, o.seller_received], ["accepted", false]);
  x = await scenario({ bTrk: "MANUAL0001", sTrk: "SELLR0023", shipByHours: 24, more: (mid) => db.sql`UPDATE offers SET buyer_delivered_at = now() - interval '80 hours' WHERE message_id = ${mid}` });
  await call(A, "GET", `/api/threads/${x.tid}`); o = await offerRow(x.mid); eq("unverified tracking is never trusted for auto-confirm", [o.status, o.seller_received], ["accepted", false]);
}
section("sweep: scheduled path and address clean-up");
{
  const pair = async () => { const x = await accepted(); await bothHeld(x.tid, x.mid);
    const addr = (n) => ({ name: n, street1: "1 Main St", city: "Calgary", state: "AB", zip: "T2P 1J9", country: "CA" });
    await act(A, x.tid, x.mid, { action: "address", address: addr("Ash") }); await act(B, x.tid, x.mid, { action: "address", address: addr("Bo") }); return x; };
  const doomed = await pair(), live = await pair(), doomed2 = await scenario({});
  await db.sql`UPDATE offers SET ship_by = now() - interval '2 hours' WHERE message_id = ${doomed.mid}`;
  const count = async (mid) => (await db.sql`SELECT count(*)::int AS n FROM trade_addresses WHERE message_id = ${mid}`)[0].n;
  eq("addresses saved while accepted", [await count(doomed.mid), await count(live.mid)], [2, 2]);
  await sweep(db, null); // what the hourly function does
  eq("global sweep cancels every overdue trade", [(await offerRow(doomed.mid)).status, (await offerRow(doomed2.mid)).status, (await offerRow(live.mid)).status], ["cancelled", "cancelled", "accepted"]);
  eq("addresses deleted once a trade ended, kept for open trades", [await count(doomed.mid), await count(live.mid)], [0, 2]);
}

// ------------------------------------------------------------------ concurrency
section("concurrency");
{
  const x = await accepted(); await bothHeld(x.tid, x.mid);
  await db.sql`UPDATE offers SET buyer_tracking = 'CONC0001', seller_tracking = 'CONC0002' WHERE message_id = ${x.mid}`;
  const both = await Promise.all([act(A, x.tid, x.mid, { action: "recv" }), act(B, x.tid, x.mid, { action: "recv" })]);
  o = await offerRow(x.mid);
  eq("both confirm at the same instant: exactly one outcome, completed, deposits released", [both.map((b) => b.s).sort(), ...[states(o)]], [[200, 200], ["completed", "released", "released"]]);
  const y = await accepted(); const dup = await Promise.all([act(A, y.tid, y.mid, { action: "deposit" }), act(A, y.tid, y.mid, { action: "deposit" })]);
  eq("double-clicking 'pay deposit': one success, one 409", dup.map((d) => d.s).sort(), [200, 409]);
  const z = await newOffer(await newListing()); const dec = await Promise.all([act(B, z.tid, z.mid, { action: "accept" }), act(A, z.tid, z.mid, { action: "withdraw" })]);
  o = await offerRow(z.mid); eq("accept and withdraw at the same time: only one wins", [dec.map((d) => d.s).sort(), ["accepted", "withdrawn"].includes(o.status)], [[200, 409], true]);
}

// ------------------------------------------------------------------ messaging
section("messaging");
{
  const x = await newOffer(await newListing());
  r = await call(B, "POST", `/api/threads/${x.tid}/messages`, { text: "Sounds good!" }); eq("seller replies", r.s, 201);
  r = await call(B, "POST", `/api/threads/${x.tid}/messages`, { text: "   " }); eq("blank message rejected", r.s, 400);
  r = await call(A, "GET", "/api/threads?game=" + encodeURIComponent("Pokémon")); const t = r.j.threads.find((t) => t.id === x.tid);
  eq("buyer sees an unread reply", [t.unread, t.last, t.other.name], [true, "Sounds good!", "Bo"]);
  await call(A, "GET", `/api/threads/${x.tid}`); r = await call(A, "GET", "/api/threads"); eq("opening the conversation marks it read", r.j.threads.find((t) => t.id === x.tid).unread, false);
  r = await call(B, "GET", "/api/threads"); eq("sender's own message isn't unread for them", r.j.threads.find((t) => t.id === x.tid).unread, true === false);
  r = await call(A, "GET", "/api/threads?game=" + encodeURIComponent("Magic: The Gathering")); eq("conversations are scoped to their community", r.j.threads.length, 0);
  r = await call(C, "GET", "/api/threads"); eq("stranger sees no conversations", r.j.threads.length, 0);
  r = await call(A, "POST", "/api/threads", { listingId: (await db.sql`SELECT listing_id FROM threads WHERE id = ${x.tid}`)[0].listing_id, text: "One more question" });
  eq("messaging the same listing again reuses the thread", r.j.id, x.tid);
}

// ------------------------------------------------------------------ courier (Shippo, faked HTTP)
section("courier: addresses, rates, labels");
const addr = (name, street) => ({ name, street1: street, city: "Calgary", state: "AB", zip: "T2P 1J9", country: "CA" });
{
  const x = await accepted(); const url = `/api/threads/${x.tid}/offers/${x.mid}`;
  r = await act(A, x.tid, x.mid, { action: "address", address: { ...addr("A", "1 Main"), zip: "nope" } }); eq("bad postal code rejected", r.s, 400);
  r = await act(A, x.tid, x.mid, { action: "address", address: { ...addr("A", "1 Main"), country: "FR", zip: "75001" } }); eq("only US and Canada for now", r.s, 400);
  r = await act(A, x.tid, x.mid, { action: "address", address: { ...addr("", "1 Main") } }); eq("name required", r.s, 400);
  r = await act(A, x.tid, x.mid, { action: "rates" }); eq("rates need a held deposit", r.s, 409);
  await bothHeld(x.tid, x.mid);
  r = await act(A, x.tid, x.mid, { action: "rates" }); eq("rates need both addresses", r.s, 409);
  r = await act(A, x.tid, x.mid, { action: "address", address: addr("Ash", "111 Secret Ave") }); eq("buyer saves address", r.s, 200);
  r = await act(A, x.tid, x.mid, { action: "address", address: addr("Ash R", "111 Secret Ave") }); eq("address can be updated", r.s, 200);
  r = await act(A, x.tid, x.mid, { action: "rates" }); eq("rates still wait for the other address", r.s, 409);
  r = await act(B, x.tid, x.mid, { action: "address", address: addr("Bo", "222 Hidden Rd") }); eq("seller saves address", r.s, 200);
  r = await act(C, x.tid, x.mid, { action: "address", address: addr("Cy", "3 Spy St") }); eq("stranger can't add an address", r.s, 404);
  fetchLog.length = 0;
  r = await act(A, x.tid, x.mid, { action: "rates" });
  ok("rates returned cheapest first", r.s === 200 && r.j.rates[0].id === "r-usps" && r.j.rates[0].amount === 4.5 && r.j.rates.length === 2, JSON.stringify(r));
  const ship = fetchLog.find((f) => f.path === "/shipments").body;
  eq("Shippo is asked to ship from the buyer to the seller", [ship.address_from.street1, ship.address_to.street1, ship.address_from.name], ["111 Secret Ave", "222 Hidden Rd", "Ash R"]);
  r = await act(A, x.tid, x.mid, { action: "label", rateId: "bogus" }); eq("label for an unquoted rate -> 409", r.s, 409);
  r = await act(B, x.tid, x.mid, { action: "label", rateId: "r-usps" }); eq("can't buy a label with someone else's quote", r.s, 409);
  r = await act(A, x.tid, x.mid, { action: "label" }); eq("label without a rate -> 409", r.s, 409);
  r = await act(A, x.tid, x.mid, { action: "label", rateId: "r-usps" }); eq("label bought", r.s, 200);
  o = await offerRow(x.mid);
  ok("tracking saved and carrier-verified", o.buyer_verified === true && /^SHP/.test(o.buyer_tracking) && o.buyer_carrier === "USPS" && o.buyer_label_url === "https://labels.test/l.pdf" && o.seller_verified === false, JSON.stringify(o));
  eq("quotes cleared after purchase", (await db.sql`SELECT count(*)::int AS n FROM label_quotes WHERE message_id = ${x.mid}`)[0].n, 0);
  r = await act(A, x.tid, x.mid, { action: "rates" }); eq("can't buy a second label", r.s, 409);
  r = await act(A, x.tid, x.mid, { action: "ship", trk: "MANUAL999" }); eq("can't also type a tracking number", r.s, 409);
  r = await call(A, "GET", `/api/threads/${x.tid}`); const ao = r.j.messages.find((m) => m.kind === "offer").offer, aText = JSON.stringify(r.j);
  r = await call(B, "GET", `/api/threads/${x.tid}`); const bo = r.j.messages.find((m) => m.kind === "offer").offer, bText = JSON.stringify(r.j);
  ok("buyer sees their own label and address", ao.myLabel === "https://labels.test/l.pdf" && ao.myAddress.street1 === "111 Secret Ave" && ao.hasMyAddress && ao.hasTheirAddress && ao.buyerVerified);
  ok("seller never sees the buyer's label or street address", bo.myLabel === null && !bText.includes("111 Secret Ave") && bText.includes("222 Hidden Rd") && bo.buyerVerified === true);
  ok("buyer never sees the seller's street address", !aText.includes("222 Hidden Rd"));
  // webhook
  const track = o.buyer_tracking, hook = (token, number, status) => call(null, "POST", "/api/shippo-webhook" + (token ? "?token=" + token : ""), { event: "track_updated", data: { tracking_number: number, tracking_status: { status } } }, { "x-requested-with": null });
  r = await hook("wrong", track, "DELIVERED"); eq("webhook rejects a bad token", r.s, 403);
  r = await hook(null, track, "DELIVERED"); eq("webhook rejects a missing token", r.s, 403);
  r = await hook("tok123", track, "TRANSIT"); o = await offerRow(x.mid); eq("webhook updates carrier status", [r.s, o.buyer_track_status, o.buyer_delivered_at], [200, "TRANSIT", null]);
  r = await hook("tok123", track, "DELIVERED"); o = await offerRow(x.mid); const t1 = o.buyer_delivered_at; ok("delivered sets the delivery time", o.buyer_track_status === "DELIVERED" && !!t1);
  await new Promise((s) => setTimeout(s, 50)); await hook("tok123", track, "DELIVERED"); o = await offerRow(x.mid); eq("a repeated DELIVERED event keeps the first delivery time", o.buyer_delivered_at, t1);
  await act(B, x.tid, x.mid, { action: "ship", trk: "MANUAL777" }); await hook("tok123", "MANUAL777", "DELIVERED"); o = await offerRow(x.mid);
  eq("webhook ignores unverified (manually typed) tracking numbers", [o.seller_track_status, o.seller_delivered_at], [null, null]);
  r = await call(null, "POST", "/api/shippo-webhook?token=tok123", { event: "batch_created", data: "x" }, { "x-requested-with": null }); eq("other webhook events are acknowledged", r.s, 200);
  await call(A, "POST", "/api/profile", { name: "Ash" });
}
section("courier: failure paths");
{
  const x = await accepted(); await bothHeld(x.tid, x.mid);
  await act(A, x.tid, x.mid, { action: "address", address: addr("Ash", "1 Main") }); await act(B, x.tid, x.mid, { action: "address", address: addr("Bo", "2 Main") });
  env.SHIPPO_API_KEY = "shippo_live_abc"; r = await act(A, x.tid, x.mid, { action: "rates" }); ok("live keys are refused unless explicitly allowed", r.s === 503 && /Live labels are switched off/.test(r.j.error), JSON.stringify(r));
  env.ALLOW_LIVE_LABELS = "true"; r = await act(A, x.tid, x.mid, { action: "rates" }); eq("live keys work once ALLOW_LIVE_LABELS=true", r.s, 200); delete env.ALLOW_LIVE_LABELS;
  delete env.SHIPPO_API_KEY; r = await act(A, x.tid, x.mid, { action: "rates" }); ok("no key: friendly 'not set up' message", r.s === 503 && /aren’t set up/.test(r.j.error), JSON.stringify(r));
  env.SHIPPO_API_KEY = "shippo_test_abc"; await act(A, x.tid, x.mid, { action: "rates" });
  await db.sql`UPDATE offers SET ship_by = now() - interval '1 hour' WHERE message_id = ${x.mid}`; fetchLog.length = 0;
  r = await act(A, x.tid, x.mid, { action: "label", rateId: "r-usps" });
  ok("deadline passes before the label is saved: 409 and the label is refunded", r.s === 409 && fetchLog.some((f) => f.path === "/refunds"), JSON.stringify([r, fetchLog.map((f) => f.path)]));
  o = await offerRow(x.mid); eq("no tracking was recorded", o.buyer_tracking, null);
  const orig = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ detail: "boom" }), { status: 500 });
  const y = await accepted(); await bothHeld(y.tid, y.mid); await act(A, y.tid, y.mid, { action: "address", address: addr("Ash", "1 Main") }); await act(B, y.tid, y.mid, { action: "address", address: addr("Bo", "2 Main") });
  r = await act(A, y.tid, y.mid, { action: "rates" }); ok("courier outage -> clear error, not a crash", r.s === 502 && r.j.error === "boom", JSON.stringify(r));
  globalThis.fetch = orig;
}

// ------------------------------------------------------------------ want lists
section("want lists");
{
  await call(B, "POST", "/api/listings", { ...base, game: "Magic: The Gathering", title: "Lightning Bolt Alpha", type: "sale", price: 40, photos: photos(B) });
  const M = "Magic: The Gathering";
  r = await call(A, "GET", "/api/wants"); eq("want list needs a game", r.s, 400);
  r = await call(A, "POST", "/api/wants", { game: M, card: "L" }); eq("one-letter want rejected", r.s, 400);
  r = await call(A, "POST", "/api/wants", { game: M, card: "lightning bolt" }); eq("want added", r.s, 201);
  r = await call(A, "GET", "/api/wants?game=" + encodeURIComponent(M));
  ok("matching is case-insensitive and finds the listing", r.j.list.length === 1 && r.j.matches.length === 1 && r.j.matches[0].title === "Lightning Bolt Alpha" && r.j.matches[0].want === "lightning bolt", JSON.stringify(r.j));
  r = await call(B, "GET", "/api/wants?game=" + encodeURIComponent(M)); ok("seller sees who wants their card", r.j.interest.length === 1 && r.j.interest[0].wanter === "Ash" && r.j.interest[0].title === "Lightning Bolt Alpha", JSON.stringify(r.j));
  r = await call(A, "GET", "/api/wants?game=" + encodeURIComponent("Pokémon")); eq("wants don't cross communities", [r.j.list.length, r.j.matches.length], [0, 0]);
  const wid = (await call(A, "GET", "/api/wants?game=" + encodeURIComponent(M))).j.list[0].id;
  r = await call(C, "DELETE", "/api/wants/" + wid, {}); r = await call(A, "GET", "/api/wants?game=" + encodeURIComponent(M)); eq("others can't delete my want", r.j.list.length, 1);
  r = await call(A, "DELETE", "/api/wants/" + wid, {}); r = await call(A, "GET", "/api/wants?game=" + encodeURIComponent(M)); eq("I can delete my own want", r.j.list.length, 0);
  for (let i = 0; i < 49; i++) await db.sql`INSERT INTO wants (user_id, game, card) VALUES (${C}, ${M}, ${"card " + i})`;
  r = await call(C, "POST", "/api/wants", { game: M, card: "card 50" }); eq("50th want accepted", r.s, 201);
  r = await call(C, "POST", "/api/wants", { game: M, card: "card 51" }); eq("want list capped at 50", r.s, 400);
}

// ------------------------------------------------------------------ community boards
section("community boards");
{
  const P = "Pokémon";
  r = await call(null, "POST", "/api/board", { game: P, title: "t", text: "x" }); eq("posting needs sign-in", r.s, 401);
  r = await call(A, "POST", "/api/board", { game: P, title: "", text: "x" }); eq("post needs a title", r.s, 400);
  r = await call(A, "POST", "/api/board", { game: P, title: "WTB Umbreon", text: "Looking for a mint copy" }); eq("post created", r.s, 201);
  await call(A, "POST", "/api/board", { game: "One Piece", title: "OP chat", text: "hi" });
  r = await call(null, "GET", "/api/board?game=" + encodeURIComponent(P)); ok("boards are public to read and scoped per game", r.j.posts.length === 1 && r.j.posts[0].author.name === "Ash", JSON.stringify(r.j));
  const pid = r.j.posts[0].id;
  r = await call(B, "POST", `/api/board/${pid}/replies`, { text: "I have one!" }); eq("reply created", r.s, 201);
  r = await call(B, "POST", `/api/board/${randomUUID()}/replies`, { text: "hi" }); eq("reply to a missing post 404", r.s, 404);
  r = await call(B, "POST", `/api/board/${pid}/replies`, { text: " " }); eq("blank reply rejected", r.s, 400);
  r = await call(null, "GET", "/api/board?game=" + encodeURIComponent(P)); eq("replies come back with the post", r.j.posts[0].replies.map((x) => [x.text, x.author.name]), [["I have one!", "Bo"]]);
  await call(B, "DELETE", "/api/board/" + pid, {}); r = await call(null, "GET", "/api/board?game=" + encodeURIComponent(P)); eq("others can't delete my post", r.j.posts.length, 1);
  await call(A, "DELETE", "/api/board/" + pid, {}); r = await call(null, "GET", "/api/board?game=" + encodeURIComponent(P)); eq("author deletes post (replies go with it)", r.j.posts.length, 0);
  eq("no orphaned replies", (await db.sql`SELECT count(*)::int AS n FROM replies WHERE post_id = ${pid}`)[0].n, 0);
}

// ------------------------------------------------------------------ photos and auth
section("photos and auth");
{
  const up = async (type, size) => { ctl.user = { id: A }; const res = await api(new Request("https://x.test/api/photos", { method: "POST", headers: { "x-requested-with": "tt", "content-type": type }, body: new Uint8Array(size) }), {}); return { s: res.status, j: await res.json() }; };
  r = await up("text/html", 500); eq("photo type check", r.s, 400);
  r = await up("image/jpeg", 50); eq("tiny file rejected", r.s, 400);
  r = await up("image/jpeg", 4_000_000); eq("over 3.5 MB rejected", r.s, 400);
  r = await up("image/jpeg", 2000); ok("photo stored, id returned", r.s === 200 && /^[0-9a-f-]{36}$/.test(r.j.id));
  r = await call(A, "GET", "/api/photo/not-a-uuid"); eq("bad photo id 404", r.s, 404);
  r = await call(null, "POST", "/api/auth/login", { email: "nope", password: "x" }); eq("login validates input", r.s, 400);
  r = await call(null, "POST", "/api/auth/login", { email: "a@b.co", password: "longenough" }); eq("login ok path", r.s, 200);
  r = await call(null, "POST", "/api/auth/signup", { email: "a@b.co", password: "short" }); eq("short password rejected", r.s, 400);
  r = await call(null, "GET", "/api/auth/login"); eq("auth is POST only", r.s, 405);
}

// ------------------------------------------------------------------ privacy gate
section("account area: profile, settings, payments, earnings, trades, views and saves");
const D = "u-dee", E = "u-eve";
for (const [u, n] of [[D, "Dee"], [E, "Eve"]]) await call(u, "POST", "/api/profile", { name: n });
const dBase = { game: "Pokémon", title: "Gengar VMAX", condition: "Near Mint", shipping: 4, type: "both", price: 40, value: 40 };
const dList = async (o = {}) => (await call(D, "POST", "/api/listings", { ...dBase, photos: photos(D), ...o })).j.id;
r = await call(null, "GET", "/api/account"); eq("account requires sign-in", r.s, 401);
r = await call(D, "GET", "/api/account"); ok("account returns profile, settings defaults, no payment methods", r.s === 200 && r.j.profile.name === "Dee" && r.j.profile.settings.notifyMessages === true && r.j.profile.settings.defaultShipping === null && r.j.payments.length === 0);
r = await call(D, "PATCH", "/api/account", { name: "D" }); eq("account name too short rejected", r.s, 400);
r = await call(D, "PATCH", "/api/account", { bio: "Collects Gengar", location: "Calgary, AB" }); eq("bio and location saved", r.s, 200);
r = await call(D, "GET", "/api/account"); eq("bio, location persisted and name untouched", [r.j.profile.bio, r.j.profile.location, r.j.profile.name], ["Collects Gengar", "Calgary, AB", "Dee"]);
r = await call(D, "PATCH", "/api/account", { name: "Dee D" }); r = await call(D, "GET", "/api/me"); eq("account rename flows to /me", r.j.user.name, "Dee D");
r = await call(D, "PATCH", "/api/account", { settings: { notifyDigest: true, notifyMessages: false, defaultLocation: "Calgary", defaultShipping: 3.5, evil: "x" } });
r = await call(D, "GET", "/api/account"); const sset = r.j.profile.settings; eq("settings saved, unknown keys dropped", [sset.notifyDigest, sset.notifyMessages, sset.defaultLocation, sset.defaultShipping, "evil" in sset], [true, false, "Calgary", 3.5, false]);
r = await call(D, "PATCH", "/api/account", { settings: { defaultShipping: -2 } }); eq("negative default shipping rejected", r.s, 400);
r = await call(D, "PATCH", "/api/account", { settings: { defaultShipping: null } }); r = await call(D, "GET", "/api/account"); eq("default shipping can be cleared", r.j.profile.settings.defaultShipping, null);
// payment methods hold a nickname and last 4 only
r = await call(D, "POST", "/api/account/payment-methods", { type: "Crypto", label: "x" }); eq("unknown payment type rejected", r.s, 400);
r = await call(D, "POST", "/api/account/payment-methods", { type: "PayPal", label: "" }); eq("payment nickname required", r.s, 400);
r = await call(D, "POST", "/api/account/payment-methods", { type: "Credit or debit card", label: "Visa", last4: "4242424242424242" }); eq("full card number rejected, not truncated", r.s, 400);
r = await call(D, "POST", "/api/account/payment-methods", { type: "Credit or debit card", label: "Visa", last4: "12" }); eq("short last4 rejected", r.s, 400);
ok("nothing was stored by the rejected card numbers", (await db.sql`SELECT count(*)::int AS n FROM payment_methods WHERE user_id = ${D}`)[0].n === 0);
r = await call(D, "POST", "/api/account/payment-methods", { type: "Credit or debit card", label: "Visa", last4: "4242" }); eq("payment method added", r.s, 201); const pm1 = r.j.id;
r = await call(D, "POST", "/api/account/payment-methods", { type: "PayPal", label: "PayPal" }); const pm2 = r.j.id;
r = await call(D, "GET", "/api/account"); eq("first method becomes the payout method", r.j.payments.map((x) => [x.label, x.payout]), [["Visa", true], ["PayPal", false]]);
r = await call(E, "POST", `/api/account/payment-methods/${pm2}/payout`); eq("can't change someone else's payout method", r.s, 404);
r = await call(E, "DELETE", `/api/account/payment-methods/${pm2}`); eq("can't delete someone else's payment method", r.s, 404);
r = await call(D, "POST", `/api/account/payment-methods/${pm2}/payout`); r = await call(D, "GET", "/api/account"); eq("payout method switches to exactly one", r.j.payments.map((x) => x.payout), [false, true]);
await call(D, "DELETE", `/api/account/payment-methods/${pm2}`); r = await call(D, "GET", "/api/account"); eq("deleting the payout method promotes another", r.j.payments.map((x) => [x.label, x.payout]), [["Visa", true]]);
for (let k = 0; k < 4; k++) await call(D, "POST", "/api/account/payment-methods", { type: "PayPal", label: "P" + k });
r = await call(D, "POST", "/api/account/payment-methods", { type: "PayPal", label: "too many" }); eq("max 5 payment methods", r.s, 400);
// views and saves
const vl = await dList({ title: "Mimikyu V" });
r = await call(D, "POST", `/api/listings/${vl}/view`); eq("owner's own visit isn't counted", r.j.ok, false);
r = await call(null, "POST", `/api/listings/${vl}/view`); eq("anonymous visit isn't counted", r.j.ok, false);
await call(E, "POST", `/api/listings/${vl}/view`); await call(E, "POST", `/api/listings/${vl}/view`);
let [vw] = await db.sql`SELECT views FROM listing_views WHERE listing_id = ${vl} AND viewer_id = ${E}`; eq("repeat visit within 30 minutes counts once", vw.views, 1);
await db.sql`UPDATE listing_views SET last_at = now() - interval '31 minutes' WHERE listing_id = ${vl}`;
await call(E, "POST", `/api/listings/${vl}/view`); [vw] = await db.sql`SELECT views FROM listing_views WHERE listing_id = ${vl} AND viewer_id = ${E}`; eq("a visit 30+ minutes later counts again", vw.views, 2);
await call(C, "POST", `/api/listings/${vl}/view`);
r = await call(D, "POST", `/api/listings/${vl}/save`, { saved: true }); eq("can't save your own listing", r.s, 400);
r = await call(E, "POST", `/api/listings/${vl}/save`, { saved: true }); eq("save a listing", r.s, 200);
await call(E, "POST", `/api/listings/${vl}/save`, { saved: true });
ok("saving twice keeps one save", (await db.sql`SELECT count(*)::int AS n FROM listing_saves WHERE listing_id = ${vl}`)[0].n === 1);
r = await call(E, "GET", "/api/saves"); eq("saved list returns the listing", r.j.items.map((x) => x.id), [vl]);
r = await call(E, "GET", "/api/listings?game=" + encodeURIComponent("Pokémon")); eq("browse marks saved listings for the viewer", r.j.items.find((x) => x.id === vl).saved, true);
r = await call(C, "GET", "/api/listings?game=" + encodeURIComponent("Pokémon")); eq("another viewer sees it unsaved", r.j.items.find((x) => x.id === vl).saved, false);
const th = await call(E, "POST", "/api/threads", { listingId: vl, text: "Is this still available?" });
r = await call(D, "GET", "/api/listings?mine=1"); const my = r.j.items.find((x) => x.id === vl);
eq("my listings carry view, visitor, save and conversation counts", [my.stats.views, my.stats.visitors, my.stats.saves, my.stats.conversations], [3, 2, 1, 1]);
r = await call(E, "GET", "/api/listings?mine=1"); ok("stats are per owner: Eve has no listings of her own", r.j.items.every((x) => x.stats.views === 0 || x.id !== vl));
r = await call(null, "GET", "/api/listings?mine=1"); eq("my listings requires sign-in", r.s, 401);
r = await call(E, "POST", `/api/listings/${randomUUID()}/save`, { saved: true }); eq("saving a missing listing is a 404", r.s, 404);
r = await call(E, "POST", `/api/listings/${vl}/save`, { saved: false }); r = await call(E, "GET", "/api/saves"); eq("unsave removes it", r.j.items.length, 0);
await call(E, "POST", `/api/listings/${vl}/save`, { saved: true }); await call(D, "DELETE", `/api/listings/${vl}`);
r = await call(E, "GET", "/api/saves"); eq("deleting a listing removes it from everyone's saved list", r.j.items.length, 0);
// vacation mode
const vac = await dList({ title: "Vacation test card" });
r = await call(D, "PATCH", "/api/account", { vacation: true });
r = await call(E, "GET", "/api/listings?game=" + encodeURIComponent("Pokémon")); ok("vacation mode hides listings from others", !r.j.items.some((x) => x.id === vac));
r = await call(D, "GET", "/api/listings?mine=1"); ok("vacation mode still shows my own listings to me", r.j.items.some((x) => x.id === vac));
await call(D, "PATCH", "/api/account", { vacation: false });
r = await call(E, "GET", "/api/listings?game=" + encodeURIComponent("Pokémon")); ok("turning vacation off brings them back", r.j.items.some((x) => x.id === vac));
// earnings
const sold1 = await dList({ title: "Sold single", type: "sale", price: 100 }), sold2 = await dList({ title: "Sold sealed", type: "sale", price: 50.5, kind: "sealed", productType: "Booster box", condition: "Factory sealed" });
const tradeOnly = await dList({ title: "Traded away", type: "trade", price: undefined, value: 70 });
for (const id of [sold1, sold2, tradeOnly]) await call(D, "PATCH", `/api/listings/${id}`, { sold: true });
r = await call(D, "GET", "/api/account/earnings"); const ey = r.j;
eq("earnings count sold sales only, with a 5% fee", [ey.items.map((x) => [x.title, x.gross, x.fee, x.net]).sort()], [[["Sold sealed", 50.5, 2.53, 47.97], ["Sold single", 100, 5, 95]]]);
ok("earnings totals add up", ey.totals.gross === 150.5 && ey.totals.fees === 7.53 && ey.totals.net === 142.97 && ey.totals.net30 === 142.97 && ey.totals.sold30 === 2);
ok("sold date is recorded", (await db.sql`SELECT sold_at FROM listings WHERE id = ${sold1}`)[0].sold_at !== null);
await db.sql`UPDATE listings SET sold_at = now() - interval '40 days' WHERE id = ${sold1}`;
r = await call(D, "GET", "/api/account/earnings"); ok("last-30-days earnings exclude older sales", r.j.totals.net30 === 47.97 && r.j.totals.net === 142.97);
await call(D, "PATCH", `/api/listings/${sold2}`, { sold: false }); r = await call(D, "GET", "/api/account/earnings"); ok("relisting removes a sale from earnings and clears its date", r.j.items.length === 1 && (await db.sql`SELECT sold_at FROM listings WHERE id = ${sold2}`)[0].sold_at === null);
r = await call(E, "GET", "/api/account/earnings"); eq("earnings are private to the seller", r.j.items.length, 0);
// trades
const tl = await dList({ title: "Trade bait", type: "trade", price: undefined, value: 60 });
const tr = await call(E, "POST", "/api/threads", { listingId: tl, offer: { card: "Eve's Alakazam", ship: 3, value: 55, photos: photos(E, 2) } });
r = await call(D, "GET", "/api/account/trades"); const dt = r.j.trades.find((x) => x.theyOffered === "Eve's Alakazam");
ok("seller sees an incoming trade with the right sides", dt && dt.with === "Eve" && dt.iOffered === "Trade bait" && dt.status === "pending" && dt.myDeposit === "due" && dt.deposit > 0);
ok("incoming offer is counted as waiting for an answer", r.j.summary.pendingAnswer >= 1 && r.j.summary.open >= 1);
r = await call(E, "GET", "/api/account/trades"); const et = r.j.trades.find((x) => x.iOffered === "Eve's Alakazam");
ok("proposer sees the same trade from the other side", et && et.with === "Dee D" && et.theyOffered === "Trade bait");
r = await call(null, "GET", "/api/account/trades"); eq("trades require sign-in", r.s, 401);
r = await call(C, "GET", "/api/account/trades"); ok("a stranger sees none of these trades", !r.j.trades.some((x) => x.theyOffered === "Eve's Alakazam" || x.iOffered === "Eve's Alakazam"));
const mid2 = (await db.sql`SELECT o.message_id FROM offers o JOIN messages m ON m.id = o.message_id WHERE m.thread_id = ${tr.j.id} ORDER BY m.created_at DESC LIMIT 1`)[0].message_id;
await act(D, tr.j.id, mid2, { action: "accept" }); await act(E, tr.j.id, mid2, { action: "deposit" }); await act(D, tr.j.id, mid2, { action: "deposit" });
r = await call(D, "GET", "/api/account/trades"); const dt2 = r.j.trades.find((x) => x.id === mid2);
ok("accepted trade shows held deposits and shipping to do", dt2.status === "accepted" && dt2.myDeposit === "held" && dt2.theirDeposit === "held" && r.j.summary.depositsHeld >= dt2.deposit && r.j.summary.toShip >= 1);

section("privacy gate (edge function)");
{
  const hit = async (auth) => { let passed = false; const res = await gate(new Request("https://x.test/", { headers: auth ? { authorization: auth } : {} }), { next: async () => { passed = true; return new Response("ok"); } }); return { s: res.status, passed }; };
  const basic = (pw) => "Basic " + btoa("anyone:" + pw);
  eq("no credentials -> 401 challenge", (await hit()).s, 401);
  eq("wrong password -> 401", (await hit(basic("nope"))).s, 401);
  eq("longer wrong password -> 401", (await hit(basic("letmeinletmein"))).s, 401);
  eq("garbage header -> 401", (await hit("Basic !!!")).s, 401);
  eq("right password passes through", await hit(basic("letmein")), { s: 200, passed: true });
  const pw = env.SITE_PASSWORD; delete env.SITE_PASSWORD;
  eq("no password configured -> locked (503), not open", (await hit()).s, 503);
  env.ALLOW_PUBLIC = "true"; eq("ALLOW_PUBLIC=true opens it", (await hit()).passed, true); delete env.ALLOW_PUBLIC; env.SITE_PASSWORD = pw;
  ok("only the Shippo webhook path skips the gate", JSON.stringify(gateConfig.excludedPath) === JSON.stringify(["/.netlify/*", "/api/shippo-webhook"]), JSON.stringify(gateConfig));
}

console.log(`\n${total - fails}/${total} passed` + (fails ? `, ${fails} FAILED` : ""));
endAll();
process.exit(fails ? 1 : 0);
