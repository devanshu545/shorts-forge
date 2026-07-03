import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Progress } from "@/components/ui/progress";
import type { ClipProgress as ClipProgressData } from "@/lib/ffmpeg-splitter.types";

function formatEta(sec: number | null) {
  if (!sec || sec < 0) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function formatBytes(bytes?: number) {
  if (!bytes || bytes <= 0) return "—";
  const mb = bytes / 1024 / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function ageLabel(ts: number | undefined, now: number) {
  if (!ts) return "now";
  const age = Math.max(0, Math.round((now - ts) / 1000));
  if (age < 3) return "live";
  if (age < 20) return `${age}s ago`;
  return `slow ${age}s`;
}

const stageLabel: Record<ClipProgressData["stage"], string> = {
  "loading-ffmpeg": "Loading engine",
  "reading-file": "Reading file",
  probing: "Probing",
  encoding: "Encoding",
  polishing: "Polishing",
  uploading: "Uploading",
  upscaling: "Upscaling to 4K",
  done: "Done",
  error: "Error",
};

export function ClipProgress({ data }: { data: ClipProgressData }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const lastMoveAge = data.updatedAt ? Math.max(0, Math.round((now - data.updatedAt) / 1000)) : 0;
  const isActive = data.stage !== "done" && data.stage !== "error";
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 via-background/40 to-background/40 p-4 backdrop-blur"
    >
      <div className="pointer-events-none absolute inset-0 opacity-40 [background:radial-gradient(600px_circle_at_var(--x,50%)_var(--y,50%),rgba(255,255,255,0.06),transparent_40%)]" />
      <div className="flex items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          {stageLabel[data.stage]}
          {data.total > 0 && data.stage !== "done" && (
            <span className="text-muted-foreground">· clip {data.index}/{data.total}</span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">{data.percent}%</div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{data.message}</p>
      {isActive && lastMoveAge >= 20 && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          No progress event for {lastMoveAge}s. The app is still watching it; stop the render if it stays slow.
        </p>
      )}
      <div className="mt-3 space-y-2">
        <Progress value={data.percent} className="h-2" />
        {(data.stage === "encoding" || data.stage === "polishing" || data.stage === "upscaling") && (
          <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground sm:grid-cols-4">
            <Stat label="Clip" value={`${data.clipPercent}%`} />
            <Stat label="ETA" value={formatEta(data.etaSeconds)} />
            <Stat label="Elapsed" value={formatEta(data.elapsedSeconds ?? null)} />
            <Stat label="Last move" value={ageLabel(data.updatedAt, now)} />
          </div>
        )}
        {data.stage === "uploading" && (
          <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground sm:grid-cols-4">
            <Stat label="Sent" value={`${formatBytes(data.uploadedBytes)} / ${formatBytes(data.totalBytes)}`} />
            <Stat label="Speed" value={data.uploadMBps ? `${data.uploadMBps.toFixed(1)} MB/s` : "—"} />
            <Stat label="ETA" value={formatEta(data.etaSeconds)} />
            <Stat label="Last move" value={ageLabel(data.updatedAt, now)} />
          </div>
        )}
        {data.lastLog && data.stage !== "done" && data.stage !== "error" && (
          <div className="rounded-md border border-border/40 bg-background/30 px-2 py-1 font-mono text-[10px] text-muted-foreground/80">
            {data.lastLog.slice(-180)}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/40 bg-background/40 px-2 py-1">
      <div className="text-[10px] uppercase tracking-wider opacity-60">{label}</div>
      <div className="font-mono text-xs text-foreground">{value}</div>
    </div>
  );
}
