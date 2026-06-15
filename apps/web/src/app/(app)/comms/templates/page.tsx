import { listTemplates } from "@/lib/comms-queries";
import { Card } from "@/components/ui/card";
import { TemplateForm } from "./template-form";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const templates = await listTemplates();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Templates</h1>
      <TemplateForm />
      <div className="space-y-2">
        {templates.map((t) => (
          <Card key={t.id} className="p-3" data-testid="template-row">
            <div className="flex items-center justify-between">
              <div className="font-medium">{t.name} <span className="text-xs text-muted-foreground">({t.channel})</span></div>
              <code className="text-xs text-muted-foreground">{t.key}</code>
            </div>
            {t.subject && <div className="text-sm">Subject: {t.subject}</div>}
            <div className="text-sm text-muted-foreground whitespace-pre-wrap">{t.body}</div>
          </Card>
        ))}
        {templates.length === 0 && <p className="text-sm text-muted-foreground">No templates yet.</p>}
      </div>
    </div>
  );
}
