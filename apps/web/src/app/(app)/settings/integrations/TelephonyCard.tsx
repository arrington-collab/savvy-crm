"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  setTelephonyModeAction,
  saveTwilioConnectionAction,
  testTwilioConnectionAction,
  disconnectTelephonyAction,
  requestManagedSetupAction,
} from "@/lib/telephony-actions";

interface Props {
  mode: "platform" | "byo";
  status: "pending" | "active" | "disabled" | "setup_requested" | null;
  fromNumber: string | null;
}

export function TelephonyCard({ mode, status, fromNumber }: Props) {
  const [pending, start] = useTransition();
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [from, setFrom] = useState(fromNumber ?? "");

  function run(fn: () => Promise<{ ok: true } | { error: string }>, okMsg: string) {
    start(async () => {
      const r = await fn();
      if ("ok" in r) toast.success(okMsg);
      else toast.error(r.error);
    });
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="flex gap-2">
        <Button
          variant={mode === "platform" ? "default" : "outline"}
          disabled={pending}
          onClick={() => run(() => setTelephonyModeAction("platform"), "Using Savvy platform telephony")}
        >
          Savvy-managed
        </Button>
        <Button
          variant={mode === "byo" ? "default" : "outline"}
          disabled={pending}
          onClick={() => run(() => setTelephonyModeAction("byo"), "Switched to your own account")}
        >
          Bring your own
        </Button>
      </div>

      {status === "setup_requested" && (
        <p className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
          Setup requested — Savvy will reach out to finish connecting your account.
        </p>
      )}

      {mode === "byo" && (
        <div className="space-y-3">
          <div className="text-sm">
            Status:{" "}
            <span className={status === "active" ? "text-green-600" : "text-muted-foreground"}>
              {status === "active" ? `Connected ✓ (${from || "no number"})` : (status ?? "not connected")}
            </span>
          </div>

          <Input
            placeholder="Account SID (AC…)"
            value={accountSid}
            onChange={(e) => setAccountSid(e.target.value)}
          />
          <Input
            placeholder="Auth Token"
            type="password"
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
          />
          <Input
            placeholder="From number (+1…)"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending}
              onClick={() =>
                run(
                  () => saveTwilioConnectionAction({ accountSid, authToken, fromNumber: from }),
                  "Credentials saved",
                )
              }
            >
              Save
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => run(() => testTwilioConnectionAction(), "Connection verified")}
            >
              Test connection
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => run(() => disconnectTelephonyAction(), "Disconnected")}
            >
              Disconnect
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => requestManagedSetupAction(), "Setup requested")}
            >
              Have Savvy set this up
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
