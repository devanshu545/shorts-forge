import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Play, Trash2, Download, Copy, Upload, Library as LibraryIcon, Loader2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/library")({
  component: LibraryPage,
});

function LibraryPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data: videos, refetch } = useQuery({
    queryKey: ["videos"],
    queryFn: async () => {
      const { data, error } = await supabase.from("videos")
        .select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    const ch = supabase.channel("videos-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "videos" }, () => { refetch(); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [refetch]);

  const del = async (id: string) => {
    const { error } = await supabase.from("videos").delete().eq("id", id);
    if (error) toast.error(error.message);
    else toast.success("Deleted");
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const { data: userRes } = await supabase.auth.getUser();
      const uid = userRes.user!.id;
      const path = `${uid}/${Date.now()}-${file.name}`;
      const { error: upErr } = await supabase.storage.from("videos").upload(path, file);
      if (upErr) throw upErr;
      const { data: signed } = await supabase.storage.from("videos").createSignedUrl(path, 60 * 60 * 24 * 7);
      const { error: insErr } = await supabase.from("videos").insert({
        user_id: uid,
        title: file.name.replace(/\.[^.]+$/, ""),
        video_url: signed?.signedUrl ?? null,
        status: "ready",
        file_size_bytes: file.size,
      });
      if (insErr) throw insErr;
      toast.success("Uploaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 md:p-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Library</h1>
          <p className="text-sm text-muted-foreground">Every short you've forged.</p>
        </div>
        <div>
          <input ref={inputRef} type="file" accept="video/mp4,video/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.currentTarget.value = ""; }} />
          <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Upload MP4
          </Button>
        </div>
      </div>

      {!videos || videos.length === 0 ? (
        <Card className="glass grid place-items-center p-16 text-center">
          <LibraryIcon className="h-8 w-8 text-primary-glow" />
          <h3 className="mt-3 font-display text-lg font-semibold">Nothing here yet</h3>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Generate a script or upload an existing MP4 to build your library.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
          {videos.map((v) => (
            <Card key={v.id} className="glass group overflow-hidden">
              <div className="relative aspect-[9/16] bg-surface-2">
                {v.thumbnail_url ? (
                  <img src={v.thumbnail_url} alt={v.title} className="h-full w-full object-cover" />
                ) : v.video_url ? (
                  <video src={v.video_url} className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full place-items-center text-muted-foreground">
                    <Play className="h-8 w-8" />
                  </div>
                )}
                <span className="absolute left-2 top-2 rounded-full bg-background/70 px-2 py-0.5 text-[10px] uppercase tracking-wide backdrop-blur">
                  {v.status}
                </span>
              </div>
              <div className="p-3">
                <p className="line-clamp-2 text-sm font-medium">{v.title}</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  {v.description && (
                    <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(v.description!); toast.success("Copied"); }}>
                      <Copy className="h-3 w-3" /> Desc
                    </Button>
                  )}
                  {v.video_url && (
                    <a href={v.video_url} download className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-accent">
                      <Download className="h-3 w-3" /> MP4
                    </a>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => del(v.id)} className="text-destructive hover:text-destructive">
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
