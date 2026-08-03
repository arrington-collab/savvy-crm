# Canvass Gamification — Design Spec

**Date:** 2026-07-12
**Status:** Approved (design), pending implementation plan
**Scope:** Phases 1–3. Each phase is independently shippable.

## Goal

Add a motivation layer to the canvassing field app that drives **volume** (doors)
and **results** (appointments, sales) and makes competition social and
self-driving. Approved reward model is **all three layered**: recognition
(base) → points/levels (progression) → real spiffs (manager-funded, tracked).

## Architecture — derive from knocks (Approach A)

`canvass_knock` remains the single source of truth. Points, levels, streaks,
and leaderboards are **computed** from knocks, never stored as duplicate state.
Only what cannot be derived is persisted, in four new tenant-scoped tables with
RLS (mirrors the existing canvass table conventions):

- `canvass_achievement` — unlocked badges per rep (idempotent).
- `canvass_challenge` — challenge/contest instances.
- `canvass_challenge_participant` — participants + final scores (for standings).
- `canvass_spiff` — the payout ledger (owed → paid).

All scoring/settlement math lives as **pure functions in `@savvy/core`** (given
knock rows → points / level / streak / unlocked badges / challenge winner), so
it is fully unit-testable and shared by the field app and the server. All
day-bucketing uses `dateKeyInTimeZone(now, tenant.timezone)` — never UTC — per
the EOD report fix (`29befa8`).

Auth/CORS/RLS on every new endpoint copies the existing canvass route pattern:
bearer canvass session (`verifyCanvassToken`) → tenant from session, `withTenant`
for all reads/writes, `canvassCors`, `export const runtime = "nodejs"`, added to
the Clerk public allowlist regex in `apps/web/src/middleware.ts`. Read endpoints
get the `canvass-read` rate-limit bucket; mutations get `canvass` (or a new
`canvass-compete`) bucket, and re-check `isCanvassRepActive`.

---

## Phase 1 — Scoreboard & Recognition

The foundation everything else reads from. No challenges, no money yet.

### Points model (`@savvy/core/canvass-points.ts`)

Pure `scoreKnock(knock, weights)` → points; `scoreRep(knocks, weights)` → total.
Default weights (tenant-configurable via `tenant.settings.canvassPoints`):

| Action | Points |
|---|---|
| Any door (knock logged) | 1 |
| Contact (outcome ≠ `noanswer`) | +2 |
| Callback (`callback`) | +3 (on top of contact) |
| Appointment (`appt`) | +10 (on top of contact) |
| Sale (`sale`) | +25 (on top of contact) + `floor(amount/1000)` capped at +25 |

A knock scores cumulatively: e.g. a sale = 1 (door) + 2 (contact) + 25 + revenue
bonus. Weights favor volume and results together per the approved priority.

### Levels/tiers

Lifetime points → named tier via ascending thresholds (pure `levelFor(points)`):

| Tier | Lifetime points |
|---|---|
| Rookie | 0 |
| Runner | 500 |
| Closer | 2,000 |
| Veteran | 6,000 |
| Legend | 15,000 |

Thresholds are constants in core (tunable). `levelFor` returns
`{ tier, next, pointsToNext, progressPct }` for a progress bar.

### Streaks

`currentStreak(knocks, tz)` / `bestStreak(knocks, tz)` — consecutive **tenant-tz**
calendar days with ≥1 knock. Derived on read; no stored state.

### Leaderboard endpoint

`GET /api/canvass/scoreboard?period=day|week|month|all` → for each active rep:
`{ repId, name, points, rank, tier, streak, doors, appts, sales, revenue }`,
sorted by points. `period` windows knocks by tenant-tz day (reuse EOD bucketing).
Bearer session; `canvass-read` rate limit.

### Achievements (`@savvy/core/canvass-achievements.ts`)

Pure `evaluateAchievements(repKnocks, tz, alreadyUnlocked)` → newly-earned badge
keys. Evaluated server-side on knock sync (in `POST /knocks`, after a successful
upsert) and on scoreboard read; newly-earned keys are inserted into
`canvass_achievement` (unique `(tenant, rep, badge_key)` → idempotent).

