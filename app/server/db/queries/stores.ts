import { sql } from 'drizzle-orm';
import type { AppDb } from '../index.js';
import type { AuditEntry, MoveOption } from '../schema.js';
import { authHeadersServicePrincipal } from '../../lib/auth.js';

export type { AuditEntry, MoveOption };

export type PositionStatus = 'stockout' | 'at_risk' | 'overstock' | 'healthy';
export type MoveType = 'transfer' | 'expedite' | 'substitute' | 'markdown_hold';
export type ActionStatus = 'proposed' | 'approved' | 'executed' | 'overridden';

// ============================================================================
// PositionRow — the Operations queue's primary entity. Reads the synced
// read-only position mirror, LEFT JOIN-ed to its LATEST ops_actions row
// (so `live_move_type` / `action_status` reflect the writable table) and
// to recovery_recommendations (the model's recommended move per shortfall).
// ============================================================================

export type PositionRow = {
  id: string;
  storeId: string;
  storeName: string | null;
  region: string | null;
  climateZone: string | null;
  city: string | null;
  storeLat: number | null;
  storeLng: number | null;
  productId: string;
  productName: string | null;
  category: string | null;
  seasonality: string | null;
  onHandUnits: number | null;
  onOrderUnits: number | null;
  recentUnits7d: number | null;
  avgDailyVelocity: number | null;
  weeksOfSupply: number | null;
  priceUsd: number | null;
  markdownRiskScore: number | null;
  lostSalesExposureUsd: number | null;
  markdownExposureUsd: number | null;
  positionStatus: PositionStatus;
  recommendedMove: MoveType | null;
  predictedRecapturedUsd: number | null;
  liveMoveType: MoveType | null;
  actionStatus: ActionStatus | null;
};

type PositionSqlRow = {
  id: string;
  store_id: string;
  store_name: string | null;
  region: string | null;
  climate_zone: string | null;
  city: string | null;
  store_lat: number | string | null;
  store_lng: number | string | null;
  product_id: string;
  product_name: string | null;
  category: string | null;
  seasonality: string | null;
  on_hand_units: number | null;
  on_order_units: number | null;
  recent_units_7d: number | null;
  avg_daily_velocity: number | string | null;
  weeks_of_supply: number | string | null;
  price_usd: number | string | null;
  markdown_risk_score: number | string | null;
  lost_sales_exposure_usd: number | string | null;
  markdown_exposure_usd: number | string | null;
  position_status: string | null;
  recommended_move: string | null;
  predicted_recaptured_usd: number | string | null;
  live_move_type: string | null;
  action_status: string | null;
};

const num = (v: number | string | null): number | null =>
  v === null || v === undefined ? null : Number(v);

const asStatus = (v: string | null): PositionStatus =>
  v === 'stockout' || v === 'at_risk' || v === 'overstock' ? v : 'healthy';

const asMove = (v: string | null): MoveType | null =>
  v === 'transfer' || v === 'expedite' || v === 'substitute' || v === 'markdown_hold'
    ? v
    : null;

const asActionStatus = (v: string | null): ActionStatus | null =>
  v === 'proposed' || v === 'approved' || v === 'executed' || v === 'overridden'
    ? v
    : null;

function toPositionRow(r: PositionSqlRow): PositionRow {
  return {
    id: r.id,
    storeId: r.store_id,
    storeName: r.store_name,
    region: r.region,
    climateZone: r.climate_zone,
    city: r.city,
    storeLat: num(r.store_lat),
    storeLng: num(r.store_lng),
    productId: r.product_id,
    productName: r.product_name,
    category: r.category,
    seasonality: r.seasonality,
    onHandUnits: r.on_hand_units === null ? null : Number(r.on_hand_units),
    onOrderUnits: r.on_order_units === null ? null : Number(r.on_order_units),
    recentUnits7d: r.recent_units_7d === null ? null : Number(r.recent_units_7d),
    avgDailyVelocity: num(r.avg_daily_velocity),
    weeksOfSupply: num(r.weeks_of_supply),
    priceUsd: num(r.price_usd),
    markdownRiskScore: num(r.markdown_risk_score),
    lostSalesExposureUsd: num(r.lost_sales_exposure_usd),
    markdownExposureUsd: num(r.markdown_exposure_usd),
    positionStatus: asStatus(r.position_status),
    recommendedMove: asMove(r.recommended_move),
    predictedRecapturedUsd: num(r.predicted_recaptured_usd),
    liveMoveType: asMove(r.live_move_type),
    actionStatus: asActionStatus(r.action_status),
  };
}

