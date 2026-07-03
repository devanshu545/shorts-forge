import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Youtube, Wand2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { commitShortsSafeVideo, createShortsSafeVideoUploadUrl, uploadVideoToYouTube } from "@/lib/media.functions";
import { generateShortSEO } from "@/lib/seo.functions";

type OneClickVideo = {
  id: string;
  title: string | null;
  description: string | null;
  tags: string[] | null;
  youtube_video_id?: string | null;
};

// One-click SEO-optimized public upload to YouTube. Auto-generates title/desc/
// tags from a hint and pushes visibility=public.
export function OneClickPublishButton({ video, hint, frames, onUploaded, size = "sm", label = "Publish" }: {
  video: OneClickVideo;
  hint?: string;
  frames?: string[];
  onUploaded?: (url: string) => void;
  size?: "sm" | "default";
  label?: string;
}) {
  const upload = useServerFn(uploadVideoToYouTube);
  const createSafeUpload = useServerFn(createShortsSafeVideoUploadUrl);
  const commitSafeUpload = useServerFn(commitShortsSafeVideo);
  const seo = useServerFn(generateShortSEO);
  const [stage, setStage] = useState<"idle" | "seo" | "uploading" | "done">(
    video.youtube_video_id ? "done" : "idle",
  );
  const [url, setUrl] = useState<string | null>(
    video.youtube_video_id ? `https://www.youtube.com/shorts/${video.youtube_video_id}` : null,
  );

  const run = async () => {
    try {
      setStage("seo");
      const meta = await seo({ data: {
        hint: hint || video.title || "Trending YouTube Short",
        frames: frames && frames.length ? frames : undefined,
      } });

      setStage("uploading");
      const safeInfo = await createSafeUpload({ data: { videoId: video.id } });
      const { fetchVideoBytes, prepareShortsSafeMp4, uploadSignedMp4 } = await import("@/lib/shorts-safe.client");
      const sourceBytes = await fetchVideoBytes(safeInfo.sourceUrl);
      const safe = await prepareShortsSafeMp4(sourceBytes, "hd");
      if (safe.changed) {
        await uploadSignedMp4(safeInfo.uploadSignedUrl, safe.bytes);
        await commitSafeUpload({ data: {
          videoId: video.id,
          videoStoragePath: safeInfo.videoStoragePath,
          fileSizeBytes: safe.bytes.byteLength,
          durationSeconds: safe.durationSeconds,
        } });
      }
      const result = await upload({ data: {
        videoId: video.id,
        title: meta.title,
        description: meta.description,
        tags: meta.tags,
        privacyStatus: "public",
      } });
      setUrl(result.url);
      setStage("done");
      toast.success("Published to YouTube (Public)", { description: meta.title });
      onUploaded?.(result.url);
    } catch (err) {
      setStage("idle");
      toast.error(err instanceof Error ? err.message : "Publish failed");
    }
  };

  if (stage === "done" && url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/15 px-2.5 py-1.5 text-xs font-medium text-primary-glow transition hover:bg-primary/25"
      >
        <CheckCircle2 className="h-3.5 w-3.5" /> Live on YouTube
      </a>
    );
  }

  const busy = stage !== "idle";
  return (
    <Button onClick={run} disabled={busy} size={size} className="group relative overflow-hidden">
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
      {stage === "seo" ? "Optimizing SEO…" : stage === "uploading" ? "Uploading…" : label}
      {!busy && <Youtube className="h-3.5 w-3.5 opacity-70" />}
    </Button>
  );
}
