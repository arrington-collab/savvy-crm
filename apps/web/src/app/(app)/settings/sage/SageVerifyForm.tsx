"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { startSagePhoneVerification } from "@/lib/sage-verify-actions";

const ERRORS: Record<string, string> = {
  not_admin: "Only owners and admins can enable Sage-by-text.",
  no_phone: "Add a phone number on your profile first.",
  sms_failed: "Couldn't send the code — check SMS is configured.",
};

export function SageVerifyForm({ verified, canVerify }: { verified: boolean; canVerify: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  if (verified) {
    return <p className="text-sm text-green-600 dark:text-green-500">✅ Your number is verified — reply to your digest to act.</p>;
  }

  return (
    <div className="space-y-2">
      <Button
        disabled={!canVerify || pending}
        onClick={() =>
          start(async () => {
            const r = await startSagePhoneVerification();
            setMsg("ok" in r ? "Code sent — reply to the text with the 6-digit code." : ERRORS[r.error] ?? "Something went wrong.");
          })
        }
      >
        {pending ? "Sending…" : "Send verification code"}
      </Button>
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </div>
  );
}
