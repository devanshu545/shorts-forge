import { Loader2, Check, X, ImageIcon, Mic, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type SceneStep = {
  order: number;
  label: string;
  status: "pending" | "keyframe" | "voiceover" | "done" | "failed";
  thumbUrl?: string;
  clipUrl?: string;
  audioUrl?: string;
  emotion?: string;
};

export function SceneProgress({ scenes }: { scenes: SceneStep[] }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {scenes.map((s) => (
        <div
          key={s.order}
          className={cn(
            "aspect-[9/16] overflow-hidden rounded-lg border bg-surface/40 relative flex flex-col items-center justify-center text-center text-xs p-2",
            s.status === "done" && "border-emerald-500/60",
            s.status === "failed" && "border-destructive/60",
            s.status === "pending" && "border-border/40",
          )}
        >
          {s.thumbUrl ? (
            <img src={s.thumbUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-80" />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-background/20 to-transparent" />
          <div className="relative z-10 flex flex-col items-center gap-1">
            <span className="font-mono text-[10px] uppercase text-muted-foreground">Scene {s.order}</span>
            {s.emotion && (
              <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[10px] capitalize text-primary-glow">
                {s.emotion}
              </span>
            )}
            {s.status === "pending" && <span className="text-muted-foreground">queued</span>}
            {s.status === "keyframe" && (
              <span className="flex items-center gap-1 text-primary-glow">
                <ImageIcon className="h-3 w-3" /> keyframe
                <Loader2 className="h-3 w-3 animate-spin" />
              </span>
            )}
            {s.status === "voiceover" && (
              <span className="flex items-center gap-1 text-primary-glow">
                <Mic className="h-3 w-3" /> narrating
                <Loader2 className="h-3 w-3 animate-spin" />
              </span>
            )}
            {s.status === "done" && (
              <span className="flex items-center gap-1 text-emerald-400">
                <Check className="h-3 w-3" /> ready
                {s.audioUrl && <Volume2 className="h-3 w-3" />}
              </span>
            )}
            {s.status === "failed" && (
              <span className="flex items-center gap-1 text-destructive">
                <X className="h-3 w-3" /> failed
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