/**
 * The Operations queue. Reads store_sku_position, LEFT JOIN-ing:
 *   - the LATEST ops_actions row for that store×SKU (DISTINCT ON) → the
 *     live recovery state (move badge + "recovery in progress"),
 *   - recovery_recommendations → the model's recommended move.
 *
 * `statusGroup='open'` (default for the queue) filters to stockout/at_risk;
 * pass a specific `positionStatus`, a `climateZone`, or a `store`/`sku`
 * to narrow.
 */
export async function listPositions(
  db: AppDb,
  opts: {
    /** 'open' = stockout|at_risk (the shortfall backlog); 'all' = everything. */
    statusGroup?: 'open' | 'all';
    positionStatus?: PositionStatus;
    climateZone?: string;
    category?: string;
    store?: string;
    sku?: string;
    /** 'exposure' = ORDER BY lost_sales_exposure DESC (default);
     *  'velocity' = ORDER BY avg_daily_velocity DESC. */
    sort?: 'exposure' | 'velocity';
    limit?: number;
  } = {},
): Promise<PositionRow[]> {
  const limit = opts.limit ?? 300;
  const statusGroup = opts.statusGroup ?? 'open';

  const whereStatusGroup =
    opts.positionStatus
      ? sql`AND p.position_status = ${opts.positionStatus}`
      : statusGroup === 'open'
        ? sql`AND p.position_status IN ('stockout', 'at_risk')`
        : sql``;
  const whereZone = opts.climateZone
    ? sql`AND p.climate_zone = ${opts.climateZone}`
    : sql``;
  const whereCategory = opts.category ? sql`AND p.category = ${opts.category}` : sql``;
  const whereStore = opts.store ? sql`AND p.store_id = ${opts.store}` : sql``;
  const whereSku = opts.sku ? sql`AND p.product_id = ${opts.sku}` : sql``;
  const orderBy =
    opts.sort === 'velocity'
      ? sql`ORDER BY p.avg_daily_velocity DESC NULLS LAST`
      : sql`ORDER BY p.lost_sales_exposure_usd DESC NULLS LAST, p.markdown_exposure_usd DESC NULLS LAST`;

  const result = await db.execute(sql`
    SELECT
      p.store_id || ':' || p.product_id AS id,
      p.store_id, p.store_name, p.region, p.climate_zone, p.city,
      p.store_lat, p.store_lng, p.product_id, p.product_name, p.category,
      p.seasonality, p.on_hand_units, p.on_order_units, p.recent_units_7d,
      p.avg_daily_velocity, p.weeks_of_supply, p.price_usd,
      p.markdown_risk_score, p.lost_sales_exposure_usd, p.markdown_exposure_usd,
      p.position_status,
      rr.recommended_move,
      rr.predicted_recaptured_usd,
      la.move_type AS live_move_type,
      la.status AS action_status
    FROM public.gold_store_sku_position p
    LEFT JOIN public.gold_recovery_recommendations rr
      ON rr.store_id = p.store_id AND rr.product_id = p.product_id
    LEFT JOIN LATERAL (
      SELECT a.move_type, a.status
      FROM app.ops_actions a
      WHERE a.store_id = p.store_id AND a.product_id = p.product_id
        AND a.move_type <> 'markdown_hold'
      ORDER BY a.created_at DESC
      LIMIT 1
    ) la ON true
    WHERE 1=1 ${whereStatusGroup} ${whereZone} ${whereCategory} ${whereStore} ${whereSku}
    ${orderBy}
    LIMIT ${limit}
  `);
  return (result.rows as PositionSqlRow[]).map(toPositionRow);
}

export async function getPosition(
  db: AppDb,
  id: string,
): Promise<PositionRow | null> {
  const result = await db.execute(sql`
    SELECT
      p.store_id || ':' || p.product_id AS id,
      p.store_id, p.store_name, p.region, p.climate_zone, p.city,
      p.store_lat, p.store_lng, p.product_id, p.product_name, p.category,
      p.seasonality, p.on_hand_units, p.on_order_units, p.recent_units_7d,
      p.avg_daily_velocity, p.weeks_of_supply, p.price_usd,
      p.markdown_risk_score, p.lost_sales_exposure_usd, p.markdown_exposure_usd,
      p.position_status,
      rr.recommended_move,
      rr.predicted_recaptured_usd,
      la.move_type AS live_move_type,
      la.status AS action_status
    FROM public.gold_store_sku_position p
    LEFT JOIN public.gold_recovery_recommendations rr
      ON rr.store_id = p.store_id AND rr.product_id = p.product_id
    LEFT JOIN LATERAL (
      SELECT a.move_type, a.status
      FROM app.ops_actions a
      WHERE a.store_id = p.store_id AND a.product_id = p.product_id
        AND a.move_type <> 'markdown_hold'
      ORDER BY a.created_at DESC
      LIMIT 1
    ) la ON true
    WHERE p.store_id || ':' || p.product_id = ${id}
    LIMIT 1
  `);
  const row = result.rows[0] as PositionSqlRow | undefined;
  return row ? toPositionRow(row) : null;
}

