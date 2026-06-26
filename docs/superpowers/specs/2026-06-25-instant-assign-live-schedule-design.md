# Instant Assignment + Live Scheduling for Inbound Calls — Design

**Date:** 2026-06-25
**Status:** Approved (design), pending spec review
**Builds on:** `2026-06-23-lead-auto-assignment-design.md`, `2026-06-24-stage4-drivetime-scheduling.md`, `2026-06-24-voice-agent-design.md`

---

## 1. Problem

When a prospect calls a roofing company, the inspection should be **scheduled live, on that call** — whether a human or the AI receptionist (Riley) answers. Today that's impossible:

- **Assignment is `off`** and runs asynchronously inside the `lead-intake` Inngest workflow, so there is no assigned rep at the moment of the call.
- **Inbound AI calls create the lead at hang-up**, not call-start, so during the call there is no lead to assign or schedule against.
- **There is no human "take a call and book it now" screen.**
- **There is no way to answer "who's free today at 4?"** — the company's speed-to-lead motto ("we always prefer **today**") has no tooling.

Most of the underlying engine already exists (assignment strategies, drive-time slot ranking, Vapi booking tools). This work **exposes and extends** that engine behind one shared service and adds the two missing front-ends.

## 2. Goals

1. A human answering the phone can create a lead and **book the inspection in one smooth, instant, no-reload screen**.
2. The system **recommends a rep** (default: zip territory → round-robin) that the human can **approve or override** (including "assign to me" when a rep answers their own phone).
3. The moment a rep is set, **two suggested appointment times** appear, **today/soonest first**.
4. When a caller proposes a specific time ("can you come today at 4?"), the user can instantly see **which reps are available** at that time and book whoever.
5. Riley (Vapi) does the same thing on inbound calls as a **backup** when no human picks up — including **confirming city + zip** so territory assignment works.
6. Companies can **choose their assignment strategy** in settings; the default is **territory by zip, falling back to round-robin**.

## 3. Non-goals (this milestone)

- Google Calendar / external calendar sync (Savvy is source of truth; reps block their own time instead). Layerable later via the existing Nango GCal integration.
- Per-rep working-hours configuration (working hours stay tenant-level; reps carve out time via blocks).
- Reassignment / SLA escalation changes (covered elsewhere).
- A full dispatcher map / live board (the "who's free at X" lookup is scoped to the quick-book screen and the voice tool, not a standalone dashboard).

## 4. Architecture — Approach A: one shared engine, thin front-ends

A single server-side module (the **intake-and-schedule service**) is the only place assignment + availability + booking logic lives. Both consumers — the **human quick-book screen** and **Riley's Vapi tools** — call the same functions, so they can never drift.

```
            ┌─────────────────────────┐         ┌──────────────────────────┐
            │  Human quick-book screen │         │  Riley (Vapi) inbound     │
            │  /leads/quick (slide-over)│        │  webhook tool-calls       │
            └───────────┬─────────────┘         └────────────┬─────────────┘
                        │                                     │
                        └──────────────┬──────────────────────┘
                                       ▼
                    ┌──────────────────────────────────────────┐
                    │   intake-and-schedule service (shared)     │
                    │   recommendAssignee · slotsForRep ·        │
                    │   repsAvailableAt · confirmIntakeBooking    │
                    └──────────────────┬───────────────────────┘
                                       ▼
       existing engine: pickAssignee · computeOpenSlots/rankSlots · bookLeadSlot · createLeadForTenant
```

### 4.1 Shared service interface

