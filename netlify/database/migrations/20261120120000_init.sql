-- TCG Trader initial schema

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,                       -- Netlify Identity user id
  name TEXT NOT NULL,
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id TEXT NOT NULL REFERENCES profiles(id),
  game TEXT NOT NULL,
  title TEXT NOT NULL,
  set_name TEXT NOT NULL DEFAULT '',
  condition TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('sale', 'both', 'trade')),
  looking_for TEXT NOT NULL DEFAULT '',
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  shipping NUMERIC(10,2) NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  photos TEXT[] NOT NULL,
  sold BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX listings_game_idx ON listings (game, sold, created_at DESC);
CREATE INDEX listings_seller_idx ON listings (seller_id);

CREATE TABLE threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  listing_title TEXT NOT NULL,
  game TEXT NOT NULL,
  buyer_id TEXT NOT NULL REFERENCES profiles(id),
  seller_id TEXT NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, buyer_id)
);
CREATE INDEX threads_buyer_idx ON threads (buyer_id);
CREATE INDEX threads_seller_idx ON threads (seller_id);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES profiles(id),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'offer')),
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread_idx ON messages (thread_id, created_at);

-- Trade offers. buyer = the person who proposed the trade, seller = the listing owner.
CREATE TABLE offers (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  card TEXT NOT NULL,
  photos TEXT[] NOT NULL DEFAULT '{}',
  buyer_ship NUMERIC(10,2) NOT NULL DEFAULT 0,
  seller_ship NUMERIC(10,2) NOT NULL DEFAULT 0,
  their_title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'completed')),
  buyer_tracking TEXT,
  seller_tracking TEXT,
  buyer_received BOOLEAN NOT NULL DEFAULT false,
  seller_received BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE offer_ratings (
  message_id UUID NOT NULL REFERENCES offers(message_id) ON DELETE CASCADE,
  rater_id TEXT NOT NULL REFERENCES profiles(id),
  ratee_id TEXT NOT NULL REFERENCES profiles(id),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  PRIMARY KEY (message_id, rater_id)
);

CREATE TABLE thread_reads (
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

CREATE TABLE wants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES profiles(id),
  game TEXT NOT NULL,
  card TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wants_user_idx ON wants (user_id);
CREATE INDEX wants_game_idx ON wants (game);

CREATE TABLE posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id TEXT NOT NULL REFERENCES profiles(id),
  game TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX posts_game_idx ON posts (game, created_at DESC);

CREATE TABLE replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES profiles(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX replies_post_idx ON replies (post_id, created_at);
