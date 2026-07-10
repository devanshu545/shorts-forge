import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Loader2, UploadCloud, Youtube } from "lucide-react";
import { toast } from "sonner";
import { uploadVideoToYouTube, createShortsReadyUploadTarget } from "@/lib/media.functions";
import { supabase } from "@/integrations/supabase/client";


type UploadVideo = {
  id: string;
  title: string | null;
  description: string | null;
  tags: string[] | null;
  hashtags: string[] | null;
  video_url: string | null;
  thumbnail_url: string | null;
  youtube_video_id?: string | null;
};

type PreparedUpload = {
  file: Blob;
  reused: boolean;
  uploadFileSize: number;
  uploadProbe: {
    rawWidth: number;
    rawHeight: number;
    durationSeconds: number;
    videoCodec: string | null;
    audioCodec: string | null;
  };
};

export function UploadToYouTubeDialog({ video, children, onUploaded }: { video: UploadVideo; children?: React.ReactNode; onUploaded?: () => void }) {
  const upload = useServerFn(uploadVideoToYouTube);
  const createTarget = useServerFn(createShortsReadyUploadTarget);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(video.title || "Untitled Short");
  const [description, setDescription] = useState(video.description || "");
  const [tags, setTags] = useState((video.tags || []).join(", "));
  const [privacy, setPrivacy] = useState<"public" | "unlisted" | "private">("private");
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [url, setUrl] = useState<string | null>(video.youtube_video_id ? `https://www.youtube.com/watch?v=${video.youtube_video_id}` : null);
  const [uploading, setUploading] = useState(false);
  const [preparedPreviewUrl, setPreparedPreviewUrl] = useState<string | null>(null);
  const [preparedSummary, setPreparedSummary] = useState<string | null>(null);
  const [preparedUpload, setPreparedUpload] = useState<PreparedUpload | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [force916, setForce916] = useState(true);

  useEffect(() => {
    return () => {
      if (preparedPreviewUrl) URL.revokeObjectURL(preparedPreviewUrl);
    };
  }, [preparedPreviewUrl]);

  // Auto-prepare the Shorts-ready copy as soon as the dialog opens, so the
  // preview shows the exact bytes we will upload — never the landscape original.
  useEffect(() => {
    if (!open || !force916 || preparedUpload || preparing || !video.video_url) return;
    let cancelled = false;
    (async () => {
      setPreparing(true);
      setPrepareError(null);
      setProgress(2);
      setStatus("Preparing Shorts-ready copy…");
      try {
        await prepareForUpload();
        if (!cancelled) {
          setProgress(100);
          setStatus("Upload-ready copy prepared — preview it, then upload.");
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Failed to prepare Shorts-ready copy";
          setPrepareError(msg);
          setStatus(msg);
          toast.error("Shorts prep failed", { description: msg });
        }
      } finally {
        if (!cancelled) setPreparing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, video.video_url]);


  const prepareForUpload = async () => {
    if (!video.video_url) {
      throw new Error("No video file attached to this clip");
    }
    // Step 1 — client-side Shorts-ready conversion. Runs entirely in the
    // browser via ffmpeg.wasm. Original file in storage stays byte-identical.
    const { prepareShortsReadyBlob } = await import(/* @vite-ignore */ "@/lib/shorts-ready.client");
    const prepared = await prepareShortsReadyBlob(video.video_url, {
      onProgress: (pct: number, label: string) => {
        const overall = Math.round(pct * 0.55);
        setProgress(overall);
        setStatus(label);
      },
    });
    const previewUrl = URL.createObjectURL(prepared.file);
    setPreparedPreviewUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return previewUrl;
    });
    setPreparedSummary(
      `${prepared.uploadProbe.rawWidth}×${prepared.uploadProbe.rawHeight} · ` +
        `${prepared.uploadProbe.durationSeconds.toFixed(1)}s · ` +
        `${prepared.uploadProbe.videoCodec || "unknown"}/${prepared.uploadProbe.audioCodec || "unknown"} · ` +
        `${(prepared.uploadFileSize / 1024 / 1024).toFixed(1)} MB`,
    );
    setPreparedUpload(prepared);
    return prepared;
  };

  const run = async () => {
    if (!video.video_url) {
      toast.error("No video file attached to this clip");
      return;
    }
    if (force916 && !preparedUpload) {
      toast.error("Upload-ready copy is still being prepared. Please wait.");
      return;
    }
    setUploading(true);
    setProgress(60);
    setStatus("Uploading prepared Shorts-ready copy…");
    let ticker: number | undefined;
    try {
      const prepared = preparedUpload;

      // Step 2 — if we re-encoded, PUT the converted blob to a temp signed URL.
      let preparedStoragePath: string | undefined;
      if (force916 && prepared && !prepared.reused) {
        setStatus("Uploading Shorts-ready copy…");
        setProgress(60);
        const target = await createTarget({ data: { videoId: video.id } });
        const { error: upErr } = await supabase.storage
          .from("videos")
          .uploadToSignedUrl(target.path, target.token, prepared.file, {
            contentType: "video/mp4",
            upsert: true,
          });
        if (upErr) throw new Error(`Failed to stage prepared copy: ${upErr.message}`);
        preparedStoragePath = target.path;
        console.info("[shorts-ready] Upload-ready MP4 staged.", {
          videoId: video.id,
          preparedStoragePath,
          width: prepared.uploadProbe.rawWidth,
          height: prepared.uploadProbe.rawHeight,
          duration: prepared.uploadProbe.durationSeconds,
          codec: [prepared.uploadProbe.videoCodec, prepared.uploadProbe.audioCodec].filter(Boolean).join("/") || "unknown",
          fileSize: prepared.uploadFileSize,
        });
      }
      if (force916 && prepared && !prepared.reused && !preparedStoragePath) {
        throw new Error("Prepared Shorts-ready copy was required but no staged upload path was created. Aborting before YouTube upload.");
      }

      // Step 3 — kick off the existing YouTube upload path.
      const uploadSource = preparedStoragePath ?? video.video_url;
      const converted = Boolean(preparedStoragePath);
      console.info("[shorts-ready] Upload uses upload-ready MP4.", {
        videoId: video.id,
        source: uploadSource,
        converted,
        force916,
        reused: prepared?.reused ?? null,
      });
      console.info("USING FILE FOR UPLOAD:", uploadSource);
      console.info(`Converted = ${converted ? "true" : "false"}`);
      setProgress(70);
      setStatus(force916 ? "Uploading to YouTube…" : "Uploading original file to YouTube…");
      ticker = window.setInterval(() => {
        setProgress((p) => {
          const next = Math.min(96, p + 3);
          setStatus(`Uploading to YouTube… ${next}%`);
          return next;
        });
      }, 900);
      const result = await upload({ data: {
        videoId: video.id,
        title,
        description,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        privacyStatus: privacy,
        preparedStoragePath,
        preparedExpected: converted,
      } });
      setProgress(100);
      setStatus(converted
        ? "✅ Uploaded to YouTube as a Short (9:16 converted copy)"
        : force916
          ? "✅ Uploaded to YouTube (original was already Shorts-ready)"
          : "✅ Uploaded original file to YouTube");
      setUrl(result.url);
      toast.success("Uploaded to YouTube");
      onUploaded?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "YouTube upload failed";
      setStatus(message);
      toast.error("YouTube upload failed", { description: message });
    } finally {
      if (ticker !== undefined) window.clearInterval(ticker);
      setUploading(false);
    }
  };


  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children || <Button><Youtube className="h-4 w-4" /> Upload to YouTube</Button>}</DialogTrigger>
      <DialogContent className="glass max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle className="font-display">Upload to YouTube</DialogTitle></DialogHeader>
        <div className="grid gap-5 md:grid-cols-[220px_1fr]">
          <div className="space-y-3">
            <div className="overflow-hidden rounded-xl border border-border/70 bg-background/40">
              {force916 ? (
                preparedPreviewUrl ? (
                  <video src={preparedPreviewUrl} controls className="aspect-[9/16] w-full object-contain" />
                ) : (
                  <div className="grid aspect-[9/16] place-items-center gap-2 p-3 text-center text-xs text-muted-foreground">
                    {prepareError ? (
                      <span className="text-destructive">{prepareError}</span>
                    ) : preparing ? (
                      <>
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <span>Preparing 9:16 Shorts-ready copy…</span>
                      </>
                    ) : (
                      <span>Waiting for source video…</span>
                    )}
                  </div>
                )
              ) : video.video_url ? (
                <video src={video.video_url} controls className="aspect-video w-full object-contain" />
              ) : (
                <div className="grid aspect-video place-items-center p-3 text-center text-xs text-muted-foreground">
                  No source video
                </div>
              )}
            </div>
            {preparedPreviewUrl && (
              <div className="rounded-md border border-border/60 bg-background/40 p-2 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">Upload-ready preview (exact bytes uploaded)</div>
                {preparedSummary && <div className="mt-1">{preparedSummary}</div>}
                <a href={preparedPreviewUrl} download={`${video.title || "short"}-upload-ready.mp4`} className="mt-2 inline-flex rounded-md border border-border px-2 py-1 hover:bg-accent">
                  Download upload-ready MP4
                </a>
              </div>
            )}
            {video.thumbnail_url && <img src={video.thumbnail_url} alt="Thumbnail" className="aspect-video rounded-lg object-cover" />}
            {video.youtube_video_id && <Badge className="w-full justify-center">Already uploaded</Badge>}
          </div>
          <div className="space-y-4">
            <div><Label>Title</Label><Input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} /></div>
            <div><Label>Description</Label><Textarea rows={7} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
            <div><Label>Tags</Label><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tag one, tag two" /></div>
            {video.hashtags?.length ? <div><Label>Hashtags</Label><p className="mt-1 rounded-md border border-border/60 bg-background/40 p-2 text-sm">{video.hashtags.join(" ")}</p></div> : null}
            <div><Label>Privacy</Label><Select value={privacy} onValueChange={(v: "public" | "unlisted" | "private") => setPrivacy(v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="private">Private</SelectItem><SelectItem value="unlisted">Unlisted</SelectItem><SelectItem value="public">Public</SelectItem></SelectContent></Select></div>
            <p className="rounded-md border border-border/50 bg-muted/30 p-2 text-xs text-muted-foreground">🎵 YouTube does not allow attaching Creator Music via API. Add music from YouTube Studio after upload.</p>
            {(uploading || preparing || status) && <div className="space-y-2"><Progress value={progress} /><p className="text-sm text-muted-foreground">{status}</p></div>}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={run}
                disabled={uploading || preparing || !preparedUpload || !title.trim() || !video.video_url}
              >
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                {preparing ? "Preparing 9:16…" : preparedUpload ? "Upload Now" : "Waiting for prep…"}
              </Button>

              {url && <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">View on YouTube</a>}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
