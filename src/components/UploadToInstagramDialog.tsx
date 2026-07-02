import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Loader2, Instagram } from "lucide-react";
import { toast } from "sonner";
import { publishVideoToInstagram } from "@/lib/instagram.functions";

type Video = {
  id: string;
  title: string | null;
  video_url: string | null;
  instagram_media_id?: string | null;
  instagram_permalink?: string | null;
};

export function UploadToInstagramDialog({ video, children, onUploaded }: { video: Video; children?: React.ReactNode; onUploaded?: () => void }) {
  const publish = useServerFn(publishVideoToInstagram);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [permalink, setPermalink] = useState<string | null>(video.instagram_permalink ?? null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setProgress(10);
    setStatus("Sending Reel to Instagram (this can take up to ~90s)…");
    const ticker = window.setInterval(() => {
      setProgress((p) => Math.min(90, p + 5));
    }, 2500);
    try {
      const result = await publish({ data: { videoId: video.id } });
      setProgress(100);
      setStatus("✅ Published to Instagram!");
      setPermalink(result.permalink ?? null);
      toast.success("Instagram Reel published!");
      onUploaded?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Instagram publish failed";
      setStatus(message);
      toast.error("Instagram publish failed", { description: message });
    } finally {
      window.clearInterval(ticker);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children || <Button variant="secondary"><Instagram className="h-4 w-4" /> Post to Instagram</Button>}</DialogTrigger>
      <DialogContent className="glass max-w-md">
        <DialogHeader><DialogTitle className="font-display">Publish Reel to Instagram</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {video.video_url && <video src={video.video_url} controls className="aspect-[9/16] w-full rounded-lg border border-border/60 object-cover" />}
          {video.instagram_media_id && <Badge className="w-full justify-center">Already published on Instagram</Badge>}
          <p className="text-sm text-muted-foreground">
            The caption + hashtags saved to this video (or the YouTube description as a fallback) will be posted to your linked Instagram Business account.
          </p>
          {(busy || status) && <div className="space-y-2"><Progress value={progress} /><p className="text-xs text-muted-foreground">{status}</p></div>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={run} disabled={busy || !video.video_url || !!video.instagram_media_id}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Instagram className="h-4 w-4" />} Publish Now
            </Button>
            {permalink && <a href={permalink} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">View on Instagram</a>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
