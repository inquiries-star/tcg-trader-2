import type { Config } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { sweep } from "../lib/sweep.mts";

// Hourly job: cancels trades past their ship-by date, auto-confirms stale receipts,
// and moves the demo deposits accordingly. (Scheduled functions run on published deploys only.)
export default async () => {
  await sweep(getDatabase(), null);
};

export const config: Config = { schedule: "@hourly" };
