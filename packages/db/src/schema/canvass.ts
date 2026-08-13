import { pgTable, uuid, text, boolean, index, jsonb, doublePrecision, integer, numeric, date, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// A canvassing field rep — a lightweight per-tenant identity (NOT a Clerk user)
// that logs into the door-knocking app with an individual PIN (scrypt hash, via
// @savvy/core hashPin/verifyPin). Deactivate with active=false; the rep's knocks
// are retained (Slice 4). Names are used to self-identify at the login screen.
export const canvassRep = pgTable("canvass_rep", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  name: text("name").notNull(),
  pinHash: text("pin_hash").notNull(),
  photoUrl: text("photo_url"),
  // Managers are sales reps too: same login + knock/contract flow, plus the
  // manager views (dashboard, EOD, team) in the field app.
  manager: boolean("manager").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index("canvass_rep_tenant_idx").on(t.tenantId), tenantIsolation()]);

// A canvassing territory (drawn polygon) shared across the tenant's reps.
// `clientId` is the field app's local id — the unique (tenant, clientId) index
// makes POST /territories idempotent on retry and lets knocks reference their
// territory by the id the device knows. Null on legacy/web-created rows.
export const canvassTerritory = pgTable("canvass_territory", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  clientId: text("client_id"),
  name: text("name").notNull(),
  color: text("color"),
  points: jsonb("points").$type<number[][]>().notNull(),
  // Phase 26 slice 2: blitz auto-territories. Windowed (day-before through
  // build-end) and carrying job context for the route ("roofing on <street>
  // through Friday" — street name, never a house number). campaign_id threads
  // knock/sale attribution back to the blitz. All null on manual territories.
  jobId: uuid("job_id"),
  campaignId: uuid("campaign_id"),
  activeFrom: timestamp("active_from", { withTimezone: true }),
  activeUntil: timestamp("active_until", { withTimezone: true }),
  context: text("context"),
  createdAt: createdAt(),
}, (t) => [
  index("canvass_territory_tenant_idx").on(t.tenantId),
  uniqueIndex("canvass_territory_client_uniq").on(t.tenantId, t.clientId).where(sql`${t.clientId} IS NOT NULL`),
  tenantIsolation(),
]);

// A logged door-knock. Synced from the field app so the whole team shares the
// map, and managers get real rollups. `clientId` is the app's local id — a
// unique (tenant, clientId) index makes POST /knock idempotent on retry.
// `gpsFlagged` / `gpsDistanceM` capture door-vs-rep-GPS mismatch (Slice 3).
export const canvassKnock = pgTable("canvass_knock", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  repId: uuid("rep_id").notNull().references(() => canvassRep.id),
  clientId: text("client_id").notNull(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  outcome: text("outcome").notNull(), // noanswer|notint|callback|appt|sale
  address: text("address"),
  contactName: text("contact_name"),
  contactPhone: text("contact_phone"),
  notes: text("notes"),
  amount: doublePrecision("amount"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  contractSignedAt: timestamp("contract_signed_at", { withTimezone: true }),
  leadId: uuid("lead_id"), // soft ref to lead(id); no FK to avoid a cross-schema import cycle
  territoryId: uuid("territory_id"),
  gpsFlagged: boolean("gps_flagged").notNull().default(false),
  gpsDistanceM: integer("gps_distance_m"),
  createdAt: createdAt(),
}, (t) => [
  index("canvass_knock_tenant_idx").on(t.tenantId),
  index("canvass_knock_tenant_rep_idx").on(t.tenantId, t.repId),
  uniqueIndex("canvass_knock_client_uniq").on(t.tenantId, t.clientId),
  tenantIsolation(),
]);

// Cached StormProof lookups for the door dossier, keyed by rounded coordinates
// so repeat knocks on the same door never re-charge the gateway. kind is
// "storms" (TTL ~7 days) or "property" (TTL ~30 days) — freshness is enforced
// by the reader (@savvy/core dossierCacheFresh), not the table.
export const dossierCache = pgTable("dossier_cache", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  kind: text("kind").notNull(), // storms | property
  coordKey: text("coord_key").notNull(), // dossierCoordKey(lat,lng) — 4-dp rounded "lat,lng"
  payload: jsonb("payload"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("dossier_cache_tenant_kind_coord_uniq").on(t.tenantId, t.kind, t.coordKey),
  tenantIsolation(),
]);

// Unlocked achievement badges per rep (Approach A: everything else is derived
// from canvass_knock; only badge unlocks persist). Idempotent via the unique
// (tenant, rep, badge_key) index.
export const canvassAchievement = pgTable("canvass_achievement", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  repId: uuid("rep_id").notNull().references(() => canvassRep.id),
  badgeKey: text("badge_key").notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>().default({}).notNull(),
  unlockedAt: createdAt(),
}, (t) => [
  uniqueIndex("canvass_achievement_uniq").on(t.tenantId, t.repId, t.badgeKey),
  index("canvass_achievement_tenant_idx").on(t.tenantId),
  tenantIsolation(),
]);