Starter badge set (v1):

| Key | Name | Condition |
|---|---|---|
| `first_sale` | First Blood | first `sale` |
| `doors_100` | Century | 100 lifetime doors |
| `doors_1000` | Grand | 1000 lifetime doors |
| `hot_hand` | Hot Hand | 10 doors within any 60-minute window |
| `streak_5` / `streak_10` / `streak_30` | Iron Streak | 5 / 10 / 30-day streak |
| `rainmaker` | Rainmaker | ≥ $25,000 sales in one tenant-tz day |
| `early_bird` | Early Bird | a knock before 8:00 local |
| `pitch_perfect` | Pitch Perfect | 5/5 pitch quota met (client-reported; see Open Questions) |

A toast fires in the app when a new badge lands (diff of unlocked set on sync).

### Recognition surfaces

- `GET /api/canvass/scoreboard` powers a new **Compete** tab: leaderboard with
  period toggle, points, tier, streak; the current period leader flagged.
- **👑 crown** on the current all-period leader's map avatar (extends the
  existing manager avatar `divIcon`).
- Rep profile: badges earned + progress to next tier.

### Phase 1 tables

Only `canvass_achievement` is needed for Phase 1:

```
canvass_achievement(id, tenant_id, rep_id, badge_key, unlocked_at, meta jsonb,
                    unique(tenant_id, rep_id, badge_key))
```

---

## Phase 2 — Challenges

Three challenge kinds share `canvass_challenge` + `canvass_challenge_participant`.
Standings are **derived** from participants' knocks within the window; only the
instance, participants, status, and winner persist.

```
canvass_challenge(id, tenant_id, kind, metric, window_start, window_end,
                  status, created_by_rep_id, winner_rep_id, meta jsonb,
                  created_at, settled_at)
  kind    ∈ {h2h, koth, contest}
  metric  ∈ {points, doors, contacts, appts, sales, revenue}
  status  ∈ {pending, active, settled, declined, cancelled}

canvass_challenge_participant(id, tenant_id, challenge_id, rep_id,
                              accepted_at, final_score,
                              unique(challenge_id, rep_id))
```

Pure `metricValue(knocks, metric, weights)` computes any metric from a knock set,
so standings, leaderboards, and challenges all share one function.

### Kinds

- **Daily head-to-head (`h2h`):** rep A challenges rep B on a metric for the
  current tenant-tz day. B accepts (or it stays `pending`). At day end the
  settler compares `metricValue` for each over the window → `winner_rep_id`, both
  participants' `final_score` recorded. A running **W/L record** between any two
  reps is derived from settled h2h challenges.
- **King-of-the-hill (`koth`):** per metric, the current period leader holds the
  "throne." A challenger opens a time-boxed duel (window = rest of today or 24h);
  if the challenger's window metric beats the holder's, they take the throne and
  earn a `king_<metric>` badge. Throne holder shown crowned on that metric's
  leaderboard. Throne = derived (current leader) until an active koth challenge
  resolves it.
- **Manager contest (`contest`):** a manager (rep with manager flag) creates a
  contest — metric, window, participant set (whole team or selected). App shows
  live standings; at window end the settler ranks participants by `metricValue`,
  sets `winner_rep_id`, records each `final_score`. Prize pool handled in Phase 3.

### Endpoints

- `POST /api/canvass/challenge` — create (h2h/koth/contest). Manager-only for
  `contest`. Body: kind, metric, window, targetRepId (h2h/koth) or participantIds
  (contest), optional wager/prizePool (Phase 3).
- `POST /api/canvass/challenge/:id/accept` — target accepts an h2h/koth.
- `POST /api/canvass/challenge/:id/decline` / `cancel`.
- `GET /api/canvass/challenges?scope=mine|active|settled` — with live standings
  computed on read.
