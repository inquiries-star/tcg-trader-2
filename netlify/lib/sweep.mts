import type { getDatabase } from "@netlify/database";

type Db = ReturnType<typeof getDatabase>;

export const SHIP_DAYS = 5;        // days each trader has to ship after a trade is accepted
export const AUTO_CONFIRM_HOURS = 72; // hours before a missing receipt confirmation is assumed

/**
 * Applies time-based trade rules. Runs lazily when a conversation is opened and
 * hourly from the scheduled function, so deposits move even if nobody visits.
 *   1. If one trader confirmed receipt and the other hasn't within 72h, the second
 *      receipt is assumed (their package was shipped), the trade completes and
 *      held deposits are released.
 *   2. If the ship-by date passes and someone hasn't shipped, the trade is cancelled.
 *      A trader who didn't ship forfeits their held deposit to the other trader if the
 *      other already shipped; otherwise held deposits are simply released.
 * Disputed trades are never touched. Pass null to sweep every trade.
 */
export async function sweep(db: Db, threadId: string | null) {
  // Carrier says the other trader's package was delivered: 72h later receipt is assumed.
  await db.sql`UPDATE offers o SET seller_received = true, seller_received_at = now(),
      status = CASE WHEN o.buyer_received THEN 'completed' ELSE o.status END,
      buyer_deposit = CASE WHEN o.buyer_received AND o.buyer_deposit = 'held' THEN 'released' ELSE o.buyer_deposit END,
      seller_deposit = CASE WHEN o.buyer_received AND o.seller_deposit = 'held' THEN 'released' ELSE o.seller_deposit END
    FROM messages m
    WHERE m.id = o.message_id AND (${threadId}::uuid IS NULL OR m.thread_id = ${threadId}::uuid)
      AND o.status = 'accepted' AND NOT o.seller_received AND o.buyer_verified
      AND o.buyer_delivered_at < now() - make_interval(hours => ${AUTO_CONFIRM_HOURS}::int)`;
  await db.sql`UPDATE offers o SET buyer_received = true, buyer_received_at = now(),
      status = CASE WHEN o.seller_received THEN 'completed' ELSE o.status END,
      buyer_deposit = CASE WHEN o.seller_received AND o.buyer_deposit = 'held' THEN 'released' ELSE o.buyer_deposit END,
      seller_deposit = CASE WHEN o.seller_received AND o.seller_deposit = 'held' THEN 'released' ELSE o.seller_deposit END
    FROM messages m
    WHERE m.id = o.message_id AND (${threadId}::uuid IS NULL OR m.thread_id = ${threadId}::uuid)
      AND o.status = 'accepted' AND NOT o.buyer_received AND o.seller_verified
      AND o.seller_delivered_at < now() - make_interval(hours => ${AUTO_CONFIRM_HOURS}::int)`;
  await db.sql`UPDATE offers o SET seller_received = true, seller_received_at = now(), status = 'completed',
      buyer_deposit = CASE WHEN o.buyer_deposit = 'held' THEN 'released' ELSE o.buyer_deposit END,
      seller_deposit = CASE WHEN o.seller_deposit = 'held' THEN 'released' ELSE o.seller_deposit END
    FROM messages m
    WHERE m.id = o.message_id AND (${threadId}::uuid IS NULL OR m.thread_id = ${threadId}::uuid)
      AND o.status = 'accepted' AND o.buyer_received AND NOT o.seller_received AND o.buyer_tracking IS NOT NULL
      AND o.buyer_received_at < now() - make_interval(hours => ${AUTO_CONFIRM_HOURS}::int)`;
  await db.sql`UPDATE offers o SET buyer_received = true, buyer_received_at = now(), status = 'completed',
      buyer_deposit = CASE WHEN o.buyer_deposit = 'held' THEN 'released' ELSE o.buyer_deposit END,
      seller_deposit = CASE WHEN o.seller_deposit = 'held' THEN 'released' ELSE o.seller_deposit END
    FROM messages m
    WHERE m.id = o.message_id AND (${threadId}::uuid IS NULL OR m.thread_id = ${threadId}::uuid)
      AND o.status = 'accepted' AND o.seller_received AND NOT o.buyer_received AND o.seller_tracking IS NOT NULL
      AND o.seller_received_at < now() - make_interval(hours => ${AUTO_CONFIRM_HOURS}::int)`;
  await db.sql`UPDATE offers o SET status = 'cancelled',
      buyer_deposit = CASE
        WHEN o.buyer_tracking IS NULL AND o.seller_tracking IS NOT NULL AND o.buyer_deposit = 'held' THEN 'forfeited'
        WHEN o.buyer_deposit = 'held' THEN 'released' ELSE o.buyer_deposit END,
      seller_deposit = CASE
        WHEN o.seller_tracking IS NULL AND o.buyer_tracking IS NOT NULL AND o.seller_deposit = 'held' THEN 'forfeited'
        WHEN o.seller_deposit = 'held' THEN 'released' ELSE o.seller_deposit END
    FROM messages m
    WHERE m.id = o.message_id AND (${threadId}::uuid IS NULL OR m.thread_id = ${threadId}::uuid)
      AND o.status = 'accepted' AND o.ship_by < now() AND (o.buyer_tracking IS NULL OR o.seller_tracking IS NULL)`;
  // Shipping addresses are only needed to print labels; delete them once a trade has ended.
  await db.sql`DELETE FROM trade_addresses ta USING offers o, messages m
    WHERE ta.message_id = o.message_id AND m.id = o.message_id
      AND o.status IN ('completed', 'cancelled', 'declined', 'withdrawn')
      AND (${threadId}::uuid IS NULL OR m.thread_id = ${threadId}::uuid)`;
}
