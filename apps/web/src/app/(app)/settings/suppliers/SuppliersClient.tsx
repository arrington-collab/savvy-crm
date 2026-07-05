"use client";
import { useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addSupplierDomain, removeSupplierDomain } from "@/lib/supplier-allowlist-actions";
import type { getSupplierAllowlist } from "@/lib/supplier-allowlist-queries";
import { PageHeader } from "@/components/cockpit/PageHeader";

type AllowlistRow = Awaited<ReturnType<typeof getSupplierAllowlist>>[number];

function AllowlistRowItem({ row, onRemove }: { row: AllowlistRow; onRemove: (id: string) => void }) {
  const [removing, setRemoving] = useState(false);

  async function handleRemove() {
    setRemoving(true);
    await removeSupplierDomain(row.id);
    onRemove(row.id);
  }

  return (
    <Card className="p-4" data-testid="supplier-allowlist-row">
      <div className="grid grid-cols-[2fr_2fr_1fr_auto] gap-3 items-center text-sm">
        <span className="font-medium mono" style={{ color: "var(--text-body)" }}>{row.domain}</span>
        <span style={{ color: "var(--text-muted)" }}>{row.label ?? "—"}</span>
        <span className="text-xs" style={{ color: "var(--text-faint)" }}>
          {new Date(row.createdAt).toLocaleDateString()}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={handleRemove}
          disabled={removing}
          className="h-7 text-xs"
        >
          {removing ? "Removing…" : "Remove"}
        </Button>
      </div>
    </Card>
  );
}

export function SuppliersClient({ rows: initialRows }: { rows: AllowlistRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleRemove(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  async function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await addSupplierDomain(formData);
      if (result.error) {
        setError(result.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Configuration" title="Supplier auto-send allow-list" />

      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Empty = credit requests auto-send to any resolved supplier address. Add domains to restrict
        auto-send to only those suppliers.
      </p>

      {/* Add form */}
      <Card className="p-4">
        <form action={handleSubmit} className="flex flex-col gap-3">
          <div className="grid grid-cols-[2fr_2fr_auto] gap-3 items-end">
            <div className="flex flex-col gap-1">
              <label className="eyebrow text-xs" htmlFor="domain-input">
                Domain or email
              </label>
              <Input
                id="domain-input"
                name="domain"
                placeholder="abcsupply.com"
                className="h-8 text-sm"
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="eyebrow text-xs" htmlFor="label-input">
                Label (optional)
              </label>
              <Input
                id="label-input"
                name="label"
                placeholder="ABC Supply"
                className="h-8 text-sm"
              />
            </div>
            <Button type="submit" size="sm" disabled={isPending} className="h-8">
              {isPending ? "Adding…" : "Add domain"}
            </Button>
          </div>
          {error && (
            <p className="text-sm" style={{ color: "var(--color-danger, #ef4444)" }}>
              {error}
            </p>
          )}
        </form>
      </Card>

      {/* List */}
      <div className="space-y-2" data-testid="supplier-allowlist">
        {rows.length === 0 ? (
          <p className="text-sm px-1" style={{ color: "var(--text-faint)" }}>
            No domains added — auto-send is unrestricted.
          </p>
        ) : (
          <>
            {/* Header */}
            <div className="grid grid-cols-[2fr_2fr_1fr_auto] gap-3 px-4 eyebrow">
              <span>Domain</span>
              <span>Label</span>
              <span>Added</span>
              <span />
            </div>
            {rows.map((row) => (
              <AllowlistRowItem key={row.id} row={row} onRemove={handleRemove} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
