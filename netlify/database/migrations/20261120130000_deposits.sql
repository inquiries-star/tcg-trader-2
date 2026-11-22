-- Trade deposits (demo ledger), estimated card values, ship-by deadlines

ALTER TABLE listings ADD COLUMN value NUMERIC(10,2) NOT NULL DEFAULT 0;
UPDATE listings SET value = price WHERE price > 0;

ALTER TABLE offers
  ADD COLUMN buyer_value NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN seller_value NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN deposit NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN buyer_deposit TEXT NOT NULL DEFAULT 'due' CHECK (buyer_deposit IN ('due', 'held', 'released', 'forfeited')),
  ADD COLUMN seller_deposit TEXT NOT NULL DEFAULT 'due' CHECK (seller_deposit IN ('due', 'held', 'released', 'forfeited')),
  ADD COLUMN ship_by TIMESTAMPTZ,
  ADD COLUMN buyer_received_at TIMESTAMPTZ,
  ADD COLUMN seller_received_at TIMESTAMPTZ;

ALTER TABLE offers DROP CONSTRAINT offers_status_check;
ALTER TABLE offers ADD CONSTRAINT offers_status_check
  CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'completed', 'cancelled', 'disputed'));
