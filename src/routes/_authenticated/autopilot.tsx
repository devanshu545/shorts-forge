import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Rocket, Loader2, Save, Sparkles, PlayCircle, Youtube, Download, Activity, AlertCircle, CheckCircle2, Clock, Plus, X, Palette, Hash } from "lucide-react";
import { toast } from "sonner";
import {
  getAutopilotSettings,
  saveAutopilotSettings,
  listAutopilotVideos,
  pickAutopilotTopic,
  getLatestAutopilotTestVideo,
  getAutopilotHealth,
} from "@/lib/autopilot.functions";
import {
  planCharacterShort,
  generateSceneKeyframe,
  generateSceneVoiceover,
  finalizeCharacterShort,
  failCharacterShort,
  CHARACTERS,
  VOICES,
  type CharacterPlan,
  type VoiceKey,
} from "@/lib/animation/character-short.functions";
import { saveScriptAsDraft } from "@/lib/scripts.functions";
import { generateMetadataForVideo } from "@/lib/media.functions";
import { runCharacterShortPipeline } from "@/lib/animation/pipeline";
import { SceneProgress, type SceneStep } from "@/components/SceneProgress";
import { UploadToYouTubeDialog } from "@/components/UploadToYouTubeDialog";

export const Route = createFileRoute("/_authenticated/autopilot")({ component: AutopilotPage });

const DEFAULT_TIMES = ["09:00", "13:00", "19:00"];
const WEEKDAYS = [
  { i: 0, label: "Sun" }, { i: 1, label: "Mon" }, { i: 2, label: "Tue" },
  { i: 3, label: "Wed" }, { i: 4, label: "Thu" }, { i: 5, label: "Fri" }, { i: 6, label: "Sat" },
];
const STYLE_PRESETS = [
  { key: "pixar", label: "Pixar 3D" },
  { key: "anime", label: "Ghibli Anime" },
  { key: "clay",  label: "Claymation" },
  { key: "paper", label: "Paper Cutout" },
  { key: "noir",  label: "Cinematic Noir" },
];

