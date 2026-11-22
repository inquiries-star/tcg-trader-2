// Minimal Shippo client (https://docs.goshippo.com). Test keys (shippo_test_...) create free, simulated labels.

export class ShippoError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export type Address = { name: string; street1: string; street2: string; city: string; state: string; zip: string; country: string; phone: string };

// A TCG card in a sleeve, top loader and bubble mailer.
const PARCEL = { length: "9", width: "6", height: "1", distance_unit: "in", weight: "4", mass_unit: "oz" };

function apiKey() {
  const key = Netlify.env.get("SHIPPO_API_KEY");
  if (!key) throw new ShippoError("Courier labels aren’t set up yet. Enter a tracking number instead.", 503);
  if (key.startsWith("shippo_live_") && Netlify.env.get("ALLOW_LIVE_LABELS") !== "true") {
    throw new ShippoError("Live labels are switched off. Use a shippo_test_ key, or set ALLOW_LIVE_LABELS=true once payments are set up.", 503);
  }
  return key;
}

async function call(path: string, method: string, body?: unknown) {
  const res = await fetch("https://api.goshippo.com" + path, {
    method,
    headers: { Authorization: `ShippoToken ${apiKey()}`, "Content-Type": "application/json", "Shippo-API-Version": "2018-02-08" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ShippoError(typeof data?.detail === "string" ? data.detail : "The courier service returned an error.", 502);
  return data;
}

const toShippo = (a: Address) => ({
  name: a.name, street1: a.street1, street2: a.street2 || undefined, city: a.city, state: a.state, zip: a.zip, country: a.country, phone: a.phone || undefined,
});

export async function getRates(from: Address, to: Address) {
  const shipment = await call("/shipments", "POST", { address_from: toShippo(from), address_to: toShippo(to), parcels: [PARCEL], async: false });
  return ((shipment.rates || []) as any[])
    .filter((r) => r.object_id && Number.isFinite(Number(r.amount)))
    .map((r) => ({ id: String(r.object_id), carrier: String(r.provider || "Carrier"), service: String(r.servicelevel?.name || ""), amount: Number(r.amount), days: r.estimated_days ?? null }))
    .sort((a, b) => a.amount - b.amount)
    .slice(0, 6);
}

export async function buyLabel(rateId: string, metadata: string) {
  const t = await call("/transactions", "POST", { rate: rateId, label_file_type: "PDF_4x6", async: false, metadata });
  if (t.status !== "SUCCESS" || !t.tracking_number || !t.label_url) {
    throw new ShippoError(t.messages?.[0]?.text || "The courier couldn’t create that label. Try another service.", 502);
  }
  return { id: String(t.object_id), tracking: String(t.tracking_number), labelUrl: String(t.label_url) };
}

export const refundLabel = (transactionId: string) => call("/refunds", "POST", { transaction: transactionId });
