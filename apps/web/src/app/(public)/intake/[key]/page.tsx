"use client";
import { useState } from "react";
import { useParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function IntakePage() {
  const { key } = useParams<{ key: string }>();
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/leads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key,
        name: fd.get("name"),
        phone: fd.get("phone"),
        address: fd.get("address"),
        source: "web",
      }),
    });
    setSubmitting(false);
    if (res.ok) setDone(true);
  }

  if (done) {
    return <div className="mx-auto max-w-md p-8" data-testid="intake-success">Thanks — we&apos;ll text you shortly.</div>;
  }
  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-md space-y-3 p-8">
      <h1 className="text-xl font-semibold">Get a free roof inspection</h1>
      <Input name="name" placeholder="Full name" required />
      <Input name="phone" placeholder="+15555550123" required />
      <Input name="address" placeholder="Property address" required />
      <Button type="submit" disabled={submitting}>Request inspection</Button>
    </form>
  );
}
