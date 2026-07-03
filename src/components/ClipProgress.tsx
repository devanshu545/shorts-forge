import { motion } from "framer-motion";
import { Progress } from "@/components/ui/progress";
import type { ClipProgress as ClipProgressData } from "@/lib/ffmpeg-splitter.types";

function formatEta(sec: number | null) {
  if (!sec || sec < 0) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
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
      <div className="mt-3 space-y-2">
        <Progress value={data.percent} className="h-2" />
        {data.stage === "encoding" && (
          <div className="grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
            <Stat label="Clip" value={`${data.clipPercent}%`} />
            <Stat label="ETA" value={formatEta(data.etaSeconds)} />
            <Stat label="Speed" value={data.fps ? `${data.fps} fps` : "—"} />
          </div>
        )}
        {data.stage === "uploading" && (
          <div className="text-[11px] text-muted-foreground">
            {data.uploadMBps ? `${data.uploadMBps.toFixed(1)} MB/s` : "Sending to storage…"}
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
