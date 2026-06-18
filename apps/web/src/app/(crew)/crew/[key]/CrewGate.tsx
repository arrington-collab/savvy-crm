"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { crewLogin } from "@/lib/crew-actions";

export function CrewGate({ workspaceKey }: { workspaceKey: string }) {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    start(async () => {
      const r = await crewLogin(workspaceKey, pin);
      if ("error" in r) { setErr(r.error); return; }
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3 pt-16" data-testid="crew-gate">
      <h1 className="text-lg font-semibold">Crew sign-in</h1>
      <Input
        inputMode="numeric"
        type="password"
        placeholder="PIN"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        data-testid="crew-pin"
        required
      />
      {err ? <p className="text-sm" style={{ color: "var(--status-error)" }} data-testid="crew-pin-error">{err}</p> : null}
      <Button type="submit" disabled={pending} data-testid="crew-pin-submit">{pending ? "Checking…" : "Sign in"}</Button>
    </form>
  );
}
