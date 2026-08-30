import {
  text,
  timestamp,
  uuid,
  integer,
  doublePrecision,
  jsonb,
  pgSchema,
  index,
  uniqueIndex,
  boolean,
} from 'drizzle-orm/pg-core';

/**
 * Lakebase schema, under `app.*` — NorthPeak Store Ops.
 *
 * Two groups managed HERE (writable, app-owned):
 *   1. Chat state      (conversations, messages, feedback) — REUSE AS-IS.
 *                      Every use case has chat. The `thinking` + `error`
 *                      jsonb/text columns on `messages` make conversations
 *                      reload-safe with full reasoning trails preserved.
 *   2. Write-surface   `ops_actions` — the ONLY table the app writes. A
 *                      UC synced table is read-only in Postgres, so the
 *                      Act layer records approved transfers / markdown
 *                      holds here. Append-only `audit_trail` JSONB makes
 *                      each action row a standalone timeline the drawer
 *                      Activity tab renders from one read.
 *
 * Why Lakebase: transactional Postgres semantics sitting next to the
 * lakehouse, with Unity Catalog governance. Lets the app do real
 * transactional writes while the analytics layer still queries Delta.
 */
export const appSchema = pgSchema('app');

// ============================================================================
// Chat state
// ============================================================================

export const conversations = appSchema.table(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userEmail: text('user_email').notNull(),
    title: text('title').notNull(),
    // 'default' for regular chats, 'demo_dock' for the floating dock's
    // persistent conversation (one per user).
    kind: text('kind', { enum: ['default', 'demo_dock'] })
      .notNull()
      .default('default'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('conversations_user_idx').on(t.userEmail, t.updatedAt),
    index('conversations_kind_idx').on(t.userEmail, t.kind),
  ],
);

export const messages = appSchema.table(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    position: integer('position').notNull(),
    traceId: text('trace_id'),
    // Captured reasoning steps (tool calls, outputs, intermediate messages)
    // for assistant messages. Shape matches client's ThinkingEvent union.
    thinking: jsonb('thinking').$type<ThinkingEntry[]>().notNull().default([]),
    // If the agent run failed, the error message is persisted here so a
    // page reload still shows what went wrong (instead of an empty bubble).
    error: text('error'),
    // True when the turn was stopped by the user (Stop button or page
    // navigation away from an in-flight stream). The assistant's partial
    // streamed content is still kept in `content` for context; the UI
    // renders a "Canceled by the user" banner below it.
    canceled: boolean('canceled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Unique on (conversation_id, position) so the `SELECT MAX + 1` race in
    // appendMessage surfaces as a constraint error (caller retries) instead
    // of silently inserting two messages at the same position — which
    // would break the on-reload ordering. Doubles as the lookup index.
    uniqueIndex('messages_convo_pos_uq').on(t.conversationId, t.position),
  ],
);

export const feedback = appSchema.table(
  'feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userEmail: text('user_email').notNull(),
    value: text('value', { enum: ['up', 'down'] }).notNull(),
    rationale: text('rationale'),
    traceId: text('trace_id'),
    mlflowAssessmentId: text('mlflow_assessment_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('feedback_message_idx').on(t.messageId)],
);

// ============================================================================
// Read-only synced Gold tables (Lakebase Synced Tables) — NOT MANAGED HERE.
//
// `public.gold_store_sku_position`, `public.gold_open_shortfalls`, and
// `public.gold_recovery_recommendations` are managed by the Lakebase sync
// pipeline (owner: `databricks_writer`), NOT by Drizzle. The app reads them
// via RAW SQL (`sql\`… FROM public.gold_*\``) in db/queries/stores.ts and
// synthesizes the composite `id` (`store_id || ':' || product_id`) in the
// SELECT — those tables have no `id` column. They are intentionally ABSENT
// from this Drizzle schema so migrations never try to create/alter/drop them.
// ============================================================================

// ============================================================================
// Writable operational table (the app writes here — Build-1 writable table)
//
// `ops_actions` is the ONLY table the app writes. An approved transfer
// inserts a row here (move + drafted request + who approved); a markdown-
// hold on the source surplus inserts a paired `markdown_hold` row. The
// Operations queue derives a position's live state by LEFT JOIN-ing
// `store_sku_position` → its latest `ops_actions` row (so "recovery in
// progress" + the move badge come from the writable table, and the
// read-only synced position is never mutated). The append-only
// `audit_trail` makes each row a standalone timeline for the drawer.
// ============================================================================

export const opsActions = appSchema.table(
  'ops_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: text('store_id').notNull(),
    productId: text('product_id').notNull(),
    moveType: text('move_type', {
      enum: ['transfer', 'expedite', 'substitute', 'markdown_hold'],
    }).notNull(),
    sourceStoreId: text('source_store_id'),
    units: integer('units'),
    // The transfer / markdown memo the agent drafted.
    draftedRequest: text('drafted_request'),
    predictedRecapturedUsd: doublePrecision('predicted_recaptured_usd'),
    status: text('status', {
      enum: ['proposed', 'approved', 'executed', 'overridden'],
    })
      .notNull()
      .default('approved'),
    // OBO-stamped viewing user's email.
    approvedBy: text('approved_by'),
    // Append-only audit trail. Each entry: { at, by, action, notes?, tool? }
    auditTrail: jsonb('audit_trail').$type<AuditEntry[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    index('ops_actions_store_idx').on(t.storeId, t.productId),
    index('ops_actions_created_idx').on(t.createdAt),
  ],
);

// ============================================================================
// workflow_events — the Lakebase workflow-state + observability table.
// Append-only log of TRIGGER events (the scheduled scorer re-ranking the view
// — a system update, not a person opening it) and DECISION events (a recovery
// action committed). Every row is timestamped; decision rows link to the
// ops_actions id + the store×SKU so the decision chain is traceable.
// ============================================================================
export const workflowEvents = appSchema.table(
  'workflow_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // 'view_scored' (scheduled trigger) | 'decision_committed' (writeback).
    eventType: text('event_type', {
      enum: ['view_scored', 'decision_committed'],
    }).notNull(),
    // 'schedule' | 'system' | 'user' — schedule/system score higher than a
    // person opening the view.
    source: text('source', { enum: ['schedule', 'system', 'user'] }).notNull(),
    storeId: text('store_id'),
    productId: text('product_id'),
    // FK-ish link to the committed action (decision rows only).
    actionId: uuid('action_id'),
    // Free-form structured detail: top shortfalls scored, the move approved, etc.
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('workflow_events_type_idx').on(t.eventType, t.createdAt),
    index('workflow_events_store_idx').on(t.storeId, t.productId),
  ],
);

// ============================================================================
// JSONB entry shapes
// ============================================================================

/** One option in the ML model's ranked recovery list (on
 *  `recovery_recommendations.move_ranking`). */
export type MoveOption = {
  move: 'transfer' | 'expedite' | 'substitute' | 'markdown_hold';
  units: number;
  costUsd: number;
  predictedRecapturedUsd: number;
  predictedNetValueUsd: number;
  sourceStoreId?: string | null;
  substituteProductId?: string | null;
};

export type AuditEntry = {
  at: string;
  by: string;
  action:
    | 'proposed'
    | 'approved'
    | 'executed'
    | 'overridden'
    | 'markdown_hold'
    | 'note';
  notes?: string;
  tool?: string;
};

export type ThinkingEntry =
  | { kind: 'tool_call'; callId: string; name: string; args: string }
  | { kind: 'tool_output'; callId: string; output: string }
  | { kind: 'intermediate_message'; text: string };
