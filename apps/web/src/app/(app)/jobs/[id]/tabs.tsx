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
import { toggleTask } from "@/lib/job-actions";
import { DocsPanel, type DocRow } from "./DocsPanel";

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function automationBadge(level: string) {
  if (level === "full")
    return <Badge variant="secondary">Full Auto · will be automated</Badge>;
  if (level === "manual") return <Badge variant="outline">Manual</Badge>;
  return <Badge variant="secondary">Partial Auto</Badge>;
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
      <span
        className={
          done
            ? "flex-1 text-sm text-muted-foreground line-through"
            : "flex-1 text-sm"
        }
      >
        {task.title}
      </span>
      {automationBadge(task.automationLevel)}
      {task.dueAt ? (
        <span className="text-xs font-medium text-primary">
          active · {formatDate(task.dueAt)}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">upcoming</span>
      )}
    </div>
  );
}

export function JobTabs({
  tasksByPhase,
  timeline,
  comms,
  docs,
  requiredPhotos,
  jobId,
  jobType,
}: {
  tasksByPhase: { phase: string; tasks: TaskRow[] }[];
  timeline: TimelineItem[];
  comms: CommRow[];
  docs: DocRow[];
  requiredPhotos: string[];
  jobId: string;
  jobType: string;
}) {
  return (
    <Tabs defaultValue="tasks">
      <TabsList>
        <TabsTrigger value="tasks">Tasks</TabsTrigger>
        <TabsTrigger value="timeline">Timeline</TabsTrigger>
        <TabsTrigger value="comms">Comms</TabsTrigger>
        <TabsTrigger value="docs">Docs</TabsTrigger>
      </TabsList>

      <TabsContent value="tasks">
        {tasksByPhase.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks yet.</p>
        ) : (
          <div className="space-y-6">
            {tasksByPhase.map((group) => (
              <div key={group.phase} className="space-y-2">
                <h3 className="text-sm font-semibold capitalize text-muted-foreground">
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
            <p className="text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            timeline.map((item, i) => (
              <div key={i} className="flex items-start gap-3 text-sm">
                <span
                  className="mt-1.5 size-2 shrink-0 rounded-full bg-primary/60"
                  aria-hidden
                />
                <div className="flex-1">
                  <div>{item.text}</div>
                  <div className="text-xs text-muted-foreground">
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
          <p className="text-sm text-muted-foreground">
            No communications yet.
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
                  <span>{formatDate(c.createdAt)}</span>
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
          jobType={jobType}
          documents={docs}
          requiredPhotos={requiredPhotos}
        />
      </TabsContent>
    </Tabs>
  );
}
