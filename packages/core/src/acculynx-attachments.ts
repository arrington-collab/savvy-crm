// Alta cutover — AccuLynx attachment mappers (pure). The exporter pulled each
// job's estimates/invoices/comms + photo & doc files to disk; these functions
// map the raw AccuLynx shapes onto Savvy's estimate/invoice/communication/
// document columns. Kept pure and separately tested; the db lifecycle wires
// them to real rows + R2 uploads through the import_record ledger.
//
// Money: AccuLynx reports dollars (floats); Savvy stores integer cents.

export function dollarsToCents(v: unknown): number | null {
  if (typeof v !== "number" || Number.isNaN(v)) return null;
  return Math.round(v * 100);
}

function toDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface MappedEstimate {
  externalId: string;
  source: "carrier";
  status: "draft" | "accepted";
  title: string | null;
  estimateNumber: string | null;
  lineItems: unknown[];
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  totalProfit: number | null;
  createdAt: Date | null;
}

export function mapEstimate(raw: Record<string, unknown>): MappedEstimate {
  return {
    externalId: `estimate:${raw.Id}`,
    source: "carrier", // AccuLynx estimates are the carrier/insurance scope
    status: raw.IsPrimary ? "accepted" : "draft",
    title: (typeof raw.Title === "string" && raw.Title) || null,
    estimateNumber: (typeof raw.EstimateNumber === "string" && raw.EstimateNumber) || null,
    lineItems: Array.isArray(raw.Sections) ? raw.Sections : [],
    subtotal: dollarsToCents(raw.TotalCost),
    tax: dollarsToCents(raw.TotalTaxes),
    total: dollarsToCents(raw.TotalPrice),
    totalProfit: dollarsToCents(raw.TotalProfit),
    createdAt: toDate(raw.CreatedTimestamp),
  };
}

export interface MappedInvoice {
  externalId: string;
  number: string | null;
  status: "draft" | "sent" | "paid";
  lineItems: unknown[];
  amountDue: number | null;
  amountPaid: number | null;
  dueAt: Date | null;
  createdAt: Date | null;
}

export function mapInvoice(raw: Record<string, unknown>): MappedInvoice {
  const paid = raw.IsPaid === true || dollarsToCents(raw.BalanceDue) === 0;
  return {
    externalId: `invoice:${raw.InvoiceId}`,
    number: (typeof raw.InvoiceNumber === "string" && raw.InvoiceNumber) || null,
    status: paid ? "paid" : "sent",
    lineItems: Array.isArray(raw.InvoiceWorksheetSections) ? raw.InvoiceWorksheetSections : [],
    amountDue: dollarsToCents(raw.Total),
    amountPaid: dollarsToCents(raw.LinkedPaymentTotal),
    dueAt: toDate(raw.DueDate),
    createdAt: toDate(raw.InvoiceDate),
  };
}

const CHANNEL_BY_TYPE: Array<[RegExp, "email" | "sms" | "call"]> = [
  [/email/i, "email"],
  [/text|sms/i, "sms"],
  [/phone|call/i, "call"],
];

/** AccuLynx thread type name → Savvy comm channel. Internal team threads
 *  ("Job Message", "Mobile Crew App") have no customer channel; email is the
 *  closest text home so the history survives in the timeline. */
export function mapCommChannel(typeName: string | undefined): "email" | "sms" | "call" {
  for (const [re, ch] of CHANNEL_BY_TYPE) if (typeName && re.test(typeName)) return ch;
  return "email";
}

const DOC_KIND_BY_FOLDER: Array<[RegExp, string]> = [
  [/insurance estimate/i, "insurance_estimate"],
  [/roof report|measurement/i, "measurement_report"],
  [/contract/i, "contract"],
  [/certificate|cert of|completion/i, "cert"],
];

/** AccuLynx document folder → Savvy document.kind. Unmapped folders (Invoice,
 *  Permit, Warranty, Email Documents, Other, …) fall to "other" — the file is
 *  still preserved, just not specially typed. */
export function mapDocKind(folder: string | undefined): string {
  for (const [re, kind] of DOC_KIND_BY_FOLDER) if (folder && re.test(folder)) return kind;
  return "other";
}

/** Deterministic, tenant/job-scoped R2 key so re-runs overwrite the same object
 *  and never collide across tenants. */
export function attachmentR2Key(
  tenantId: string, jobId: string, kind: string, fileId: string, filename: string,
): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "-");
  return `acculynx/${tenantId}/${jobId}/${kind}/${fileId}_${safe}`;
}
