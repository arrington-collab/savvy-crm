"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { saveQuickBooksConnection } from "@/lib/quickbooks-actions";

const ERROR_MESSAGES: Record<string, string> = {
  missing_connection_id: "QuickBooks connection failed — no connection id returned. Please try again.",
  unauthorized: "QuickBooks connection failed — not authorized. Please try again.",
  not_verified: "QuickBooks connection failed — could not verify connection ownership. Please try again.",
};

interface ConnectQuickBooksButtonProps {
  connected: boolean;
  connectionId?: string;
  /** Set when the page was reached via ?connected=1 after a successful connection */
  connectedFlag: boolean;
  /** Error code from ?error=<code> when the connection failed */
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

  // onConnected is the handler the Nango frontend SDK will call via its onSuccess
  // callback once @nangohq/frontend is installed. It persists the connectionId to
  // the tenant row via a server action (bypassing RLS, same pattern as Stripe).
  // It is wired into handleConnect's SDK stub below so it's live and type-checked.
  // TODO: replace the stub block with: nango.connect(token, { onSuccess: onConnected })
  const onConnected = async (nangoConnectionId: string): Promise<void> => {
    const result = await saveQuickBooksConnection(nangoConnectionId);
    if ("error" in result) {
      toast.error(
        ERROR_MESSAGES[result.error] ?? "Couldn't save QuickBooks connection.",
      );
    } else {
      toast.success("QuickBooks connected");
    }
  };

  async function handleConnect() {
    setLoading(true);
    try {
      // Step 1: Mint a Nango connect-session token from the server.
      const res = await fetch("/api/nango/qbo/start", { method: "POST" });
      const data = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || data.error || !data.token) {
        toast.error("Could not start QuickBooks connection.");
        return;
      }

      // Step 2 (STUB — pending @nangohq/frontend SDK install):
      // The session-token flow delivers the connectionId to the frontend via the
      // SDK's onSuccess callback — it is never sent to a server redirect URL.
      // When the SDK is installed, replace this block with:
      //
      //   import Nango from "@nangohq/frontend";
      //   const nango = new Nango();
      //   await nango.connect(data.token, { onSuccess: ({ connectionId }) => onConnected(connectionId) });
      //
      // For now, surface a clear message so the flow is honest in dev/staging.
      await onConnected(""); // ← calls the real persist path; empty string returns missing_connection_id error
      // (The error toast surfaces "no connection id returned" — expected until SDK is wired.)
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