| Function | Responsibility | Reuses / extends |
|---|---|---|
| `recommendAssignee({ tenantId, zip, city, state })` | Return the recommended rep id per the tenant strategy. Default chain: **zip territory → round-robin**. Pure preview, **no DB write**. | extends `pickAssignee` (new zip matching) |
| `slotsForRep({ tenantId, repId, type, todayFirst, limit })` | The rep's next open times, **today/soonest first**, drive-time aware. Default `limit: 2`, `type: "inspection"`. | refactor `getRecommendedSlots` to accept a `repId` (not a `leadId`) |
| `repsAvailableAt({ tenantId, startsAt, type })` | "Who's free at this exact time?" — every rep open at `startsAt` (working hours − appointments − blocks). | **new**, reuses the busy-time math from the slot engine |
| `confirmIntakeBooking({ tenantId, contact, address, repId, startsAt, endsAt })` | Atomic: create/dedupe customer+property+lead → assign `repId` → book appointment → emit `appointment/booked`. Re-checks slot at write time. | fuses `createLeadForTenant` + `bookLeadSlot` in one transaction |

All four are tenant-scoped and RLS-safe. The first three are **read/preview only**; persistence happens exclusively in `confirmIntakeBooking`.

## 5. Data-model changes

1. **Zip territories.** Extend `assignmentConfigSchema.territoryRules` so a rule may key on `zip` (`{ zip: "85203", userId }`) in addition to the existing `{ state, city?, userId }`. `pickAssignee`'s `territory` branch matches the lead's property **zip** first, then city/state, then round-robin fallback. The default tenant `strategy` becomes `territory` (was `off`).
2. **Round-robin tiebreak in territory.** Within a matched territory containing multiple reps, break ties by **round-robin** (least-recently-assigned), not least-loaded, per the company's stated preference. (One-line change in the `territory` branch.)
3. **Rep availability blocks.** New table `rep_availability_block`:
   - columns: `id`, `tenant_id`, `user_id`, `starts_at`, `ends_at`, `reason` (nullable), `created_at`
   - RLS: tenant-scoped (`tenant_id = current_setting('app.tenant_id')`)
   - The slot engine subtracts these intervals exactly like `scheduled` appointments when computing a rep's open slots and in `repsAvailableAt`.
   - A simple rep-facing control ("block this time") creates/deletes rows. (UI minimal; full management UI is out of scope.)
4. **Today-first ranking.** Add a same-day weight bump in `rankSlots` (or a `todayFirst` flag) so same-day slots float above all future slots, encoding speed-to-lead. Drive-time/cluster ranking still orders within a day.

No changes to customer/property/lead/appointment shapes beyond what already exists.

## 6. Human quick-book screen

**Entry:** a "📞 New Call" action (slide-over) available from the leads area, route `/leads/quick`. Single screen, live updates via server actions, **no full-page reloads**.

### 6.1 Flow

| Step | Behavior |
|---|---|
| 1. Type name / phone / address | Address uses Google Places autocomplete → structured `city` + `zip`. |
| 2. Zip resolves | `recommendAssignee` runs live → shows recommended rep. **Nothing persisted.** |
| 3. Rep override | Recommended rep is editable (dropdown of tenant reps). One-tap **"assign to me"** when a rep is logged in. Changing the rep instantly refreshes the slots. |
| 4. Two slots appear | `slotsForRep(repId, { todayFirst: true, limit: 2 })` → two buttons, **today first**. |
| 5. Specific-time request | "Today @ 4:00 PM" + **"Who's free?"** → `repsAvailableAt` lists reps open then. Tap a free rep → sets assignment + slot in one move. |
| 6. Confirm & Book | `confirmIntakeBooking` fires once: lead + assignment + appointment, atomically. |

### 6.2 Principles baked in

- **Nothing persists until Confirm** — a hang-up mid-conversation leaves no orphan lead (steps 2–5 are server-action *reads*).
- **Today surfaced first** — if any rep has a same-day opening, it is the first option offered.
- **Override rule:** the screen defaults the assignment to the **logged-in rep if they are a valid rep for the tenant**, otherwise to the **zip-territory recommendation**; always shown, one tap to change.

## 7. AI / Vapi path (backup)

Human answering is preferred; Riley is the backup when no one picks up. Riley performs the same steps, spoken, against the same shared service. The timing differs because an inbound call has no address at call-start.

