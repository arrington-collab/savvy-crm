"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { normalizePhone, formatPhoneDisplay, AD_PLATFORM_VALUES } from "@savvy/core";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AddressAutocomplete, type ParsedAddress } from "@/components/AddressAutocomplete";
import { LeadSourceSelect, HUMAN_LEAD_SOURCES } from "@/components/LeadSourceSelect";
import { createLead } from "@/lib/lead-actions";

const ROOF_TYPES = [
  { v: "", label: "— select (optional) —" },
  { v: "asphalt_shingle", label: "Asphalt shingle" },
  { v: "tile", label: "Tile" },
  { v: "metal", label: "Metal" },
  { v: "flat_foam", label: "Flat / foam" },
  { v: "other", label: "Other" },
];

// Enum members the human picker offers directly (not the tenant customs).
const HUMAN_SOURCE_VALUES = HUMAN_LEAD_SOURCES.map((s) => s.value);

type SourceDetail = Record<string, unknown>;

/** Empty seed shape for each source's detail object. */
function emptyDetailFor(source: string): SourceDetail {
  switch (source) {
    case "referral":
      return { referrer_name: "", referrer_contact: "", referral_fee_dollars: "" };
    case "insurance_agent":
      return { agency: "", agent_name: "" };
    case "ads":
      return { platform: AD_PLATFORM_VALUES[0] };
    case "realtor":
      return { name: "", brokerage: "" };
    case "partner":
      return { name: "" };
    case "other":
      return { note: "" };
    default:
      return {};
  }
}

/** Converts the form's working detail shape into the shape createLead expects (dollars->cents etc). */
function toSourceDetailPayload(source: string, detail: SourceDetail): Record<string, unknown> {
  if (source === "referral") {
    const dollars = String(detail.referral_fee_dollars ?? "").trim();
    const cents = dollars ? Math.round(Number(dollars) * 100) : undefined;
    return {
      referrer_name: String(detail.referrer_name ?? ""),
      referrer_contact: detail.referrer_contact ? String(detail.referrer_contact) : undefined,
      referral_fee_cents: Number.isFinite(cents) ? cents : undefined,
    };
  }
  if (source === "insurance_agent") {
    return {
      agency: String(detail.agency ?? ""),
      agent_name: detail.agent_name ? String(detail.agent_name) : undefined,
    };
  }
  if (source === "ads") {
    return { platform: String(detail.platform ?? AD_PLATFORM_VALUES[0]) };
  }
  if (source === "realtor") {
    return {
      name: String(detail.name ?? ""),
      brokerage: detail.brokerage ? String(detail.brokerage) : undefined,
    };
  }
  if (source === "partner") {
    return { name: String(detail.name ?? "") };
  }
  if (source === "other") {
    const payload: Record<string, unknown> = {};
    if (detail.note) payload.note = String(detail.note);
    if (detail.custom_label) payload.custom_label = String(detail.custom_label);
    return payload;
  }
  return {};
}

