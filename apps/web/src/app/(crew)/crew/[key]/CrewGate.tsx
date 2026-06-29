"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { crewLogin, crewSelectMember } from "@/lib/crew-actions";

type MemberPickState = {
  crewId: string;
  members: { id: string; name: string }[];
};

export function CrewGate({ workspaceKey }: { workspaceKey: string }) {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Step 2 state: when a shared crew PIN matches, hold the member list
  const [memberPick, setMemberPick] = useState<MemberPickState | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    start(async () => {
      const r = await crewLogin(workspaceKey, pin);
      if ("error" in r) { setErr(r.error); return; }
      if ("selectCrew" in r) {
        // Shared crew PIN matched — keep pin in state (needed for step 2 re-verify)
        setMemberPick({ crewId: r.selectCrew.crewId, members: r.selectCrew.members });
        return;
      }
      router.refresh();
    });
  }

  function selectMember(memberId: string) {
    setErr(null);
    start(async () => {
      const r = await crewSelectMember(workspaceKey, pin, memberId);
      if ("error" in r) {
        setErr(r.error);
        return;
      }
      router.refresh();
    });
  }

  // Step 2: member picker
  if (memberPick) {
    return (
      <div className="space-y-3 pt-16" data-testid="crew-gate">
        <h1 className="text-lg font-semibold">Who are you?</h1>
        {err ? (
          <p className="text-sm" style={{ color: "var(--status-error)" }} data-testid="crew-pin-error">{err}</p>
        ) : null}
        <div className="space-y-2" data-testid="crew-member-pick">
          {memberPick.members.map((member) => (
            <Button
              key={member.id}
              type="button"
              variant="outline"
              className="w-full justify-start"
              disabled={pending}
              onClick={() => selectMember(member.id)}
              data-testid="crew-member-option"
              data-user-id={member.id}
            >
              {member.name}
            </Button>
          ))}
        </div>
        <button
          type="button"
          className="text-sm hover:underline"
          style={{ color: "var(--text-muted)" }}
          onClick={() => { setMemberPick(null); setErr(null); }}
        >
          ← Back
        </button>
      </div>
    );
  }

  // Step 1: PIN entry
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
