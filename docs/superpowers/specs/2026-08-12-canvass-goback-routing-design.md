# Canvass — sold-home status, Go Backs, and pin-drop routing

**Date:** 2026-08-12
**Status:** approved, building
**Repos:** `savvy-crm` (schema, API, optimizer) and `savvy-canvass` (map UI)
**Builds on:** `2026-08-12-canvass-recently-sold-design.md`

## Goal

Three things, for Pestkee (pest control) first:

1. **Go Backs** — a rep marks a sold home to return to when nobody answers.
2. **Status colors** — the yard-sign pin changes color as its status changes.
3. **Pin-drop routing** — a rep drops a pin, takes the nearest 15 or 25 sold
   homes, those are claimed for them, and the app builds an efficient route.

## The Pestkee constraint (do not let this drift)

**Routes draw ONLY from `canvass_sold_listing`.** Pestkee uses this app for one
purpose: knocking recently-sold homes, because new homeowners buy pest plans.
The claim endpoint never selects arbitrary addresses, prior knocks, or
territory polygons — only sold listings. Any future "route my whole street"
feature is a separate mode, not a change to this one.

## Status: two systems, deliberately

The sign carries its **own** lifecycle, set on the pin, independent of knock
logging. This was chosen over deriving color from the knock outcome.

Accepted cost: the two can disagree — a rep can log a Sale knock while the sign
still reads Go Back. Mitigation: the pin popup shows the most recent knock
outcome at that address alongside the sign status, so a stale status is visible
rather than hidden. We are not auto-syncing them.

### Statuses and colors

| Status | Color | Meaning | Visibility |
|---|---|---|---|
| `new` | blue | imported, untouched | visible |
| `goback` | amber | nobody home — return | visible |
| `appt` | purple | scheduled | visible |
| `customer` | green | closed | visible |
| `notint` | grey | declined | **hides 7 days after `statusAt`** |
| `dnk` | red | do not knock (bad address, dog, hostile) | **always visible** |

Amber for Go Back is deliberate: it is the only status meaning *unfinished
work*, so it should pull the eye on a map of blue.

Do Not Knock never hides — it is a safety flag, not clutter. Hiding it would
send the next rep to the door it exists to prevent.

## Schema — six columns on `canvass_sold_listing`

| Column | Type | Notes |
|---|---|---|
| `status` | text notNull default `'new'` | one of the six above |
| `statusAt` | timestamptz notNull default now() | drives the Not Interested hide |
| `statusByRepId` | uuid → canvass_rep | who set it, nullable |
| `assignedRepId` | uuid → canvass_rep | current claim, null when free |
| `assignedAt` | timestamptz | drives the 30-day auto-release |
| `routeSeq` | integer | position in that rep's route, null when unclaimed |

Indexes: `(tenantId, assignedRepId)` for "my route", and
`(tenantId, status, statusAt)` for the weekly hide sweep.

## Claim and release

- **Claim:** rep drops a pin, picks 15 or 25.
- **Eligible:** `status IN ('new','goback')`, not expired, and either unassigned
  or holding an assignment older than 30 days.
- **Excluded:** `notint`, `customer`, `dnk`, expired, and anything actively
  claimed by another rep.
- **Radius cap: 5 miles.** Without it, "nearest 25" in a sparse area drags a rep
  across the Valley. Returning fewer homes beats returning a nonsense route —
  the response says how many it found so the app can tell the rep plainly.
- **Atomicity:** selection and assignment happen in ONE transaction using a
  conditional update (`WHERE assigned_rep_id IS NULL OR assigned_at < now() -
  interval '30 days'`). Two reps tapping simultaneously cannot both win the same
  house; the loser simply gets fewer and is told.
- **Release:** 30 days after `assignedAt`, automatically — enforced by the
  eligibility predicate above, so a stale claim is reclaimable without a cleanup
  job having to run first. The weekly job also clears them for tidiness.

30 days is the owner's choice. Consequence, stated plainly: with a 90-day pin
lifetime, an unworked claim blocks a door for a third of its useful life. A
manager "release" button is the obvious follow-on if that bites.

## Route optimization

**Nearest-neighbor seeded from the rep's GPS, then 2-opt.** Straight-line
(haversine) distance, computed server-side at claim time and stored in
`routeSeq`.

Why not a road-routing API: it costs per request, needs a key, breaks offline,
and Phoenix is a near-perfect street grid, so straight-line order matches
driving order for all but a stop or two out of 25. Not worth the dependency.

Why 2-opt and not plain nearest-neighbor: greedy reliably strands one outlying
house and doubles back for it at the end. 2-opt uncrosses those segments and
typically cuts 10–20% of total distance at this size. At 25 points it is
milliseconds.

Server-side so the order persists, survives a reinstall, and a manager can see
what a rep is working.

## Offline behavior — a deliberate exception

The full sold layer is **never** written to localStorage (see the prior spec:
the app db is one localStorage blob near the 5–10MB ceiling, and thousands of
sold rows could evict a rep's unsynced knocks).

**The claimed route is the exception and IS stored locally.** 25 rows is trivial
next to 737, and a rep's work list is exactly the thing that must survive a dead
zone. The principle holds: reference data is online-only, assigned work is
offline-first — the same rule knocks already follow.

## API

- `POST /api/canvass/sold/status` — `{ id, status }`, bearer rep session. Sets
  `status`, `statusAt`, `statusByRepId`.
- `POST /api/canvass/sold/claim` — `{ lat, lng, count }` where count ∈ {15,25}.
  Returns the claimed listings in route order plus `found` and `requested` so the
  app can say "only 12 nearby" rather than silently under-delivering.
- `GET /api/canvass/sold` — extended with `status`, `assignedRepId`, `routeSeq`;
  applies the Not Interested 7-day hide server-side.

## Failure modes

- **Fewer than N available** → return what exists; the app tells the rep the
  number. Never pad the route with far-away homes to hit the count.
- **Simultaneous claims** → conditional update means at most one rep wins each
  house; no double-booked doors.
- **Rep loses signal mid-route** → route is local, so it keeps working. Status
  changes made offline queue and sync, same as knocks.
- **Claim with no GPS** → route seeds from the dropped pin instead; the rep
  still gets a sane order.
- **Status set on an expired/hidden pin** → allowed and recorded; visibility
  rules still apply on the next render.

## Testing

Unit (pure, no DB):
- 2-opt never returns a longer route than its input
- optimizer is deterministic for a given input
- optimizer handles 0, 1, and 2 points without crashing
- haversine matches known distances
- the 7-day Not Interested hide and 30-day release boundaries, tested either
  side of the cutoff

Integration:
- claim assigns exactly N when available, fewer when not, never more
- claim never returns a home actively claimed by another rep
- a claim older than 30 days is reclaimable
- `dnk` and `customer` are never claimable
- `goback` **is** claimable (the whole point)
- status change updates `statusAt` and `statusByRepId`
- cross-tenant RLS: one tenant cannot claim or restatus another's listings

## Out of scope

- Retiring drawn territories — Draw stays; this is a second way to work.
- Auto-syncing sign status with knock outcomes (explicitly rejected above).
- Manager release/reassign UI — likely the first follow-on.
