"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { inviteMember, changeUserRole, removeMember, addCrewMember } from "@/lib/team-actions";
import { setCrewPin } from "@/lib/crew-admin-actions";
import type { UserRole } from "@savvy/core";

type Member = { id: string; name: string; email: string; role: string; isClerkBacked: boolean; deactivated: boolean; hasPin: boolean };
const ROLES = ["owner", "admin", "rep", "office", "crew"] as const;

export function TeamManager({ team }: { team: Member[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("rep");
  const [crewName, setCrewName] = useState("");
  const [pins, setPins] = useState<Record<string, string>>({});

  function run(fn: () => Promise<{ ok: true } | { ok: true; id: string } | { error: string }>, okMsg: string) {
    start(async () => {
      const r = await fn();
      if ("error" in r) { toast.error(r.error); return; }
      toast.success(okMsg);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <div className="eyebrow mb-2">Invite teammate</div>
        <div className="flex flex-wrap items-center gap-2">
          <Input placeholder="email@company.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="w-64" />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} data-testid="invite-role"
            className="mono rounded-md border border-white/10 bg-transparent px-2 py-1.5 text-sm">
            <option value="admin">admin</option>
            <option value="rep">rep</option>
          </select>
          <Button disabled={pending} data-testid="invite-submit"
            onClick={() => run(() => inviteMember(inviteEmail, inviteRole as UserRole), "Invite sent")}>Invite</Button>
        </div>
      </Card>

      <Card className="p-4">
        <div className="eyebrow mb-2">Add crew member (PIN-only, no login)</div>
        <div className="flex flex-wrap items-center gap-2">
          <Input placeholder="Crew member name" value={crewName} onChange={(e) => setCrewName(e.target.value)} className="w-64" />
          <Button disabled={pending} data-testid="add-crew-submit"
            onClick={() => run(async () => { const r = await addCrewMember(crewName); if ("ok" in r) setCrewName(""); return r; }, "Crew member added")}>Add crew</Button>
        </div>
      </Card>

      <Card className="divide-y divide-white/5 p-0">
        {team.map((m) => (
          <div key={m.id} className="flex flex-wrap items-center gap-3 p-4" data-testid="team-row" data-user-id={m.id}
            style={{ opacity: m.deactivated ? 0.5 : 1 }}>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{m.name}{m.deactivated ? " · (removed)" : ""}</div>
              <div className="mono text-xs" style={{ color: "var(--text-muted)" }}>
                {m.email || (m.isClerkBacked ? "—" : "crew · no login")} · {m.role}
              </div>
            </div>
            {!m.deactivated && (
              <>
                <select value={m.role} disabled={pending} data-testid="role-select"
                  onChange={(e) => run(() => changeUserRole(m.id, e.target.value as UserRole), "Role updated")}
                  className="mono rounded-md border border-white/10 bg-transparent px-2 py-1.5 text-sm">
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                {!m.isClerkBacked && (
                  <Input placeholder={m.hasPin ? "reset PIN" : "set PIN"} value={pins[m.id] ?? ""}
                    onChange={(e) => setPins((p) => ({ ...p, [m.id]: e.target.value }))} className="w-24"
                    onBlur={() => { const pin = pins[m.id]; if (pin) run(() => setCrewPin(m.id, pin), "PIN set"); }} />
                )}
                <Button variant="outline" disabled={pending} data-testid="remove-member"
                  onClick={() => run(() => removeMember(m.id), "Removed")}>Remove</Button>
              </>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
