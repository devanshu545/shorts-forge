import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";
import { Scissors, UploadCloud, Loader2, Youtube, Trash2, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  createLongVideoUploadUrl,
  markLongVideoQueued,
  listLongVideos,
  listClipsForLongVideo,
  deleteLongVideo,
} from "@/lib/splitter.functions";
import { UploadToYouTubeDialog } from "@/components/UploadToYouTubeDialog";

export const Route = createFileRoute("/_authenticated/split")({ component: SplitPage });

function SplitPage() {
  const qc = useQueryClient();
  const createFn = useServerFn(createLongVideoUploadUrl);
  const queueFn = useServerFn(markLongVideoQueued);
  const listFn = useServerFn(listLongVideos);
  const clipsFn = useServerFn(listClipsForLongVideo);
  const deleteFn = useServerFn(deleteLongVideo);

  const [file, setFile] = useState<File | null>(null);
  const [clipLength, setClipLength] = useState(55);
  const [maxClips, setMaxClips] = useState(5);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
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
    refetchInterval: 10_000,
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
    setUploading(true);
    setProgress(2);
    try {
      const info = await createFn({ data: {
        filename: file.name,
        sizeBytes: file.size,
        clipLength,
        maxClips,
      } });
      setProgress(10);
      // Upload directly to Supabase Storage via signed upload URL.
      const up = await supabase.storage
        .from("videos")
        .uploadToSignedUrl(info.path, info.token, file, { contentType: file.type || "video/mp4" });
      if (up.error) throw new Error(up.error.message);
      setProgress(85);
      await queueFn({ data: { longVideoId: info.longVideoId } });
      setProgress(100);
      toast.success("Uploaded — splitter queued on GitHub Actions.");
      setFile(null);
      qc.invalidateQueries({ queryKey: ["long-videos"] });
      setSelectedId(info.longVideoId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      setTimeout(() => setProgress(0), 1500);
    }
  };

  return (
    <div className="mx-auto grid max-w-6xl gap-6 p-6 md:p-10 lg:grid-cols-[420px_1fr]">
      <Card className="glass h-fit p-6">
        <div className="flex items-center gap-2">
          <Scissors className="h-5 w-5 text-primary-glow" />
          <h1 className="font-display text-xl font-semibold">Long → Shorts</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload any MP4. Our worker slices it into vertical 1080×1920 YouTube Shorts using scene detection.
        </p>

        <div className="mt-6 space-y-5">
          <div>
            <Label>Source MP4</Label>
            <label className="mt-1 flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border/60 bg-background/30 p-6 transition hover:bg-background/50">
              <UploadCloud className="h-6 w-6 text-primary-glow" />
              <span className="text-sm">{file ? file.name : "Click to choose a video"}</span>
              {file && <span className="text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} MB</span>}
              <input
                type="file"
                accept="video/mp4,video/quicktime,video/*"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
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

          {uploading && (
            <div className="space-y-2">
              <Progress value={progress} />
              <p className="text-xs text-muted-foreground">
                {progress < 85 ? "Uploading to storage…" : progress < 100 ? "Queueing on GitHub Actions…" : "Queued!"}
              </p>
            </div>
          )}

          <Button onClick={startUpload} disabled={!file || uploading} className="w-full">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
            {uploading ? "Working…" : "Upload & Split"}
          </Button>
        </div>
      </Card>

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
            <ul className="mt-3 space-y-2">
              {jobs.map((j) => (
                <li
                  key={j.id}
                  onClick={() => setSelectedId(j.id)}
                  className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 transition ${
                    selectedId === j.id
                      ? "border-primary/50 bg-primary/10"
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
                      variant={
                        j.status === "ready" ? "default" : j.status === "failed" ? "destructive" : "secondary"
                      }
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
                </li>
              ))}
            </ul>
          )}
        </Card>

        {selectedId && (
          <Card className="glass p-6">
            <h2 className="font-display text-lg font-semibold">Generated Shorts</h2>
            {!clips?.length ? (
              <p className="mt-3 text-sm text-muted-foreground">Waiting on the splitter worker… clips appear here as they finish rendering (usually 1–3 min).</p>
            ) : (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {clips.map((c: any) => (
                  <div key={c.id} className="rounded-xl border border-border/60 bg-background/40 p-3">
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
                      {c.youtube_video_id ? (
                        <a
                          href={`https://www.youtube.com/watch?v=${c.youtube_video_id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-xs text-primary-glow"
                        >
                          <Youtube className="h-3.5 w-3.5" /> Open
                        </a>
                      ) : (
                        <UploadToYouTubeDialog video={c}>
                          <Button size="sm">
                            <Youtube className="h-3.5 w-3.5" /> Upload
                          </Button>
                        </UploadToYouTubeDialog>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
