"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveSchedulingConfig } from "@/lib/settings-actions";
import type { SchedulingConfig } from "@savvy/core";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Weekday = (typeof WEEKDAYS)[number];
const DAY_LABELS: Record<Weekday, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};

const APPT_TYPES = ["inspection", "cm", "crew"] as const;
type ApptType = (typeof APPT_TYPES)[number];
const TYPE_LABELS: Record<ApptType, string> = { inspection: "Inspection", cm: "CM", crew: "Crew" };

type HoursState = Record<Weekday, { enabled: boolean; open: number; close: number }>;
type TypesState = Record<ApptType, { durationMin: number; bufferMin: number }>;
type Reminder = { offsetH: number; channel: "sms" | "email" };

function buildHoursState(cfg: SchedulingConfig): HoursState {
  return Object.fromEntries(
    WEEKDAYS.map((d) => {
      const h = cfg.hours[d];
      const enabled = Array.isArray(h) && h.length === 2;
      return [d, { enabled, open: enabled ? (h as [number, number])[0] : 8, close: enabled ? (h as [number, number])[1] : 17 }];
    }),
  ) as HoursState;
}

function buildHoursConfig(state: HoursState): Record<string, number[]> {
  return Object.fromEntries(
    WEEKDAYS.map((d) => [d, state[d].enabled ? [state[d].open, state[d].close] : []]),
  );
}

