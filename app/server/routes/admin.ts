import type { Application } from 'express';
import { resetDemoTables } from '../db/queries/stores.js';
import type { AppDb } from '../db/index.js';

/**
 * Demo-only admin routes. /api/admin/reset truncates the app's WRITABLE
 * tables (ops_actions + chat state) — click it between demos to start clean.
 * All agent writes are wiped: shortfalls return to stockout/at_risk, exposure
 * returns to full.
 *
 * The read-only synced Gold tables (public.gold_*) are NOT touched: they are
 * owned by the Lakebase sync pipeline and refresh via `Sync now`, not app SQL.
 */
export function registerAdminRoutes(
  app: Application,
  deps: { db: AppDb },
): void {
  const { db } = deps;
  app.post('/api/admin/reset', async (_req, res) => {
    await resetDemoTables(db);
    res.json({ ok: true });
  });
}
