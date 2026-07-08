"use client";

import { useTransition } from "react";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toggleTask, setTaskAutomationLevel } from "@/lib/job-actions";
import { nextAutomationLevel, isAutomationLevel, type AutomationLevel } from "@savvy/core";
import { DocsPanel, type DocRow } from "./DocsPanel";
import type { DocParseSummary } from "@savvy/core";
import { EsignPanel, type EsignRow } from "./EsignPanel";
import { formatDate } from "@/lib/format";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { resolveAgent, personaLine, PERSONAS } from "@/lib/agents";

type CheckinRow = {
  id: string;
  crewName: string | null;
  checkedInAt: string;
  checkedOutAt: string | null;
};

type TaskRow = {
  id: string;
  title: string;
  phase: string;
  automationLevel: string;
  status: string;
  dueAt: string | null;
  ownerAgent: string | null;
};

type TimelineItem = {
  kind: "stage" | "comm" | "audit";
  at: string;
  text: string;
};

type CommRow = {
  id: string;
  channel: string;
  direction: string;
  body: string | null;
  createdAt: string;
};

function automationBadge(level: string) {
  if (level === "full") return <Badge variant="secondary">Full Auto</Badge>;
  if (level === "manual") return <Badge variant="outline">Manual</Badge>;
  return <Badge variant="secondary">Assisted</Badge>;
}

/** Clickable automation control: cycles Manual → Assisted → Auto → Manual (Background Ops). */
function AutomationLevelControl({ taskId, level }: { taskId: string; level: string }) {
  const [pending, startTransition] = useTransition();
  const current = (isAutomationLevel(level) ? level : "manual") as AutomationLevel;
  return (
    <button
      type="button"
      disabled={pending}
      data-testid="automation-level-control"
      title="Click to change automation: Manual → Assisted → Auto"
      onClick={() =>
        startTransition(async () => {
          await setTaskAutomationLevel(taskId, nextAutomationLevel(current));
        })
      }
      className="cursor-pointer rounded-full outline-none focus:ring-1 focus:ring-accent-gold disabled:opacity-50"
    >
      {automationBadge(current)}
    </button>
  );
}

function TaskItem({ task }: { task: TaskRow }) {
  const [pending, startTransition] = useTransition();
  const done = task.status === "done";

  return (
    <div
      data-testid="task-row"
      data-task-status={task.status}
      className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
    >
      <Checkbox
        checked={done}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          startTransition(async () => {
            await toggleTask(task.id, next);
          });
        }}
      />
      {task.ownerAgent ? (
        <AgentAvatar persona={resolveAgent({ agent: task.ownerAgent }).persona} size="sm" />
      ) : null}
      <span
        className={
          done
            ? "flex-1 text-sm text-muted-foreground line-through"
            : "flex-1 text-sm"
        }
      >
        {task.title}
      </span>
      <AutomationLevelControl taskId={task.id} level={task.automationLevel} />
      {task.dueAt ? (
        <span className="mono text-xs font-medium text-primary">
          active · {formatDate(task.dueAt)}
        </span>
      ) : (
        <span className="mono text-xs text-muted-foreground">upcoming</span>
      )}
    </div>
  );
}

export function JobTabs({
  tasksByPhase,
  timeline,
  comms,
  docs,
  docParseSummaries,
  requiredPhotos,
  jobId,
  companycamProjectId,
  esignRequests,
  customerEmail,
  checkins,
}: {
  tasksByPhase: { phase: string; tasks: TaskRow[] }[];
  timeline: TimelineItem[];
  comms: CommRow[];
  docs: DocRow[];
  docParseSummaries: Record<string, DocParseSummary>;
  requiredPhotos: string[];
  jobId: string;
  companycamProjectId: string | null;
  esignRequests: EsignRow[];
  customerEmail: string | null;
  checkins: CheckinRow[];
}) {
  return (
    <Tabs defaultValue="tasks">
      <TabsList>
        <TabsTrigger value="tasks">Tasks</TabsTrigger>
        <TabsTrigger value="timeline">Timeline</TabsTrigger>
        <TabsTrigger value="comms">Comms</TabsTrigger>
        <TabsTrigger value="docs">Docs</TabsTrigger>
        <TabsTrigger value="esign">E-sign</TabsTrigger>
      </TabsList>

      <TabsContent value="tasks">
        {tasksByPhase.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks yet.</p>
        ) : (
          <div className="space-y-6">
            {tasksByPhase.map((group) => (
              <div key={group.phase} className="space-y-2">
                <h3 className="eyebrow capitalize">
                  {group.phase}
                </h3>
                <div className="space-y-2">
                  {group.tasks.map((task) => (
                    <TaskItem key={task.id} task={task} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="timeline">
        <div data-testid="timeline" className="space-y-3">
          {timeline.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-faint)" }}>{personaLine(PERSONAS.SAGE)}</p>
          ) : (
            timeline.map((item, i) => (
              <div key={i} className="flex items-start gap-3 text-sm">
                <span
                  className="mt-1.5 size-2 shrink-0 rounded-full bg-primary/60"
                  aria-hidden
                />
                <div className="flex-1">
                  <div>{item.text}</div>
                  <div className="mono text-xs" style={{ color: "var(--text-faint)" }}>
                    {formatDate(item.at)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </TabsContent>

      <TabsContent value="comms">
        {comms.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>
            {personaLine(PERSONAS.NOVA)}
          </p>
        ) : (
          <div className="space-y-2">
            {comms.map((c) => (
              <div
                key={c.id}
                className="rounded-md border border-border px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="capitalize">
                    {c.direction} · {c.channel}
                  </span>
                  <span className="mono" style={{ color: "var(--text-faint)" }}>{formatDate(c.createdAt)}</span>
                </div>
                {c.body && <div className="mt-1">{c.body}</div>}
              </div>
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="docs">
        <DocsPanel
          jobId={jobId}
          documents={docs}
          parseSummaries={docParseSummaries}
          requiredPhotos={requiredPhotos}
          companycamProjectId={companycamProjectId}
        />

        {/* ── Crew check-in history ───────────────────────────────────── */}
        {checkins.length > 0 && (
          <div data-testid="crew-checkin-strip" className="mt-6 space-y-2">
            <h3 className="text-sm font-semibold text-muted-foreground">Crew check-ins</h3>
            {checkins.map((c) => (
              <div key={c.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
                <AgentAvatar
                  persona={resolveAgent({ agent: "scheduling", taskKey: "crew.checkin" }).persona}
                  size="sm"
                />
                <span className="flex-1 truncate">
                  {c.crewName ?? "Crew member"}
                </span>
                <span className="mono text-xs text-muted-foreground">
                  in {formatDate(c.checkedInAt)} · out {c.checkedOutAt ? formatDate(c.checkedOutAt) : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="esign">
        <EsignPanel jobId={jobId} customerEmail={customerEmail} requests={esignRequests} />
      </TabsContent>
    </Tabs>
  );
}