export function SchedulingSettingsForm({ config }: { config: SchedulingConfig }) {
  const [pending, start] = useTransition();

  // Working hours state
  const [hours, setHours] = useState<HoursState>(() => buildHoursState(config));

  // Slot / horizon settings
  const [granularity, setGranularity] = useState(config.slotGranularityMin);
  const [horizon, setHorizon] = useState(config.bookingHorizonDays);

  // Per-type durations
  const [types, setTypes] = useState<TypesState>(() =>
    Object.fromEntries(APPT_TYPES.map((t) => [t, { ...config.types[t] }])) as TypesState,
  );

  // Reminder rows
  const [reminders, setReminders] = useState<Reminder[]>(() =>
    config.reminders.map((r) => ({ offsetH: r.offsetH, channel: r.channel })),
  );

  // Google Calendar connect state
  const [gcalState, setGcalState] = useState<"idle" | "loading" | "done" | "error">("idle");

  function updateHours(day: Weekday, field: keyof HoursState[Weekday], value: boolean | number) {
    setHours((prev) => ({ ...prev, [day]: { ...prev[day], [field]: value } }));
  }

  function updateType(t: ApptType, field: "durationMin" | "bufferMin", value: number) {
    setTypes((prev) => ({ ...prev, [t]: { ...prev[t], [field]: value } }));
  }

  function addReminder() {
    setReminders((prev) => [...prev, { offsetH: 24, channel: "sms" }]);
  }

  function removeReminder(i: number) {
    setReminders((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateReminder(i: number, field: keyof Reminder, value: number | string) {
    setReminders((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)),
    );
  }

  function handleSubmit() {
    start(async () => {
      const cfg = {
        hours: buildHoursConfig(hours),
        slotGranularityMin: granularity,
        bookingHorizonDays: horizon,
        types,
        reminders,
      };
      const result = await saveSchedulingConfig(cfg);
      if ("error" in result) {
        toast.error("Invalid configuration — check your inputs.");
      } else {
        toast.success("Scheduling settings saved.");
      }
    });
  }

  async function handleConnectGCal() {
    setGcalState("loading");
    try {
      const res = await fetch("/api/nango/connect", { method: "POST" });
      const data = (await res.json()) as { token?: string; url?: string; error?: string };
      if (!res.ok || data.error) {
        toast.error("Could not start Google Calendar connection.");
        setGcalState("error");
        return;
      }
      // If Nango returns a redirect URL, open it; otherwise show the session token.
      // Full OAuth callback persistence is a follow-up (Task 19+).
      if (data.url) {
        window.open(data.url, "_blank");
        setGcalState("done");
        toast.success("Google Calendar connection opened in a new tab.");
      } else {
        // Nango connect-sessions returns a token for the frontend SDK.
        // Without the SDK installed, we surface the token for manual use in dev.
        setGcalState("done");
        toast.success("Connection session started (Nango SDK not installed; use the token manually in dev).");
        console.info("Nango connect session token:", data.token ?? data);
      }
    } catch {
      toast.error("Network error connecting to Google Calendar.");
      setGcalState("error");
    }
  }

  return (
    <div className="space-y-6">
      {/* Working hours */}
      <Card className="p-4">
        <h2 className="font-semibold mb-3">Working Hours</h2>
        <div className="space-y-2">
          {WEEKDAYS.map((day) => (
            <div key={day} className="flex items-center gap-3">
              <input
                type="checkbox"
                id={`enabled-${day}`}
                checked={hours[day].enabled}
                onChange={(e) => updateHours(day, "enabled", e.target.checked)}
                className="h-4 w-4"
              />
              <Label htmlFor={`enabled-${day}`} className="w-24 text-sm">
                {DAY_LABELS[day]}
              </Label>
              {hours[day].enabled ? (
                <>
                  <Input
                    type="number"
                    value={hours[day].open}
                    min={0}
                    max={23}
                    onChange={(e) => updateHours(day, "open", Number(e.target.value))}
                    className="w-16 text-sm"
                    aria-label={`${DAY_LABELS[day]} open hour`}
                  />
                  <span className="text-sm text-muted-foreground">to</span>
                  <Input
                    type="number"
                    value={hours[day].close}
                    min={0}
                    max={24}
                    onChange={(e) => updateHours(day, "close", Number(e.target.value))}
                    className="w-16 text-sm"
                    aria-label={`${DAY_LABELS[day]} close hour`}
                  />
                </>
              ) : (
                <span className="text-sm text-muted-foreground">Closed</span>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* Slot settings */}
      <Card className="p-4">
        <h2 className="font-semibold mb-3">Slot Settings</h2>
        <div className="flex flex-wrap gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="granularity" className="text-sm">Slot granularity (min)</Label>
            <Input
              id="granularity"
              type="number"
              value={granularity}
              min={5}
              max={120}
              onChange={(e) => setGranularity(Number(e.target.value))}
              className="w-24 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="horizon" className="text-sm">Booking horizon (days)</Label>
            <Input
              id="horizon"
              type="number"
              value={horizon}
              min={1}
              max={365}
              onChange={(e) => setHorizon(Number(e.target.value))}
              className="w-24 text-sm"
            />
          </div>
        </div>
      </Card>

      {/* Per-type durations */}
      <Card className="p-4">
        <h2 className="font-semibold mb-3">Appointment Type Durations</h2>
        <div className="space-y-3">
          {APPT_TYPES.map((t) => (
            <div key={t} className="flex items-center gap-4">
              <span className="w-24 text-sm font-medium">{TYPE_LABELS[t]}</span>
              <div className="flex flex-col gap-0.5">
                <Label className="text-xs text-muted-foreground">Duration (min)</Label>
                <Input
                  type="number"
                  value={types[t].durationMin}
                  min={5}
                  onChange={(e) => updateType(t, "durationMin", Number(e.target.value))}
                  className="w-20 text-sm"
                  aria-label={`${TYPE_LABELS[t]} duration`}
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <Label className="text-xs text-muted-foreground">Buffer (min)</Label>
                <Input
                  type="number"
                  value={types[t].bufferMin}
                  min={0}
                  onChange={(e) => updateType(t, "bufferMin", Number(e.target.value))}
                  className="w-20 text-sm"
                  aria-label={`${TYPE_LABELS[t]} buffer`}
                />
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Reminder builder */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Appointment Reminders</h2>
          <Button type="button" variant="outline" size="sm" onClick={addReminder}>
            + Add reminder
          </Button>
        </div>
        {reminders.length === 0 && (
          <p className="text-sm text-muted-foreground">No reminders configured.</p>
        )}
        <div className="space-y-2">
          {reminders.map((r, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="flex flex-col gap-0.5">
                <Label className="text-xs text-muted-foreground">Before appt (hours)</Label>
                <Input
                  type="number"
                  value={r.offsetH}
                  min={0.5}
                  step={0.5}
                  onChange={(e) => updateReminder(i, "offsetH", Number(e.target.value))}
                  className="w-24 text-sm"
                  aria-label={`Reminder ${i + 1} offset hours`}
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <Label className="text-xs text-muted-foreground">Channel</Label>
                <select
                  value={r.channel}
                  onChange={(e) => updateReminder(i, "channel", e.target.value)}
                  className="rounded border px-2 py-1.5 text-sm h-9"
                  aria-label={`Reminder ${i + 1} channel`}
                >
                  <option value="sms">SMS</option>
                  <option value="email">Email</option>
                </select>
              </div>
              <button
                type="button"
                onClick={() => removeReminder(i)}
                className="mt-4 text-sm text-destructive hover:underline"
                aria-label={`Remove reminder ${i + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </Card>

      {/* Google Calendar connect */}
      <Card className="p-4">
        <h2 className="font-semibold mb-1">Google Calendar</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Connect your Google Calendar to sync appointments. Full callback persistence is a follow-up (Task 19+).
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={gcalState === "loading" || gcalState === "done"}
          onClick={handleConnectGCal}
        >
          {gcalState === "loading" ? "Connecting…" : gcalState === "done" ? "Connection initiated" : "Connect Google Calendar"}
        </Button>
      </Card>

      {/* Save */}
      <div className="flex justify-end">
        <Button onClick={handleSubmit} disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}