// A gamification challenge/contest. Standings are DERIVED from participants'
// knocks within [windowStart, windowEnd); only the instance + settled winner
// persist. kind h2h|koth|contest, metric points|doors|contacts|appts|sales|
// revenue, status pending|active|settled|declined|cancelled.
export const canvassChallenge = pgTable("canvass_challenge", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  kind: text("kind").notNull(),
  metric: text("metric").notNull(),
  status: text("status").notNull().default("pending"),
  createdByRepId: uuid("created_by_rep_id").notNull().references(() => canvassRep.id),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  winnerRepId: uuid("winner_rep_id").references(() => canvassRep.id),
  meta: jsonb("meta").$type<Record<string, unknown>>().default({}).notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("canvass_challenge_tenant_idx").on(t.tenantId),
  index("canvass_challenge_tenant_status_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);

// A participant in a challenge; final_score is stamped at settlement. The unique
// (challenge, rep) index keeps a rep from joining a challenge twice.
export const canvassChallengeParticipant = pgTable("canvass_challenge_participant", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  challengeId: uuid("challenge_id").notNull().references(() => canvassChallenge.id),
  repId: uuid("rep_id").notNull().references(() => canvassRep.id),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  finalScore: doublePrecision("final_score"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("canvass_challenge_participant_uniq").on(t.challengeId, t.repId),
  index("canvass_challenge_participant_tenant_idx").on(t.tenantId),
  tenantIsolation(),
]);

// A money ledger entry for spiffs — wagers, contest prizes, or manual bonuses
// owed to a rep. kind wager|contest_prize|manual, status owed|paid|void.
// challengeId is set null on delete since the ledger entry should outlive a
// deleted challenge; the rep FKs cascade since a deleted rep's ledger has no
// meaning.
export const canvassSpiff = pgTable("canvass_spiff", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
  challengeId: uuid("challenge_id").references(() => canvassChallenge.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  amountCents: integer("amount_cents").notNull(),
  winnerRepId: uuid("winner_rep_id").notNull().references(() => canvassRep.id, { onDelete: "cascade" }),
  fromRepId: uuid("from_rep_id").references(() => canvassRep.id, { onDelete: "set null" }),
  status: text("status").notNull().default("owed"),
  note: text("note"),
  createdAt: createdAt(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (t) => [
  index("canvass_spiff_tenant_idx").on(t.tenantId),
  index("canvass_spiff_winner_idx").on(t.winnerRepId),
  tenantIsolation(),
]);

// An alert delivered to a rep — e.g. a sale that closed without a signed
// contract yet (kind 'sale_no_contract'), so the rep/manager can follow up.
// knockId is set null on delete since the alert should outlive a deleted
// knock; leadId is a soft ref (no FK) used only for the CRM deep-link.
export const canvassAlert = pgTable("canvass_alert", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // 'sale_no_contract'
  repId: uuid("rep_id").notNull().references(() => canvassRep.id, { onDelete: "cascade" }), // recipient
  knockId: uuid("knock_id").references(() => canvassKnock.id, { onDelete: "set null" }),
  leadId: uuid("lead_id"), // soft ref for the CRM deep-link
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
  readAt: timestamp("read_at", { withTimezone: true }),
}, (t) => [
  index("canvass_alert_tenant_rep_idx").on(t.tenantId, t.repId, t.readAt),
  index("canvass_alert_knock_idx").on(t.knockId),
  tenantIsolation(),
]);

// A homeowner's scan of a rep's digital ID page (public QR/link, no auth) —
// captures optional self-identification (name/phone) plus an ack timestamp
// once the homeowner confirms the rep's identity. userAgent is stored for
// abuse/debugging context, not analytics.
export const canvassScan = pgTable("canvass_scan", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
  repId: uuid("rep_id").notNull().references(() => canvassRep.id, { onDelete: "cascade" }),
  name: text("name"),
  phone: text("phone"),
  ack: boolean("ack").notNull().default(false),
  ackAt: timestamp("ack_at", { withTimezone: true }),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
}, (t) => [
  index("canvass_scan_tenant_created_idx").on(t.tenantId, t.createdAt),
  tenantIsolation(),
]);

// A GPS breadcrumb ping from a rep's field-app session, used to render the
// live/historical movement trail alongside their knocks. `at` is the
// device-reported timestamp (may lag createdAt on sync/retry).
export const canvassPing = pgTable("canvass_ping", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
  repId: uuid("rep_id").notNull().references(() => canvassRep.id, { onDelete: "cascade" }),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("canvass_ping_tenant_rep_at_idx").on(t.tenantId, t.repId, t.at),
  tenantIsolation(),
]);

// A recently-sold home, dropped on the field-app map so reps can target new
// homeowners (the strongest lead signal in pest control — new owners buy plans).
// Rows are bulk-loaded weekly and pruned once they pass expiresAt.
//
// Tenant-scoped even though sale records are public and identical for everyone:
// it matches dossierCache (which caches public storm data per tenant), the
// volume is trivial (~800 sales/week x 90-day window ~= 10k rows), and it makes
// the source region per-tenant config instead of one region for all tenants.
//
// These are NOT rep pins. Rep-authored pins live in canvassKnock, so "the
// weekly job must never touch a rep's own pins" is guaranteed by the schema
// rather than by careful code.
export const canvassSoldListing = pgTable("canvass_sold_listing", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
  mls: text("mls"), // not every source supplies one
  address: text("address").notNull(),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  // The feed already carries coordinates, so nothing here needs geocoding.
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  soldDate: date("sold_date").notNull(),
  price: integer("price"), // whole dollars
  propertyType: text("property_type"),
  beds: integer("beds"),
  baths: numeric("baths"), // 2.5 baths is real
  sqft: integer("sqft"),
  yearBuilt: integer("year_built"),
  url: text("url"),
  source: text("source").notNull().default("redfin_recently_sold"),
  // Normalized MLS, else address+zip. The unique index below is the whole
  // idempotency story: overlapping weeks and re-runs insert only new homes.
  dedupeKey: text("dedupe_key").notNull(),
  expiresAt: date("expires_at").notNull(), // soldDate + tenant's expiryDays
  // The sign's own lifecycle, set on the pin — deliberately NOT derived from
  // knock outcomes (see the goback-routing spec). new|goback|notint|appt|
  // customer|dnk. `notint` hides 7 days after statusAt; `dnk` never hides,
  // because it exists to stop the next rep walking up to that door.
  status: text("status").notNull().default("new"),
  statusAt: timestamp("status_at", { withTimezone: true }).defaultNow().notNull(),
  statusByRepId: uuid("status_by_rep_id").references(() => canvassRep.id, { onDelete: "set null" }),
  // Claimed via pin-drop routing. Auto-releases 30 days after assignedAt — the
  // eligibility predicate enforces it directly, so a stale claim is reclaimable
  // even if no cleanup job has run.
  assignedRepId: uuid("assigned_rep_id").references(() => canvassRep.id, { onDelete: "set null" }),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  routeSeq: integer("route_seq"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("canvass_sold_tenant_source_dedupe_uniq").on(t.tenantId, t.source, t.dedupeKey),
  index("canvass_sold_tenant_lat_lng_idx").on(t.tenantId, t.lat, t.lng),
  index("canvass_sold_tenant_source_expires_idx").on(t.tenantId, t.source, t.expiresAt),
  index("canvass_sold_tenant_assigned_idx").on(t.tenantId, t.assignedRepId, t.routeSeq),
  index("canvass_sold_tenant_status_idx").on(t.tenantId, t.status, t.statusAt),
  tenantIsolation(),
]);
