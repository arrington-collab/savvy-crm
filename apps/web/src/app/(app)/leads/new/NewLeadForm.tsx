"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { normalizePhone, formatPhoneDisplay } from "@savvy/core";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AddressAutocomplete, type ParsedAddress } from "@/components/AddressAutocomplete";
import { LeadSourceSelect } from "@/components/LeadSourceSelect";
import { createLead } from "@/lib/lead-actions";

const ROOF_TYPES = [
  { v: "", label: "— select (optional) —" },
  { v: "asphalt_shingle", label: "Asphalt shingle" },
  { v: "tile", label: "Tile" },
  { v: "metal", label: "Metal" },
  { v: "flat_foam", label: "Flat / foam" },
  { v: "other", label: "Other" },
];

export function NewLeadForm({ initialCustomSources }: { initialCustomSources: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [formError, setFormError] = useState("");
  const [address, setAddress] = useState("");
  const [parts, setParts] = useState<Partial<ParsedAddress>>({});
  const [source, setSource] = useState("referral");
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
          <LeadSourceSelect value={source} onChange={setSource} initialCustom={initialCustomSources} />
        </div>
        <Button type="submit" disabled={pending} data-testid="new-lead-submit">
          {pending ? "Creating…" : "Create lead"}
        </Button>
      </form>
    </Card>
  );
}
