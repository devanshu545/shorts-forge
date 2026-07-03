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
import { Scissors, UploadCloud, Loader2, Youtube, Trash2, RefreshCw, Sparkles, Zap } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  createLongVideoUploadUrl,
  markLongVideoQueued,
  listLongVideos,
  listClipsForLongVideo,
  deleteLongVideo,
  registerSplitClip,
  finishSplitJob,
} from "@/lib/splitter.functions";
import { OneClickPublishButton } from "@/components/OneClickPublishButton";
import { ClipProgress } from "@/components/ClipProgress";
import type { ClipProgress as ClipProgressData, SplitOptions } from "@/lib/ffmpeg-splitter.types";

export const Route = createFileRoute("/_authenticated/split")({ component: SplitPage });

const runBrowserSplitter = createClientOnlyFn((file: File, opts: SplitOptions) =>
  import("@/lib/ffmpeg-splitter.client").then(({ splitVideoInBrowser }) =>
    splitVideoInBrowser(file, opts),
  ),
);

function SplitPage() {
  const qc = useQueryClient();
  const createFn = useServerFn(createLongVideoUploadUrl);
  const queueFn = useServerFn(markLongVideoQueued);
  const listFn = useServerFn(listLongVideos);
  const clipsFn = useServerFn(listClipsForLongVideo);
  const deleteFn = useServerFn(deleteLongVideo);
  const registerFn = useServerFn(registerSplitClip);
  const finishFn = useServerFn(finishSplitJob);

  const [file, setFile] = useState<File | null>(null);
  const [clipLength, setClipLength] = useState(55);
  const [maxClips, setMaxClips] = useState(5);
  const [is4k, setIs4k] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [progress, setProgress] = useState<ClipProgressData | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const startUpload = async () => {
    if (!file) return;
    setBusy(true);
    setUploadPct(2);
    let longVideoId: string | null = null;
    try {
      // 1. Upload source to storage
      const info = await createFn({ data: {
        filename: file.name,
        sizeBytes: file.size,
        clipLength,
        maxClips,
      } });
      longVideoId = info.longVideoId;
      setUploadPct(15);
      const up = await supabase.storage
        .from("videos")
        .uploadToSignedUrl(info.path, info.token, file, { contentType: file.type || "video/mp4" });
      if (up.error) throw new Error(up.error.message);
      setUploadPct(100);
      await queueFn({ data: { longVideoId: info.longVideoId } });
      qc.invalidateQueries({ queryKey: ["long-videos"] });
      setSelectedId(info.longVideoId);

      // 2. Split in browser via ffmpeg.wasm
      const results = await runBrowserSplitter(file, {
        clipLength,
        maxClips,
        resolution: is4k ? "4k" : "1080p",
        onProgress: setProgress,
      });

      // 3. Upload each clip + register
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error("Not signed in");

      for (let i = 0; i < results.length; i++) {
        const clip = results[i];
        const t0 = Date.now();
        setProgress({
          index: i + 1,
          total: results.length,
          stage: "uploading",
          percent: Math.round((i / results.length) * 100),
          clipPercent: 0,
          etaSeconds: null,
          fps: null,
          uploadMBps: null,
          message: `Uploading clip ${i + 1} of ${results.length} to storage…`,
        });
        const clipId = crypto.randomUUID();
        const videoPath = `${userId}/${clipId}/clip.mp4`;
        const thumbPath = `${userId}/${clipId}.jpg`;
        const upV = await supabase.storage.from("videos").upload(videoPath, clip.mp4, { contentType: "video/mp4", upsert: true });
        if (upV.error) throw new Error(upV.error.message);
        const upT = await supabase.storage.from("thumbnails").upload(thumbPath, clip.thumbnailJpg, { contentType: "image/jpeg", upsert: true });
        if (upT.error) throw new Error(upT.error.message);
        const mb = clip.mp4.byteLength / 1024 / 1024;
        const secs = (Date.now() - t0) / 1000;
        setProgress((p) => p && { ...p, uploadMBps: mb / Math.max(secs, 0.1) });

        await registerFn({ data: {
          longVideoId: info.longVideoId,
          videoStoragePath: videoPath,
          thumbnailStoragePath: thumbPath,
          title: clip.title,
          description: `Auto-cut from long-form video (${Math.round(clip.startSeconds)}s–${Math.round(clip.endSeconds)}s).\n\n#shorts #shortsfeed`,
          tags: ["shorts", "shorts fyp", "clip", "highlight"],
          hashtags: ["#shorts", "#shortsfeed", "#viral", "#fyp"],
          startSeconds: clip.startSeconds,
          endSeconds: clip.endSeconds,
          durationSeconds: clip.endSeconds - clip.startSeconds,
          fileSizeBytes: clip.mp4.byteLength,
        } });
        qc.invalidateQueries({ queryKey: ["long-clips", info.longVideoId] });
      }

      await finishFn({ data: { longVideoId: info.longVideoId, status: "ready" } });
      qc.invalidateQueries({ queryKey: ["long-videos"] });
      setProgress({
        index: results.length,
        total: results.length,
        stage: "done",
        percent: 100,
        clipPercent: 100,
        etaSeconds: 0,
        fps: null,
        uploadMBps: null,
        message: `✅ ${results.length} clip${results.length === 1 ? "" : "s"} ready. Click "Publish" to auto-post to YouTube.`,
      });
      toast.success(`Generated ${results.length} short${results.length === 1 ? "" : "s"}`);
      setFile(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Split failed";
      toast.error(msg);
      if (longVideoId) {
        try { await finishFn({ data: { longVideoId, status: "failed", errorMessage: msg } }); } catch {}
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
            Upload any MP4. Instant mode cuts Shorts in minutes without slow re-rendering.
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
                <Label className="flex items-center gap-1"><Sparkles className="h-3.5 w-3.5 text-primary-glow" /> True 4K render</Label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Slow export. Keep off for instant Shorts under 5 minutes.</p>
              </div>
              <Switch checked={is4k} onCheckedChange={setIs4k} />
            </div>

            {busy && uploadPct > 0 && uploadPct < 100 && (
              <div className="space-y-1">
                <Progress value={uploadPct} className="h-2" />
                <p className="text-xs text-muted-foreground">Uploading source to storage… {uploadPct}%</p>
              </div>
            )}

            <AnimatePresence>
              {progress && <ClipProgress data={progress} />}
            </AnimatePresence>

            <Button onClick={startUpload} disabled={!file || busy} className="w-full">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
              {busy ? "Working…" : is4k ? "Render 4K Shorts" : "Create Instant Shorts"}
            </Button>
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
                    }) => (
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
                            <div className="text-xs text-muted-foreground">
                              {Math.round(c.clip_start_seconds ?? 0)}s → {Math.round(c.clip_end_seconds ?? 0)}s
                            </div>
                          </div>
                          <OneClickPublishButton
                            video={c}
                            hint={c.title || "Trending short clip"}
                            onUploaded={() => qc.invalidateQueries({ queryKey: ["long-clips", selectedId] })}
                          />
                        </div>
                      </motion.div>
                    ))}
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
