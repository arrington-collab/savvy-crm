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
import {
  previewAssignee,
  previewSlots,
  whoIsFree,
  confirmIntakeBooking,
} from "@/lib/intake-schedule";

type Rep = { id: string; name: string };
type Slot = { startsAt: string; endsAt: string; label: string };

export function QuickBook({ reps }: { reps: Rep[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  const [address, setAddress] = useState("");
  const [parts, setParts] = useState<Partial<ParsedAddress>>({});
  // Manual fallback fields (Places is unavailable without a real key).
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");

  const [repId, setRepId] = useState("");
  const [recommended, setRecommended] = useState(false);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [chosen, setChosen] = useState<Slot | null>(null);

  const [whosFreeTime, setWhosFreeTime] = useState("");
  const [freeReps, setFreeReps] = useState<Rep[]>([]);

  function onPhoneChange(raw: string) {
    const n = normalizePhone(raw);
    setPhone(n ? formatPhoneDisplay(n) : raw);
  }
  function onPick(a: ParsedAddress) {
    setAddress(a.formatted);
    setParts(a);
    if (a.city) setCity(a.city);
    if (a.state) setState(a.state);
    if (a.zip) setZip(a.zip);
  }

  // Effective geo (autocomplete pick wins, else manual fields).
  function geo() {
    return {
      zip: parts.zip || zip || undefined,
      city: parts.city || city || undefined,
      state: parts.state || state || undefined,
    };
  }
  function cluster(): { lat: number; lng: number } | null {
    return parts.lat != null && parts.lng != null ? { lat: parts.lat, lng: parts.lng } : null;
  }

  async function loadSlots(rep: string) {
    const res = await previewSlots({ repId: rep, clusterAround: cluster() });
    setSlots(res.slots);
    setChosen(null);
  }

  // Recommend a rep from the geo, then surface their soonest slots.
  function findRepAndTimes() {
    start(async () => {
      const { repId: rec } = await previewAssignee(geo());
      if (rec) {
        setRepId(rec);
        setRecommended(true);
        await loadSlots(rec);
      } else {
        setRecommended(false);
        toast.error("No rep covers this area — pick one manually.");
        setSlots([]);
      }
    });
  }

  function onRepChange(rep: string) {
    setRepId(rep);
    setRecommended(false);
    if (rep) start(() => loadSlots(rep));
    else setSlots([]);
  }

  function runWhosFree() {
    if (!whosFreeTime) return;
    start(async () => {
      const res = await whoIsFree({ startsAt: new Date(whosFreeTime).toISOString() });
      setFreeReps(res.reps);
      if (res.reps.length === 0) toast.message("No reps free at that time.");
    });
  }

  function book() {
    if (!repId || !chosen) {
      toast.error("Pick a rep and a time first.");
      return;
    }
    start(async () => {
      const res = await confirmIntakeBooking({
        contact: { name, phone: phone || undefined, email: email || undefined },
        address: {
          address,
          city: parts.city || city || undefined,
          state: parts.state || state || undefined,
          zip: parts.zip || zip || undefined,
          county: parts.county || undefined,
          line1: parts.line1 || undefined,
          lat: parts.lat,
          lng: parts.lng,
        },
        repId,
        startsAt: chosen.startsAt,
        endsAt: chosen.endsAt,
      });
      if ("ok" in res) {
        toast.success("Booked — inspection scheduled.");
        router.push(`/leads/${res.leadId}`);
        return;
      }
      if (res.error === "slot_taken") {
        toast.error("That slot was just taken — pick another.");
        await loadSlots(repId);
        return;
      }
      toast.error(res.error === "no_assignee" ? "No rep available." : "Couldn't book — check the details.");
    });
  }

  const repName = reps.find((r) => r.id === repId)?.name;

  return (
    <Card className="max-w-lg space-y-5 p-6" data-testid="quick-book">
      <div className="space-y-1.5">
        <Label htmlFor="qb-name">Caller name</Label>
        <Input id="qb-name" data-testid="qb-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="qb-phone">Phone</Label>
        <Input id="qb-phone" data-testid="qb-phone" value={phone} onChange={(e) => onPhoneChange(e.target.value)} placeholder="(480) 555-1234" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="qb-email">Email (optional)</Label>
        <Input id="qb-email" data-testid="qb-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="qb-address">Property address</Label>
        <AddressAutocomplete value={address} onChange={setAddress} onPick={onPick} id="qb-address" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="qb-city">City</Label>
          <Input id="qb-city" data-testid="qb-city" value={city} onChange={(e) => setCity(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="qb-state">State</Label>
          <Input id="qb-state" data-testid="qb-state" value={state} onChange={(e) => setState(e.target.value)} placeholder="AZ" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="qb-zip">ZIP</Label>
          <Input id="qb-zip" data-testid="qb-zip" value={zip} onChange={(e) => setZip(e.target.value)} placeholder="85203" />
        </div>
      </div>

      <Button type="button" variant="secondary" onClick={findRepAndTimes} disabled={pending} data-testid="qb-find">
        Find rep &amp; times
      </Button>

      <div className="space-y-1.5">
        <Label htmlFor="qb-rep">Assigned rep</Label>
        <select
          id="qb-rep"
          data-testid="qb-rep"
          className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          value={repId}
          onChange={(e) => onRepChange(e.target.value)}
        >
          <option value="">— select a rep —</option>
          {reps.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        {recommended && repName && (
          <p className="text-xs text-muted-foreground" data-testid="qb-recommended">
            Recommended: {repName}
          </p>
        )}
      </div>

      {slots.length > 0 && (
        <div className="space-y-2">
          <Label>Soonest times</Label>
          <div className="flex flex-wrap gap-2">
            {slots.map((s) => (
              <Button
                key={s.startsAt}
                type="button"
                variant={chosen?.startsAt === s.startsAt ? "default" : "outline"}
                onClick={() => setChosen(s)}
                data-testid="qb-slot"
              >
                {s.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2 rounded-md border p-3">
        <Label htmlFor="qb-whosfree-time">Who&apos;s free at…</Label>
        <div className="flex gap-2">
          <Input
            id="qb-whosfree-time"
            data-testid="qb-whosfree-time"
            type="datetime-local"
            value={whosFreeTime}
            onChange={(e) => setWhosFreeTime(e.target.value)}
          />
          <Button type="button" variant="secondary" onClick={runWhosFree} disabled={pending} data-testid="qb-whosfree-run">
            Check
          </Button>
        </div>
        {freeReps.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {freeReps.map((r) => (
              <Button
                key={r.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onRepChange(r.id)}
                data-testid="qb-free-rep"
              >
                {r.name}
              </Button>
            ))}
          </div>
        )}
      </div>

      <Button type="button" onClick={book} disabled={pending || !repId || !chosen} data-testid="qb-confirm">
        {pending ? "Working…" : "Confirm & Book"}
      </Button>
    </Card>
  );
}
