import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { generateScript, saveScriptAsDraft, type GeneratedScript } from "@/lib/scripts.functions";
import { startVideoGeneration } from "@/lib/media.functions";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { UploadToYouTubeDialog } from "@/components/UploadToYouTubeDialog";
import { Loader2, Wand2, Copy, Save, Sparkles, Download, Youtube } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/generate")({
  component: GeneratePage,
});

function GeneratePage() {
  const navigate = useNavigate();
  const gen = useServerFn(generateScript);
  const save = useServerFn(saveScriptAsDraft);
  const genVideo = useServerFn(startVideoGeneration);

  const [niche, setNiche] = useState("");
  const [tone, setTone] = useState("energetic and punchy");
  const [hookStyle, setHookStyle] = useState("shocking statistic");
  const [duration, setDuration] = useState(30);
  const [loading, setLoading] = useState(false);
  const [script, setScript] = useState<GeneratedScript | null>(null);
  const [saving, setSaving] = useState(false);
  const [generatingVideo, setGeneratingVideo] = useState(false);
  const [videoRow, setVideoRow] = useState<any | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setScript(null);
    try {
      const result = await gen({ data: { niche, tone, hookStyle, durationSeconds: duration } });
      setScript(result.script);
      toast.success("Script ready");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  const saveDraft = async () => {
    if (!script) return;
    setSaving(true);
    try {
      const { id } = await save({ data: { script, durationSeconds: duration } });
      toast.success("Saved to library");
      navigate({ to: "/library", search: { highlight: id } as never });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const copy = (label: string, text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard!", { description: label });
  };

  const copyAll = () => {
    if (!script) return;
    copy("All metadata", [`Title: ${script.title}`, `Hook: ${script.hook}`, `Description:\n${script.description}`, `Hashtags: ${script.hashtags.join(" ")}`, `Script:\n${script.fullVoiceover}`].join("\n\n"));
  };

  const runVideoGeneration = async () => {
    if (!script) return;
    setGeneratingVideo(true);
    setVideoError(null);
    setVideoRow({ generation_progress: 3, generation_stage: "🔄 Generating video... This may take 2-5 minutes.", title: script.title, script, status: "generating_video" });
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      const draft = await save({ data: { script, durationSeconds: duration } });
      setVideoRow((prev: any) => ({ ...prev, id: draft.id }));
      channel = supabase
        .channel(`video-progress-${draft.id}`)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "videos", filter: `id=eq.${draft.id}` }, (payload) => {
          setVideoRow(payload.new);
        })
        .subscribe();
      const result = await genVideo({ data: { script, durationSeconds: duration, existingVideoId: draft.id } });
      const { data: row } = await supabase.from("videos").select("*").eq("id", result.videoId).single();
      setVideoRow(row || { id: result.videoId, title: result.metadata.title, video_url: result.videoUrl, description: result.metadata.description, tags: result.metadata.tags, hashtags: result.metadata.hashtags, thumbnail_url: null, status: "ready", generation_progress: 100, generation_stage: "Video ready! 🎉" });
      if (result.warning) toast.warning(result.warning);
      toast.success("Video ready! 🎉");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Video generation failed";
      setVideoError(message);
      toast.error("Video generation failed", { description: message });
    } finally {
      if (channel) supabase.removeChannel(channel);
      setGeneratingVideo(false);
    }
  };

  return (
    <div className="mx-auto grid max-w-6xl gap-6 p-6 md:p-10 lg:grid-cols-[380px_1fr]">
      <Card className="glass h-fit p-6">
        <div className="flex items-center gap-2">
          <Wand2 className="h-5 w-5 text-primary-glow" />
          <h2 className="font-display text-lg font-semibold">New short</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Describe the vibe. AI writes the rest.</p>
        <form onSubmit={run} className="mt-6 space-y-4">
          <div>
            <Label htmlFor="niche">Niche / topic</Label>
            <Textarea id="niche" required rows={3} placeholder="e.g. 3 unexpected productivity hacks for developers"
              value={niche} onChange={(e) => setNiche(e.target.value)} className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="tone">Tone</Label>
            <Input id="tone" value={tone} onChange={(e) => setTone(e.target.value)} className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="hook">Hook style</Label>
            <Input id="hook" value={hookStyle} onChange={(e) => setHookStyle(e.target.value)} className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="dur">Duration (seconds)</Label>
            <Input id="dur" type="number" min={15} max={90} value={duration}
              onChange={(e) => setDuration(parseInt(e.target.value) || 30)} className="mt-1.5" />
          </div>
          <Button type="submit" className="w-full" disabled={loading || !niche.trim()}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Generate script
          </Button>
        </form>
      </Card>

      <div className="space-y-4">
        {loading && !script && (
          <Card className="glass grid place-items-center p-16">
            <Loader2 className="h-8 w-8 animate-spin text-primary-glow" />
            <p className="mt-3 text-sm text-muted-foreground">Crafting your script…</p>
          </Card>
        )}
        {!loading && !script && (
          <Card className="glass grid place-items-center p-16 text-center">
            <Wand2 className="h-8 w-8 text-primary-glow" />
            <h3 className="mt-3 font-display text-lg font-semibold">Your script appears here</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Fill in a niche on the left, then hit Generate.
            </p>
          </Card>
        )}
        {script && (
          <>
            <Card className="glass p-6">
              <FieldRow label="Title" onCopy={() => copy("Title", script.title)}>
                <Input value={script.title} onChange={(e) => setScript({ ...script, title: e.target.value })} />
              </FieldRow>
              <FieldRow label="Hook" onCopy={() => copy("Hook", script.hook)}>
                <Input value={script.hook} onChange={(e) => setScript({ ...script, hook: e.target.value })} />
              </FieldRow>
              <FieldRow label="Description" onCopy={() => copy("Description", script.description)}>
                <Textarea rows={3} value={script.description} onChange={(e) => setScript({ ...script, description: e.target.value })} />
              </FieldRow>
              <FieldRow label="Hashtags" onCopy={() => copy("Hashtags", script.hashtags.join(" "))}>
                <Input value={script.hashtags.join(" ")}
                  onChange={(e) => setScript({ ...script, hashtags: e.target.value.split(/\s+/).filter(Boolean) })} />
              </FieldRow>
              <Button size="sm" variant="outline" onClick={copyAll}><Copy className="h-3.5 w-3.5" /> Copy All</Button>
            </Card>

            <Card className="glass p-6">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-display text-lg font-semibold">Scenes</h3>
                <Button size="sm" variant="ghost" onClick={() => copy("Full voiceover", script.fullVoiceover)}>
                  <Copy className="h-3.5 w-3.5" /> Copy full VO
                </Button>
              </div>
              <div className="space-y-3">
                {script.scenes.map((scene, i) => (
                  <div key={i} className="rounded-lg border border-border/60 bg-surface/40 p-4">
                    <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                      <span>Scene {scene.order} · {scene.durationSeconds}s</span>
                    </div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Visual</p>
                    <p className="mt-1 text-sm">{scene.visualPrompt}</p>
                    <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Voiceover</p>
                    <p className="mt-1 text-sm">{scene.voiceover}</p>
                    <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">On-screen text</p>
                    <p className="mt-1 text-sm">{scene.onScreenText}</p>
                  </div>
                ))}
              </div>
            </Card>

            <div className="flex flex-wrap gap-2">
              <Button onClick={saveDraft} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save to library
              </Button>
              <Button variant="outline" onClick={runVideoGeneration} disabled={generatingVideo}>
                {generatingVideo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Generate video
              </Button>
            </div>

            {(videoRow || videoError) && (
              <Card className="glass p-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div><h3 className="font-display text-lg font-semibold">Video generation</h3><p className="text-sm text-muted-foreground">{videoRow?.generation_stage || videoError}</p></div>
                  {videoRow?.status && <Badge>{videoRow.status}</Badge>}
                </div>
                {generatingVideo && <div className="space-y-2"><Progress value={videoRow?.generation_progress || 8} /><p className="text-sm">🔄 Generating video... This may take 2-5 minutes.</p></div>}
                {videoError && <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm"><p>{videoError}</p><Button className="mt-3" size="sm" onClick={runVideoGeneration}>Retry</Button></div>}
                {videoRow?.video_url && <div className="mt-4 grid gap-4 md:grid-cols-[260px_1fr]"><video src={videoRow.video_url} controls className="aspect-[9/16] w-full rounded-xl border border-border object-cover" /><div className="space-y-3"><p className="font-medium">{videoRow.title}</p><p className="whitespace-pre-wrap text-sm text-muted-foreground">{videoRow.description}</p><div className="flex flex-wrap gap-2"><a href={videoRow.video_url} download className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"><Download className="h-4 w-4" /> Download</a><UploadToYouTubeDialog video={videoRow}><Button><Youtube className="h-4 w-4" />Upload to YouTube</Button></UploadToYouTubeDialog></div></div></div>}
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FieldRow({ label, onCopy, children }: { label: string; onCopy: () => void; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center justify-between">
        <Label>{label}</Label>
        <button type="button" onClick={onCopy} className="text-xs text-muted-foreground hover:text-foreground">
          <Copy className="inline h-3 w-3" /> Copy
        </button>
      </div>
      {children}
    </div>
  );
}
