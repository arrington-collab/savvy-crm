"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { saveDocumentNoteAction } from "@/lib/document-actions";

// Photo gallery + lightweight markup editor. Opens the job's photos full-screen;
// ◀/▶ (and ←/→) page through the whole set. A notes box beside the image
// autosaves a rep's field note per photo (fed to AI upsell drafting). "Markup"
// reveals arrow/circle/text/pen tools drawn on a canvas over the image; saving
// composites the shapes onto the pixels and uploads the result as a NEW photo
// document (the original is never touched), reusing the presign→PUT→record flow.

export interface AnnotatorDoc {
  id: string;
  filename: string | null;
  label: string | null;
  notes: string | null;
  externalUrl: string | null;
}

type Tool = "arrow" | "circle" | "text" | "pen";

interface Shape {
  tool: Tool;
  color: string;
  width: number;
  // arrow/circle: from → to; pen: points; text: at (from) with `text`
  from: { x: number; y: number };
  to: { x: number; y: number };
  points?: { x: number; y: number }[];
  text?: string;
}

const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#ffffff", "#111111"];
const TOOLS: { id: Tool; label: string; glyph: string }[] = [
  { id: "arrow", label: "Arrow", glyph: "↗" },
  { id: "circle", label: "Circle", glyph: "◯" },
  { id: "pen", label: "Pen", glyph: "✎" },
  { id: "text", label: "Text", glyph: "T" },
];