// ============================================================================
// Shortfall — the shortfall + its nearest surplus (read-only mirror).
// ============================================================================

export type Shortfall = {
  storeId: string;
  productId: string;
  onHandUnits: number | null;
  avgDailyVelocity: number | null;
  lostSalesExposureUsd: number | null;
  nearestSurplusStoreId: string | null;
  nearestSurplusOnHand: number | null;
  nearestSurplusDistanceKm: number | null;
};

export async function getShortfall(
  db: AppDb,
  storeId: string,
  productId: string,
): Promise<Shortfall | null> {
  const res = await db.execute(sql`
    SELECT store_id, product_id, on_hand_units, avg_daily_velocity,
           lost_sales_exposure_usd, nearest_surplus_store_id,
           nearest_surplus_on_hand, nearest_surplus_distance_km
    FROM public.gold_open_shortfalls
    WHERE store_id = ${storeId} AND product_id = ${productId}
    LIMIT 1
  `);
  const r = res.rows[0] as
    | {
        store_id: string;
        product_id: string;
        on_hand_units: number | null;
        avg_daily_velocity: number | string | null;
        lost_sales_exposure_usd: number | string | null;
        nearest_surplus_store_id: string | null;
        nearest_surplus_on_hand: number | null;
        nearest_surplus_distance_km: number | string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    storeId: r.store_id,
    productId: r.product_id,
    onHandUnits: r.on_hand_units === null ? null : Number(r.on_hand_units),
    avgDailyVelocity: num(r.avg_daily_velocity),
    lostSalesExposureUsd: num(r.lost_sales_exposure_usd),
    nearestSurplusStoreId: r.nearest_surplus_store_id,
    nearestSurplusOnHand:
      r.nearest_surplus_on_hand === null ? null : Number(r.nearest_surplus_on_hand),
    nearestSurplusDistanceKm: num(r.nearest_surplus_distance_km),
  };
}

/**
 * The worst OPEN shortfall by lost-sales exposure. Used by the agent's
 * `find_shortfall` tool (Build 2) when the user doesn't name a store×SKU.
 * Ships as a helper so the trainee's tool has a ready query.
 */
export async function worstShortfall(db: AppDb): Promise<Shortfall | null> {
  const res = await db.execute(sql`
    SELECT store_id, product_id, on_hand_units, avg_daily_velocity,
           lost_sales_exposure_usd, nearest_surplus_store_id,
           nearest_surplus_on_hand, nearest_surplus_distance_km
    FROM public.gold_open_shortfalls
    ORDER BY lost_sales_exposure_usd DESC NULLS LAST
    LIMIT 1
  `);
  const r = res.rows[0] as
    | {
        store_id: string;
        product_id: string;
        on_hand_units: number | null;
        avg_daily_velocity: number | string | null;
        lost_sales_exposure_usd: number | string | null;
        nearest_surplus_store_id: string | null;
        nearest_surplus_on_hand: number | null;
        nearest_surplus_distance_km: number | string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    storeId: r.store_id,
    productId: r.product_id,
    onHandUnits: r.on_hand_units === null ? null : Number(r.on_hand_units),
    avgDailyVelocity: num(r.avg_daily_velocity),
    lostSalesExposureUsd: num(r.lost_sales_exposure_usd),
    nearestSurplusStoreId: r.nearest_surplus_store_id,
    nearestSurplusOnHand:
      r.nearest_surplus_on_hand === null ? null : Number(r.nearest_surplus_on_hand),
    nearestSurplusDistanceKm: num(r.nearest_surplus_distance_km),
  };
}

// ============================================================================
// RecoveryRecommendation — the ML model's ranked moves (read-only mirror).
// ============================================================================

export type RecoveryRecommendation = {
  storeId: string;
  productId: string;
  recommendedMove: MoveType | null;
  recommendedSourceStoreId: string | null;
  recommendedSubstituteProductId: string | null;
  recommendedUnits: number | null;
  predictedRecapturedUsd: number | null;
  predictedNetValueUsd: number | null;
  moveRanking: MoveOption[];
};

