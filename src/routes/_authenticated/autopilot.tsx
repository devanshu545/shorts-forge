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
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Rocket, Loader2, Save, Sparkles, PlayCircle } from "lucide-react";
import { toast } from "sonner";
import { getAutopilotSettings, saveAutopilotSettings, listAutopilotVideos, runAutopilotTestNow } from "@/lib/autopilot.functions";
import { CHARACTERS, VOICES } from "@/lib/animation/character-short.functions";


export const Route = createFileRoute("/_authenticated/autopilot")({ component: AutopilotPage });

const DEFAULT_SLOTS = [9, 13, 19];

function AutopilotPage() {
  const qc = useQueryClient();
  const getFn = useServerFn(getAutopilotSettings);
  const saveFn = useServerFn(saveAutopilotSettings);
  const listFn = useServerFn(listAutopilotVideos);

  const { data: settings, isLoading } = useQuery({ queryKey: ["autopilot"], queryFn: () => getFn() });
  const { data: recent } = useQuery({ queryKey: ["autopilot-videos"], queryFn: () => listFn(), refetchInterval: 30000 });

  const [form, setForm] = useState({
    enabled: false,
    videos_per_day: 3,
    slot_hours: DEFAULT_SLOTS,
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
      setForm({
        enabled: settings.enabled,
        videos_per_day: settings.videos_per_day,
        slot_hours: settings.slot_hours,
        topic_mode: settings.topic_mode as "trending" | "niche" | "mix",
        niche: settings.niche || "",
        tone: settings.tone,
        character_key: settings.character_key,
        voice: settings.voice,
        privacy: settings.privacy as "public" | "unlisted" | "private",
        timezone: settings.timezone,
      });
    }
  }, [settings]);

  const saveMut = useMutation({
    mutationFn: () => saveFn({ data: { ...form, niche: form.niche || null } }),
    onSuccess: () => { toast.success("Autopilot saved"); qc.invalidateQueries({ queryKey: ["autopilot"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const setSlot = (idx: number, val: number) => {
    const arr = [...form.slot_hours];
    arr[idx] = Math.max(0, Math.min(23, val));
    setForm((f) => ({ ...f, slot_hours: arr }));
  };

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
            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/30 p-3">
              <div>
                <Label>Enable autopilot</Label>
                <p className="text-xs text-muted-foreground">Master switch. Runs hourly on the server.</p>
              </div>
              <Switch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />
            </div>

            <div>
              <Label>Videos per day: {form.videos_per_day}</Label>
              <Slider
                min={1} max={5} step={1}
                value={[form.videos_per_day]}
                onValueChange={([v]) => {
                  const slots = form.slot_hours.slice(0, v);
                  while (slots.length < v) slots.push(DEFAULT_SLOTS[slots.length] ?? 12 + slots.length);
                  setForm({ ...form, videos_per_day: v, slot_hours: slots });
                }}
                className="mt-3"
              />
              <p className="mt-2 text-xs text-muted-foreground">30 days × {form.videos_per_day} = {form.videos_per_day * 30} videos / month.</p>
            </div>

            <div>
              <Label>Upload times (hour of day, your local time)</Label>
              <div className="mt-2 grid grid-cols-5 gap-2">
                {Array.from({ length: form.videos_per_day }).map((_, i) => (
                  <Input key={i} type="number" min={0} max={23} value={form.slot_hours[i] ?? 12} onChange={(e) => setSlot(i, Number(e.target.value))} />
                ))}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Best Shorts times: 9, 13, 19.</p>
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

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Character</Label>
                <Select value={form.character_key} onValueChange={(v) => setForm({ ...form, character_key: v })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.keys(CHARACTERS).map((k) => <SelectItem key={k} value={k}>{k.replace(/_/g, " ")}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Voice</Label>
                <Select value={form.voice} onValueChange={(v) => setForm({ ...form, voice: v })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VOICES.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
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
        <Card className="glass p-6">
          <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary-glow" /><h2 className="font-display text-lg font-semibold">How to turn on hands-off uploads</h2></div>
          <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li>1. Connect your GitHub repo to this project (Plus menu → GitHub).</li>
            <li>2. In GitHub → Settings → Secrets → Actions, add <code className="rounded bg-muted px-1">AUTOPILOT_SECRET</code> (value below) and <code className="rounded bg-muted px-1">APP_BASE_URL</code> (your published URL).</li>
            <li>3. Enable GitHub Actions on the repo. The <code className="rounded bg-muted px-1">.github/workflows/autopilot.yml</code> workflow runs every hour and renders + uploads any Shorts whose scheduled slot has just passed.</li>
            <li>4. Turn on the Autopilot switch above and hit Apply.</li>
          </ol>
          <div className="mt-3 rounded-lg border border-border/60 bg-background/40 p-3 text-xs">
            <div className="font-medium">AUTOPILOT_SECRET</div>
            <div className="mt-1 text-muted-foreground">Stored in your Lovable Cloud secrets. Copy the same value into your GitHub secret — I can't display it here for safety, so open the Backend view → Secrets to copy it.</div>
          </div>
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
