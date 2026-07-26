import type { DailyMetrics } from "./metrics";
import type { FlashComparison } from "./comparison";
import type { QueueItem } from "./exception-queue";

export function dollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

const dash = (
  v: number | null,
  fmt: (n: number) => string
): string => (v === null ? "—" : fmt(v));

export function renderFlashHeadline(
  m: DailyMetrics,
  needsYou: QueueItem[]
): string {
  const t = m.topLine;
  const quiet =
    t.leadsTotal === 0 &&
    t.contractsSigned === 0 &&
    m.money.cashCollectedCents === 0 &&
    needsYou.length === 0;
  if (quiet)
    return `Savvy Daily Flash ${m.businessDate}: quiet day — nothing needs you.`;
  const need =
    needsYou.length > 0 ? `${needsYou.length} need you` : "0 need you";
  return `Savvy Daily Flash ${m.businessDate}: ${t.leadsTotal} leads, ${t.contractsSigned} signed (${dollars(t.contractValueCents)}), ${dollars(m.money.cashCollectedCents)} collected — ${need}.`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    };
    return map[c]!;
  });
}

export function renderFlashHtml(
  m: DailyMetrics,
  needsYou: QueueItem[],
  c: FlashComparison,
  opts: { flashUrl?: string } = {}
): string {
  const t = m.topLine;
  const needsRows =
    needsYou.length > 0
      ? needsYou
          .map(
            (it) =>
              `<li><b>[${esc(it.severity)}]</b> ${esc(it.reason)} <span class="rule">${esc(it.ruleId)}</span></li>`
          )
          .join("")
      : `<li class="clear">All clear — the machine ran itself today.</li>`;
  const speed =
    m.speed.medianSpeedToLeadMs === null
      ? "—"
      : `${Math.round(m.speed.medianSpeedToLeadMs / 60000)}m`;
  const pct =
    m.speed.pctLeadsUnder5Min === null
      ? "—"
      : `${Math.round(m.speed.pctLeadsUnder5Min * 100)}%`;
  return `<!-- self-contained phone-first flash -->
<section class="flash" style="max-width:480px;margin:0 auto;font-family:system-ui,sans-serif">
  <header><h1>Daily Flash</h1><time>${esc(m.businessDate)} (Denver)</time></header>
  <div class="needs-you" style="background:#fff3f3;border:1px solid #f3caca;padding:12px;border-radius:8px">
    <h2>Needs you</h2><ul>${needsRows}</ul>
  </div>
  <div class="grid">
    <div><span>Leads</span><strong>${t.leadsTotal}</strong><em>${dash(c.leadsTotalVsYesterday, (n) => (n >= 0 ? `+${n}` : `${n}`))} vs yest</em></div>
    <div><span>Signed</span><strong>${t.contractsSigned} · ${dollars(t.contractValueCents)}</strong></div>
    <div><span>Appts</span><strong>${t.appointmentsSet} set · ${t.appointmentsNoShow} no-show</strong></div>
    <div><span>Jobs done</span><strong>${t.jobsCompleted}</strong></div>
    <div><span>Invoiced</span><strong>${dollars(m.money.invoicedCents)}</strong></div>
    <div><span>Cash collected</span><strong>${dollars(m.money.cashCollectedCents)}</strong></div>
    <div><span>Speed-to-lead</span><strong>${speed} · ${pct} &lt;5m</strong></div>
    <div><span>Reviews</span><strong>${m.quality.reviewsPosted} · ${dash(m.quality.avgStars, (n) => `${n.toFixed(1)}★`)}</strong></div>
  </div>
  ${opts.flashUrl ? `<a href="${esc(opts.flashUrl)}">see all</a>` : ""}
</section>`;
}
