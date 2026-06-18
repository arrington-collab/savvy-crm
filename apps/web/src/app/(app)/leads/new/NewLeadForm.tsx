"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createLead } from "@/lib/lead-actions";

export function NewLeadForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [source, setSource] = useState("manual");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await createLead({ name, phone, address, source });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
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
          <Label htmlFor="phone">Phone (E.164, e.g. +14805551234)</Label>
          <Input id="phone" name="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1..." required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="address">Property address</Label>
          <Input id="address" name="address" value={address} onChange={(e) => setAddress(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="source">Source</Label>
          <Input id="source" name="source" value={source} onChange={(e) => setSource(e.target.value)} />
        </div>
        <Button type="submit" disabled={pending} data-testid="new-lead-submit">
          {pending ? "Creating…" : "Create lead"}
        </Button>
      </form>
    </Card>
  );
}
