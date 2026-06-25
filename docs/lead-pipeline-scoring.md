# Lead Pipeline — Scoring, Lanes & Dedupe

> How Atlas scores incoming leads, routes them into lanes, deduplicates them, and
> how operators can tune the model per tenant.

---

## 1. Scoring model

Every lead gets a **0–100 integer score** composed of three weighted sub-scores,
each normalised to 0–1 before weighting:

| Component | Default weight | What it measures |
|-----------|---------------|-----------------|
| Storm     | 47            | Hail/wind severity × recency at the property |
| Roof      | 33            | Roof age within the sweet spot + material bump |
| Source    | 20            | Historical close-rate proxy by lead origin |

`score = round(100 × (w_storm·S + w_roof·R + w_source·Q) / (w_storm + w_roof + w_source))`

### 1a. Storm sub-score (0–1)

`S = severity × recency × multi-event bump`

**Severity** (the higher of hail or wind wins):

| Hail size | Severity | Wind speed | Severity |
|-----------|----------|------------|----------|
| ≥ 1.5"    | 1.00     | ≥ 58 mph   | 0.60     |
| ≥ 1.0"    | 0.70     | ≥ 45 mph   | 0.35     |
| ≥ 0.75"   | 0.40     | < 45 mph   | 0.00     |
| < 0.75"   | 0.00     |            |          |

**Recency factor** (applied to severity):

| Months since worst event | Multiplier |
|--------------------------|-----------|
| ≤ 6                      | 1.00      |
| ≤ 12                     | 0.85      |
| ≤ 18                     | 0.55      |
| ≤ 24                     | 0.30      |
| > 24                     | 0.00      |
| Unknown (undated event)  | 0.50      |

**Multi-event bump:** if `eventCount ≥ 2`, multiply S by `1 + multiEventBumpPct`
(default +10%), then clamp to [0, 1].

### 1b. Roof sub-score (0–1)

```
ramp = clamp((roofAgeYears - roofAgeMinYears) / (roofAgeMaxYears - roofAgeMinYears), 0, 1)
R = ramp + tileBump   (if roofType === "tile", capped at 1.0)
```

Defaults: `roofAgeMinYears = 10`, `roofAgeMaxYears = 22`, `tileBump = 0.1`.
If `roofAgeYears` is unknown, R = 0.5 (neutral — not penalised).

### 1c. Source sub-score (0–1)

Looks up `source.toLowerCase()` in a quality map; falls back to `sourceDefault`
(0.4) for unknown sources.

Default source quality map:

| Source          | Quality |
|-----------------|---------|
| referral        | 1.00    |
| repeat          | 0.95    |
| carrier         | 0.80    |
| storm_canvass   | 0.70    |
| google          | 0.50    |
| website / web   | 0.45    |
| door_knock      | 0.45    |
| facebook        | 0.40    |
| yard_sign       | 0.35    |
| manual          | 0.30    |
| other           | 0.25    |
| *(unknown)*     | 0.40    |

### 1d. Score bands

| Band | Minimum score (default) |
|------|------------------------|
| hot  | 80                     |
| warm | 60                     |
| cool | 40                     |
| cold | < 40                   |

`band` is stored on `lead.scoreBand` (text). Exposed on the lead detail card
alongside the numeric score.

---

## 2. Disqualification gates

Gates short-circuit scoring and return `score = 0, band = "cold", disqualified = true`.

| Gate | Condition | Reason shown |
|------|-----------|-------------|
| Out-of-area | `serviceAreaStates` is configured AND `lead.state` is known AND NOT in the list | "Out of area — disqualified" |
| Dormant renter | `occupancyType === "renter"` — applies `renterMultiplier` (default 0.5) to the weighted score instead of a hard disqualify (guard is dormant until occupancy data exists) | n/a |

---

## 3. Lane assignment

Lane is derived from the lead's properties **after** scoring. Precedence:

1. **Storm lane** — storm sub-score ≥ `stormLaneThreshold` (default 0.3). The
   storm is the primary driver; route to storm-response workflow.
2. **Tile lane** — `roofType === "tile"`. Tile jobs need specialised crews and
   pricing; route to tile workflow.
3. **Standard lane** — everything else.

Lane is stored on `lead.lane` and drives which Inngest workflow handles the lead.

---

## 4. Nightly re-score cron

An Inngest cron (`lead-rescore`) fires nightly at **03:00 America/Phoenix**. Per tenant it:

1. Loads all **open** leads (status `new` / `contacted` / `qualified` / `booked` — i.e. not `won` / `lost`) that have property coordinates.
2. Re-fetches storm data for each property (storm events update continuously); a StormProof failure for one lead is logged and skipped (fail-open).
3. Re-runs `scoreLead()` + `deriveLane()` with the tenant's current `parseScoringConfig`.
4. Writes updated `score`, `scoreBand`, `scoreReason`, `scoreFeatures`, `lane`.
5. Records an `agentRun` audit (`lead.rescore.upgraded`) when any lead's band improved — the band itself lives on the lead row for the UI (there is no per-user push channel yet).

This means band changes surface automatically as fresh storms hit (or age out of
recency windows) without any manual trigger.

---

## 5. Dedupe rule

On lead intake (`createLeadForTenant`), Savvy checks for an existing **customer**
in the same tenant whose contact exactly matches either:

- Exact normalized phone (E.164) — OR —
- Exact normalized email (lowercased)

If a customer matches, the new intake **reuses that customer** (the oldest, if
several match) and reuses one of their properties only when the normalized
address matches exactly; otherwise a new property is inserted under that
customer. A **new lead is always created** and linked to the resolved
customer/property. The operation is strictly non-destructive: existing customer
and property rows are never updated or deleted. Address-only matches (no
phone/email match) are **not** deduped, to avoid false merges.

---

## 6. Tuning via `tenant.settings.scoring`

Store a JSON object at `tenant.settings.scoring` to override any default.
Unset keys fall back to defaults — partial overrides are safe.

```json
{
  "weights": {
    "storm": 47,
    "roof": 33,
    "source": 20
  },
  "bands": {
    "hot": 80,
    "warm": 60,
    "cool": 40
  },
  "roofAgeMinYears": 10,
  "roofAgeMaxYears": 22,
  "tileBump": 0.1,
  "sourceQuality": {
    "referral": 1.0,
    "repeat": 0.95,
    "carrier": 0.8,
    "storm_canvass": 0.7,
    "google": 0.5,
    "website": 0.45,
    "web": 0.45,
    "door_knock": 0.45,
    "facebook": 0.4,
    "yard_sign": 0.35,
    "manual": 0.3,
    "other": 0.25
  },
  "sourceDefault": 0.4,
  "serviceAreaStates": ["AZ", "NV", "TX"],
  "renterMultiplier": 0.5,
  "multiEventBumpPct": 0.1,
  "stormLaneThreshold": 0.3
}
```

**Common tuning patterns:**

- Raise `weights.storm` to 60+ for storm-chaser tenants who only work
  post-event leads.
- Lower `bands.hot` to 70 for a market with many older roofs (more leads will
  qualify as hot, increasing outbound volume).
- Add local door-knock campaigns: set `sourceQuality.door_knock = 0.65` to
  reflect a higher conversion rate for that tenant.
- Restrict geography: set `serviceAreaStates: ["AZ"]` to hard-disqualify
  out-of-state leads from ad campaigns.
- Lower `stormLaneThreshold` to 0.2 to route marginal-storm leads into the
  storm workflow (more aggressive follow-up).

Changes take effect on the next nightly re-score (or immediately for new intake).
