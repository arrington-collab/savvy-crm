"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const ERROR_MESSAGES: Record<string, string> = {
  invalid: "Couldn't connect Stripe — invalid request. Please try again.",
  mismatch: "Couldn't connect Stripe — account mismatch. Please try again.",
  unauthorized: "Couldn't connect Stripe — not authorized. Please try again.",
  exchange_failed: "Couldn't connect Stripe — exchange failed. Please try again.",
};

interface ConnectStripeButtonProps {
  connected: boolean;
  accountId?: string;
  /** Set when the page was reached via ?connected=1 redirect from Stripe OAuth */
  connectedFlag: boolean;
  /** Error code from ?error=<code> when OAuth failed */
  errorCode?: string;
}

export function ConnectStripeButton({
  connected,
  accountId,
  connectedFlag,
  errorCode,
}: ConnectStripeButtonProps) {
  useEffect(() => {
    if (connectedFlag) {
      toast.success("Stripe connected");
    } else if (errorCode) {
      const msg =
        ERROR_MESSAGES[errorCode] ??
        "Couldn't connect Stripe, try again.";
      toast.error(msg);
    }
    // Only run on mount — intentionally omitting deps that would re-fire
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card className="p-4">
      <h2 className="font-semibold mb-1">Stripe Account</h2>
      {connected ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-green-600 dark:text-green-400">
              Connected ✓
            </span>
          </div>
          {accountId && (
            <p className="text-xs text-muted-foreground font-mono">{accountId}</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            No Stripe account connected yet.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              window.location.href = "/api/stripe/connect/start";
            }}
          >
            Connect Stripe
          </Button>
        </div>
      )}
    </Card>
  );
}
