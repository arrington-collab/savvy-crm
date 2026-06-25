# Stage 4: Drive-Time-Aware Assignment + `getRecommendedSlots`

## Position in the Lead-Intake Pipeline

```
lead/created
  └─ load-lead            (Stage 1: resolve customer + property)
  └─ enrich-property      (Stage 2: StormProof — year built, storm history)
  └─ ai-qualify           (Stage 3: hybrid lead scoring)
  └─ assign-lead          (Stage 4: this stage — drive-time-aware rep selection)
  └─ send-sms             (Stage 5: booking link via Twilio)
```

Stage 4 runs inside the `assign-lead` Inngest step, which is durable and idempotent.

---

## Drive-Time Gateway + Fail-Open Behavior

Driving distances are resolved through the `@savvy/integrations` `distance` singleton (`DistanceGateway`). It calls the Google Maps Distance Matrix API when `GOOGLE_MAPS_SERVER_KEY` is set; when the key is absent or the call fails, it falls back to a **fake provider** (`makeFakeDistance`) that computes straight-line-proportional minutes.

The gateway is **fail-open**: if the matrix call returns `null` (network error, quota exceeded), each rep's `driveMinutes` is recorded as `null` and `pickAssignee` degrades to the `least_loaded` tiebreaker. No lead is ever stuck in limbo due to a Maps API outage.

---

## The `"proximity"` Strategy

### How to Enable

Set `tenant.settings.assignment.strategy = "proximity"` (via the admin UI or directly):

```sql
UPDATE tenant
SET settings = jsonb_set(settings, '{assignment,strategy}', '"proximity"')
WHERE id = '<tenantId>';
```

### What Happens at Assignment Time

1. **Destination** — The lead's property lat/lng is fetched from the `property` table.
2. **Lane** — If `property.roof_type = 'tile'`, lane is set to `"tile"` so `pickAssignee` can prefer tile-skilled reps.
3. **Rep origins** — For each eligible rep, `resolveRepOrigin` picks the best origin using the **fallback chain** (see below).
4. **Drive-time matrix** — A single `distance.driveMinutesMatrix(origins, [dest])` call returns drive minutes for every rep with a resolvable origin in one round-trip.
5. **Selection** — `pickAssignee` ranks by `driveMinutes asc` (closest rep wins), with `openLeadCount` as the tiebreaker.

### Origin Fallback Chain (`resolveRepOrigin`)

For a given slot reference time, the rep's origin is resolved in this priority order:

| Priority | Source | Condition |
|----------|--------|-----------|
| 1 | Last same-day appointment location | Rep has a `status='scheduled'` appt ending before the reference time |
| 2 | `user.base_lat` / `user.base_lng` | Rep has a configured home base |
| 3 | `tenant.settings.scheduling.office` | Tenant office is configured |
| 4 | `null` | Rep is excluded from the drive-time ranking; falls to tiebreaker |

---

## `getRecommendedSlots(leadId, opts?)`

**Location:** `apps/web/src/lib/recommended-slots.ts` (Next.js server action)

**Signature:**

```ts
getRecommendedSlots(
  leadId: string,
  opts?: { type?: "inspection" | "cm" | "crew"; limit?: number }
): Promise<
  | { error: "no_lead" | "no_assignee" }
  | { slots: { startsAt: string; endsAt: string; driveMinutes: number | null }[] }
>
```

**What it does:**

1. Resolves the lead's assigned rep and tenant scheduling config.
2. Loads the rep's existing appointments (busy intervals + locations for the origin chain).
3. Calls `computeOpenSlots` to generate up to 12 candidate slots within the booking horizon.
4. Computes the rep's origin for each slot day via `resolveRepOrigin`.
5. Batches one `driveMinutesMatrix` call for all slots with a known origin.
6. Calls `rankSlots` to sort by drive time (ascending) and returns the top `limit` (default 3).

**Who consumes it:** The inspection/CM booking flow in `apps/web` — surfaces the top slots to the rep or customer on the booking page.

---

## Tunable Configuration

### Tenant Settings (`tenant.settings`)

```jsonc
{
  "assignment": {
    "strategy": "proximity"  // "off" | "round_robin" | "least_loaded" | "territory" | "score" | "proximity"
  },
  "scheduling": {
    "office": { "lat": 33.4484, "lng": -112.074 },  // fallback origin for all reps
    "hours": {                      // per-weekday [openHour, closeHour] (UTC); [] = closed
      "mon": [8, 17], "tue": [8, 17], "wed": [8, 17], "thu": [8, 17], "fri": [8, 17],
      "sat": [], "sun": []
    },
    "slotGranularityMin": 30,       // slot step size in minutes
    "bookingHorizonDays": 14,       // how far ahead to offer slots
    "driveTime": {
      // Ranking weights (passed to rankSlots). Slot score =
      // (wSoon*soonest + wDrive*proximity + wCluster*clustering), renormalized.
      "wSoon": 0.5,        // weight on the soonest-feasible slot
      "wDrive": 0.3,       // weight on drive-time proximity (dropped when drive-time unknown)
      "wCluster": 0.2,     // weight on same-day clustering with the rep's existing jobs
      "driveHalfMin": 20   // minutes at which the drive-time score is 0.5
    }
  }
}
```

### User Fields

| Column | Type | Purpose |
|--------|------|---------|
| `user.base_lat` | `double precision` | Rep home base latitude |
| `user.base_lng` | `double precision` | Rep home base longitude |
| `user.skills` | `text[]` | Skill tags (e.g. `["tile"]`) for lane-based filtering |

Set via the user profile UI or migration. Reps without a base fall through to the tenant office fallback.

---

## Required Environment Variable

| Variable | Purpose |
|----------|---------|
| `GOOGLE_MAPS_SERVER_KEY` | Server-side Distance Matrix API key |

Without this key, the fake provider activates. Slot ranking still runs but uses straight-line-proportional minutes instead of real drive times. Assignment and booking continue to work — drive-time ordering is just approximate.