- Settlement: extend the daily cron (`stormAlertDaily` pattern) with a
  `challengeSettler` that finds `active` challenges past `window_end`, computes
  winners via the pure settler, writes results. Also settle opportunistically on
  read when a window has passed (so results don't wait for the cron).

Live-ness: the field app refreshes challenge standings on the existing 30-second
team sync — no new polling.

---

## Phase 3 — Spiffs & payouts

A ledger only — **no payment processing**. Reps settle in real life and mark paid.

```
canvass_spiff(id, tenant_id, challenge_id (nullable), kind, amount_cents,
              winner_rep_id, from_rep_id (nullable), status, note,
              created_at, settled_at)
  kind   ∈ {wager, contest_prize, manual}
  status ∈ {owed, paid, void}
```

- **Wager:** optional `amount` on an h2h/koth challenge; on settle the loser owes
  the winner → one `canvass_spiff` (kind `wager`, status `owed`,
  from_rep_id = loser, winner_rep_id = winner).
- **Contest prize:** manager funds a `prizePool` on a contest; on settle the pool
  is distributed to winner(s) → `canvass_spiff` rows (kind `contest_prize`,
  from_rep_id = null).
- **Manual:** manager awards a spiff anytime (kind `manual`).
- Ledger surface: a **Spiffs** screen (manager) — owed/paid per rep, running
  totals; mark-paid action flips `status` and stamps `settled_at`.

### Endpoints

- `GET /api/canvass/spiffs?scope=mine|all` — mine (rep sees their own owed/won);
  all (manager sees the full ledger).
- `POST /api/canvass/spiff` — manager creates a manual spiff.
- `POST /api/canvass/spiff/:id/paid` — manager marks paid.
- Wager/prize spiffs are created by the settler on challenge/contest settlement.

---

## Field app UI

New **Compete** tab (nav) with sub-sections:

- **Leaderboard** — period toggle, rank, points, tier, streak, crown on leader.
- **Me** — my tier + progress bar, badges earned + next-badge hints, my streak.
- **Challenges** — active challenges with live standings; "Challenge a teammate"
  (pick rep, metric, kind); accept/decline incoming; W/L records; metric thrones.
- **Contests / Spiffs** (manager) — create contest; spiff ledger with mark-paid.

Map: 👑 crown on the leader's avatar. Toasts on badge-unlock and challenge
win/loss. All computed client-side from the scoreboard/challenge endpoints +
synced knocks; the app already syncs team knocks every 30s.

---

## Testing

- **Pure core** (`@savvy/core`): `scoreKnock`/`scoreRep`, `levelFor`, streaks,
  `metricValue`, `evaluateAchievements`, and challenge settlement — table-driven
  unit tests (given knocks → expected points/tier/streak/badges/winner). Include
  the tenant-tz day-boundary cases (an after-5pm-Phoenix knock counts on the
  right day).
- **DB-backed** (`packages/db` / route logic): achievement insert idempotency,
  challenge create/accept/settle, spiff owed→paid — seed tenant + reps + knocks,
  assert, following `canvass-knock-upsert.test.ts`.
- `pnpm typecheck && pnpm lint && pnpm test` clean per phase; the pre-existing
  `@savvy/integrations` vapi.ts error is ignored.

## Non-goals (YAGNI)

- No real payment processing — spiffs are a ledger reps settle IRL.
- No cross-tenant / global leaderboards.
- No bracket seeding for contests v1 — simple ranked standings.
- Points weights are configurable but ship with the defaults above; no in-app
  weight editor in v1 (change via `tenant.settings`).

## Open questions

- **Pitch Perfect / pitch-based points:** pitch recordings live only in the
  field app's IndexedDB, not the server. The `pitch_perfect` badge and any
  pitch-based scoring would need the app to report daily pitch counts to the
  server (a small addition) or be evaluated client-side. Proposed: defer
  pitch-based achievements to a Phase 1 fast-follow; ship the knock-derived
  badges first.
- **Level thresholds** and the **hot_hand / rainmaker** numbers are first-guess;
  tune after seeing real Northwind point distributions.