export async function getRecommendation(
  db: AppDb,
  storeId: string,
  productId: string,
): Promise<RecoveryRecommendation | null> {
  const res = await db.execute(sql`
    SELECT store_id, product_id, recommended_move, recommended_source_store_id,
           recommended_substitute_product_id, recommended_units,
           predicted_recaptured_usd, predicted_net_value_usd, move_ranking
    FROM public.gold_recovery_recommendations
    WHERE store_id = ${storeId} AND product_id = ${productId}
    LIMIT 1
  `);
  const r = res.rows[0] as
    | {
        store_id: string;
        product_id: string;
        recommended_move: string | null;
        recommended_source_store_id: string | null;
        recommended_substitute_product_id: string | null;
        recommended_units: number | null;
        predicted_recaptured_usd: number | string | null;
        predicted_net_value_usd: number | string | null;
        // In the synced Gold table `move_ranking` is TEXT (a JSON string),
        // not jsonb, so it arrives as a string from the driver — parse it.
        move_ranking: string | MoveOption[] | null;
      }
    | undefined;
  if (!r) return null;
  return {
    storeId: r.store_id,
    productId: r.product_id,
    recommendedMove: asMove(r.recommended_move),
    recommendedSourceStoreId: r.recommended_source_store_id,
    recommendedSubstituteProductId: r.recommended_substitute_product_id,
    recommendedUnits: r.recommended_units === null ? null : Number(r.recommended_units),
    predictedRecapturedUsd: num(r.predicted_recaptured_usd),
    predictedNetValueUsd: num(r.predicted_net_value_usd),
    moveRanking: parseMoveRanking(r.move_ranking),
  };
}

/** `move_ranking` in `public.gold_recovery_recommendations` is a TEXT column
 *  holding a JSON array, so the driver returns it verbatim as a string. Parse
 *  defensively — a null/malformed ranking just becomes []. (Tolerates an
 *  already-parsed array too, in case the column type ever changes back.) */
function parseMoveRanking(raw: string | MoveOption[] | null): MoveOption[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as MoveOption[]) : [];
  } catch {
    return [];
  }
}

// ============================================================================
// OpsAction — the writable table (the app's own recovery-action records).
// ============================================================================

export type OpsAction = {
  id: string;
  storeId: string;
  productId: string;
  moveType: MoveType;
  sourceStoreId: string | null;
  units: number | null;
  draftedRequest: string | null;
  predictedRecapturedUsd: number | null;
  status: ActionStatus;
  approvedBy: string | null;
  auditTrail: AuditEntry[];
  createdAt: string;
  decidedAt: string | null;
};

type OpsActionSqlRow = {
  id: string;
  store_id: string;
  product_id: string;
  move_type: string;
  source_store_id: string | null;
  units: number | null;
  drafted_request: string | null;
  predicted_recaptured_usd: number | string | null;
  status: string;
  approved_by: string | null;
  audit_trail: AuditEntry[];
  created_at: string;
  decided_at: string | null;
};

