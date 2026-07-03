import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClientOnlyFn, useServerFn } from "@tanstack/react-start";
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
  createClipUploadUrls,
  queueClip4KUpgrade,
  markLongVideoQueued,
  listLongVideos,
  listClipsForLongVideo,
  deleteLongVideo,
  registerSplitClip,
  finishSplitJob,
} from "@/lib/splitter.functions";
import { OneClickPublishButton } from "@/components/OneClickPublishButton";
import { ClipProgress } from "@/components/ClipProgress";
import { BulkPublishPanel } from "@/components/BulkPublishPanel";
import type { ClipProgress as ClipProgressData, ClipResult, SplitOptions } from "@/lib/ffmpeg-splitter.types";


export const Route = createFileRoute("/_authenticated/split")({ component: SplitPage });

const runBrowserSplitter = createClientOnlyFn((file: File, opts: SplitOptions) =>
  import("@/lib/ffmpeg-splitter.client").then(({ splitVideoInBrowser }) =>
    splitVideoInBrowser(file, opts),
  ),
);

const cancelBrowserSplitter = createClientOnlyFn(() =>
  import("@/lib/ffmpeg-splitter.client").then(({ cancelSplitVideoInBrowser }) => cancelSplitVideoInBrowser()),
);

type ClipMeta = {
  clipId: string;
  frames: string[];
  upscale: { state: "idle" | "queued" | "running" | "done" | "failed"; pct: number; error?: string };
};

