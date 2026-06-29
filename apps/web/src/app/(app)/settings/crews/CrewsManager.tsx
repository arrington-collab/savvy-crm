"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  createCrewAction,
  renameCrewAction,
  setCrewActiveAction,
  setCrewLocationAction,
  addCrewMemberAction,
  removeCrewMemberAction,
  setCrewPinAction,
} from "@/lib/crew-team-actions";

type CrewMember = { userId: string; name: string };
type Crew = { id: string; name: string; active: boolean; baseLat: number | null; baseLng: number | null; hasPin: boolean; members: CrewMember[] };
type CrewUser = { id: string; name: string; hasPin: boolean };

export function CrewsManager(props: {
  initialCrews: Crew[];
  crewUsers: CrewUser[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [newCrewName, setNewCrewName] = useState("");
  // Per-crew rename state
  const [renameInputs, setRenameInputs] = useState<Record<string, string>>({});
  // Per-crew selected user to add
  const [addSelects, setAddSelects] = useState<Record<string, string>>({});
  // Per-crew home-base lat/lng edits (raw strings; seeded from props on first edit)
  const [locInputs, setLocInputs] = useState<Record<string, { lat: string; lng: string }>>({});
  // Per-crew shared PIN inputs
  const [pinInputs, setPinInputs] = useState<Record<string, string>>({});

  function run(fn: () => Promise<{ ok: true }>, okMsg: string) {
    start(async () => {
      await fn();
      toast.success(okMsg);
      router.refresh();
    });
  }

  function handleCreate() {
    const name = newCrewName.trim();
    if (!name) return;
    run(async () => {
      const r = await createCrewAction({ name });
      setNewCrewName("");
      return r;
    }, "Crew created");
  }

  function handleRename(crewId: string) {
    const name = (renameInputs[crewId] ?? "").trim();
    if (!name) return;
    run(() => renameCrewAction({ crewId, name }), "Crew renamed");
  }

  function handleToggleActive(crewId: string, active: boolean) {
    run(() => setCrewActiveAction({ crewId, active }), active ? "Crew activated" : "Crew deactivated");
  }

  function handleSaveLocation(crewId: string, raw: { lat: string; lng: string }) {
    const lat = raw.lat.trim();
    const lng = raw.lng.trim();
    if (lat === "" && lng === "") {
      run(() => setCrewLocationAction({ crewId, baseLat: null, baseLng: null }), "Crew location cleared");
      return;
    }
    const latNum = Number(lat);
    const lngNum = Number(lng);
    if (Number.isNaN(latNum) || Number.isNaN(lngNum) || latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      toast.error("Enter a valid latitude (−90…90) and longitude (−180…180), or clear both.");
      return;
    }
    run(() => setCrewLocationAction({ crewId, baseLat: latNum, baseLng: lngNum }), "Crew location saved");
  }

  function handleAddMember(crewId: string) {
    const userId = addSelects[crewId] ?? "";
    if (!userId) return;
    run(async () => {
      const r = await addCrewMemberAction({ crewId, userId });
      setAddSelects((prev) => ({ ...prev, [crewId]: "" }));
      return r;
    }, "Member added");
  }

  function handleRemoveMember(crewId: string, userId: string) {
    run(() => removeCrewMemberAction({ crewId, userId }), "Member removed");
  }

  function handleSavePin(crewId: string) {
    const value = (pinInputs[crewId] ?? "").trim();
    const pin = value === "" ? null : value;
    if (pin !== null && !/^\d{6,8}$/.test(pin)) {
      toast.error("PIN must be 6–8 digits");
      return;
    }
    run(async () => {
      const r = await setCrewPinAction({ crewId, pin });
      if ("error" in r) { toast.error(r.error); return { ok: true as const }; }
      setPinInputs((prev) => ({ ...prev, [crewId]: "" }));
      return r;
    }, pin === null ? "Crew PIN cleared" : "Crew PIN saved");
  }

  return (
    <div className="space-y-6" data-testid="crews-manager">
      {/* Create new crew */}
      <Card className="p-4">
        <div className="eyebrow mb-2">New crew</div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            data-testid="new-crew-input"
            placeholder="Crew name (e.g. Alpha team)"
            value={newCrewName}
            onChange={(e) => setNewCrewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
            className="w-64"
          />
          <Button
            data-testid="create-crew-btn"
            disabled={pending || !newCrewName.trim()}
            onClick={handleCreate}
          >
            Create crew
          </Button>
        </div>
      </Card>

      {/* Crew list */}
      {props.initialCrews.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-faint)" }}>
          No crews yet — create one above.
        </p>
      ) : (
        <div className="space-y-4">
          {props.initialCrews.map((crew) => {
            // Users not already in this crew
            const eligibleUsers = props.crewUsers.filter(
              (u) => !crew.members.some((m) => m.userId === u.id),
            );

            return (
              <Card key={crew.id} className="p-4" data-testid="crew-row" data-crew-id={crew.id}>
                {/* Header row: name + active toggle */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium" style={{ color: "var(--text-primary)", opacity: crew.active ? 1 : 0.5 }}>
                      {crew.name}
                      {!crew.active && (
                        <span className="ml-2 text-xs" style={{ color: "var(--text-faint)" }}>
                          (inactive)
                        </span>
                      )}
                    </div>
                    <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                      {crew.members.length} member{crew.members.length !== 1 ? "s" : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => handleToggleActive(crew.id, !crew.active)}
                  >
                    {crew.active ? "Deactivate" : "Activate"}
                  </Button>
                </div>

                {/* Rename */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Input
                    placeholder={`Rename "${crew.name}"`}
                    value={renameInputs[crew.id] ?? ""}
                    onChange={(e) => setRenameInputs((prev) => ({ ...prev, [crew.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") handleRename(crew.id); }}
                    className="w-48 text-sm"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || !(renameInputs[crew.id] ?? "").trim()}
                    onClick={() => handleRename(crew.id)}
                  >
                    Rename
                  </Button>
                </div>

                {/* Home base (drive-time origin for install slot recommendations) */}
                {(() => {
                  const loc = locInputs[crew.id] ?? {
                    lat: crew.baseLat?.toString() ?? "",
                    lng: crew.baseLng?.toString() ?? "",
                  };
                  return (
                    <div className="mt-3 flex flex-wrap items-end gap-2" data-testid="crew-location">
                      <label className="text-xs" style={{ color: "var(--text-muted)" }}>
                        Base latitude
                        <Input
                          data-testid="crew-base-lat"
                          inputMode="decimal"
                          placeholder="33.45"
                          value={loc.lat}
                          onChange={(e) => setLocInputs((p) => ({ ...p, [crew.id]: { ...loc, lat: e.target.value } }))}
                          className="mt-0.5 w-32 text-sm"
                        />
                      </label>
                      <label className="text-xs" style={{ color: "var(--text-muted)" }}>
                        Base longitude
                        <Input
                          data-testid="crew-base-lng"
                          inputMode="decimal"
                          placeholder="-112.07"
                          value={loc.lng}
                          onChange={(e) => setLocInputs((p) => ({ ...p, [crew.id]: { ...loc, lng: e.target.value } }))}
                          className="mt-0.5 w-32 text-sm"
                        />
                      </label>
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid="save-crew-location-btn"
                        disabled={pending}
                        onClick={() => handleSaveLocation(crew.id, loc)}
                      >
                        Save base
                      </Button>
                    </div>
                  );
                })()}

                {/* Shared crew PIN */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Input
                    inputMode="numeric"
                    type="password"
                    placeholder="6–8 digit PIN"
                    value={pinInputs[crew.id] ?? ""}
                    onChange={(e) => setPinInputs((prev) => ({ ...prev, [crew.id]: e.target.value }))}
                    className="w-36 text-sm"
                    data-testid="crew-pin-input"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => handleSavePin(crew.id)}
                    data-testid="save-crew-pin-btn"
                  >
                    {crew.hasPin ? "Update PIN" : "Set PIN"}
                  </Button>
                  {crew.hasPin && (
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                      PIN set
                    </span>
                  )}
                </div>

                {/* Members */}
                {crew.members.length > 0 && (
                  <div className="mt-3 divide-y" style={{ borderColor: "var(--border-panel)" }}>
                    {crew.members.map((member) => (
                      <div key={member.userId} className="flex items-center justify-between py-1.5">
                        <span className="text-sm" style={{ color: "var(--text-body)" }}>{member.name}</span>
                        <button
                          data-testid="remove-member-btn"
                          data-user-id={member.userId}
                          disabled={pending}
                          onClick={() => handleRemoveMember(crew.id, member.userId)}
                          className="text-xs hover:underline"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add member */}
                {eligibleUsers.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <select
                      data-testid="add-member-select"
                      value={addSelects[crew.id] ?? ""}
                      onChange={(e) => setAddSelects((prev) => ({ ...prev, [crew.id]: e.target.value }))}
                      className="rounded-md border bg-transparent px-2 py-1 text-sm"
                      style={{ borderColor: "var(--border-panel)", color: "var(--text-body)" }}
                    >
                      <option value="">Add member…</option>
                      {eligibleUsers.map((u) => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || !(addSelects[crew.id] ?? "")}
                      onClick={() => handleAddMember(crew.id)}
                    >
                      Add
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
