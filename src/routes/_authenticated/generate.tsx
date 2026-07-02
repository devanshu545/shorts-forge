import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  planCharacterShort,
  generateSceneKeyframe,
  generateSceneVoiceover,
  finalizeCharacterShort,
  failCharacterShort,
  CHARACTERS,
  VOICES,
  type CharacterKey,
  type CharacterPlan,
  type VoiceKey,
} from "@/lib/animation/character-short.functions";
import { saveScriptAsDraft } from "@/lib/scripts.functions";
import { generateMetadataForVideo } from "@/lib/media.functions";
import { stitchClips, extForMime } from "@/lib/animation/stitcher";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { UploadToYouTubeDialog } from "@/components/UploadToYouTubeDialog";
import { CharacterPicker, CHARACTER_OPTIONS } from "@/components/CharacterPicker";
import { SceneProgress, type SceneStep } from "@/components/SceneProgress";
import { Loader2, Wand2, Sparkles, Download, Youtube } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/generate")({
  component: GeneratePage,
});

const TONES = ["wholesome", "funny", "adventurous", "cozy", "mysterious"] as const;

function GeneratePage() {
  const navigate = useNavigate();
  const plan = useServerFn(planCharacterShort);
  const save = useServerFn(saveScriptAsDraft);
  const keyframe = useServerFn(generateSceneKeyframe);
  const voiceover = useServerFn(generateSceneVoiceover);
  const finalize = useServerFn(finalizeCharacterShort);
  const fail = useServerFn(failCharacterShort);
  const genMeta = useServerFn(generateMetadataForVideo);

  const [characterKey, setCharacterKey] = useState<string>("ginger_cat");
  const [customCharacter, setCustomCharacter] = useState("");
  const [topic, setTopic] = useState("goes fishing at a sunny pond, catches a fish, brings it home and cooks it");
  const [tone, setTone] = useState<(typeof TONES)[number]>("wholesome");
  const [voice, setVoice] = useState<VoiceKey>("alloy");

  const [status, setStatus] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [scenes, setScenes] = useState<SceneStep[]>([]);
  const [videoRow, setVideoRow] = useState<any | null>(null);
  const [currentPlan, setCurrentPlan] = useState<CharacterPlan | null>(null);

  const resolveCharacter = (): string => {
    if (characterKey === "custom") return customCharacter.trim();
    return CHARACTERS[characterKey as CharacterKey] ?? "";
  };

  const run = async () => {
    const character = resolveCharacter();
    if (!character) {
      toast.error("Describe your custom character first.");
      return;
    }
    if (!topic.trim()) {
      toast.error("What is your character doing?");
      return;
    }
    setStatus("running");
    setError(null);
    setVideoRow(null);
    setCurrentPlan(null);
    setScenes([1, 2, 3, 4].map((n) => ({ order: n, label: `Scene ${n}`, status: "pending" })));
    setProgress(2);
    setStage("Planning your short with Lovable AI…");

    let videoId: string | null = null;
    try {
      // 1. Plan
      const { plan: planned } = await plan({
        data: {
          characterKey,
          characterDescription: character,
          topic: topic.trim(),
          tone,
        },
      });
      setCurrentPlan(planned);

      // 2. Save draft row
      setStage("Saving draft…");
      setProgress(8);
      const scriptPayload = {
        title: planned.title,
        hook: planned.hook,
        scenes: planned.scenes.map((s) => ({
          order: s.order,
          visualPrompt: `${s.setting}. ${s.action}. ${s.cameraShot}. ${s.mood}. (${s.emotion})`,
          voiceover: s.voiceover,
          onScreenText: "",
          durationSeconds: s.durationSeconds,
        })),
        fullVoiceover: planned.scenes.map((s) => s.voiceover).join(" "),
        description: planned.description,
        hashtags: planned.hashtags,
        seoKeywords: planned.hashtags.map((h) => h.replace(/^#/, "").toLowerCase()),
      };
      const draft = await save({ data: { script: scriptPayload, durationSeconds: 22 } });
      videoId = draft.id;
      setVideoRow({ id: draft.id, title: planned.title, description: planned.description });

      // Prime scene tiles with the emotion labels
      setScenes(
        planned.scenes.map((b) => ({
          order: b.order,
          label: `Scene ${b.order}`,
          status: "pending",
          emotion: b.emotion,
        })),
      );

      // 3. Per-scene keyframe (Pollinations — free) + voiceover (Lovable AI TTS)
      const stitchInput: { imageUrl: string; audioUrl?: string; order: number }[] = [];
      let ttsWarning: string | null = null;

      for (const beat of planned.scenes) {
        setScenes((prev) => prev.map((s) => (s.order === beat.order ? { ...s, status: "keyframe" } : s)));
        setStage(`Scene ${beat.order} — painting (feeling: ${beat.emotion})…`);
        setProgress(10 + (beat.order - 1) * 12);
        const kf = await keyframe({
          data: {
            videoId: draft.id,
            sceneOrder: beat.order,
            characterDescription: character,
            setting: beat.setting,
            action: beat.action,
            cameraShot: beat.cameraShot,
            emotion: beat.emotion,
          },
        });
        setScenes((prev) =>
          prev.map((s) => (s.order === beat.order ? { ...s, thumbUrl: kf.url, status: "voiceover" } : s)),
        );

        // Voiceover — soft-fail so a TTS credit issue doesn't lose the whole video
        let audioUrl: string | undefined;
        try {
          setStage(`Scene ${beat.order} — recording narration…`);
          setProgress(14 + (beat.order - 1) * 12);
          const vo = await voiceover({
            data: {
              videoId: draft.id,
              sceneOrder: beat.order,
              text: beat.voiceover,
              voice,
            },
          });
          audioUrl = vo.url;
        } catch (voErr) {
          if (!ttsWarning) ttsWarning = voErr instanceof Error ? voErr.message : String(voErr);
        }

        stitchInput.push({ imageUrl: kf.url, audioUrl, order: beat.order });
        setScenes((prev) =>
          prev.map((s) =>
            s.order === beat.order ? { ...s, thumbUrl: kf.url, audioUrl, status: "done" } : s,
          ),
        );
      }

      if (ttsWarning) {
        toast.warning("Narration skipped", {
          description: `${ttsWarning}. Video will render without voiceover.`,
        });
      }

      // 4. Client-side stitch (narration + Ken Burns + persistent SUBSCRIBE + end card)
      setStage("Stitching narrated video…");
      setProgress(65);
      const { blob, durationSeconds } = await stitchClips({
        scenes: stitchInput,
        ctaTop: planned.cta.top,
        ctaBottom: planned.cta.bottom,
        onProgress: (p, s) => {
          setProgress(p);
          setStage(s);
        },
      });

      // 5. Upload final
      setStage("Uploading to your library…");
      setProgress(96);
      const { data: userRes } = await supabase.auth.getUser();
      const uid = userRes.user?.id;
      if (!uid) throw new Error("Not signed in");
      const ext = extForMime(blob.type);
      const path = `${uid}/${draft.id}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("videos")
        .upload(path, blob, { contentType: blob.type, upsert: true });
      if (upErr) throw upErr;
      const { data: signed } = await supabase.storage.from("videos").createSignedUrl(path, 60 * 60 * 24 * 7);
      if (!signed?.signedUrl) throw new Error("Could not sign final URL");

      await finalize({
        data: {
          videoId: draft.id,
          storagePath: path,
          signedUrl: signed.signedUrl,
          fileSize: blob.size,
          durationSeconds,
        },
      });

      genMeta({ data: { videoId: draft.id, script: scriptPayload } }).catch(() => {});

      const { data: row } = await supabase.from("videos").select("*").eq("id", draft.id).single();
      setVideoRow(row);
      setStatus("done");
      setStage("Video ready! 🎉");
      setProgress(100);
      toast.success("Your short is ready!");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Generation failed";
      setError(message);
      setStatus("failed");
      setScenes((prev) => prev.map((s) => (s.status === "keyframe" || s.status === "voiceover" ? { ...s, status: "failed" } : s)));
      if (videoId) {
        try {
          await fail({ data: { videoId, message } });
        } catch { /* ignore */ }
      }
      toast.error("Generation failed", { description: message });
    }
  };

  const busy = status === "running";
  const currentChar = CHARACTER_OPTIONS.find((c) => c.key === characterKey);

  return (
    <div className="mx-auto grid max-w-6xl gap-6 p-6 md:p-10 lg:grid-cols-[380px_1fr]">
      <Card className="glass h-fit p-6">
        <div className="flex items-center gap-2">
          <Wand2 className="h-5 w-5 text-primary-glow" />
          <h2 className="font-display text-lg font-semibold">New short</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a character, describe the story. AI writes the plan, generates 4 Pixar-style scenes, and stitches them with a SUBSCRIBE overlay.
        </p>

        <div className="mt-5 space-y-4">
          <div>
            <Label>Character</Label>
            <div className="mt-1.5"><CharacterPicker value={characterKey} onChange={setCharacterKey} /></div>
          </div>

          {characterKey === "custom" && (
            <div>
              <Label htmlFor="custom">Describe your character</Label>
              <Textarea
                id="custom"
                rows={3}
                placeholder="e.g. a chubby grey kitten with huge blue eyes wearing a red bow…"
                value={customCharacter}
                onChange={(e) => setCustomCharacter(e.target.value)}
                className="mt-1.5"
              />
              <p className="mt-1 text-xs text-muted-foreground">Include colors, size, clothing/accessories. More detail = more consistency across scenes.</p>
            </div>
          )}

          <div>
            <Label htmlFor="topic">What is {currentChar?.label ?? "your character"} doing?</Label>
            <Textarea
              id="topic"
              rows={3}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="mt-1.5"
              placeholder="e.g. opens a lemonade stand, sells to forest animals, ends the day tired but happy"
            />
          </div>

          <div>
            <Label>Tone</Label>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {TONES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTone(t)}
                  className={`rounded-full border px-3 py-1 text-xs capitalize transition-all ${tone === t ? "border-primary bg-primary/15 text-primary-glow" : "border-border/60 bg-surface/40 hover:border-border"}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label>Narrator voice</Label>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {VOICES.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVoice(v)}
                  className={`rounded-full border px-3 py-1 text-xs capitalize transition-all ${voice === v ? "border-primary bg-primary/15 text-primary-glow" : "border-border/60 bg-surface/40 hover:border-border"}`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          <Button onClick={run} className="w-full" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {busy ? "Generating…" : "Generate narrated short (~2 min)"}
          </Button>
          <p className="text-xs text-muted-foreground">
            100% free: Lovable AI writes the story + narrates it, Pollinations paints the 4 emotion-matched scenes, your browser mixes it all into a narrated video with a persistent SUBSCRIBE watermark and end card. Keep this tab open while it renders.
          </p>
        </div>
      </Card>

      <div className="space-y-4">
        {status === "idle" && (
          <Card className="glass grid place-items-center p-16 text-center">
            <Wand2 className="h-8 w-8 text-primary-glow" />
            <h3 className="mt-3 font-display text-lg font-semibold">Ready when you are</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Pick a character, describe the story, hit Generate. You'll see the 4 scenes appear as they render.
            </p>
          </Card>
        )}

        {status !== "idle" && (
          <Card className="glass p-6">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-lg font-semibold">{currentPlan?.title ?? "Generating…"}</h3>
                <p className="text-sm text-muted-foreground">{stage}</p>
              </div>
              <Badge variant={status === "failed" ? "destructive" : "default"}>{status}</Badge>
            </div>
            {busy && <Progress value={progress} className="mb-4" />}
            <SceneProgress scenes={scenes} />
            {error && (
              <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
                <p className="font-medium">Something went wrong</p>
                <p className="mt-1 text-muted-foreground">{error}</p>
                <Button className="mt-3" size="sm" onClick={run}>Retry</Button>
              </div>
            )}
          </Card>
        )}

        {videoRow?.video_url && (
          <Card className="glass p-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="grid gap-4 md:grid-cols-[280px_1fr]">
              <video
                src={videoRow.video_url}
                controls
                className="aspect-[9/16] w-full rounded-xl border border-border object-cover bg-black"
              />
              <div className="space-y-3">
                <p className="font-display text-lg font-semibold">{videoRow.title}</p>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{videoRow.description}</p>
                <div className="flex flex-wrap gap-2 pt-2">
                  <a
                    href={videoRow.video_url}
                    download
                    className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
                  >
                    <Download className="h-4 w-4" /> Download
                  </a>
                  <UploadToYouTubeDialog video={videoRow}>
                    <Button>
                      <Youtube className="h-4 w-4" />Upload to YouTube
                    </Button>
                  </UploadToYouTubeDialog>
                  <Button variant="outline" onClick={() => navigate({ to: "/library" })}>Open library</Button>
                </div>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