function toOpsAction(r: OpsActionSqlRow): OpsAction {
  return {
    id: r.id,
    storeId: r.store_id,
    productId: r.product_id,
    moveType: (asMove(r.move_type) ?? 'transfer') as MoveType,
    sourceStoreId: r.source_store_id,
    units: r.units === null ? null : Number(r.units),
    draftedRequest: r.drafted_request,
    predictedRecapturedUsd: num(r.predicted_recaptured_usd),
    status: asActionStatus(r.status) ?? 'approved',
    approvedBy: r.approved_by,
    auditTrail: Array.isArray(r.audit_trail) ? r.audit_trail : [],
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

/** All recorded actions for a store×SKU (the drawer's Activity timeline). */
export async function listActionsForPosition(
  db: AppDb,
  storeId: string,
  productId: string,
): Promise<OpsAction[]> {
  const res = await db.execute(sql`
    SELECT id, store_id, product_id, move_type, source_store_id, units,
           drafted_request, predicted_recaptured_usd, status, approved_by,
           audit_trail, created_at, decided_at
    FROM app.ops_actions
    WHERE store_id = ${storeId} AND product_id = ${productId}
    ORDER BY created_at DESC
  `);
  return (res.rows as OpsActionSqlRow[]).map(toOpsAction);
}

// ============================================================================
// Act (Build 3): the human-in-the-loop WRITE to app.ops_actions, plus the
// workflow_events observability log. All writes go to the WRITABLE Postgres
// tables — never the read-only synced mirrors.
// ============================================================================

export type RecordRecoveryActionArgs = {
  storeId: string;
  productId: string;
  moveType: 'transfer' | 'expedite' | 'substitute';
  units: number;
  sourceStoreId: string | null;
  draftedRequest: string;
  predictedRecapturedUsd: number;
  userEmail: string;
};

/**
 * Record an approved recovery move. Filter-driven + transactional
 * (TEMPLATE_MAP pattern #5): inputs are a FILTER + drafted text, never a list
 * of ids. Writes the approved action, a paired markdown-hold on the source
 * surplus for a transfer, and a `decision_committed` workflow event — all in
 * one transaction so the closed loop commits atomically.
 */
export async function recordRecoveryAction(
  db: AppDb,
  args: RecordRecoveryActionArgs,
): Promise<{ actionId: string; markdownHoldId: string | null }> {
  const now = new Date().toISOString();
  return db.transaction(async (tx) => {
    const primaryAudit = [
      {
        at: now,
        by: args.userEmail,
        action: 'approved',
        notes: 'Recovery move recorded',
        tool: 'execute_recovery_action',
      },
    ];
    const ins = await tx.execute(sql`
      INSERT INTO app.ops_actions
        (store_id, product_id, move_type, source_store_id, units, drafted_request,
         predicted_recaptured_usd, status, approved_by, audit_trail, decided_at)
      VALUES (${args.storeId}, ${args.productId}, ${args.moveType}, ${args.sourceStoreId},
              ${args.units}, ${args.draftedRequest}, ${args.predictedRecapturedUsd},
              'approved', ${args.userEmail}, ${JSON.stringify(primaryAudit)}::jsonb, now())
      RETURNING id
    `);
    const actionId = (ins.rows[0] as { id: string }).id;

    let markdownHoldId: string | null = null;
    if (args.moveType === 'transfer' && args.sourceStoreId) {
      const holdNote = `Markdown hold on surplus feeding ${args.storeId} transfer`;
      const holdAudit = [
        {
          at: now,
          by: args.userEmail,
          action: 'markdown_hold',
          notes: holdNote,
          tool: 'execute_recovery_action',
        },
      ];
      const h = await tx.execute(sql`
        INSERT INTO app.ops_actions
          (store_id, product_id, move_type, source_store_id, units, drafted_request,
           predicted_recaptured_usd, status, approved_by, audit_trail, decided_at)
        VALUES (${args.sourceStoreId}, ${args.productId}, 'markdown_hold', ${args.storeId}, 0,
                ${holdNote}, 0, 'approved', ${args.userEmail},
                ${JSON.stringify(holdAudit)}::jsonb, now())
        RETURNING id
      `);
      markdownHoldId = (h.rows[0] as { id: string }).id;
    }

    await tx.execute(sql`
      INSERT INTO app.workflow_events
        (event_type, source, store_id, product_id, action_id, payload)
      VALUES ('decision_committed', 'user', ${args.storeId}, ${args.productId}, ${actionId},
              ${JSON.stringify({
                move_type: args.moveType,
                units: args.units,
                source_store_id: args.sourceStoreId,
                predicted_recaptured_usd: args.predictedRecapturedUsd,
                approved_by: args.userEmail,
                markdown_hold_id: markdownHoldId,
              })}::jsonb)
    `);

    return { actionId, markdownHoldId };
  });
}

/** Append a workflow/observability event (e.g. the scheduled view-scoring
 *  trigger). Timestamped by the DB default. */
export async function logWorkflowEvent(
  db: AppDb,
  ev: {
    eventType: 'view_scored' | 'decision_committed';
    source: 'schedule' | 'system' | 'user';
    storeId?: string | null;
    productId?: string | null;
    actionId?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO app.workflow_events
      (event_type, source, store_id, product_id, action_id, payload)
    VALUES (${ev.eventType}, ${ev.source}, ${ev.storeId ?? null}, ${ev.productId ?? null},
            ${ev.actionId ?? null}, ${JSON.stringify(ev.payload ?? {})}::jsonb)
  `);
}

// ============================================================================
// Lakebase Hybrid Search (Task 6): BM25 + ANN over public.gold_products,
// fused with Reciprocal Rank Fusion (RRF).
//
// `searchProducts` queries the SYNCED public.gold_products table directly
// (BM25 + ANN indexes built in Task 2), so there is no longer any derived
// `app.products` catalog to build at boot.
// ============================================================================

export type ProductMatch = {
  product_id: string;
  product_name: string | null;
  category: string | null;
  price_usd: number | null;
  on_hand_units: number;
};

/**
 * Pure Reciprocal Rank Fusion over two ranked lists.
 *
 * Each item's score = 1/(k + rank₁) + 1/(k + rank₂), where rank is 1-based
 * (i.e. position index + 1). Items appearing in only one list contribute a
 * single term. Ties are broken by product_id string (deterministic).
 *
 * @returns product_ids in descending RRF score order (highest first).
 */
export function rrfFuse(
  listA: { product_id: string }[],
  listB: { product_id: string }[],
  k = 60,
): string[] {
  const scores = new Map<string, number>();
  for (let i = 0; i < listA.length; i++) {
    const id = listA[i].product_id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
  }
  for (let i = 0; i < listB.length; i++) {
    const id = listB[i].product_id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
  }
  return [...scores.entries()]
    .sort(([idA, sA], [idB, sB]) => {
      if (sB !== sA) return sB - sA; // higher score first
      return idA < idB ? -1 : 1; // deterministic tie-break by id
    })
    .map(([id]) => id);
}

/**
 * Fetch a 1024-dim embedding for `query` from the `databricks-gte-large-en`
 * endpoint using service-principal auth.
 *
 * Response shape (OpenAI-compatible):
 *   { "data": [{ "index": 0, "object": "embedding", "embedding": [...1024] }] }
 */
async function embedQuery(host: string, query: string): Promise<number[]> {
  const headers = await authHeadersServicePrincipal();
  headers.set('Content-Type', 'application/json');
  const resp = await fetch(
    `${host}/serving-endpoints/databricks-gte-large-en/invocations`,
    { method: 'POST', headers, body: JSON.stringify({ input: [query] }) },
  );
  if (!resp.ok) {
    throw new Error(`embedding endpoint returned ${resp.status}: ${await resp.text()}`);
  }
  const json = (await resp.json()) as { data: Array<{ embedding: number[] }> };
  return json.data[0].embedding;
}

/**
 * Hybrid BM25 + ANN product search over the synced public.gold_products table,
 * fused with Reciprocal Rank Fusion (RRF).
 *
 * Steps:
 *  1. Embed the query via databricks-gte-large-en (service-principal auth).
 *  2. Run BM25 top-40 (gold_products_bm25 index, score < 0, ASC order).
 *  3. Run ANN top-40 (gold_products_ann index, cosine distance ASC).
 *  4. rrfFuse the two ranked lists → take top-10 ids.
 *  5. Hydrate product details + on-hand from public.gold_store_sku_position.
 *
 * Graceful degradation: if the embedding call fails, falls back to BM25-only
 * top-10 so search always works even when the endpoint is unavailable.
 */
export async function searchProducts(db: AppDb, query: string): Promise<ProductMatch[]> {
  const host = (process.env.DATABRICKS_HOST ?? '').replace(/\/$/, '');

  // ── 1. Embed the query (best-effort — failure → BM25-only) ────────────────
  let embedding: number[] | null = null;
  try {
    embedding = await embedQuery(host, query);
  } catch (err) {
    console.warn('[searchProducts] embedding failed, degrading to BM25-only:', err);
  }

  // ── 2. BM25 leg (always runs) ─────────────────────────────────────────────
  // Score is negative (more negative = more relevant); filter < 0, order ASC.
  const bm25Res = await db.execute(sql`
    WITH scored AS (
      SELECT product_id,
        to_tsvector('english', product_name || ' ' || coalesce(description, ''))
          <@> to_bm25query(to_tsvector('english', ${query}), 'gold_products_bm25') AS score
      FROM public.gold_products
    )
    SELECT product_id FROM scored
    WHERE score < 0
    ORDER BY score ASC
    LIMIT 40
  `);
  const bm25List = bm25Res.rows as Array<{ product_id: string }>;

  // ── 3. Fuse BM25 + ANN (or BM25-only on embedding failure) ───────────────
  let topIds: string[];
  if (embedding !== null) {
    const embStr = `[${embedding.join(',')}]`;
    const annRes = await db.execute(sql`
      SELECT product_id
      FROM public.gold_products
      ORDER BY embedding <=> ${embStr}::vector
      LIMIT 40
    `);
    const annList = annRes.rows as Array<{ product_id: string }>;
    topIds = rrfFuse(bm25List, annList).slice(0, 10);
  } else {
    topIds = bm25List.slice(0, 10).map((r) => r.product_id);
  }

  if (topIds.length === 0) return [];

  // ── 4. Hydrate: fetch details + on-hand from synced tables ────────────────
  const idSqls = topIds.map((id) => sql`${id}`);
  const hydrated = await db.execute(sql`
    SELECT
      p.product_id,
      p.product_name,
      p.category,
      p.price_usd,
      COALESCE(MAX(s.on_hand_units), 0)::int AS on_hand_units
    FROM public.gold_products p
    LEFT JOIN public.gold_store_sku_position s ON s.product_id = p.product_id
    WHERE p.product_id IN (${sql.join(idSqls, sql`, `)})
    GROUP BY p.product_id, p.product_name, p.category, p.price_usd
  `);

  const byId = new Map(
    (
      hydrated.rows as Array<{
        product_id: string;
        product_name: string | null;
        category: string | null;
        price_usd: number | string | null;
        on_hand_units: number | string;
      }>
    ).map((r) => [
      r.product_id,
      {
        product_id: r.product_id,
        product_name: r.product_name,
        category: r.category,
        price_usd: num(r.price_usd),
        on_hand_units: Number(r.on_hand_units),
      } satisfies ProductMatch,
    ]),
  );

  // Return in fused rank order (drop any ids the DB didn't return).
  return topIds.flatMap((id) => {
    const r = byId.get(id);
    return r !== undefined ? [r] : [];
  });
}

// ============================================================================
// KPI summary for the Operations header.
// ============================================================================

export type PositionSummary = {
  lostSalesExposureUsd: number;
  markdownExposureUsd: number;
  openShortfalls: number;
  recoveriesInProgress: number;
};

/**
 * KPI rollup. Lost-sales exposure sums OPEN shortfalls that DON'T yet have a
 * recovery action (so the number ticks down as the agent acts). Markdown
 * exposure sums overstock positions. Open shortfalls counts stockout/at_risk
 * positions without a recovery action; recoveries-in-progress counts the
 * ones that gained one.
 */
export async function positionSummary(db: AppDb): Promise<PositionSummary> {
  const res = await db.execute(sql`
    WITH acted AS (
      SELECT DISTINCT store_id, product_id
      FROM app.ops_actions
      WHERE move_type <> 'markdown_hold'
    )
    SELECT
      COALESCE(SUM(p.lost_sales_exposure_usd) FILTER (
        WHERE p.position_status IN ('stockout','at_risk')
          AND a.store_id IS NULL
      ), 0)::float8 AS lost_sales_exposure_usd,
      COALESCE(SUM(p.markdown_exposure_usd) FILTER (
        WHERE p.position_status = 'overstock'
      ), 0)::float8 AS markdown_exposure_usd,
      COUNT(*) FILTER (
        WHERE p.position_status IN ('stockout','at_risk') AND a.store_id IS NULL
      )::int AS open_shortfalls,
      COUNT(*) FILTER (
        WHERE p.position_status IN ('stockout','at_risk') AND a.store_id IS NOT NULL
      )::int AS recoveries_in_progress
    FROM public.gold_store_sku_position p
    LEFT JOIN acted a
      ON a.store_id = p.store_id AND a.product_id = p.product_id
  `);
  const r = (res.rows[0] ?? {}) as {
    lost_sales_exposure_usd: number | string;
    markdown_exposure_usd: number | string;
    open_shortfalls: number;
    recoveries_in_progress: number;
  };
  return {
    lostSalesExposureUsd: Number(r.lost_sales_exposure_usd ?? 0),
    markdownExposureUsd: Number(r.markdown_exposure_usd ?? 0),
    openShortfalls: r.open_shortfalls ?? 0,
    recoveriesInProgress: r.recoveries_in_progress ?? 0,
  };
}

// ============================================================================
// Store-level aggregation for the store map. One row per store with coords,
// its WORST position status (colors the dot), and exposure. Same
// statusGroup/zone scope as the queue so map + table agree.
// ============================================================================

export type StoreBucket = {
  storeId: string;
  storeName: string | null;
  city: string | null;
  region: string | null;
  climateZone: string | null;
  lat: number;
  lng: number;
  status: PositionStatus;
  positions: number;
  recentVelocity: number;
  lostSalesExposureUsd: number;
  markdownExposureUsd: number;
};

export async function storeBreakdown(
  db: AppDb,
  opts: {
    statusGroup?: 'open' | 'all';
    positionStatus?: PositionStatus;
    climateZone?: string;
    limit?: number;
  } = {},
): Promise<StoreBucket[]> {
  const limit = opts.limit ?? 500;
  const statusGroup = opts.statusGroup ?? 'open';
  const whereStatusGroup = opts.positionStatus
    ? sql`AND p.position_status = ${opts.positionStatus}`
    : statusGroup === 'open'
      ? sql`AND p.position_status IN ('stockout', 'at_risk', 'overstock')`
      : sql``;
  const whereZone = opts.climateZone
    ? sql`AND p.climate_zone = ${opts.climateZone}`
    : sql``;

  // Worst-status ranking so the dot color reflects the store's most urgent
  // position: stockout > at_risk > overstock > healthy.
  const res = await db.execute(sql`
    SELECT
      p.store_id,
      MAX(p.store_name) AS store_name,
      MAX(p.city) AS city,
      MAX(p.region) AS region,
      MAX(p.climate_zone) AS climate_zone,
      AVG(p.store_lat)::float8 AS lat,
      AVG(p.store_lng)::float8 AS lng,
      COUNT(*)::int AS positions,
      COALESCE(SUM(p.recent_units_7d), 0)::float8 / 7.0 AS recent_velocity,
      COALESCE(SUM(p.lost_sales_exposure_usd), 0)::float8 AS lost_sales_exposure_usd,
      COALESCE(SUM(p.markdown_exposure_usd), 0)::float8 AS markdown_exposure_usd,
      MIN(
        CASE p.position_status
          WHEN 'stockout' THEN 0
          WHEN 'at_risk' THEN 1
          WHEN 'overstock' THEN 2
          ELSE 3
        END
      ) AS worst_rank
    FROM public.gold_store_sku_position p
    WHERE p.store_lat IS NOT NULL AND p.store_lng IS NOT NULL
      ${whereStatusGroup} ${whereZone}
    GROUP BY p.store_id
    ORDER BY lost_sales_exposure_usd DESC
    LIMIT ${limit}
  `);
  const RANK_TO_STATUS: PositionStatus[] = [
    'stockout',
    'at_risk',
    'overstock',
    'healthy',
  ];
  return (
    res.rows as Array<{
      store_id: string;
      store_name: string | null;
      city: string | null;
      region: string | null;
      climate_zone: string | null;
      lat: number | string;
      lng: number | string;
      positions: number;
      recent_velocity: number | string;
      lost_sales_exposure_usd: number | string;
      markdown_exposure_usd: number | string;
      worst_rank: number;
    }>
  ).map((r) => ({
    storeId: r.store_id,
    storeName: r.store_name,
    city: r.city,
    region: r.region,
    climateZone: r.climate_zone,
    lat: Number(r.lat),
    lng: Number(r.lng),
    status: RANK_TO_STATUS[r.worst_rank] ?? 'healthy',
    positions: r.positions,
    recentVelocity: Number(r.recent_velocity),
    lostSalesExposureUsd: Number(r.lost_sales_exposure_usd),
    markdownExposureUsd: Number(r.markdown_exposure_usd),
  }));
}

// ============================================================================
// Recent activity — the app's ops_actions rows, newest first. Powers the
// Home page activity feed.
// ============================================================================

export type ActivityEvent = {
  kind: 'action';
  action_id: string;
  store_id: string;
  product_id: string;
  at: string;
  by: string;
  move_type: MoveType;
  status: ActionStatus;
  units: number | null;
  predicted_recaptured_usd: number | null;
  notes: string | null;
};

export async function recentActivity(
  db: AppDb,
  limit = 20,
): Promise<ActivityEvent[]> {
  const res = await db.execute(sql`
    SELECT
      a.id AS action_id,
      a.store_id,
      a.product_id,
      COALESCE(a.decided_at, a.created_at) AS at,
      COALESCE(a.approved_by, 'system') AS by,
      a.move_type,
      a.status,
      a.units,
      a.predicted_recaptured_usd,
      a.drafted_request AS notes
    FROM app.ops_actions a
    ORDER BY COALESCE(a.decided_at, a.created_at) DESC NULLS LAST
    LIMIT ${limit}
  `);
  return (
    res.rows as Array<{
      action_id: string;
      store_id: string;
      product_id: string;
      at: string;
      by: string;
      move_type: string;
      status: string;
      units: number | null;
      predicted_recaptured_usd: number | string | null;
      notes: string | null;
    }>
  ).map((r) => ({
    kind: 'action' as const,
    action_id: r.action_id,
    store_id: r.store_id,
    product_id: r.product_id,
    at: r.at,
    by: r.by,
    move_type: (asMove(r.move_type) ?? 'transfer') as MoveType,
    status: asActionStatus(r.status) ?? 'approved',
    units: r.units === null ? null : Number(r.units),
    predicted_recaptured_usd: num(r.predicted_recaptured_usd),
    notes: r.notes,
  }));
}

// ============================================================================
// Reset demo — writable tables ONLY.
//
// Relocated from the retired db/sync.ts `wipeMirroredTables`. The read-only
// synced Gold mirrors (public.gold_*) are NOT touched here: they are owned by
// the Lakebase sync pipeline and refresh via `Sync now`, not app SQL —
// truncating them would just trigger a re-sync. This truncates only the
// tables the app itself writes, so between demos the backlog looks untouched:
// all agent writes are wiped and exposure/shortfalls return to full.
// ============================================================================
export async function resetDemoTables(db: AppDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE app.feedback RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.messages RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.conversations RESTART IDENTITY CASCADE`);
    // The writable action table — the only place agent writes land.
    await tx.execute(sql`TRUNCATE TABLE app.ops_actions RESTART IDENTITY CASCADE`);
  });
}
