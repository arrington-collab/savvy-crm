"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { saveTemplate } from "@/lib/comms-actions";
import type { MessageChannel } from "@savvy/core";

export function TemplateForm() {
  const [pending, start] = useTransition();
  const [channel, setChannel] = useState<MessageChannel>("sms");

  return (
    <Card className="p-4">
      <form
        className="grid gap-2 sm:grid-cols-2"
        action={(fd) => {
          const key = String(fd.get("key") ?? "").trim();
          const name = String(fd.get("name") ?? "").trim();
          const body = String(fd.get("body") ?? "").trim();
          if (!key || !name || !body) { toast.error("key, name and body are required"); return; }
          start(async () => {
            await saveTemplate({
              key, name, channel, body,
              subject: channel === "email" ? String(fd.get("subject") ?? "") : undefined,
            });
            toast.success("Template saved");
          });
        }}
      >
        <input name="key" placeholder="key (stable id)" className="rounded border px-2 py-1.5 text-sm" />
        <input name="name" placeholder="name" className="rounded border px-2 py-1.5 text-sm" />
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value as MessageChannel)}
          className="rounded border px-2 py-1.5 text-sm"
        >
          <option value="sms">sms</option>
          <option value="email">email</option>
        </select>
        {channel === "email" && (
          <input name="subject" placeholder="subject" className="rounded border px-2 py-1.5 text-sm" />
        )}
        <textarea
          name="body"
          placeholder="body (use {{firstName}}, {{name}})"
          className="sm:col-span-2 rounded border px-2 py-1.5 text-sm"
          rows={3}
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Saving…" : "Add template"}
        </button>
      </form>
    </Card>
  );
}
