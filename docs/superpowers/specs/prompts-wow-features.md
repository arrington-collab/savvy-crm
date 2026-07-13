# Claude Code Prompt — Wow Features: Sage-by-Text · 30-Second Ballpark · Spanish Crew Comms

Written 2026-07-07. Owner-approved scope. Supplementing/SupplementIQ is explicitly OUT of
this version — do not build scope-comparison or supplement drafting. One worktree per
slice → TDD → PR → watch CI. Read CLAUDE.md.

---

Work in ~/Sites/savvy-crm. Build three features. Survey first: the digest sender
(ops-digest), exception cards + their action handlers (Today), Ask Sage backend
(sage-answers.ts — cited answers), the inbound voice/Vapi agent and inbound SMS routing,
tenant/user phone fields, crew + canvass_rep schemas, comms template system, the
lead-intake + inbound-call flows, price book + property enrichment fields (sqft, roof
type, effective age when the leads slices land). Check the drizzle journal from YOUR
worktree before any migration.

## Slice 1 — Sage by text & voice (reply-to-act)

The owner runs another company all day; the phone IS the interface.

1. ACTIONABLE DIGEST: digest SMS numbers its items — "(1) Kowalski estimate $32.7k @
   41% GM — reply 1 to approve · (2) Yates 60d overdue — reply 2 to send lien draft".
   Inbound reply from the owner's verified number resolves the exception exactly as the
   Today card's primary action would. Reply "1?" (or unknown input) ⇒ detail, not action.
2. SECURITY MODEL (non-negotiable):
   - Actions accepted ONLY from phone numbers registered + verified on an org-admin
     user (verification flow: code sent to the number, once).
   - Action set = the exception card's existing one-tap actions. NEVER arbitrary
     operations, never money movement beyond what the card itself could do.
   - Money actions above tenant threshold require a confirm round-trip ("Reply YES to
     approve $32,750 estimate to Kowalski").
   - Idempotent: replaying "1" after resolution returns "already done at 2:14 PM", not
     a double action. Numbered mappings expire when the digest is superseded.
3. FREE-TEXT SAGE: non-numeric texts route to the Ask Sage backend — answers cite the
   job ledger / task health exactly like the in-app version, over SMS. ("did we send
   the Hendricks estimate?" works from a truck.)
4. VOICE: calls from a verified owner number to the Sage line get the queue read aloud
   (reuse the Vapi/voice infra) and accept the same numbered commands + confirm
   round-trips. Keep scope tight: queue readout, item detail, approve/snooze — not
   open-ended conversation.
5. EVIDENCE: bind sage.remote_actions — every SMS/voice-initiated action logs phone,
   user, exception id, confirmation state; invariant: zero actions from unverified
   numbers (red-path test). All timestamps in tenant TZ.

## Slice 2 — 30-second ballpark

Anchor the homeowner while they're still on the line. Data already exists.

1. PURE FUNCTION in @savvy/core: ballparkRange({property, priceBook, tenantConfig}) →
   {lowCents, highCents, confidence, basis} from best-available roof size (measurement >
   assessor sqft × roof-type factor > footprint estimate), roof type(s), effective age,
   price-book good/better tiers ± spread. Returns null when data is insufficient —
   NEVER guess below the confidence floor.
2. SURFACES (config-gated per tenant, default ON for retail only):
   - Inbound voice agent: after address capture, if ballparkRange returns, the agent may
     say it with the mandatory framing: "typically runs $X–$Y — the exact number comes
     from a free inspection; want Thursday or Friday?"
   - SMS auto-reply flow: same range + booking link.
   - Lead tile: a quiet "ballpark $X–$Y (basis)" chip for reps.
3. GUARDRAILS: always a RANGE with the subject-to-inspection line (template in Library);
   NEVER offered on insurance-claim intents (carrier pricing governs — detect claim
   context and skip); margin floor from price book respected at the low end; every
   spoken/sent ballpark logged on the lead with its inputs snapshot.
4. EVIDENCE: bind ballpark.calibration — monthly report: quoted range vs eventual
   estimate value, hit-rate within range, per tenant (activates at ≥20 pairs; reports
   "insufficient data — n=X" below). This is what earns the feature wider autonomy.

## Slice 3 — Spanish-first crew comms

1. LANGUAGE PREFERENCE: language field (en·es, default en) on crew and canvass_rep;
   settable in Team admin and self-service via reply ("ESPAÑOL" to any crew message
   flips it — confirmation in the new language).
2. OUTBOUND: every crew-facing message (schedule/day-before, material delivery, punch
   list, weather reschedule, safety notices) renders in the recipient's language.
   Static template pairs live in Library (professionally phrased, versioned); dynamic
   fragments (addresses, times, punch item text) translated via the cheap-model gateway
   capability at send time with the English stored alongside. Times in tenant TZ,
   per-recipient language, same quiet-hours rules.
3. INBOUND: crew SMS/voice-memos in Spanish transcribe + translate through the existing
   memo pipeline — parsed fields land in English in the system with the original
   preserved on the event. Punch-list photo replies work regardless of language.
4. EVIDENCE: bind comms.crew_language — zero crew messages sent in a language other
   than the recipient's preference once set (red-path test); translation-failure
   fail-soft = send English + flag, never silence.

## House rules
Per-tenant TZ everywhere; no literal secrets; dormant/config-gated defaults (ballpark
OFF for insurance, voice actions only for verified numbers); red-path tests are the
deliverable on slice 1 security and slice 2 claim-context skip. Update first-20-cells
STATUS only if evidence states change — this is post-contract work; log it as such.
Verify each slice live on Bloom (a real digest reply round-trip with YOUR verified
number; a ballpark returned for a test address; a crew test contact set to Spanish
receiving a schedule notice) and state verifications in the PRs.

Start with the survey, then slice 1. Restate the plan, confirm the migration number,
and list files you'll touch.
