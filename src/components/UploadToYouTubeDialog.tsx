import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Loader2, UploadCloud, Youtube } from "lucide-react";
import { toast } from "sonner";
import { commitShortsSafeVideo, createShortsSafeVideoUploadUrl, uploadVideoToYouTube } from "@/lib/media.functions";

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

export function UploadToYouTubeDialog({ video, children, onUploaded }: { video: UploadVideo; children?: React.ReactNode; onUploaded?: () => void }) {
  const upload = useServerFn(uploadVideoToYouTube);
  const createSafeUpload = useServerFn(createShortsSafeVideoUploadUrl);
  const commitSafeUpload = useServerFn(commitShortsSafeVideo);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(video.title || "Untitled Short");
  const [description, setDescription] = useState(video.description || "");
  const [tags, setTags] = useState((video.tags || []).join(", "));
  const [privacy, setPrivacy] = useState<"public" | "unlisted" | "private">("private");
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [url, setUrl] = useState<string | null>(video.youtube_video_id ? `https://www.youtube.com/shorts/${video.youtube_video_id}` : null);
  const [uploading, setUploading] = useState(false);

  const run = async () => {
    setUploading(true);
    setProgress(8);
    setStatus("Checking vertical Shorts format...");
    const ticker = window.setInterval(() => {
      setProgress((p) => {
        const next = Math.min(92, p + 5);
        setStatus(next < 45 ? "Preparing 9:16 Shorts MP4..." : `Uploading to YouTube... ${next}%`);
        return next;
      });
    }, 900);
    try {
      const safeInfo = await createSafeUpload({ data: { videoId: video.id } });
      const { fetchVideoBytes, prepareShortsSafeMp4, uploadSignedMp4 } = await import(/* @vite-ignore */ ("@/lib/shorts-safe" + ".client"));
      const sourceBytes = await fetchVideoBytes(safeInfo.sourceUrl);
      const safe = await prepareShortsSafeMp4(sourceBytes, "hd");
      if (safe.changed) {
        setProgress(48);
        setStatus("Saving vertical 9:16 Shorts MP4...");
        await uploadSignedMp4(safeInfo.uploadSignedUrl, safe.bytes);
        await commitSafeUpload({ data: {
          videoId: video.id,
          videoStoragePath: safeInfo.videoStoragePath,
          fileSizeBytes: safe.bytes.byteLength,
          durationSeconds: safe.durationSeconds,
        } });
      }
      setProgress(60);
      setStatus("Uploading to YouTube as a Short...");
      const result = await upload({ data: { videoId: video.id, title, description, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), privacyStatus: privacy } });
      setProgress(100);
      setStatus("✅ Uploaded to YouTube as a Shorts-ready vertical MP4!");
      setUrl(result.url);
      toast.success("Uploaded to YouTube");
      onUploaded?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "YouTube upload failed";
      setStatus(message);
      toast.error("YouTube upload failed", { description: message });
    } finally {
      window.clearInterval(ticker);
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
              {video.video_url ? <video src={video.video_url} controls className="aspect-[9/16] w-full object-cover" /> : <div className="grid aspect-[9/16] place-items-center text-sm text-muted-foreground">No video file</div>}
            </div>
            {video.thumbnail_url && <img src={video.thumbnail_url} alt="Thumbnail" className="aspect-video rounded-lg object-cover" />}
            {video.youtube_video_id && <Badge className="w-full justify-center">Already uploaded</Badge>}
          </div>
          <div className="space-y-4">
            <div><Label>Title</Label><Input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} /></div>
            <div><Label>Description</Label><Textarea rows={7} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
            <div><Label>Tags</Label><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tag one, tag two" /></div>
            {video.hashtags?.length ? <div><Label>Hashtags</Label><p className="mt-1 rounded-md border border-border/60 bg-background/40 p-2 text-sm">{video.hashtags.join(" ")}</p></div> : null}
            <div><Label>Privacy</Label><Select value={privacy} onValueChange={(v: "public" | "unlisted" | "private") => setPrivacy(v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="private">Private</SelectItem><SelectItem value="unlisted">Unlisted</SelectItem><SelectItem value="public">Public</SelectItem></SelectContent></Select></div>
            {(uploading || status) && <div className="space-y-2"><Progress value={progress} /><p className="text-sm text-muted-foreground">{status}</p></div>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={run} disabled={uploading || !title.trim() || !video.video_url}>{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}Upload Now</Button>
              {url && <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">View on YouTube</a>}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
