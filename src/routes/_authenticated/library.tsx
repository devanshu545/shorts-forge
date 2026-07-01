import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { UploadToYouTubeDialog } from "@/components/UploadToYouTubeDialog";
import { generateMetadataForVideo, startVideoGeneration } from "@/lib/media.functions";
import { Play, Trash2, Download, Copy, Upload, Library as LibraryIcon, Loader2, Search, Youtube, RefreshCw } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/library")({ component: LibraryPage });

type Video = Database["public"]["Tables"]["videos"]["Row"];

function LibraryPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const genMeta = useServerFn(generateMetadataForVideo);
  const genVideo = useServerFn(startVideoGeneration);
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("date" as "date" | "duration" | "title");
  const [selected, setSelected] = useState<Video | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);

  const { data: videos, refetch, isLoading } = useQuery({
    queryKey: ["videos"],
    queryFn: async () => {
      const { data, error } = await supabase.from("videos").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return data as Video[];
    },
  });

  useEffect(() => {
    const ch = supabase.channel("videos-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "videos" }, (payload) => {
        if (selected && (payload.new as any)?.id === selected.id) setSelected(payload.new as Video);
        refetch();
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [refetch, selected]);

  const filtered = useMemo(() => {
    const list = [...(videos || [])].filter((v) => v.title.toLowerCase().includes(query.toLowerCase()));
    list.sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "duration") return (b.duration_seconds || 0) - (a.duration_seconds || 0);
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    return list;
  }, [videos, query, sort]);

  const copy = (label: string, text?: string | null) => {
    navigator.clipboard.writeText(text || "");
    toast.success("Copied to clipboard!", { description: label });
  };

  const del = async (id: string) => {
    const { error } = await supabase.from("videos").delete().eq("id", id);
    if (error) toast.error(error.message);
    else { toast.success("Deleted"); if (selected?.id === id) setSelected(null); }
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const topic = window.prompt("Optional: enter the video topic/script for Gemini metadata. Leave blank to use the file name.") || file.name.replace(/\.[^.]+$/, "");
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userRes.user) throw userErr || new Error("Not signed in");
      const uid = userRes.user.id;
      const cleanName = file.name.replace(/[^a-z0-9_.-]/gi, "-");
      const path = `${uid}/${crypto.randomUUID()}-${cleanName}`;
      const { error: upErr } = await supabase.storage.from("videos").upload(path, file, { contentType: file.type || "video/mp4" });
      if (upErr) throw upErr;
      const { data: signed } = await supabase.storage.from("videos").createSignedUrl(path, 60 * 60 * 24 * 7);
      const { data: row, error: insErr } = await supabase.from("videos").insert({
        user_id: uid,
        title: file.name.replace(/\.[^.]+$/, ""),
        video_url: signed?.signedUrl ?? null,
        video_storage_path: path,
        status: "ready",
        file_size_bytes: file.size,
      }).select("id").single();
      if (insErr) throw insErr;
      toast.success("Uploaded. Generating metadata...");
      await genMeta({ data: { videoId: row.id, topic } });
      toast.success("Auto-metadata generated");
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const regenerate = async (video: Video) => {
    const script: any = video.script;
    if (!script?.title || !script?.scenes || !script?.fullVoiceover) {
      toast.error("This item has no complete AI script to regenerate video from. Use Generate for new AI video, or regenerate metadata for this upload.");
      return;
    }
    setRegeneratingId(video.id);
    try {
      await genVideo({ data: { script, durationSeconds: video.duration_seconds || 45, existingVideoId: video.id } });
      toast.success("Video regenerated");
      refetch();
    } catch (err) {
      toast.error("Video generation failed", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setRegeneratingId(null);
    }
  };

  const regenerateMetadata = async (video: Video) => {
    try {
      await genMeta({ data: { videoId: video.id, topic: video.title } });
      toast.success("Metadata regenerated");
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Metadata generation failed");
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6 md:p-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><h1 className="font-display text-3xl font-semibold">Library</h1><p className="text-sm text-muted-foreground">Every short you've forged.</p></div>
        <div><input ref={inputRef} type="file" accept="video/mp4,video/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.currentTarget.value = ""; }} /><Button variant="outline" onClick={() => inputRef.current?.click()} disabled={uploading}>{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}Upload MP4</Button></div>
      </div>
      <Card className="glass p-4"><div className="flex flex-col gap-3 sm:flex-row"><div className="relative flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-9" placeholder="Search by title" value={query} onChange={(e) => setQuery(e.target.value)} /></div><Select value={sort} onValueChange={(v: "date" | "duration" | "title") => setSort(v)}><SelectTrigger className="sm:w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="date">Sort by date</SelectItem><SelectItem value="duration">Sort by duration</SelectItem><SelectItem value="title">Sort by title</SelectItem></SelectContent></Select></div></Card>

      {isLoading ? <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Card key={i} className="glass aspect-[9/16] animate-pulse" />)}</div> : !filtered.length ? (
        <Card className="glass grid place-items-center p-16 text-center"><LibraryIcon className="h-8 w-8 text-primary-glow" /><h3 className="mt-3 font-display text-lg font-semibold">No videos generated yet</h3><p className="mt-1 max-w-sm text-sm text-muted-foreground">Generate a video or upload an MP4 to build your library.</p></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
          {filtered.map((v) => <VideoCard key={v.id} video={v} onOpen={() => setSelected(v)} onDelete={() => del(v.id)} onCopy={copy} onRegenerate={() => regenerate(v)} regenerating={regeneratingId === v.id} onUploaded={refetch} />)}
        </div>
      )}
      <DetailDialog video={selected} onClose={() => setSelected(null)} onCopy={copy} onDelete={del} onRegenerate={regenerate} onRegenerateMetadata={regenerateMetadata} regeneratingId={regeneratingId} onUploaded={refetch} />
    </div>
  );
}