| When | Behavior |
|---|---|
| **Call start** (`assistant-request` server event) | Resolve tenant by the dialed number → create a minimal lead (caller phone, `source: inbound-call`, unassigned) → inject `leadId` + tenant context into `assistantOverrides.metadata` so mid-call tools have lead context. *(This is the inbound-mid-call-booking fix flagged in the voice-agent handoff.)* |
| **Riley collects address** | Riley **must capture and confirm city + zip** (see 7.1). A tool call updates the property, runs `recommendAssignee(zip)` → assigns the rep → returns the **2 today-first slots**. |
| **Caller picks / proposes a time** | `bookSlot` → `confirmIntakeBooking` (lead exists; assign-if-needed + book). For a specific time, Riley may call `repsAvailableAt` and book whoever is free. |

### 7.1 Address capture requirement (voice)

Zip drives territory assignment, so Riley **must not book on a street address alone**. The persona/prompt is updated to:

- explicitly **ask for and read back the city and zip code** ("Got it — 882 West Elm Street in Mesa, zip code 8-5-2-0-3, correct?"), and
- a **server-side geocode backstop**: when the address tool runs, geocode the spoken address; if it does not resolve to a confident zip, return a re-prompt instruction so Riley asks again rather than silently falling back to round-robin.

The human screen already gets a structured zip from Places autocomplete, so this requirement is voice-specific.

## 8. Edge cases & fallbacks

| Situation | Behavior |
|---|---|
| No zip-territory rule matches | Round-robin across all reps (default chain). |
| Nobody free at the requested time | `repsAvailableAt` returns empty → offer the **soonest real slots**, today-first. |
| No same-day availability at all | Offer soonest future day; today-first naturally yields to the next open day. |
| Slot taken between preview and Confirm | `confirmIntakeBooking` re-checks at write time → returns `slot_taken` → screen/Riley offers fresh options. No double-booking. |
| Address won't resolve to a zip | Human: require a valid Places selection. Voice: re-prompt (7.1); if still unresolved, round-robin and proceed. |
| No reps configured / strategy `off` | Screen shows manual rep dropdown; Riley leaves lead unassigned → "a specialist will call you right back." |
| Requested time outside working hours | Not offered; nearest in-hours slot surfaced instead. |

## 9. Testing

Per repo rule: testable logic lives in `packages/*`; `apps/web` routes are exercised by Playwright e2e only.

- **Unit (`packages/core`, pure):** zip-territory match + round-robin tiebreak · today-first ranking · `repsAvailableAt` interval math (hours − appointments − blocks) · slot-taken handling.
- **Integration (`packages/db`):** `confirmIntakeBooking` atomicity · **RLS cross-tenant isolation** (assert a tenant cannot read/assign another tenant's reps or leads) · block subtraction · customer/property dedupe.
- **E2E (`apps/web`, Playwright):** quick-book screen (type → rep appears → 2 slots → book) · rep override · "who's free?" lookup · Vapi `assistant-request` + tool-call webhook path including the city/zip confirmation + geocode re-prompt.

## 10. Sequencing

1. **Engine extensions** (`packages/core` + `packages/db`): zip territory rules, round-robin tiebreak, `rep_availability_block` + slot subtraction, today-first ranking, `repsAvailableAt`. Ship with unit/integration tests.
2. **Shared service module**: `recommendAssignee`, `slotsForRep`, `repsAvailableAt`, `confirmIntakeBooking`.
3. **Human quick-book screen** (first consumer) — the immediately usable deliverable.
4. **Assignment settings UI**: choose strategy + manage zip territory rules; default `territory`.
5. **AI wiring**: `assistant-request` call-start lead creation + metadata injection; address tool with city/zip confirmation + geocode backstop; reuse shared service in tool-calls.
6. **Rep block control**: minimal "block this time" UI.

## 11. Open questions

None blocking. (Google Calendar sync and a standalone dispatch board are explicitly deferred — section 3.)
