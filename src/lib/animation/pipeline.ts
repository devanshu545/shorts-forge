// Reusable client-side "generate one narrated animated short" pipeline.
// Runs entirely in the browser (heavy stitching happens via MediaRecorder),
// but talks to the same server fns as the /generate route so both stay in sync.

import {
  planCharacterShort,
  generateSceneKeyframe,
  generateSceneVoiceover,
  finalizeCharacterShort,
  failCharacterShort,
  type CharacterPlan,
  type VoiceKey,
} from "@/lib/animation/character-short.functions";
import { saveScriptAsDraft } from "@/lib/scripts.functions";
import { generateMetadataForVideo } from "@/lib/media.functions";
import { stitchClips, extForMime } from "@/lib/animation/stitcher";
import { supabase } from "@/integrations/supabase/client";
import type { SceneStep } from "@/components/SceneProgress";

export type PipelineInput = {
  characterKey: string;
  characterDescription: string;
  topic: string;
  tone: string;
  voice: VoiceKey;
};

export type PipelineCallbacks = {
  onStage?: (stage: string) => void;
  onProgress?: (progress: number) => void;
  onScenes?: (scenes: SceneStep[]) => void;
  onPlan?: (plan: CharacterPlan) => void;
  onDraft?: (videoRow: { id: string; title: string; description: string }) => void;
  onTtsWarning?: (message: string) => void;
};

export type PipelineResult = { videoId: string; videoRow: any };

type ServerFn<TInput, TOutput> = (opts: { data: TInput }) => Promise<TOutput>;

export type PipelineServerFns = {
  plan: ServerFn<Parameters<typeof planCharacterShort>[0]["data"], { plan: CharacterPlan }>;
  save: ServerFn<Parameters<typeof saveScriptAsDraft>[0]["data"], { id: string }>;
  keyframe: ServerFn<Parameters<typeof generateSceneKeyframe>[0]["data"], { url: string }>;
  voiceover: ServerFn<Parameters<typeof generateSceneVoiceover>[0]["data"], { url: string }>;
  finalize: ServerFn<Parameters<typeof finalizeCharacterShort>[0]["data"], unknown>;
  fail: ServerFn<Parameters<typeof failCharacterShort>[0]["data"], unknown>;
  genMeta: ServerFn<Parameters<typeof generateMetadataForVideo>[0]["data"], unknown>;
};

export async function runCharacterShortPipeline(
  input: PipelineInput,
  fns: PipelineServerFns,
  cb: PipelineCallbacks = {},
): Promise<PipelineResult> {
  const setStage = (s: string) => cb.onStage?.(s);
  const setProgress = (p: number) => cb.onProgress?.(p);
  const setScenes = (s: SceneStep[]) => cb.onScenes?.(s);

  setStage("Planning your short with Lovable AI…");
  setProgress(2);
  setScenes([1, 2, 3, 4].map((n) => ({ order: n, label: `Scene ${n}`, status: "pending" })));

  let videoId: string | null = null;
  try {
    const { plan: planned } = await fns.plan({
      data: {
        characterKey: input.characterKey,
        characterDescription: input.characterDescription,
        topic: input.topic,
        tone: input.tone,
      },
    });
    cb.onPlan?.(planned);

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
    const draft = await fns.save({ data: { script: scriptPayload, durationSeconds: 22 } });
    videoId = draft.id;
    cb.onDraft?.({ id: draft.id, title: planned.title, description: planned.description });

    let currentScenes: SceneStep[] = planned.scenes.map((b) => ({
      order: b.order,
      label: `Scene ${b.order}`,
      status: "pending" as const,
      emotion: b.emotion,
    }));
    setScenes(currentScenes);

    const patchScene = (order: number, patch: Partial<SceneStep>) => {
      currentScenes = currentScenes.map((s) => (s.order === order ? { ...s, ...patch } : s));
      setScenes(currentScenes);
    };

    const stitchInput: { imageUrl: string; audioUrl?: string; order: number }[] = [];
    let ttsWarning: string | null = null;

    for (const beat of planned.scenes) {
      patchScene(beat.order, { status: "keyframe" });
      setStage(`Scene ${beat.order} — painting (feeling: ${beat.emotion})…`);
      setProgress(10 + (beat.order - 1) * 12);
      const kf = await fns.keyframe({
        data: {
          videoId: draft.id,
          sceneOrder: beat.order,
          characterDescription: input.characterDescription,
          setting: beat.setting,
          action: beat.action,
          cameraShot: beat.cameraShot,
          emotion: beat.emotion,
        },
      });
      patchScene(beat.order, { thumbUrl: kf.url, status: "voiceover" });

      let audioUrl: string | undefined;
      try {
        setStage(`Scene ${beat.order} — recording narration…`);
        setProgress(14 + (beat.order - 1) * 12);
        const vo = await fns.voiceover({
          data: {
            videoId: draft.id,
            sceneOrder: beat.order,
            text: beat.voiceover,
            voice: input.voice,
          },
        });
        audioUrl = vo.url;
      } catch (voErr) {
        if (!ttsWarning) ttsWarning = voErr instanceof Error ? voErr.message : String(voErr);
      }

      stitchInput.push({ imageUrl: kf.url, audioUrl, order: beat.order });
      patchScene(beat.order, { thumbUrl: kf.url, audioUrl, status: "done" });
    }

    if (ttsWarning) cb.onTtsWarning?.(ttsWarning);

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

    await fns.finalize({
      data: {
        videoId: draft.id,
        storagePath: path,
        signedUrl: signed.signedUrl,
        fileSize: blob.size,
        durationSeconds,
      },
    });

    fns.genMeta({ data: { videoId: draft.id, script: scriptPayload } }).catch(() => {});

    const { data: row } = await supabase.from("videos").select("*").eq("id", draft.id).single();
    setStage("Video ready! 🎉");
    setProgress(100);
    return { videoId: draft.id, videoRow: row };
  } catch (err) {
    if (videoId) {
      try {
        await fns.fail({
          data: { videoId, message: err instanceof Error ? err.message : "Generation failed" },
        });
      } catch { /* ignore */ }
    }
    throw err;
  }
}
