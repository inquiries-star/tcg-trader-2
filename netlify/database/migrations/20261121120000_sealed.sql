-- Sealed products: listings can be single cards (default) or sealed product (boxes, packs, decks)

ALTER TABLE listings
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'card' CHECK (kind IN ('card', 'sealed')),
  ADD COLUMN product_type TEXT NOT NULL DEFAULT '';
