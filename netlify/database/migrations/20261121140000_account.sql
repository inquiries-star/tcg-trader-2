-- Account area: profile and settings, payment-method labels (never full numbers), earnings dates, views and saves

ALTER TABLE profiles
  ADD COLUMN bio TEXT NOT NULL DEFAULT '',
  ADD COLUMN location TEXT NOT NULL DEFAULT '',
  ADD COLUMN vacation BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN settings JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE listings ADD COLUMN sold_at TIMESTAMPTZ;
UPDATE listings SET sold_at = created_at WHERE sold;

-- Only a nickname and the last 4 digits are stored. Card entry belongs to a payment provider.
CREATE TABLE payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES profiles(id),
  type TEXT NOT NULL CHECK (type IN ('Credit or debit card', 'Bank account (payouts)', 'PayPal')),
  label TEXT NOT NULL,
  last4 TEXT NOT NULL DEFAULT '' CHECK (last4 ~ '^[0-9]{0,4}$'),
  is_payout BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_methods_user_idx ON payment_methods (user_id);

CREATE TABLE listing_views (
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  viewer_id TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 1,
  first_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, viewer_id)
);

CREATE TABLE listing_saves (
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, user_id)
);
CREATE INDEX listing_saves_user_idx ON listing_saves (user_id, created_at DESC);
