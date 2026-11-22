-- Courier integration (Shippo): addresses used only to print labels, rate quotes, carrier-verified tracking

CREATE TABLE trade_addresses (
  message_id UUID NOT NULL REFERENCES offers(message_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES profiles(id),
  name TEXT NOT NULL,
  street1 TEXT NOT NULL,
  street2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  country TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE label_quotes (
  message_id UUID NOT NULL REFERENCES offers(message_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  rate_id TEXT NOT NULL,
  carrier TEXT NOT NULL,
  service TEXT NOT NULL DEFAULT '',
  amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, rate_id)
);

ALTER TABLE offers
  ADD COLUMN buyer_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN seller_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN buyer_carrier TEXT,
  ADD COLUMN seller_carrier TEXT,
  ADD COLUMN buyer_label_url TEXT,
  ADD COLUMN seller_label_url TEXT,
  ADD COLUMN buyer_label_tx TEXT,
  ADD COLUMN seller_label_tx TEXT,
  ADD COLUMN buyer_track_status TEXT,
  ADD COLUMN seller_track_status TEXT,
  ADD COLUMN buyer_delivered_at TIMESTAMPTZ,
  ADD COLUMN seller_delivered_at TIMESTAMPTZ;
