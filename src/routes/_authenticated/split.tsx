import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";
import { Scissors, UploadCloud, Loader2, Trash2, RefreshCw, Sparkles, Zap, Wand2, CheckCircle2 } from "lucide-react";
import {
  createLongVideoUploadUrl,
  queueClip4KUpgrade,
  markLongVideoUploaded,
  markLongVideoFailed,
  queueLongVideoNative,
  retryLongVideoNative,
  listLongVideos,
  listClipsForLongVideo,
  deleteLongVideo,
} from "@/lib/splitter.functions";
import { OneClickPublishButton } from "@/components/OneClickPublishButton";
import { ClipProgress } from "@/components/ClipProgress";
import { BulkPublishPanel } from "@/components/BulkPublishPanel";
import type { ClipProgress as ClipProgressData } from "@/lib/ffmpeg-splitter.types";


export const Route = createFileRoute("/_authenticated/split")({ component: SplitPage });

type ClipMeta = {
  clipId: string;
  frames: string[];
  upscale: { state: "idle" | "queued" | "running" | "done" | "failed"; pct: number; error?: string };
};

function SplitPage() {
  const qc = useQueryClient();
  const createFn = useServerFn(createLongVideoUploadUrl);
  const markUploadedFn = useServerFn(markLongVideoUploaded);
  const markFailedFn = useServerFn(markLongVideoFailed);
  const queueNativeFn = useServerFn(queueLongVideoNative);
  const retryNativeFn = useServerFn(retryLongVideoNative);
  const listFn = useServerFn(listLongVideos);
  const clipsFn = useServerFn(listClipsForLongVideo);
  const deleteFn = useServerFn(deleteLongVideo);
  const queue4kFn = useServerFn(queueClip4KUpgrade);

  const [file, setFile] = useState<File | null>(null);
  const [clipLength, setClipLength] = useState(55);
  const [maxClips, setMaxClips] = useState(5);
  const [smart4k, setSmart4k] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [progress, setProgress] = useState<ClipProgressData | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Per-clip local metadata (frames for AI titles, upscale state).
  const [clipMeta, setClipMeta] = useState<Record<string, ClipMeta>>({});

  const { data: jobs } = useQuery({
    queryKey: ["long-videos"],
    queryFn: () => listFn(),
    refetchInterval: 5_000,
  });
  const { data: clips } = useQuery({
    queryKey: ["long-clips", selectedId],
    queryFn: () => (selectedId ? clipsFn({ data: { longVideoId: selectedId } }) : Promise.resolve([])),
    enabled: !!selectedId,
    refetchInterval: 4_000,
  });
  const selectedJob = jobs?.find((j) => j.id === selectedId);

  const delMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { longVideoId: id } }),
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["long-videos"] });
      if (selectedId) setSelectedId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const uploadSigned = async (
    signedUrl: string,
    body: File | Uint8Array,
    contentType: string,
    onProgress?: (loaded: number, total: number, mbps: number) => void,
  ) => {
    const blob = body instanceof File
      ? body
      : new Blob([body.slice().buffer as ArrayBuffer], { type: contentType });
    const totalBytes = body instanceof File ? body.size : body.byteLength;
    let attempt = 0;
    while (attempt < 3) {
      const startedAt = Date.now();
      let lastProgressAt = Date.now();
      try {
        await new Promise<void>((resolve, reject) => {
          const payload = new FormData();
          payload.append("cacheControl", "3600");
          payload.append("", blob);
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", signedUrl, true);
          xhr.timeout = 10 * 60 * 1000;
          xhr.setRequestHeader("x-upsert", "true");
          const progressWatch = window.setInterval(() => {
            if (Date.now() - lastProgressAt > 45_000) {
              xhr.abort();
              window.clearInterval(progressWatch);
              reject(new Error("Upload stalled without progress. Retrying safely."));
            }
          }, 5_000);
          xhr.upload.onprogress = (e) => {
            lastProgressAt = Date.now();
            const loaded = e.lengthComputable ? e.loaded : 0;
            const total = e.lengthComputable ? e.total : totalBytes;
            const secs = Math.max((Date.now() - startedAt) / 1000, 0.1);
            onProgress?.(loaded, total, loaded / 1024 / 1024 / secs);
          };
          xhr.onload = () => {
            window.clearInterval(progressWatch);
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText || "upload failed"}`));
          };
          xhr.onerror = () => { window.clearInterval(progressWatch); reject(new Error("Network error during upload")); };
          xhr.ontimeout = () => { window.clearInterval(progressWatch); reject(new Error("Upload timed out")); };
          xhr.onabort = () => { window.clearInterval(progressWatch); reject(new Error("Upload was interrupted before completion")); };
          xhr.send(payload);
        });
        return;
      } catch (err) {
        attempt += 1;
        if (attempt >= 3) throw err;
        onProgress?.(0, totalBytes, 0);
        await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
      }
    }
  };

  const runSingle4KUpgrade = async (clipId: string) => {
      const startedAt = Date.now();
      setClipMeta((m) => ({
        ...m,
        [clipId]: { ...m[clipId], upscale: { state: "queued", pct: 5 } },
      }));
      try {
        setProgress({
          index: 1, total: 1, stage: "upscaling",
          percent: 5, clipPercent: 5, etaSeconds: 240, elapsedSeconds: 0,
          fps: null, uploadMBps: null, updatedAt: Date.now(),
          message: "Queued native 4K worker. HD clip stays ready while 4K renders.",
        });
        await queue4kFn({ data: { clipId } });
        setClipMeta((m) => ({
          ...m,
          [clipId]: { ...m[clipId], upscale: { state: "running", pct: 15 } },
        }));
        setProgress({
          index: 1, total: 1, stage: "upscaling", percent: 15, clipPercent: 15,
          etaSeconds: 240, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
          fps: null, uploadMBps: null, updatedAt: Date.now(),
          message: "Native 4K worker started. This page will refresh the clip status automatically.",
        });
        toast.success("4K upgrade queued on the native worker");
        qc.invalidateQueries({ queryKey: ["long-clips", selectedId] });
      } catch (err) {
        console.warn("[upscale] failed", err);
        setClipMeta((m) => ({
          ...m,
          [clipId]: {
            ...m[clipId],
            upscale: { state: "failed", pct: 0, error: err instanceof Error ? err.message : "upscale failed" },
          },
        }));
        setProgress({
          index: 1, total: 1, stage: "error", percent: 0, clipPercent: 0,
          etaSeconds: null, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
          fps: null, uploadMBps: null, updatedAt: Date.now(),
          message: err instanceof Error ? err.message : "4K queue failed; HD clip is still ready.",
        });
      }
  };

  const startUpload = async () => {
    if (!file) return;
    setBusy(true);
    setUploadPct(1);
    let longVideoId: string | null = null;
    try {
      const info = await createFn({ data: {
        filename: file.name,
        sizeBytes: file.size,
        clipLength,
        maxClips,
      } });
      longVideoId = info.longVideoId;
      setSelectedId(info.longVideoId);
      qc.invalidateQueries({ queryKey: ["long-videos"] });

      const startedAt = Date.now();
      setProgress({
        index: 0, total: maxClips, stage: "uploading", percent: 1, clipPercent: 1,
        etaSeconds: null, elapsedSeconds: 0, fps: null, uploadMBps: null, updatedAt: Date.now(),
        message: "Uploading source video before native cinematic splitting starts…",
      });
      await uploadSigned(info.signedUrl, file, file.type || "video/mp4", (loaded, total, mbps) => {
        const pct = Math.max(1, Math.min(99, Math.round((loaded / Math.max(total, 1)) * 100)));
        setUploadPct(pct);
        setProgress({
          index: 0, total: maxClips, stage: "uploading", percent: pct, clipPercent: pct,
          etaSeconds: mbps > 0 ? Math.round(((total - loaded) / 1024 / 1024) / mbps) : null,
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
          fps: null, uploadMBps: mbps, uploadedBytes: loaded, totalBytes: total, updatedAt: Date.now(),
          message: "Uploading source video for the native splitter…",
        });
      });
      setUploadPct(100);
      await markUploadedFn({ data: { longVideoId: info.longVideoId } });

      setProgress({
        index: 0, total: maxClips, stage: "encoding", percent: 15, clipPercent: 0,
        etaSeconds: null, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), fps: null, uploadMBps: null, updatedAt: Date.now(),
        message: "Source upload confirmed. Queueing native cinematic splitter…",
      });
      const queued = await queueNativeFn({ data: { longVideoId: info.longVideoId } });
      qc.invalidateQueries({ queryKey: ["long-videos"] });
      setProgress({
        index: 0, total: maxClips, stage: "done", percent: 100, clipPercent: 100,
        etaSeconds: 0, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), fps: null, uploadMBps: null, updatedAt: Date.now(),
        message: queued.dispatchOk
          ? "Native cinematic splitter started. Clips will appear automatically as each one is uploaded."
          : `Queued. Scheduled worker will pick it up within ~5 minutes. (${queued.message || "dispatch failed"})`,
      });
      if (queued.dispatchOk) toast.success("Native cinematic splitter started");
      else toast.warning(queued.message || "Dispatch failed — scheduler will retry within ~5 min");
      setFile(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Split failed";
      toast.error(msg);
      if (longVideoId) {
        try { await markFailedFn({ data: { longVideoId, errorMessage: msg, retryable: true, failureCode: "upload_or_queue_failed" } }); } catch { /* noop */ }
        qc.invalidateQueries({ queryKey: ["long-videos"] });
      }
      setProgress((p) => p ? { ...p, stage: "error", message: msg } : null);
    } finally {
      setBusy(false);
      setUploadPct(0);
    }
  };

  return (
    <div className="mx-auto grid max-w-6xl gap-6 p-6 md:p-10 lg:grid-cols-[420px_1fr]">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="glass h-fit overflow-hidden p-6">
          <div className="flex items-center gap-2">
            <motion.div animate={{ rotate: busy ? 360 : 0 }} transition={{ duration: 2, repeat: busy ? Infinity : 0, ease: "linear" }}>
              <Scissors className="h-5 w-5 text-primary-glow" />
            </motion.div>
            <h1 className="font-display text-xl font-semibold">Long → Shorts</h1>
            <Badge variant="secondary" className="ml-auto gap-1 text-[10px]">
              <Zap className="h-3 w-3" /> In-browser
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Cinematic polish, AI titles from real frames, optional smart 4K in the background.
          </p>

          <div className="mt-6 space-y-5">
            <div>
              <Label>Source MP4</Label>
              <motion.label
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                className="mt-1 flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border/60 bg-background/30 p-6 transition hover:bg-background/50 hover:border-primary/50"
              >
                <UploadCloud className="h-6 w-6 text-primary-glow" />
                <span className="text-sm">{file ? file.name : "Click to choose a video"}</span>
                {file && <span className="text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} MB</span>}
                <input
                  type="file"
                  accept="video/mp4,video/quicktime,video/*"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </motion.label>
            </div>

            <div>
              <Label>Clip length: {clipLength}s</Label>
              <Slider min={15} max={60} step={1} value={[clipLength]} onValueChange={(v) => setClipLength(v[0])} className="mt-2" />
              <p className="mt-1 text-xs text-muted-foreground">YouTube Shorts must be ≤ 60 seconds.</p>
            </div>

            <div>
              <Label>Max clips per upload</Label>
              <Select value={String(maxClips)} onValueChange={(v) => setMaxClips(Number(v))}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 5, 7, 10, 15].map((n) => (
                    <SelectItem key={n} value={String(n)}>{n} clips</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/30 p-3">
              <div className="min-w-0">
                <Label className="flex items-center gap-1"><Wand2 className="h-3.5 w-3.5 text-primary-glow" /> Cinematic polish</Label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Always applied by the native worker with safe timeouts and automatic retry.</p>
              </div>
              <Badge variant="secondary">Native</Badge>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/30 p-3">
              <div className="min-w-0">
                <Label className="flex items-center gap-1"><Sparkles className="h-3.5 w-3.5 text-primary-glow" /> Smart 4K</Label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Show per-clip 4K upgrade buttons after HD is ready. No automatic queue stalls.</p>
              </div>
              <Switch checked={smart4k} onCheckedChange={setSmart4k} />
            </div>

            {busy && uploadPct > 0 && uploadPct < 100 && (
              <div className="space-y-1">
                <Progress value={uploadPct} className="h-2" />
                <p className="text-xs text-muted-foreground">Uploading source… {uploadPct}%</p>
              </div>
            )}

            <AnimatePresence>
              {progress && <ClipProgress data={progress} />}
            </AnimatePresence>

            <Button onClick={startUpload} disabled={!file || busy} className="w-full">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
              {busy ? "Working…" : "Create Shorts"}
            </Button>
            {busy && (
              <Button variant="outline" disabled className="w-full">
                Native queue protected from browser tab closes
              </Button>
            )}
          </div>
        </Card>
      </motion.div>

      <div className="space-y-4">
        <Card className="glass p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold">Your long videos</h2>
            <Button variant="ghost" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["long-videos"] })}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          {!jobs?.length ? (
            <p className="mt-3 text-sm text-muted-foreground">Upload a long MP4 to get started.</p>
          ) : (
            <motion.ul
              className="mt-3 space-y-2"
              initial="hidden"
              animate="visible"
              variants={{ visible: { transition: { staggerChildren: 0.04 } } }}
            >
              <AnimatePresence>
                {jobs.map((j) => {
                  const heartbeatAgeSec = j.last_progress_at
                    ? Math.round((Date.now() - new Date(j.last_progress_at).getTime()) / 1000)
                    : null;
                  const isActive = j.status === "queued" || j.status === "uploaded" || j.status === "processing";
                  const isStalled = isActive && heartbeatAgeSec !== null && heartbeatAgeSec > 120;
                  const displayStatus = isStalled ? "recovering" : j.status;
                  const canRetry = j.status === "failed_retryable" || isStalled;
                  return (
                  <motion.li
                    key={j.id}
                    layout
                    variants={{ hidden: { opacity: 0, y: 6 }, visible: { opacity: 1, y: 0 } }}
                    exit={{ opacity: 0, x: -20 }}
                    onClick={() => setSelectedId(j.id)}
                    className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 transition ${
                      selectedId === j.id
                        ? "border-primary/50 bg-primary/10 shadow-[0_0_20px_-8px_theme(colors.primary.DEFAULT)]"
                        : "border-border/60 bg-background/40 hover:bg-background/60"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{j.original_filename || j.id}</div>
                      <div className="text-xs text-muted-foreground">
                        {j.clip_length}s × up to {j.max_clips} · {j.clips_generated} clip(s) generated
                        {typeof j.progress_percent === "number" ? ` · ${j.progress_percent}%` : ""}
                        {j.progress_stage ? ` · ${j.progress_stage.slice(0, 60)}` : ""}
                        {isStalled ? ` · no heartbeat for ${heartbeatAgeSec}s` : ""}
                        {j.error_message ? ` · ${j.error_message.slice(0, 80)}` : ""}
                      </div>
                      {j.status !== "ready" && j.status !== "failed_final" && (
                        <Progress value={Math.max(0, Math.min(100, j.progress_percent ?? 0))} className="mt-2 h-1.5" />
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={j.status === "ready" ? "default" : (j.status.includes("failed") || isStalled) ? "destructive" : "secondary"}
                      >
                        {displayStatus}
                      </Badge>
                      {canRetry && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              await retryNativeFn({ data: { longVideoId: j.id } });
                              toast.success("Retry queued");
                              qc.invalidateQueries({ queryKey: ["long-videos"] });
                            } catch (err) {
                              toast.error(err instanceof Error ? err.message : "Retry failed");
                            }
                          }}
                        >
                          Retry
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); delMut.mutate(j.id); }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </motion.li>
                  );
                })}
              </AnimatePresence>
            </motion.ul>
          )}
        </Card>

        <AnimatePresence>
          {selectedId && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <Card className="glass p-6">
                <h2 className="font-display text-lg font-semibold">Generated Shorts</h2>
                {!clips?.length ? (
                  <p className="mt-3 text-sm text-muted-foreground">Clips will appear here as they finish rendering.</p>
                ) : (
                  <>
                    <BulkPublishPanel
                      clips={clips}
                      hintForClip={(c) =>
                        `Short clip from "${(jobs?.find((j) => j.id === selectedId)?.original_filename || "video").replace(/\.[^.]+$/, "")}" — segment ${Math.round(c.clip_start_seconds ?? 0)}s to ${Math.round(c.clip_end_seconds ?? 0)}s.`
                      }
                      framesForClip={(c) => clipMeta[c.id]?.frames}
                      onPublished={() => qc.invalidateQueries({ queryKey: ["long-clips", selectedId] })}
                    />

                  <motion.div
                    className="mt-4 grid gap-4 md:grid-cols-2"
                    initial="hidden"
                    animate="visible"
                    variants={{ visible: { transition: { staggerChildren: 0.06 } } }}
                  >
                    {clips.map((c: {
                      id: string;
                      title: string | null;
                      description: string | null;
                      tags: string[] | null;
                      video_url: string | null;
                      thumbnail_url: string | null;
                      youtube_video_id: string | null;
                      clip_start_seconds: number | null;
                      clip_end_seconds: number | null;
                      generation_stage: string | null;
                      generation_progress: number | null;
                    }) => {
                      const meta = clipMeta[c.id];
                      const dbStage = c.generation_stage || "";
                      const dbProgress = c.generation_progress ?? 0;
                      const isNative4k = dbStage.toLowerCase().includes("4k");
                      const db4kFailed = dbStage.toLowerCase().includes("4k failed");
                      const db4kQueued = dbStage.toLowerCase().includes("4k upgrade queued");
                      const upscaleState = meta?.upscale || (isNative4k
                        ? { state: db4kFailed ? "failed" as const : dbProgress >= 100 ? "done" as const : db4kQueued ? "queued" as const : "running" as const, pct: dbProgress }
                        : undefined);
                      return (
                        <motion.div
                          key={c.id}
                          variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }}
                          whileHover={{ y: -2 }}
                          className="rounded-xl border border-border/60 bg-background/40 p-3 transition hover:border-primary/40 hover:shadow-[0_0_20px_-10px_theme(colors.primary.DEFAULT)]"
                        >
                          {c.video_url ? (
                            <video src={c.video_url} controls className="aspect-[9/16] w-full rounded-lg border border-border object-cover bg-black" />
                          ) : (
                            <div className="grid aspect-[9/16] place-items-center text-xs text-muted-foreground">Rendering…</div>
                          )}
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">{c.title}</div>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span>{Math.round(c.clip_start_seconds ?? 0)}s → {Math.round(c.clip_end_seconds ?? 0)}s</span>
                                {(upscaleState?.state === "queued" || upscaleState?.state === "running") && (
                                  <Badge variant="secondary" className="gap-1 text-[10px]">
                                    <Loader2 className="h-3 w-3 animate-spin" /> 4K {upscaleState.pct}%
                                  </Badge>
                                )}
                                {upscaleState?.state === "done" && (
                                  <Badge variant="default" className="gap-1 text-[10px]">
                                    <CheckCircle2 className="h-3 w-3" /> 4K Ready
                                  </Badge>
                                )}
                                {upscaleState?.state === "failed" && (
                                  <Badge variant="destructive" className="text-[10px]">HD only</Badge>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {smart4k && (!upscaleState || upscaleState.state === "idle" || upscaleState.state === "failed") && (
                                <Button size="sm" variant="outline" onClick={() => runSingle4KUpgrade(meta?.clipId || c.id)}>
                                  Upgrade 4K
                                </Button>
                              )}
                              <OneClickPublishButton
                                video={c}
                                frames={meta?.frames}
                                hint={`Short clip from "${(jobs?.find((j) => j.id === selectedId)?.original_filename || "video").replace(/\.[^.]+$/, "")}" — segment ${Math.round(c.clip_start_seconds ?? 0)}s to ${Math.round(c.clip_end_seconds ?? 0)}s.`}
                                onUploaded={() => qc.invalidateQueries({ queryKey: ["long-clips", selectedId] })}
                              />
                            </div>
                          </div>
                        </motion.div>
                      );
                    })}
                  </motion.div>
                  </>
                )}
              </Card>

            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
