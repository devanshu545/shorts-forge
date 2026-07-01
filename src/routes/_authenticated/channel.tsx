import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Youtube, RefreshCw, Unlink, Loader2, Info } from "lucide-react";
import { toast } from "sonner";
import {
  getYouTubeAuthUrl,
  getYouTubeConnection,
  disconnectYouTube,
  refreshChannelStats,
} from "@/lib/youtube.functions";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type ChannelSearch = { connected?: string; error?: string };

export const Route = createFileRoute("/_authenticated/channel")({
  validateSearch: (s: Record<string, unknown>): ChannelSearch => ({
    connected: typeof s.connected === "string" ? s.connected : undefined,
    error: typeof s.error === "string" ? s.error : undefined,
  }),
  component: ChannelPage,
});

function ChannelPage() {
  const search = Route.useSearch();
  const qc = useQueryClient();
  const getConn = useServerFn(getYouTubeConnection);
  const getUrl = useServerFn(getYouTubeAuthUrl);
  const disconnect = useServerFn(disconnectYouTube);
  const refresh = useServerFn(refreshChannelStats);
  const [connecting, setConnecting] = useState(false);

  const { data: conn, isLoading } = useQuery({
    queryKey: ["yt-connection"],
    queryFn: () => getConn(),
  });

  const [stats, setStats] = useState<any | null>(null);

  useEffect(() => {
    if (search.connected) toast.success("YouTube channel connected!");
    if (search.error) {
      toast.error(`Connection failed: ${search.error}`, {
        description: "Please ensure the YouTube Analytics API is enabled in your Google Cloud project and you have granted all requested permissions.",
        duration: 8000,
      });
    }
  }, [search.connected, search.error]);

  const refreshMut = useMutation({
    mutationFn: () => refresh({ data: {} }),
    onSuccess: (r) => {
      setStats(r.stats);
      toast.success("Stats refreshed");
    },
    onError: (e: Error) => {
      console.error("Refresh error:", e);
      toast.error("Failed to refresh stats", {
        description: e.message,
      });
    },
  });

  const disconnectMut = useMutation({
    mutationFn: () => disconnect(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["yt-connection"] });
      setStats(null);
      toast.success("Disconnected");
    },
  });

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const { url } = await getUrl();
      window.location.href = url;
    } catch (e) {
      setConnecting(false);
      toast.error(e instanceof Error ? e.message : "Failed to start OAuth");
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 md:p-10">
      <div>
        <h1 className="font-display text-3xl font-semibold">Channel</h1>
        <p className="text-sm text-muted-foreground">
          Connect your YouTube channel for real analytics and auto-upload.
        </p>
      </div>

      <Card className="glass p-8">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : conn ? (
          <div className="space-y-8">
            <div className="flex items-center gap-4">
              {conn.channel_thumbnail && (
                <img
                  src={conn.channel_thumbnail}
                  alt=""
                  className="h-14 w-14 rounded-full"
                />
              )}
              <div className="flex-1">
                <p className="font-display text-lg font-semibold">
                  {conn.channel_title}
                </p>
                <p className="text-xs text-muted-foreground">
                  Connected ·{" "}
                  {conn.connected_at
                    ? new Date(conn.connected_at).toLocaleDateString()
                    : ""}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refreshMut.mutate()}
                disabled={refreshMut.isPending}
              >
                <RefreshCw
                  className={`h-4 w-4 ${refreshMut.isPending ? "animate-spin" : ""}`}
                />
                Refresh
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => disconnectMut.mutate()}
                disabled={disconnectMut.isPending}
              >
                <Unlink className="h-4 w-4" />
                Disconnect
              </Button>
            </div>

            {stats && (
              <div className="space-y-6">
                <div>
                  <h3 className="mb-4 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                    Lifetime Statistics
                  </h3>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <StatTile label="Subscribers" value={stats.subscriberCount} />
                    <StatTile label="Total views" value={stats.viewCount} />
                    <StatTile label="Videos" value={stats.videoCount} />
                  </div>
                </div>

                {stats.recent && (
                  <div>
                    <h3 className="mb-4 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                      Last 30 Days
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <Info className="h-4 w-4" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Real-time analytics from YouTube Analytics API</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </h3>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <StatTile label="Views" value={stats.recent.views} />
                      <StatTile label="Subs Gained" value={stats.recent.subscribersGained} color="text-green-500" />
                      <StatTile label="Watch Time (min)" value={stats.recent.estimatedMinutesWatched} />
                      <StatTile label="Avg Duration (sec)" value={stats.recent.averageViewDuration} />
                    </div>
                  </div>
                )}
                
                {!stats.recent && !refreshMut.isPending && (
                  <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4 text-sm text-yellow-600 dark:text-yellow-500">
                    <p className="font-semibold">Recent analytics unavailable</p>
                    <p>Make sure the YouTube Analytics API is enabled in your Google Cloud Console.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="text-center">
            <Youtube className="mx-auto h-8 w-8 text-primary-glow" />
            <h3 className="mt-3 font-display text-lg font-semibold">
              No channel connected
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Grant read-only access to your channel & analytics.
            </p>
            <Button className="mt-5" onClick={handleConnect} disabled={connecting}>
              {connecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Youtube className="h-4 w-4" />
              )}
              Connect YouTube
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function StatTile({ label, value, color }: { label: string; value?: string | number; color?: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-4 transition-colors hover:border-border">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 font-display text-2xl font-semibold ${color || ""}`}>
        {value !== undefined ? Number(value).toLocaleString() : "—"}
      </p>
    </div>
  );
}
