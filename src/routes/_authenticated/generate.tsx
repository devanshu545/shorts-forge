import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { generateScript, saveScriptAsDraft, type GeneratedScript } from "@/lib/scripts.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Wand2, Copy, Save, Sparkles } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/generate")({
  component: GeneratePage,
});

function GeneratePage() {
  const navigate = useNavigate();
  const gen = useServerFn(generateScript);
  const save = useServerFn(saveScriptAsDraft);

  const [niche, setNiche] = useState("");
  const [tone, setTone] = useState("energetic and punchy");
  const [hookStyle, setHookStyle] = useState("shocking statistic");
  const [duration, setDuration] = useState(30);
  const [loading, setLoading] = useState(false);
  const [script, setScript] = useState<GeneratedScript | null>(null);
  const [saving, setSaving] = useState(false);

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
    toast.success(`${label} copied`);
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
              <Button variant="outline" disabled title="Video generation coming next">
                Generate video (soon)
              </Button>
            </div>
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
