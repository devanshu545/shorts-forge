import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Calendar, Loader2, Trash2, Clock } from "lucide-react";
import { toast } from "sonner";
import { createScheduledJob, deleteScheduledJob, listScheduledJobs, toggleScheduledJob } from "@/lib/scheduler.functions";

export const Route = createFileRoute("/_authenticated/schedule")({ component: SchedulePage });

function SchedulePage() {
  const qc = useQueryClient();
  const listJobs = useServerFn(listScheduledJobs);
  const createJob = useServerFn(createScheduledJob);
  const toggleJob = useServerFn(toggleScheduledJob);
  const deleteJob = useServerFn(deleteScheduledJob);
  const [form, setForm] = useState({
    name: "Daily viral short",
    niche: "",
    tone: "energetic and punchy",
    hookStyle: "shocking statistic",
    durationSeconds: 45,
    nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16),
    cadence: "once" as "once" | "daily" | "weekly",
    autoUpload: false,
  });

  const { data: jobs, isLoading } = useQuery({ queryKey: ["scheduled-jobs"], queryFn: () => listJobs() });
  const createMut = useMutation({
    mutationFn: () => createJob({ data: { ...form, nextRunAt: new Date(form.nextRunAt).toISOString() } }),
    onSuccess: () => {
      toast.success("Schedule saved");
      setForm((f) => ({ ...f, niche: "" }));
      qc.invalidateQueries({ queryKey: ["scheduled-jobs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => toggleJob({ data: { id, active } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scheduled-jobs"] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteJob({ data: { id } }),
    onSuccess: () => { toast.success("Schedule deleted"); qc.invalidateQueries({ queryKey: ["scheduled-jobs"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mx-auto grid max-w-6xl gap-6 p-6 md:p-10 lg:grid-cols-[420px_1fr]">
      <Card className="glass h-fit p-6 animate-in fade-in slide-in-from-left-2 duration-300">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-primary-glow" />
          <h1 className="font-display text-xl font-semibold">Schedule a Short</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Saved jobs run from the backend worker, not this browser tab.</p>
        <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); createMut.mutate(); }}>
          <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><Label>Topic / niche</Label><Textarea required rows={4} value={form.niche} onChange={(e) => setForm({ ...form, niche: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Tone</Label><Input value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })} /></div>
            <div><Label>Hook</Label><Input value={form.hookStyle} onChange={(e) => setForm({ ...form, hookStyle: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Duration</Label><Input type="number" min={15} max={90} value={form.durationSeconds} onChange={(e) => setForm({ ...form, durationSeconds: Number(e.target.value) || 45 })} /></div>
            <div><Label>Cadence</Label><Select value={form.cadence} onValueChange={(v: "once" | "daily" | "weekly") => setForm({ ...form, cadence: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="once">Once</SelectItem><SelectItem value="daily">Daily</SelectItem><SelectItem value="weekly">Weekly</SelectItem></SelectContent></Select></div>
          </div>
          <div><Label>Date & time</Label><Input type="datetime-local" value={form.nextRunAt} onChange={(e) => setForm({ ...form, nextRunAt: e.target.value })} /></div>
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/30 p-3">
            <div><Label>Auto-upload after generation</Label><p className="text-xs text-muted-foreground">Uses your YouTube upload permission when enabled.</p></div>
            <Switch checked={form.autoUpload} onCheckedChange={(autoUpload) => setForm({ ...form, autoUpload })} />
          </div>
          <Button className="w-full" disabled={createMut.isPending || !form.niche.trim()}>
            {createMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
            Schedule
          </Button>
        </form>
      </Card>

      <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div><h2 className="font-display text-3xl font-semibold">Scheduled jobs</h2><p className="text-sm text-muted-foreground">The worker processes due jobs hourly when configured in Supabase cron.</p></div>
        {isLoading ? <Card className="glass p-8"><Loader2 className="h-5 w-5 animate-spin" /></Card> : !jobs?.length ? (
          <Card className="glass grid place-items-center p-16 text-center"><Calendar className="h-8 w-8 text-primary-glow" /><h3 className="mt-3 font-display text-lg font-semibold">No scheduled jobs</h3><p className="mt-1 max-w-md text-sm text-muted-foreground">Create a job to save it in Postgres and let the backend worker pick it up.</p></Card>
        ) : jobs.map((job) => (
          <Card key={job.id} className="glass p-5 transition-transform duration-300 hover:scale-[1.01]">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0"><div className="flex items-center gap-2"><h3 className="font-display text-lg font-semibold">{job.name}</h3><Badge variant={job.active ? "default" : "secondary"}>{job.active ? "Active" : "Paused"}</Badge><Badge variant="outline">{job.cadence}</Badge></div><p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{job.niche}</p><p className="mt-2 text-xs text-muted-foreground">Next run: {new Date(job.next_run_at).toLocaleString()}</p></div>
              <div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => toggleMut.mutate({ id: job.id, active: !job.active })}>{job.active ? "Pause" : "Resume"}</Button><Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => deleteMut.mutate(job.id)}><Trash2 className="h-4 w-4" /></Button></div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