export function NewLeadForm({ initialCustomSources }: { initialCustomSources: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [formError, setFormError] = useState("");
  const [address, setAddress] = useState("");
  const [parts, setParts] = useState<Partial<ParsedAddress>>({});
  const [pickerValue, setPickerValue] = useState("referral"); // raw picker selection (enum member or custom label)
  const [source, setSource] = useState("referral"); // resolved enum member sent to createLead
  const [sourceDetail, setSourceDetail] = useState<SourceDetail>(emptyDetailFor("referral"));
  const [roofType, setRoofType] = useState("");
  const [yearBuilt, setYearBuilt] = useState("");

  function onPhoneChange(raw: string) {
    const n = normalizePhone(raw);
    setPhone(n ? formatPhoneDisplay(n) : raw);
  }
  function onPick(a: ParsedAddress) {
    setAddress(a.formatted);
    setParts(a);
  }
  function onSourceChange(v: string) {
    setPickerValue(v);
    if (HUMAN_SOURCE_VALUES.includes(v)) {
      setSource(v);
      setSourceDetail(emptyDetailFor(v));
    } else {
      // A tenant custom source label -> maps to the "other" enum member.
      setSource("other");
      setSourceDetail({ ...emptyDetailFor("other"), custom_label: v });
    }
  }
  function setDetailField(field: string, value: string) {
    setSourceDetail((d) => ({ ...d, [field]: value }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!phone.trim() && !email.trim()) {
      setFormError("Add a phone or email");
      return;
    }
    setFormError("");
    start(async () => {
      const res = await createLead({
        name, phone, email, address, source,
        sourceDetail: toSourceDetailPayload(source, sourceDetail),
        line1: parts.line1, city: parts.city, state: parts.state, zip: parts.zip,
        county: parts.county, lat: parts.lat, lng: parts.lng,
        roofType: roofType || undefined,
        yearBuilt: yearBuilt ? Number(yearBuilt) : undefined,
      });
      if ("error" in res) { toast.error(res.error); return; }
      toast.success("Lead created");
      router.push(`/leads/${res.leadId}`);
    });
  }

  return (
    <Card className="max-w-lg p-6">
      <form onSubmit={submit} className="space-y-4" data-testid="new-lead-form">
        <div className="space-y-1.5">
          <Label htmlFor="name">Customer name</Label>
          <Input id="name" name="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" name="phone" value={phone} onChange={(e) => onPhoneChange(e.target.value)}
                 placeholder="(480) 555-1234" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" value={email}
                 onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
        </div>
        {formError && (
          <p className="text-sm text-destructive" data-testid="new-lead-error">{formError}</p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="address">Property address</Label>
          <AddressAutocomplete value={address} onChange={setAddress} onPick={onPick} />
        </div>
        {(parts.city || parts.state) && (
          <p className="text-xs text-muted-foreground" data-testid="address-parts">
            {[parts.city, parts.state, parts.zip].filter(Boolean).join(", ")}
            {parts.county ? ` · ${parts.county} County` : ""}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="roofType">Roof type (optional)</Label>
            <select id="roofType" data-testid="roof-type"
                    className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={roofType} onChange={(e) => setRoofType(e.target.value)}>
              {ROOF_TYPES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="yearBuilt">Year built (optional)</Label>
            <Input id="yearBuilt" data-testid="year-built" type="number" inputMode="numeric"
                   value={yearBuilt} onChange={(e) => setYearBuilt(e.target.value)} placeholder="e.g. 2004" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="source">Source</Label>
          <LeadSourceSelect value={pickerValue} onChange={onSourceChange} initialCustom={initialCustomSources} />
        </div>
        {source === "referral" && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="src-referrer-name">Referrer name</Label>
              <Input
                id="src-referrer-name"
                data-testid="src-referrer-name"
                value={String(sourceDetail.referrer_name ?? "")}
                onChange={(e) => setDetailField("referrer_name", e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="src-referrer-contact">Referrer contact (optional)</Label>
              <Input
                id="src-referrer-contact"
                data-testid="src-referrer-contact"
                value={String(sourceDetail.referrer_contact ?? "")}
                onChange={(e) => setDetailField("referrer_contact", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="src-referral-fee">Referral fee, $ (optional)</Label>
              <Input
                id="src-referral-fee"
                data-testid="src-referral-fee"
                type="number"
                inputMode="decimal"
                value={String(sourceDetail.referral_fee_dollars ?? "")}
                onChange={(e) => setDetailField("referral_fee_dollars", e.target.value)}
              />
            </div>
          </div>
        )}
        {source === "insurance_agent" && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="src-agency">Agency</Label>
              <Input
                id="src-agency"
                data-testid="src-agency"
                value={String(sourceDetail.agency ?? "")}
                onChange={(e) => setDetailField("agency", e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="src-agent-name">Agent name (optional)</Label>
              <Input
                id="src-agent-name"
                data-testid="src-agent-name"
                value={String(sourceDetail.agent_name ?? "")}
                onChange={(e) => setDetailField("agent_name", e.target.value)}
              />
            </div>
          </div>
        )}
        {source === "ads" && (
          <div className="space-y-1.5 rounded-md border p-3">
            <Label htmlFor="src-ad-platform">Ad platform</Label>
            <select
              id="src-ad-platform"
              data-testid="src-ad-platform"
              className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              value={String(sourceDetail.platform ?? AD_PLATFORM_VALUES[0])}
              onChange={(e) => setDetailField("platform", e.target.value)}
            >
              {AD_PLATFORM_VALUES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        )}
        {source === "realtor" && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="src-realtor-name">Realtor name</Label>
              <Input
                id="src-realtor-name"
                data-testid="src-realtor-name"
                value={String(sourceDetail.name ?? "")}
                onChange={(e) => setDetailField("name", e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="src-brokerage">Brokerage (optional)</Label>
              <Input
                id="src-brokerage"
                data-testid="src-brokerage"
                value={String(sourceDetail.brokerage ?? "")}
                onChange={(e) => setDetailField("brokerage", e.target.value)}
              />
            </div>
          </div>
        )}
        {source === "partner" && (
          <div className="space-y-1.5 rounded-md border p-3">
            <Label htmlFor="src-partner-name">Partner name</Label>
            <Input
              id="src-partner-name"
              data-testid="src-partner-name"
              value={String(sourceDetail.name ?? "")}
              onChange={(e) => setDetailField("name", e.target.value)}
              required
            />
          </div>
        )}
        {source === "other" && (
          <div className="space-y-1.5 rounded-md border p-3">
            <Label htmlFor="src-other-note">Note (optional)</Label>
            <Input
              id="src-other-note"
              data-testid="src-other-note"
              value={String(sourceDetail.note ?? "")}
              onChange={(e) => setDetailField("note", e.target.value)}
            />
          </div>
        )}
        <Button type="submit" disabled={pending} data-testid="new-lead-submit">
          {pending ? "Creating…" : "Create lead"}
        </Button>
      </form>
    </Card>
  );
}