function SplitPage() {
  const qc = useQueryClient();
  const createFn = useServerFn(createLongVideoUploadUrl);
  const clipUrlFn = useServerFn(createClipUploadUrls);
  const queueFn = useServerFn(markLongVideoQueued);
  const listFn = useServerFn(listLongVideos);
  const clipsFn = useServerFn(listClipsForLongVideo);
  const deleteFn = useServerFn(deleteLongVideo);
  const registerFn = useServerFn(registerSplitClip);
  const finishFn = useServerFn(finishSplitJob);
  const queue4kFn = useServerFn(queueClip4KUpgrade);

  const [file, setFile] = useState<File | null>(null);
  const [clipLength, setClipLength] = useState(55);
  const [maxClips, setMaxClips] = useState(5);
  const [smart4k, setSmart4k] = useState(false);
  const [polish, setPolish] = useState(true);
  const [backupSource, setBackupSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [progress, setProgress] = useState<ClipProgressData | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Per-clip local metadata (frames for AI titles, upscale state).
  const [clipMeta, setClipMeta] = useState<Record<string, ClipMeta>>({});

  const { data: jobs } = useQuery({
    queryKey: ["long-videos"],
    queryFn: () => listFn(),
    refetchInterval: 15_000,
  });
  const { data: clips } = useQuery({
    queryKey: ["long-clips", selectedId],
    queryFn: () => (selectedId ? clipsFn({ data: { longVideoId: selectedId } }) : Promise.resolve([])),
    enabled: !!selectedId,
    refetchInterval: 8_000,
  });

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
      try {
        await new Promise<void>((resolve, reject) => {
          const payload = new FormData();
          payload.append("cacheControl", "3600");
          payload.append("", blob);
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", signedUrl, true);
          xhr.timeout = 10 * 60 * 1000;
          xhr.setRequestHeader("x-upsert", "true");
          xhr.upload.onprogress = (e) => {
            const loaded = e.lengthComputable ? e.loaded : 0;
            const total = e.lengthComputable ? e.total : totalBytes;
            const secs = Math.max((Date.now() - startedAt) / 1000, 0.1);
            onProgress?.(loaded, total, loaded / 1024 / 1024 / secs);
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText || "upload failed"}`));
          };
          xhr.onerror = () => reject(new Error("Network error during upload"));
          xhr.ontimeout = () => reject(new Error("Upload timed out"));
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

      const uploadPromise = backupSource
        ? uploadSigned(info.signedUrl, file, file.type || "video/mp4", (loaded, total) => {
            const pct = Math.max(1, Math.min(99, Math.round((loaded / Math.max(total, 1)) * 100)));
            setUploadPct(pct);
          }).then(() => setUploadPct(100)).catch((err) => console.warn("[source-upload] failed", err))
        : Promise.resolve();

      // Kick backend queue marker in parallel; don't wait.
      queueFn({ data: { longVideoId: info.longVideoId } }).catch(() => {});

      const uploadTasks: Promise<{ ok: true } | { ok: false; error: Error }>[] = [];

      const uploadClip = async (clip: ClipResult) => {
        const uploadInfo = await clipUrlFn({ data: { longVideoId: info.longVideoId, clipIndex: clip.index } });
        const clipBytes = clip.mp4.byteLength;
        const thumbBytes = clip.thumbnailJpg.byteLength;
        const totalBytes = clipBytes + thumbBytes;
        let videoLoaded = 0;
        let thumbLoaded = 0;
        const startedAt = Date.now();
        const updateUploadProgress = (message: string, mbps: number) => {
          const loaded = videoLoaded + thumbLoaded;
          setProgress({
            index: clip.index, total: maxClips, stage: "uploading",
            percent: Math.max(1, Math.min(99, Math.round((loaded / Math.max(totalBytes, 1)) * 100))),
            clipPercent: Math.max(1, Math.min(100, Math.round((loaded / Math.max(totalBytes, 1)) * 100))),
            etaSeconds: mbps > 0 ? Math.round(((totalBytes - loaded) / 1024 / 1024) / mbps) : null,
            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
            fps: null, uploadMBps: mbps, uploadedBytes: loaded, totalBytes, updatedAt: Date.now(),
            message,
          });
        };

        await Promise.all([
          uploadSigned(uploadInfo.videoSignedUrl, clip.mp4, "video/mp4", (loaded, _total, mbps) => {
            videoLoaded = loaded;
            updateUploadProgress(`Uploading clip ${clip.index} video…`, mbps);
          }),
          uploadSigned(uploadInfo.thumbnailSignedUrl, clip.thumbnailJpg, "image/jpeg", (loaded, _total, mbps) => {
            thumbLoaded = loaded;
            updateUploadProgress(`Uploading clip ${clip.index} thumbnail…`, mbps);
          }),
        ]);

        await registerFn({ data: {
          clipId: uploadInfo.clipId,
          longVideoId: info.longVideoId,
          videoStoragePath: uploadInfo.videoPath,
          thumbnailStoragePath: uploadInfo.thumbnailPath,
          title: clip.title,
          description: `Auto-cut from long-form video (${Math.round(clip.startSeconds)}s–${Math.round(clip.endSeconds)}s).\n\n#shorts #shortsfeed`,
          tags: ["shorts", "shorts fyp", "clip", "highlight"],
          hashtags: ["#shorts", "#shortsfeed", "#viral", "#fyp"],
          startSeconds: clip.startSeconds,
          endSeconds: clip.endSeconds,
          durationSeconds: clip.endSeconds - clip.startSeconds,
          fileSizeBytes: clip.mp4.byteLength,
        } });

        setClipMeta((m) => ({
          ...m,
          [uploadInfo.clipId]: {
            clipId: uploadInfo.clipId,
            frames: clip.frames,
            upscale: { state: smart4k ? "idle" : "done", pct: smart4k ? 0 : 100 },
          },
        }));
        qc.invalidateQueries({ queryKey: ["long-clips", info.longVideoId] });
      };

      // Start splitting IMMEDIATELY from the local File — no need to wait for upload.
      const results = await runBrowserSplitter(file, {
        clipLength,
        maxClips,
        resolution: smart4k ? "4k-smart" : "hd",
        polish,
        onProgress: setProgress,
        maxProcessingSeconds: 290,
        onClip: (clip) => {
          const task = uploadClip(clip)
            .then(() => ({ ok: true }) as const)
            .catch((error: Error) => ({ ok: false, error }) as const);
          uploadTasks.push(task);
        },
      });

      // Let background upload finish quietly, but never block the UI on it.
      uploadPromise.catch(() => {});
      const uploadResults = await Promise.all(uploadTasks);
      const uploadFailure = uploadResults.find((r) => !r.ok);
      if (uploadFailure && !uploadFailure.ok) throw uploadFailure.error;

      await finishFn({ data: { longVideoId: info.longVideoId, status: "ready" } });
      qc.invalidateQueries({ queryKey: ["long-videos"] });
      setProgress({
        index: results.length, total: results.length, stage: "done",
        percent: 100, clipPercent: 100, etaSeconds: 0, fps: null, uploadMBps: null,
        message: `✅ ${results.length} clip${results.length === 1 ? "" : "s"} ready. AI titles generate on publish.`,
      });
      toast.success(`Generated ${results.length} short${results.length === 1 ? "" : "s"}`);
      setFile(null);

      if (smart4k) toast.info("HD clips are ready. Use Upgrade 4K per clip so nothing stalls.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Split failed";
      toast.error(msg);
      if (longVideoId) {
        try { await finishFn({ data: { longVideoId, status: "failed", errorMessage: msg } }); } catch { /* noop */ }
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
                <p className="mt-0.5 text-[11px] text-muted-foreground">Fast color/sharpen polish with a 5-minute safety budget. Falls back to instant HD if slow.</p>
              </div>
              <Switch checked={polish} onCheckedChange={setPolish} />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/30 p-3">
              <div className="min-w-0">
                <Label className="flex items-center gap-1"><Sparkles className="h-3.5 w-3.5 text-primary-glow" /> Smart 4K</Label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Show per-clip 4K upgrade buttons after HD is ready. No automatic queue stalls.</p>
              </div>
              <Switch checked={smart4k} onCheckedChange={setSmart4k} />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/30 p-3">
              <div className="min-w-0">
                <Label>Backup source video</Label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Off by default for speed. Clips still save normally.</p>
              </div>
              <Switch checked={backupSource} onCheckedChange={setBackupSource} />
            </div>

            {busy && backupSource && uploadPct > 0 && uploadPct < 100 && (
              <div className="space-y-1">
                <Progress value={uploadPct} className="h-2" />
                <p className="text-xs text-muted-foreground">Backing up source in background… {uploadPct}% (splitting has already started, you don't need to wait)</p>
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
              <Button variant="outline" onClick={() => cancelBrowserSplitter()} className="w-full">
                Stop current render
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
                {jobs.map((j) => (
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
                        {j.error_message ? ` · ${j.error_message.slice(0, 80)}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={j.status === "ready" ? "default" : j.status === "failed" ? "destructive" : "secondary"}
                      >
                        {j.status}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); delMut.mutate(j.id); }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </motion.li>
                ))}
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
                      const upscaleState = meta?.upscale || (isNative4k
                        ? { state: db4kFailed ? "failed" as const : dbProgress >= 100 ? "done" as const : "running" as const, pct: dbProgress }
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
                )}
              </Card>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
