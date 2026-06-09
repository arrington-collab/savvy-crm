"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

const TabsCtx = React.createContext<{ value: string; setValue: (v: string) => void } | null>(null);

export function Tabs({ defaultValue, className, children }: { defaultValue: string; className?: string; children: React.ReactNode }) {
  const [value, setValue] = React.useState(defaultValue);
  return <TabsCtx.Provider value={{ value, setValue }}><div className={className}>{children}</div></TabsCtx.Provider>;
}
export function TabsList({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("inline-flex items-center gap-1 rounded-lg border bg-muted/40 p-1", className)}>{children}</div>;
}
export function TabsTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  const ctx = React.useContext(TabsCtx)!;
  const active = ctx.value === value;
  return (
    <button type="button" onClick={() => ctx.setValue(value)}
      className={cn("rounded-md px-3 py-1.5 text-sm font-medium transition-colors", active ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
      data-state={active ? "active" : "inactive"}>
      {children}
    </button>
  );
}
export function TabsContent({ value, className, children }: { value: string; className?: string; children: React.ReactNode }) {
  const ctx = React.useContext(TabsCtx)!;
  if (ctx.value !== value) return null;
  return <div className={cn("mt-4", className)}>{children}</div>;
}