function VideoCard({ video, onOpen, onDelete, onCopy, onRegenerate, regenerating, onUploaded }: { video: Video; onOpen: () => void; onDelete: () => void; onCopy: (l: string, t?: string | null) => void; onRegenerate: () => void; regenerating: boolean; onUploaded: () => void }) {
  return <Card className="glass group overflow-hidden transition-all duration-300 hover:scale-[1.02] hover:border-primary/40">
    <button type="button" onClick={onOpen} className="relative block aspect-[9/16] w-full bg-surface-2 text-left">
      {video.thumbnail_url ? <img src={video.thumbnail_url} alt={video.title} className="h-full w-full object-cover" /> : video.video_url ? <video src={video.video_url} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-muted-foreground"><Play className="h-8 w-8" /></div>}
      <span className="absolute left-2 top-2 rounded-full bg-background/70 px-2 py-0.5 text-[10px] uppercase tracking-wide backdrop-blur">{video.status}</span>
      {video.youtube_video_id && <Badge className="absolute right-2 top-2">Uploaded</Badge>}
      {video.duration_seconds && <span className="absolute bottom-2 right-2 rounded bg-background/80 px-2 py-0.5 text-xs">{video.duration_seconds}s</span>}
      {video.generation_progress > 0 && video.status === "generating_video" && <Progress value={video.generation_progress} className="absolute bottom-0 left-0 right-0 h-1" />}
    </button>
    <div className="p-3"><p className="line-clamp-2 text-sm font-medium">{video.title}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(video.created_at).toLocaleDateString()}</p><div className="mt-3 flex flex-wrap gap-1"><Button size="sm" variant="ghost" onClick={() => onCopy("Title", video.title)}><Copy className="h-3 w-3" />Title</Button>{video.video_url && <a href={video.video_url} download className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-accent"><Download className="h-3 w-3" />MP4</a>}<UploadToYouTubeDialog video={video} onUploaded={onUploaded}><Button size="sm" variant="ghost"><Youtube className="h-3 w-3" />YT</Button></UploadToYouTubeDialog><Button size="sm" variant="ghost" onClick={onRegenerate} disabled={regenerating}>{regenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}</Button><Button size="sm" variant="ghost" onClick={onDelete} className="text-destructive hover:text-destructive"><Trash2 className="h-3 w-3" /></Button></div></div>
  </Card>;
}

function DetailDialog({ video, onClose, onCopy, onDelete, onRegenerate, onRegenerateMetadata, regeneratingId, onUploaded }: { video: Video | null; onClose: () => void; onCopy: (l: string, t?: string | null) => void; onDelete: (id: string) => void; onRegenerate: (v: Video) => void; onRegenerateMetadata: (v: Video) => void; regeneratingId: string | null; onUploaded: () => void }) {
  const script: any = video?.script;
  const scriptText = script?.fullVoiceover || (script ? JSON.stringify(script, null, 2) : "No script saved for this item.");
  if (!video) return null;
  const copyAll = () => onCopy("All", [`Title: ${video.title}`, `Description:\n${video.description || ""}`, `Tags: ${(video.tags || []).join(", ")}`, `Hashtags: ${(video.hashtags || []).join(" ")}`, `Script:\n${scriptText}`].join("\n\n"));
  return <Dialog open={!!video} onOpenChange={(o) => !o && onClose()}><DialogContent className="glass max-h-[92vh] max-w-5xl overflow-hidden"><DialogHeader><DialogTitle className="font-display">{video.title}</DialogTitle></DialogHeader><div className="grid max-h-[78vh] gap-5 overflow-y-auto md:grid-cols-[320px_1fr]"><div className="space-y-3">{video.video_url ? <video src={video.video_url} controls className="aspect-[9/16] w-full rounded-xl border border-border object-cover" /> : <div className="grid aspect-[9/16] place-items-center rounded-xl border border-border text-muted-foreground"><Play /></div>}<div className="flex flex-wrap gap-2">{video.video_url && <a href={video.video_url} download className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"><Download className="h-4 w-4" />Download</a>}<UploadToYouTubeDialog video={video} onUploaded={onUploaded}><Button><Youtube className="h-4 w-4" />Upload to YouTube</Button></UploadToYouTubeDialog><Button variant="outline" onClick={() => onRegenerate(video)} disabled={regeneratingId === video.id}>{regeneratingId === video.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}Regenerate</Button><Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => onDelete(video.id)}><Trash2 className="h-4 w-4" />Delete</Button></div></div><div className="space-y-5"><section><div className="mb-2 flex items-center justify-between"><h3 className="font-display font-semibold">Metadata</h3><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => onRegenerateMetadata(video)}>Regenerate metadata</Button><Button size="sm" variant="outline" onClick={copyAll}><Copy className="h-3.5 w-3.5" />Copy All</Button></div></div><div className="grid gap-3"><Meta label="Title" value={video.title} onCopy={() => onCopy("Title", video.title)} /><Meta label="Description" value={video.description || ""} textarea onCopy={() => onCopy("Description", video.description)} /><Meta label="Tags" value={(video.tags || []).join(", ")} onCopy={() => onCopy("Tags", (video.tags || []).join(", "))} /><Meta label="Hashtags" value={(video.hashtags || []).join(" ")} onCopy={() => onCopy("Hashtags", (video.hashtags || []).join(" "))} /><Meta label="Keywords" value={(video.seo_keywords || []).join(", ")} onCopy={() => onCopy("Keywords", (video.seo_keywords || []).join(", "))} /></div></section><section><h3 className="mb-2 font-display font-semibold">Script</h3><ScrollArea className="h-56 rounded-lg border border-border/60 bg-background/40 p-4"><pre className="whitespace-pre-wrap text-sm font-sans">{scriptText}</pre></ScrollArea><Button className="mt-2" size="sm" variant="outline" onClick={() => onCopy("Script", scriptText)}><Copy className="h-3.5 w-3.5" />Copy Script</Button></section><section className="grid grid-cols-2 gap-3 text-sm text-muted-foreground"><p>Status: {video.status}</p><p>Duration: {video.duration_seconds || "—"}s</p><p>Date: {new Date(video.created_at).toLocaleString()}</p><p>YouTube ID: {video.youtube_video_id || "—"}</p>{video.error_message && <p className="col-span-2 text-destructive">Error: {video.error_message}</p>}</section></div></div></DialogContent></Dialog>;
}

function Meta({ label, value, textarea, onCopy }: { label: string; value: string; textarea?: boolean; onCopy: () => void }) {
  return <div><div className="mb-1 flex items-center justify-between"><span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span><button onClick={onCopy} className="text-xs text-muted-foreground hover:text-foreground"><Copy className="inline h-3 w-3" /> Copy</button></div>{textarea ? <Textarea readOnly value={value} rows={5} /> : <Input readOnly value={value} />}</div>;
}
