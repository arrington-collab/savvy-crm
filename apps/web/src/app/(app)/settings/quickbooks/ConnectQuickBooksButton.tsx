"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const ERROR_MESSAGES: Record<string, string> = {
  missing_connection_id: "QuickBooks connection failed — no connection id returned. Please try again.",
  unauthorized: "QuickBooks connection failed — not authorized. Please try again.",
  no_active_tenant: "QuickBooks connection failed — no active organization. Please try again.",
  persist_failed: "QuickBooks connection failed — could not save connection. Please try again.",
};

interface ConnectQuickBooksButtonProps {
  connected: boolean;
  connectionId?: string;
  /** Set when the page was reached via ?connected=1 redirect from Nango OAuth */
  connectedFlag: boolean;
  /** Error code from ?error=<code> when OAuth failed */
  errorCode?: string;
}

export function ConnectQuickBooksButton({
  connected,
  connectionId,
  connectedFlag,
  errorCode,
}: ConnectQuickBooksButtonProps) {
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (connectedFlag) {
      toast.success("QuickBooks connected");
    } else if (errorCode) {
      const msg =
        ERROR_MESSAGES[errorCode] ?? "Couldn't connect QuickBooks, try again.";
      toast.error(msg);
    }
    // Only run on mount — intentionally omitting deps that would re-fire
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConnect() {
    setLoading(true);
    try {
      const res = await fetch("/api/nango/qbo/start", { method: "POST" });
      const data = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || data.error) {
        toast.error("Could not start QuickBooks connection.");
        setLoading(false);
        return;
      }
      // Nango connect-sessions returns a token for the frontend SDK.
      // Without the full SDK installed, we surface the token for manual use in dev.
      // In production, pass this token to the Nango frontend SDK's connect() method.
      if (data.token) {
        toast.success("Connection session started (use Nango frontend SDK with this token).");
        console.info("Nango QBO connect session token:", data.token);
      } else {
        toast.error("Could not start QuickBooks connection.");
      }
    } catch {
      toast.error("Network error connecting to QuickBooks.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="p-4">
      <h2 className="font-semibold mb-1">QuickBooks Online</h2>
      {connected ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-green-600 dark:text-green-400">
              Connected ✓
            </span>
          </div>
          {connectionId && (
            <p className="text-xs text-muted-foreground font-mono">{connectionId}</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            No QuickBooks account connected yet.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={handleConnect}
          >
            {loading ? "Connecting…" : "Connect QuickBooks"}
          </Button>
        </div>
      )}
    </Card>
  );
}