function AutopilotPage() {
  const qc = useQueryClient();
  const getFn = useServerFn(getAutopilotSettings);
  const saveFn = useServerFn(saveAutopilotSettings);
  const listFn = useServerFn(listAutopilotVideos);
  const pickTopicFn = useServerFn(pickAutopilotTopic);
  const latestTestFn = useServerFn(getLatestAutopilotTestVideo);
  const healthFn = useServerFn(getAutopilotHealth);

  const planFn = useServerFn(planCharacterShort);
  const saveScriptFn = useServerFn(saveScriptAsDraft);
  const keyframeFn = useServerFn(generateSceneKeyframe);
  const voFn = useServerFn(generateSceneVoiceover);
  const finalizeFn = useServerFn(finalizeCharacterShort);
  const failFn = useServerFn(failCharacterShort);
  const metaFn = useServerFn(generateMetadataForVideo);

  const { data: settings, isLoading } = useQuery({ queryKey: ["autopilot"], queryFn: () => getFn() });
  const { data: recent } = useQuery({ queryKey: ["autopilot-videos"], queryFn: () => listFn(), refetchInterval: 30000 });
  const { data: latestTest, refetch: refetchLatest } = useQuery({
    queryKey: ["autopilot-latest-test"],
    queryFn: () => latestTestFn(),
  });
  const { data: health } = useQuery({
    queryKey: ["autopilot-health"],
    queryFn: () => healthFn(),
    refetchInterval: 60000,
  });

  const [form, setForm] = useState({
    enabled: false,
    slot_times: DEFAULT_TIMES as string[],
    pause_days: [] as number[],
    characters_pool: [] as string[],
    voices_pool: [] as string[],
    style_preset: "pixar",
    hashtag_pool: [] as string[],
    auto_pause_on_failures: true,
    topic_mode: "trending" as "trending" | "niche" | "mix",
    niche: "",
    tone: "wholesome and funny",
    character_key: "ginger_cat",
    voice: "alloy",
    privacy: "public" as "public" | "unlisted" | "private",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  });

  useEffect(() => {
    if (settings) {
      const s = settings as any;
      setForm({
        enabled: s.enabled,
        slot_times: (s.slot_times && s.slot_times.length ? s.slot_times : (s.slot_hours || []).map((h: number) => `${String(h).padStart(2, "0")}:00`)) as string[],
        pause_days: s.pause_days || [],
        characters_pool: s.characters_pool || [],
        voices_pool: s.voices_pool || [],
        style_preset: s.style_preset || "pixar",
        hashtag_pool: s.hashtag_pool || [],
        auto_pause_on_failures: s.auto_pause_on_failures !== false,
        topic_mode: s.topic_mode as "trending" | "niche" | "mix",
        niche: s.niche || "",
        tone: s.tone,
        character_key: s.character_key,
        voice: s.voice,
        privacy: s.privacy as "public" | "unlisted" | "private",
        timezone: s.timezone,
      });
    }
  }, [settings]);


  const saveMut = useMutation({
    mutationFn: () => saveFn({ data: { ...form, niche: form.niche || null } }),
    onSuccess: () => { toast.success("Autopilot saved"); qc.invalidateQueries({ queryKey: ["autopilot"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  // Test flow (Step 1): generate video only, save to library, show preview
  const [testStatus, setTestStatus] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [testStage, setTestStage] = useState("");
  const [testProgress, setTestProgress] = useState(0);
  const [testScenes, setTestScenes] = useState<SceneStep[]>([]);
  const [testPlan, setTestPlan] = useState<CharacterPlan | null>(null);
  const [testVideo, setTestVideo] = useState<any | null>(latestTest ?? null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => { if (latestTest && !testVideo) setTestVideo(latestTest); }, [latestTest]);

  const runTestFlow = async () => {
    setTestStatus("running");
    setTestError(null);
    setTestPlan(null);
    setTestVideo(null);
    setTestProgress(2);
    setTestStage("Preparing autopilot topic…");
    try {
      const topicPick = await pickTopicFn();
      const result = await runCharacterShortPipeline(
        {
          characterKey: topicPick.characterKey,
          characterDescription: topicPick.characterDescription,
          topic: topicPick.storyPrompt,
          tone: topicPick.tone,
          voice: (topicPick.voice as VoiceKey) ?? "alloy",
        },
        {
          plan: planFn,
          save: saveScriptFn,
          keyframe: keyframeFn,
          voiceover: voFn,
          finalize: finalizeFn,
          fail: failFn,
          genMeta: metaFn,
        },
        {
          onStage: setTestStage,
          onProgress: setTestProgress,
          onScenes: setTestScenes,
          onPlan: setTestPlan,
          onTtsWarning: (m) => toast.warning("Narration skipped", { description: m }),
        },
      );
      setTestVideo(result.videoRow);
      setTestStatus("done");
      toast.success("Test video generated successfully! Ready for upload.");
      qc.invalidateQueries({ queryKey: ["autopilot-latest-test"] });
      qc.invalidateQueries({ queryKey: ["autopilot-videos"] });
      refetchLatest();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Generation failed";
      setTestError(msg);
      setTestStatus("failed");
      toast.error("Test flow failed", { description: msg });
    }
  };

  const updateTime = (idx: number, val: string) => {
    const arr = [...form.slot_times]; arr[idx] = val;
    setForm((f) => ({ ...f, slot_times: arr }));
  };
  const addTime = () => {
    if (form.slot_times.length >= 8) return;
    setForm((f) => ({ ...f, slot_times: [...f.slot_times, "12:00"] }));
  };
  const removeTime = (idx: number) => {
    if (form.slot_times.length <= 1) return;
    setForm((f) => ({ ...f, slot_times: f.slot_times.filter((_, i) => i !== idx) }));
  };
  const togglePauseDay = (d: number) => {
    setForm((f) => ({ ...f, pause_days: f.pause_days.includes(d) ? f.pause_days.filter((x) => x !== d) : [...f.pause_days, d] }));
  };
  const toggleInPool = (poolKey: "characters_pool" | "voices_pool", key: string) => {
    setForm((f) => ({ ...f, [poolKey]: f[poolKey].includes(key) ? f[poolKey].filter((x) => x !== key) : [...f[poolKey], key] }));
  };
  const [hashtagInput, setHashtagInput] = useState("");
  const addHashtag = () => {
    const clean = hashtagInput.trim().replace(/^#+/, "");
    if (!clean || form.hashtag_pool.includes(clean) || form.hashtag_pool.length >= 50) return;
    setForm((f) => ({ ...f, hashtag_pool: [...f.hashtag_pool, clean] }));
    setHashtagInput("");
  };

  const testRunning = testStatus === "running";
  const hasReadyTest = !!(testVideo && testVideo.video_url && !testVideo.youtube_video_id);

  // Live countdown to next scheduled slot.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const nextSlotIso = health?.upcomingSlots?.[0];
  const countdown = (() => {
    if (!nextSlotIso) return null;
    const diff = new Date(nextSlotIso).getTime() - now;
    if (diff <= 0) return "any moment now";
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    const s = Math.floor((diff % 60_000) / 1000);
    return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
  })();

  return (
    <div className="mx-auto grid max-w-6xl gap-6 p-6 md:p-10 lg:grid-cols-[440px_1fr]">
      <Card className="glass h-fit p-6">
        <div className="flex items-center gap-2">
          <Rocket className="h-5 w-5 text-primary-glow" />
          <h1 className="font-display text-xl font-semibold">Autopilot</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Auto-write, render, and upload Shorts every day — even when your laptop is off.</p>

        {isLoading ? <Loader2 className="mt-6 h-5 w-5 animate-spin" /> : (
          <form className="mt-6 space-y-5" onSubmit={(e) => { e.preventDefault(); saveMut.mutate(); }}>
            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/30 p-3 transition hover:bg-background/50">
              <div>
                <Label>Enable autopilot</Label>
                <p className="text-xs text-muted-foreground">Master switch. Renders on the server every 5 min.</p>
              </div>
              <Switch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <Label>Upload times ({form.slot_times.length}/day)</Label>
                <Button type="button" size="sm" variant="ghost" onClick={addTime} disabled={form.slot_times.length >= 8}>
                  <Plus className="h-3.5 w-3.5" /> Add
                </Button>
              </div>
              <div className="mt-2 space-y-2">
                {form.slot_times.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/30 p-2 transition hover:bg-background/50">
                    <Input type="time" value={t} onChange={(e) => updateTime(i, e.target.value)} className="flex-1" />
                    <Button type="button" size="sm" variant="ghost" onClick={() => removeTime(i)} disabled={form.slot_times.length <= 1}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {form.slot_times.length * 30} videos / month · matched within ±5 min of your local time.
              </p>
            </div>

            <div>
              <Label>Pause on days</Label>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {WEEKDAYS.map((d) => {
                  const on = form.pause_days.includes(d.i);
                  return (
                    <button type="button" key={d.i} onClick={() => togglePauseDay(d.i)}
                      className={`rounded-full border px-3 py-1 text-xs transition ${on ? "border-destructive/50 bg-destructive/20 text-destructive-foreground" : "border-border/60 bg-background/30 hover:bg-background/60"}`}>
                      {d.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Selected days will be skipped.</p>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/30 p-3">
              <div>
                <Label>Auto-pause after 3 failures</Label>
                <p className="text-xs text-muted-foreground">Prevents credit waste on repeated errors.</p>
              </div>
              <Switch checked={form.auto_pause_on_failures} onCheckedChange={(v) => setForm({ ...form, auto_pause_on_failures: v })} />
            </div>

            <div>
              <Label>Timezone</Label>
              <Input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
            </div>

            <div>
              <Label>Topic source</Label>
              <Select value={form.topic_mode} onValueChange={(v: "trending" | "niche" | "mix") => setForm({ ...form, topic_mode: v })}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="trending">🔥 Trending (Google Trends)</SelectItem>
                  <SelectItem value="niche">My niche only</SelectItem>
                  <SelectItem value="mix">Mix trending + my niche</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.topic_mode !== "trending" && (
              <div>
                <Label>Your niche</Label>
                <Textarea rows={3} value={form.niche} onChange={(e) => setForm({ ...form, niche: e.target.value })} placeholder="e.g. tiny animals learning big lessons" />
              </div>
            )}

            <div>
              <Label className="flex items-center gap-1.5"><Palette className="h-3.5 w-3.5" /> Visual style</Label>
              <Select value={form.style_preset} onValueChange={(v) => setForm({ ...form, style_preset: v })}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STYLE_PRESETS.map((p) => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Default character</Label>
                <Select value={form.character_key} onValueChange={(v) => setForm({ ...form, character_key: v })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.keys(CHARACTERS).map((k) => <SelectItem key={k} value={k}>{k.replace(/_/g, " ")}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Default voice</Label>
                <Select value={form.voice} onValueChange={(v) => setForm({ ...form, voice: v })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VOICES.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label>Rotate multiple characters (optional)</Label>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.keys(CHARACTERS).map((k) => {
                  const on = form.characters_pool.includes(k);
                  return (
                    <button type="button" key={k} onClick={() => toggleInPool("characters_pool", k)}
                      className={`rounded-full border px-3 py-1 text-xs transition ${on ? "border-primary/50 bg-primary/20 text-primary-foreground" : "border-border/60 bg-background/30 hover:bg-background/60"}`}>
                      {k.replace(/_/g, " ")}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">If any selected, autopilot rotates through them. Empty = use default character.</p>
            </div>

            <div>
              <Label>Rotate multiple voices (optional)</Label>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {VOICES.map((v) => {
                  const on = form.voices_pool.includes(v);
                  return (
                    <button type="button" key={v} onClick={() => toggleInPool("voices_pool", v)}
                      className={`rounded-full border px-3 py-1 text-xs transition ${on ? "border-primary/50 bg-primary/20 text-primary-foreground" : "border-border/60 bg-background/30 hover:bg-background/60"}`}>
                      {v}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <Label className="flex items-center gap-1.5"><Hash className="h-3.5 w-3.5" /> Hashtag pool (rotator)</Label>
              <div className="mt-2 flex gap-2">
                <Input value={hashtagInput} onChange={(e) => setHashtagInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addHashtag(); } }}
                  placeholder="viralshorts (no #)" />
                <Button type="button" variant="secondary" onClick={addHashtag} disabled={!hashtagInput.trim()}>Add</Button>
              </div>
              {form.hashtag_pool.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {form.hashtag_pool.map((h) => (
                    <button type="button" key={h} onClick={() => setForm((f) => ({ ...f, hashtag_pool: f.hashtag_pool.filter((x) => x !== h) }))}
                      className="rounded-full border border-border/60 bg-background/40 px-3 py-1 text-xs hover:border-destructive/50 hover:bg-destructive/10">
                      #{h} <X className="ml-1 inline h-3 w-3" />
                    </button>
                  ))}
                </div>
              )}
              <p className="mt-1 text-xs text-muted-foreground">3 random hashtags from the pool are merged into every upload.</p>
            </div>

            <div>
              <Label>Tone</Label>
              <Input value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })} />
            </div>



            <div>
              <Label>YouTube privacy</Label>
              <Select value={form.privacy} onValueChange={(v: "public" | "unlisted" | "private") => setForm({ ...form, privacy: v })}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">Public</SelectItem>
                  <SelectItem value="unlisted">Unlisted</SelectItem>
                  <SelectItem value="private">Private</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button type="submit" className="w-full" disabled={saveMut.isPending}>
              {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Apply
            </Button>
          </form>
        )}
      </Card>

      <div className="space-y-4">
        {/* Autopilot Health */}
        <Card className="glass p-6">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary-glow" />
            <h2 className="font-display text-lg font-semibold">Autopilot Health</h2>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-background/40 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {health?.heartbeat?.stale ? <AlertCircle className="h-3.5 w-3.5 text-destructive" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
                GitHub cron heartbeat
              </div>
              <div className="mt-1 text-sm font-medium">
                {health?.heartbeat?.lastPing
                  ? `${health.heartbeat.ageMinutes}m ago`
                  : "Never pinged yet"}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {health?.heartbeat?.stale
                  ? "No ping in 2h+. Check GitHub Actions is enabled."
                  : "GitHub worker is alive."}
              </div>
            </div>
            <div className="rounded-lg border border-border/60 bg-background/40 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {health?.youtube?.connected ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <AlertCircle className="h-3.5 w-3.5 text-destructive" />}
                YouTube channel
              </div>
              <div className="mt-1 truncate text-sm font-medium">
                {health?.youtube?.connected ? (health.youtube.channelTitle || "Connected") : "Not connected"}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {health?.youtube?.connected ? "Ready to upload." : "Open the Channel tab and reconnect."}
              </div>
            </div>
            <div className="rounded-lg border border-border/60 bg-background/40 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Youtube className="h-3.5 w-3.5 text-primary-glow" /> Last upload
              </div>
              <div className="mt-1 truncate text-sm font-medium">
                {health?.lastUpload ? new Date(health.lastUpload.created_at).toLocaleString() : "None yet"}
              </div>
              {health?.lastUpload?.youtube_video_id && (
                <a
                  href={`https://youtube.com/shorts/${health.lastUpload.youtube_video_id}`}
                  target="_blank" rel="noreferrer"
                  className="text-[11px] text-primary-glow underline"
                >Open on YouTube</a>
              )}
            </div>
          </div>

          <div className="mt-4">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Clock className="h-3.5 w-3.5" /> Next scheduled slots
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {health?.upcomingSlots?.length
                ? health.upcomingSlots.map((iso) => (
                    <Badge key={iso} variant="secondary">{new Date(iso).toLocaleString()}</Badge>
                  ))
                : <span className="text-xs text-muted-foreground">Turn on Autopilot to see upcoming slots.</span>}
            </div>
          </div>

          <div className="mt-4">
            <div className="text-xs font-medium text-muted-foreground">Last 5 autopilot runs</div>
            {!health?.recentRuns?.length ? (
              <p className="mt-2 text-xs text-muted-foreground">No autopilot runs yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {health.recentRuns.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/30 p-2 text-xs">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{r.title || "(untitled)"}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {r.autopilot_slot ? new Date(r.autopilot_slot).toLocaleString() : ""}
                        {r.error_message ? ` · ${r.error_message.slice(0, 80)}` : ""}
                      </div>
                    </div>
                    <Badge variant={r.youtube_video_id ? "default" : r.status === "failed" ? "destructive" : "secondary"}>
                      {r.youtube_video_id ? "uploaded" : r.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        {/* Two-step workflow */}
        <Card className="glass p-6">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary-glow" />
            <h2 className="font-display text-lg font-semibold">Two-step workflow</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Step 1 generates ONE test short (script + scenes + voiceover) into your library so you can preview it.
            Step 2 uploads that same test short to YouTube — only when you say so.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
              <div className="flex items-center gap-2 text-sm font-medium"><PlayCircle className="h-4 w-4 text-primary-glow" /> Step 1 — Test Flow</div>
              <p className="mt-1 text-xs text-muted-foreground">Generate video only. No upload.</p>
              <Button className="mt-3 w-full" onClick={runTestFlow} disabled={testRunning}>
                {testRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
                {testRunning ? "Generating…" : "Test Flow"}
              </Button>
            </div>
            <div className="rounded-lg border border-border/60 bg-background/30 p-4">
              <div className="flex items-center gap-2 text-sm font-medium"><Youtube className="h-4 w-4 text-primary-glow" /> Step 2 — Run Workflow</div>
              <p className="mt-1 text-xs text-muted-foreground">Upload the test short to YouTube.</p>
              {hasReadyTest ? (
                <UploadToYouTubeDialog
                  video={testVideo}
                  onUploaded={() => {
                    qc.invalidateQueries({ queryKey: ["autopilot-latest-test"] });
                    qc.invalidateQueries({ queryKey: ["autopilot-videos"] });
                    refetchLatest();
                  }}
                >
                  <Button className="mt-3 w-full" variant="secondary">
                    <Youtube className="h-4 w-4" /> Run Workflow
                  </Button>
                </UploadToYouTubeDialog>
              ) : (
                <Button className="mt-3 w-full" variant="secondary" disabled>
                  <Youtube className="h-4 w-4" /> Run Workflow
                </Button>
              )}
              {!hasReadyTest && (
                <p className="mt-2 text-xs text-muted-foreground">Generate a test video first.</p>
              )}
            </div>
          </div>

          {testStatus !== "idle" && (
            <div className="mt-5 rounded-lg border border-border/60 bg-background/40 p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{testPlan?.title ?? "Generating test short…"}</p>
                  <p className="text-xs text-muted-foreground">{testStage}</p>
                </div>
                <Badge variant={testStatus === "failed" ? "destructive" : testStatus === "done" ? "default" : "secondary"}>
                  {testStatus === "done" ? "Test video generated successfully!" : testStatus}
                </Badge>
              </div>
              {testRunning && <Progress value={testProgress} className="mb-3" />}
              {testScenes.length > 0 && <SceneProgress scenes={testScenes} />}
              {testError && (
                <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
                  <p className="font-medium">Something went wrong</p>
                  <p className="mt-1 text-muted-foreground">{testError}</p>
                </div>
              )}
            </div>
          )}

          {testVideo?.video_url && (
            <div className="mt-5 grid gap-4 rounded-lg border border-border/60 bg-background/40 p-4 md:grid-cols-[220px_1fr]">
              <video src={testVideo.video_url} controls className="aspect-[9/16] w-full rounded-lg border border-border object-cover bg-black" />
              <div className="space-y-2">
                <p className="font-display text-base font-semibold">{testVideo.title}</p>
                <p className="whitespace-pre-wrap text-xs text-muted-foreground">{testVideo.description}</p>
                <div className="flex flex-wrap gap-2 pt-2">
                  <a href={testVideo.video_url} download className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs hover:bg-accent">
                    <Download className="h-3.5 w-3.5" /> Download
                  </a>
                  {testVideo.youtube_video_id ? (
                    <a href={`https://www.youtube.com/watch?v=${testVideo.youtube_video_id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-primary-glow hover:bg-primary/20">
                      <Youtube className="h-3.5 w-3.5" /> View on YouTube
                    </a>
                  ) : (
                    <UploadToYouTubeDialog
                      video={testVideo}
                      onUploaded={() => {
                        qc.invalidateQueries({ queryKey: ["autopilot-latest-test"] });
                        refetchLatest();
                      }}
                    >
                      <Button size="sm"><Youtube className="h-3.5 w-3.5" /> Upload to YouTube</Button>
                    </UploadToYouTubeDialog>
                  )}
                </div>
              </div>
            </div>
          )}
        </Card>

        <Card className="glass p-6">
          <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary-glow" /><h2 className="font-display text-lg font-semibold">Hands-off daily uploads (GitHub worker)</h2></div>
          <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li>1. Connect your GitHub repo to this project (Plus menu → GitHub).</li>
            <li>2. In GitHub → Settings → Secrets → Actions, add only <code className="rounded bg-muted px-1">APP_BASE_URL</code> (your published URL). The workflow now authenticates itself automatically.</li>
            <li>3. For testing: click Test Flow here first, then run the GitHub workflow with <code className="rounded bg-muted px-1">force_test=true</code>. It uploads that ready preview video only.</li>
            <li>4. For automation: turn on Autopilot and hit Apply. The workflow runs hourly and renders + uploads any Shorts whose scheduled slot just passed.</li>
          </ol>
        </Card>

        <Card className="glass p-6">
          <h2 className="font-display text-lg font-semibold">Recent autopilot uploads</h2>
          {!recent?.length ? (
            <p className="mt-3 text-sm text-muted-foreground">Nothing yet. Once a slot passes and the worker runs, videos will appear here.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {recent.map((v: any) => (
                <li key={v.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/40 p-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{v.title}</div>
                    <div className="text-xs text-muted-foreground">{v.autopilot_slot ? new Date(v.autopilot_slot).toLocaleString() : ""}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={v.status === "ready" ? "default" : v.status === "failed" ? "destructive" : "secondary"}>{v.status}</Badge>
                    {v.youtube_video_id && <a className="text-xs text-primary-glow underline" href={`https://youtube.com/shorts/${v.youtube_video_id}`} target="_blank" rel="noreferrer">Open</a>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
