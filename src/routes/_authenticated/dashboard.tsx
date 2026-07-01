import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Youtube, Video, Wand2, Sparkles, Play } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

const overviewQuery = queryOptions({
  queryKey: ["dashboard-overview"],
  queryFn: async () => {
    const [{ data: user }, videos, connection] = await Promise.all([
      supabase.auth.getUser(),
      supabase.from("videos").select("id,title,status,thumbnail_url,duration_seconds,created_at").order("created_at", { ascending: false }).limit(6),
      supabase.from("youtube_channel_info").select("*").maybeSingle(),
    ]);
    const { count } = await supabase.from("videos").select("*", { count: "exact", head: true });
    return {
      user: user.user,
      recent: videos.data ?? [],
      totalVideos: count ?? 0,
      channel: connection.data,
    };
  },
});

function Dashboard() {
  const { data } = useSuspenseQuery(overviewQuery);
  const displayName = data.user?.user_metadata?.full_name ?? data.user?.email?.split("@")[0] ?? "there";

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6 md:p-10">
      <div>
        <p className="text-sm text-muted-foreground">Welcome back</p>
        <h1 className="font-display text-3xl font-semibold">Hey {displayName} 👋</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Videos generated" value={data.totalVideos.toString()} icon={Video} />
        <StatCard label="Ready to publish" value={data.recent.filter(v => v.status === "ready").length.toString()} icon={Sparkles} />
        <StatCard
          label="Channel"
          value={data.channel?.channel_title ?? "Not connected"}
          icon={Youtube}
          hint={data.channel ? "Connected" : "Connect in Channel tab"}
        />
      </div>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-xl font-semibold">Recent shorts</h2>
          <Link to="/library" className="text-sm text-primary hover:underline">View library →</Link>
        </div>
        {data.recent.length === 0 ? (
          <Card className="glass p-10 text-center">
            <Wand2 className="mx-auto h-8 w-8 text-primary-glow" />
            <h3 className="mt-4 font-display text-lg font-semibold">No shorts yet</h3>
            <p className="mt-1 text-sm text-muted-foreground">Generate your first script to get started.</p>
            <Link to="/generate" className="mt-5 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              Create your first short
            </Link>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.recent.map((v) => (
              <Card key={v.id} className="glass overflow-hidden">
                <div className="relative aspect-[9/16] bg-surface-2">
                  {v.thumbnail_url ? (
                    <img src={v.thumbnail_url} alt={v.title} className="h-full w-full object-cover" />
                  ) : (
                    <div className="grid h-full place-items-center text-muted-foreground">
                      <Play className="h-8 w-8" />
                    </div>
                  )}
                  <span className="absolute right-2 top-2 rounded-full bg-background/70 px-2 py-0.5 text-xs backdrop-blur">
                    {v.status}
                  </span>
                </div>
                <div className="p-3">
                  <p className="line-clamp-2 text-sm font-medium">{v.title}</p>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value, icon: Icon, hint }: { label: string; value: string; icon: React.ComponentType<{ className?: string }>; hint?: string }) {
  return (
    <Card className="glass p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 text-primary-glow" />
      </div>
      <p className="mt-2 font-display text-2xl font-semibold">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}
