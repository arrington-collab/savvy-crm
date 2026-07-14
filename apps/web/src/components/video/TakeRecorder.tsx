"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { presignVideoUpload, recordEstimateVideoAction } from "@/lib/video-actions";

// Slice 5b: the take recorder — teleprompter overlay, record 30–60s, one-tap
// approve/redo with a quick preview, auto-attach to the estimate. No filing,
// no uploads to think about. Used by the owner batch AND the rep single-take.
export function TakeRecorder({
  estimateId,
  role,
  overlay,
  onDone,
}: {
  estimateId: string;
  role: "rep" | "owner";
  overlay: { headline: string; lines: string[] };
  onDone: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [phase, setPhase] = useState<"idle" | "live" | "recording" | "preview" | "uploading">("idle");
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    return () => streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: true });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play();
      }
      setPhase("live");
    } catch {
      setError("Camera unavailable — check permissions.");
    }
  }

  function record() {
    if (!streamRef.current) return;
    chunksRef.current = [];
    const rec = new MediaRecorder(streamRef.current, { mimeType: "video/webm" });
    rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
    rec.onstop = () => {
      const b = new Blob(chunksRef.current, { type: "video/webm" });
      setBlob(b);
      if (videoRef.current) {
        videoRef.current.srcObject = null;
        videoRef.current.src = URL.createObjectURL(b);
        videoRef.current.currentTime = 0;
        void videoRef.current.play(); // the first-3-seconds gut check
        setTimeout(() => videoRef.current?.pause(), 3200);
      }
      setPhase("preview");
    };
    recorderRef.current = rec;
    setSeconds(0);
    rec.start();
    setPhase("recording");
  }

  function stop() {
    recorderRef.current?.stop();
  }

  async function approve() {
    if (!blob) return;
    setPhase("uploading");
    try {
      const { url, r2Key } = await presignVideoUpload({ estimateId, contentType: "video/webm" });
      const put = await fetch(url, { method: "PUT", headers: { "Content-Type": "video/webm" }, body: blob });
      if (!put.ok) throw new Error("upload failed");
      await recordEstimateVideoAction({ estimateId, role, r2Key, sizeBytes: blob.size, approved: true });
      onDone();
    } catch {
      setError("Upload hiccuped — your take is still here, try Approve again.");
      setPhase("preview");
    }
  }

  function redo() {
    setBlob(null);
    if (videoRef.current && streamRef.current) {
      videoRef.current.src = "";
      videoRef.current.srcObject = streamRef.current;
      void videoRef.current.play();
    }
    setPhase("live");
  }

  return (
    <div className="relative overflow-hidden rounded-2xl bg-black" data-testid="take-recorder">
      <video ref={videoRef} muted={phase !== "preview"} playsInline className="aspect-video w-full object-cover" />

      {/* Teleprompter overlay — everything needed, zero lookup */}
      {phase !== "preview" && (
        <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/80 to-transparent p-4 text-white" data-testid="teleprompter">
          <p className="text-lg font-semibold">{overlay.headline}</p>
          {overlay.lines.map((l) => (
            <p key={l} className="text-sm opacity-90">{l}</p>
          ))}
        </div>
      )}

      {phase === "recording" && (
        <span className="absolute right-4 top-4 rounded-full bg-red-600 px-3 py-1 text-sm font-semibold text-white">
          ● {seconds}s{seconds > 60 ? " — wrap it up" : ""}
        </span>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 bg-gradient-to-t from-black/80 to-transparent p-4">
        {phase === "idle" && (
          <Button size="lg" onClick={() => void start()} data-testid="recorder-start">
            Open camera
          </Button>
        )}
        {phase === "live" && (
          <Button size="lg" onClick={record} data-testid="recorder-record">
            ● Record
          </Button>
        )}
        {phase === "recording" && (
          <Button size="lg" variant="destructive" onClick={stop} data-testid="recorder-stop">
            ■ Stop
          </Button>
        )}
        {phase === "preview" && (
          <>
            <Button size="lg" variant="outline" onClick={redo} data-testid="recorder-redo">
              Redo
            </Button>
            <Button size="lg" onClick={() => void approve()} data-testid="recorder-approve">
              Approve ✓
            </Button>
          </>
        )}
        {phase === "uploading" && <span className="text-sm text-white">Attaching…</span>}
      </div>
      {error && <p className="absolute inset-x-0 top-1/2 text-center text-sm text-amber-300">{error}</p>}
    </div>
  );
}