function drawShape(ctx: CanvasRenderingContext2D, s: Shape) {
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (s.tool === "arrow") {
    const { from, to } = s;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = Math.max(12, s.width * 4);
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  } else if (s.tool === "circle") {
    const cx = (s.from.x + s.to.x) / 2;
    const cy = (s.from.y + s.to.y) / 2;
    const rx = Math.abs(s.to.x - s.from.x) / 2;
    const ry = Math.abs(s.to.y - s.from.y) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.tool === "pen" && s.points && s.points.length > 1) {
    ctx.beginPath();
    ctx.moveTo(s.points[0]!.x, s.points[0]!.y);
    for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (s.tool === "text" && s.text) {
    const size = Math.max(18, s.width * 8);
    ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    // readability halo
    ctx.lineWidth = Math.max(2, size / 8);
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.strokeText(s.text, s.from.x, s.from.y);
    ctx.fillStyle = s.color;
    ctx.fillText(s.text, s.from.x, s.from.y);
  }
}

export function PhotoAnnotator({
  docs, startIndex, jobId, onClose, onSaved,
}: {
  docs: AnnotatorDoc[];
  startIndex: number;
  jobId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState<Tool>("arrow");
  const [color, setColor] = useState(COLORS[0]!);
  const [width, setWidth] = useState(4);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const draftRef = useRef<Shape | null>(null);
  const [textInput, setTextInput] = useState<{ x: number; y: number; value: string } | null>(null);
  const [saving, startSave] = useTransition();

  // ── gallery navigation ──
  const [index, setIndex] = useState(() => Math.min(Math.max(startIndex, 0), Math.max(docs.length - 1, 0)));
  const doc = docs[index] ?? null;
  const atStart = index <= 0;
  const atEnd = index >= docs.length - 1;
  const go = useCallback((delta: number) => {
    setIndex((i) => {
      const next = Math.min(Math.max(i + delta, 0), docs.length - 1);
      if (next !== i) { setEditing(false); setShapes([]); setFailed(false); setTextInput(null); }
      return next;
    });
  }, [docs.length]);

  // ── per-photo notes (autosave, debounced) ──
  // In-session edits are held per document id so paging away and back shows the
  // latest typed value; the server value (doc.notes) seeds each photo first.
  const [noteEdits, setNoteEdits] = useState<Record<string, string>>({});
  const [savedTick, setSavedTick] = useState(0);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteValue = doc ? (noteEdits[doc.id] ?? doc.notes ?? "") : "";
  function onNoteChange(v: string) {
    if (!doc) return;
    const id = doc.id;
    setNoteEdits((m) => ({ ...m, [id]: v }));
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(async () => {
      const r = await saveDocumentNoteAction(id, v);
      if ("error" in r) toast.error(r.error);
      else setSavedTick((t) => t + 1);
    }, 800);
  }
  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current); }, []);

  // Load the image through the SAME-ORIGIN proxy route, not the presigned R2
  // URL directly: R2 sends no CORS headers, so a cross-origin <img> both fails
  // to load and (if it loaded) would taint the canvas — breaking toBlob() on
  // save. The proxy streams the bytes from our origin, so the canvas stays
  // exportable. The parent remounts this per photo (keyed by id).
  // R2-backed photos stream through the same-origin proxy (canvas stays
  // exportable for markup). CompanyCam photos have only an external URL — show
  // it directly (drawImage works cross-origin; only markup EXPORT would taint,
  // so markup is disabled for those below).
  const docId = doc?.id;
  const src = doc?.externalUrl ?? (docId ? `/api/documents/${docId}/view` : null);
  const canMarkup = !!src && !doc?.externalUrl;

  // (re)paint the canvas: base image, committed shapes, then the in-progress draft
  const repaint = useCallback(() => {
    const canvas = canvasRef.current, img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const s of shapes) drawShape(ctx, s);
    if (draftRef.current) drawShape(ctx, draftRef.current);
  }, [shapes]);

  function onImgLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    imgRef.current = img;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    repaint();
  }

  useEffect(() => { repaint(); }, [shapes, repaint]);

  // Keyboard: ←/→ page photos, Esc closes. Ignore arrows while typing in a
  // field (notes textarea / markup text input) so the cursor still moves.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === "Escape") { onClose(); return; }
      if (editing || typing) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, go, onClose]);

  // map a pointer event to canvas (image-pixel) coordinates
  function toCanvas(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.width,
      y: ((e.clientY - r.top) / r.height) * canvas.height,
    };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!editing) return;
    const p = toCanvas(e);
    if (tool === "text") { setTextInput({ x: p.x, y: p.y, value: "" }); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    draftRef.current = { tool, color, width: scaledWidth(), from: p, to: p, points: tool === "pen" ? [p] : undefined };
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!editing || !draftRef.current) return;
    const p = toCanvas(e);
    draftRef.current.to = p;
    if (draftRef.current.tool === "pen") draftRef.current.points!.push(p);
    repaint();
  }
  function onPointerUp() {
    if (!draftRef.current) return;
    const s = draftRef.current;
    draftRef.current = null;
    // ignore accidental zero-length marks
    const moved = Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) > 3 || (s.points?.length ?? 0) > 2;
    if (moved) setShapes((prev) => [...prev, s]);
    else repaint();
  }

  // Stroke/text sizes are chosen against the on-screen preview but drawn in the
  // image's native pixel space, so scale them up to the image's resolution —
  // otherwise a 4px line is a hairline on a 3000px-wide photo.
  function scaledWidth() {
    return width * Math.max(1, (canvasRef.current?.width ?? 900) / 700);
  }

  function commitText() {
    if (textInput && textInput.value.trim()) {
      setShapes((prev) => [...prev, { tool: "text", color, width: scaledWidth(), from: { x: textInput.x, y: textInput.y }, to: { x: textInput.x, y: textInput.y }, text: textInput.value.trim() }]);
    }
    setTextInput(null);
  }

  function save() {
    const canvas = canvasRef.current;
    if (!canvas || !doc) return;
    startSave(async () => {
      // JPEG, not PNG: a full-res photo as PNG easily exceeds the upload body
      // limit, and photos belong in JPEG anyway. Quality 0.9 keeps annotations crisp.
      const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), "image/jpeg", 0.9));
      if (!blob) { toast.error("Could not render the image."); return; }
      const base = (doc.filename ?? "photo").replace(/\.[a-z0-9]+$/i, "");
      const filename = `${base}-markup.jpg`;
      const fd = new FormData();
      fd.append("file", blob, filename);
      fd.append("filename", filename);
      fd.append("label", doc.label ? `${doc.label} (markup)` : "markup");
      const res = await fetch(`/api/jobs/${jobId}/annotated-photo`, { method: "POST", body: fd }).catch(() => null);
      const json = res && res.ok ? await res.json().catch(() => null) : null;
      if (json?.ok) { toast.success("Marked-up photo saved."); onSaved(); onClose(); }
      else toast.error("Could not save the marked-up photo.");
    });
  }

  if (!doc) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Photo viewer">
      {/* top bar */}
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-sm text-white/80">{doc.label || doc.filename || "Photo"}</span>
          {docs.length > 1 && (
            <span className="mono shrink-0 text-xs text-white/50" data-testid="photo-counter">{index + 1} / {docs.length}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!editing ? (
            <>
              {src && !doc.externalUrl && (
                <a href={`${src}?download=1`} download={doc.filename ?? "photo"} className="text-xs text-white/70 underline-offset-2 hover:underline">
                  Download
                </a>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={!canMarkup} data-testid="photo-markup"
                title={doc.externalUrl ? "Markup unavailable for CompanyCam photos" : undefined}>
                Markup
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" className="text-white hover:text-white" onClick={() => setShapes((s) => s.slice(0, -1))} disabled={!shapes.length}>
                Undo
              </Button>
              <Button size="sm" variant="ghost" className="text-white hover:text-white" onClick={() => setShapes([])} disabled={!shapes.length}>
                Clear
              </Button>
              <Button size="sm" onClick={save} disabled={saving || !shapes.length} data-testid="photo-markup-save">
                {saving ? "Saving…" : "Save copy"}
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" className="text-white hover:text-white" onClick={onClose} aria-label="Close">✕</Button>
        </div>
      </div>

      {/* toolbar (edit mode) */}
      {editing && (
        <div className="flex flex-wrap items-center gap-3 border-b border-white/10 bg-black/40 px-4 py-2">
          <div className="flex items-center gap-1">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTool(t.id)}
                aria-pressed={tool === t.id}
                title={t.label}
                className={`flex h-8 w-8 items-center justify-center rounded-md border text-sm ${tool === t.id ? "border-white bg-white/15 text-white" : "border-white/20 text-white/70 hover:bg-white/10"}`}
              >
                {t.glyph}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                aria-label={`color ${c}`}
                aria-pressed={color === c}
                className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-white" : "border-white/30"}`}
                style={{ background: c }}
              />
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-white/70">
            Size
            <input type="range" min={2} max={12} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
          </label>
        </div>
      )}

      {/* stage */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {!editing && docs.length > 1 && (
          <>
            <button
              onClick={() => go(-1)} disabled={atStart} aria-label="Previous photo" data-testid="photo-prev"
              className="absolute left-3 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-2xl text-white/90 hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-30"
            >‹</button>
            <button
              onClick={() => go(1)} disabled={atEnd} aria-label="Next photo" data-testid="photo-next"
              className="absolute right-3 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-2xl text-white/90 hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-30"
            >›</button>
          </>
        )}
        {failed && <p className="text-sm text-white/70">Photo unavailable.</p>}
        {!failed && !src && <div className="h-40 w-40 animate-pulse rounded-md bg-white/10" aria-label="Loading photo" />}
        {src && (
          <>
            {/* hidden source image feeds the canvas */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img ref={imgRef} src={src} alt="" className="hidden" onLoad={onImgLoad} onError={() => setFailed(true)} />
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
              style={{ cursor: editing ? "crosshair" : "default", touchAction: "none" }}
              data-testid="photo-canvas"
            />
            {textInput && (
              <input
                autoFocus
                value={textInput.value}
                onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
                onBlur={commitText}
                onKeyDown={(e) => { if (e.key === "Enter") commitText(); if (e.key === "Escape") setTextInput(null); }}
                placeholder="Type, then Enter"
                className="absolute rounded border border-white/40 bg-black/70 px-2 py-1 text-sm text-white"
                style={{ left: "50%", top: "12%", transform: "translateX(-50%)" }}
              />
            )}
          </>
        )}
      </div>

      {/* notes (view mode) — autosaves; fed to AI upsell drafting */}
      {!editing && doc && (
        <div className="border-t border-white/10 bg-black/40 px-4 py-3">
          <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="photo-note" className="text-xs font-medium text-white/60">Notes for AI (estimates &amp; reports)</label>
              {savedTick > 0 && <span className="text-[11px] text-white/40" data-testid="photo-note-saved">Saved</span>}
            </div>
            <textarea
              id="photo-note"
              data-testid="photo-note"
              value={noteValue}
              onChange={(e) => onNoteChange(e.target.value)}
              rows={2}
              placeholder="e.g. hail bruising on north slope; gutters dented; 3 aged skylights"
              className="w-full resize-y rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-white/40 focus:outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
