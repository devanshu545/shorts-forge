import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Youtube, Wand2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { uploadVideoToYouTube, createShortsReadyUploadTarget } from "@/lib/media.functions";
import { generateShortSEO } from "@/lib/seo.functions";
import { supabase } from "@/integrations/supabase/client";

type OneClickVideo = {
  id: string;
  title: string | null;
  description: string | null;
  tags: string[] | null;
  video_url?: string | null;
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
  const createTarget = useServerFn(createShortsReadyUploadTarget);
  const seo = useServerFn(generateShortSEO);
  const [stage, setStage] = useState<"idle" | "seo" | "uploading" | "done">(
    video.youtube_video_id ? "done" : "idle",
  );
  const [url, setUrl] = useState<string | null>(
    video.youtube_video_id ? `https://www.youtube.com/watch?v=${video.youtube_video_id}` : null,
  );

  const run = async () => {
    try {
      setStage("seo");
      const meta = await seo({ data: {
        hint: hint || video.title || "Trending YouTube Short",
        frames: frames && frames.length ? frames : undefined,
      } });

      setStage("uploading");
      let preparedStoragePath: string | undefined;
      let preparedExpected = false;
      if (video.video_url) {
        console.info("[shorts-ready] One-click upload prep started.", { videoId: video.id, sourceUrl: video.video_url });
        const { prepareShortsReadyBlob } = await import(/* @vite-ignore */ "@/lib/shorts-ready.client");
        const prepared = await prepareShortsReadyBlob(video.video_url);
        preparedExpected = !prepared.reused;
        if (!prepared.reused) {
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
        if (preparedExpected && !preparedStoragePath) {
          throw new Error("Prepared Shorts-ready copy was required but no staged upload path was created. Aborting before YouTube upload.");
        }
        const uploadSource = prepared.reused ? video.video_url : preparedStoragePath;
        console.info("[shorts-ready] Upload uses upload-ready MP4.", {
          videoId: video.id,
          source: uploadSource,
          converted: !prepared.reused,
          width: prepared.uploadProbe.rawWidth,
          height: prepared.uploadProbe.rawHeight,
          duration: prepared.uploadProbe.durationSeconds,
          codec: [prepared.uploadProbe.videoCodec, prepared.uploadProbe.audioCodec].filter(Boolean).join("/") || "unknown",
          fileSize: prepared.uploadFileSize,
        });
        console.info("USING FILE FOR UPLOAD:", uploadSource);
        console.info(`Converted = ${prepared.reused ? "false" : "true"}`);
      }
      const result = await upload({ data: {
        videoId: video.id,
        title: meta.title,
        description: meta.description,
        tags: meta.tags,
        privacyStatus: "public",
        preparedStoragePath,
        preparedExpected,
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
