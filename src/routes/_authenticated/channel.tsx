import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Youtube, RefreshCw, Unlink, Loader2, Info, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import {
  getYouTubeAuthUrl,
  getYouTubeConnection,
  disconnectYouTube,
  refreshChannelStats,
  syncYouTubeUploadState,
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
  const syncUploads = useServerFn(syncYouTubeUploadState);
  const [connecting, setConnecting] = useState(false);

  const { data: conn, isLoading } = useQuery({
    queryKey: ["yt-connection"],
    queryFn: () => getConn(),
  });

  const [stats, setStats] = useState<any | null>(null);
  const savedAnalytics = conn?.analytics && typeof conn.analytics === "object" && Object.keys(conn.analytics).length > 0 ? conn.analytics : null;
  const liveStats = stats || savedAnalytics || conn?.statistics || null;

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
    mutationFn: async () => {
      await syncUploads();
      return refresh({ data: {} });
    },
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
            {conn.channel_banner && <img src={conn.channel_banner} alt="Channel banner" className="h-36 w-full rounded-2xl object-cover" />}
            <div className="flex flex-wrap items-center gap-4">
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
                <p className="line-clamp-2 max-w-2xl text-sm text-muted-foreground">{conn.channel_description}</p>
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

            {!conn.scope?.includes("youtube.upload") && (
              <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4 text-sm text-yellow-500">
                Upload permission is missing from your saved token. Click Disconnect, then Connect YouTube again and accept all scopes.
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <InfoTile label="Created" value={conn.channel_created_at ? new Date(conn.channel_created_at).toLocaleDateString() : "—"} />
              <InfoTile label="Country" value={conn.country || "—"} />
              <InfoTile label="Made for kids" value={conn.made_for_kids === null ? "—" : conn.made_for_kids ? "Yes" : "No"} />
              <InfoTile label="Redirect URI" value={`${window.location.origin}/api/public/youtube/callback`} small />
            </div>

            {liveStats && (
              <div className="space-y-6">
                <div>
                  <h3 className="mb-4 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                    Lifetime Statistics
                  </h3>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <StatTile label="Subscribers" value={liveStats.subscriberCount} />
                    <StatTile label="Total views" value={liveStats.viewCount} />
                    <StatTile label="Total uploads" value={liveStats.videoCount} />
                  </div>
                </div>

                {liveStats.recent && !liveStats.recent.error && (
                  <div>
                    <h3 className="mb-4 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                      Last 28-30 Days
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
                      <StatTile label="Views" value={liveStats.recent.views} />
                      <StatTile label="Subs Gained" value={liveStats.recent.subscribersGained} color="text-green-500" />
                      <StatTile label="Watch Hours" value={liveStats.watchHours28Days ? Number(liveStats.watchHours28Days).toFixed(1) : undefined} />
                      <StatTile label="Avg Duration (sec)" value={liveStats.recent.averageViewDuration} />
                    </div>
                  </div>
                )}
                {liveStats.topVideos?.length > 0 && (
                  <div>
                    <h3 className="mb-4 font-display text-sm font-semibold uppercase tracking-wider text-muted-foreground">Top 10 videos</h3>
                    <div className="space-y-2">
                      {liveStats.topVideos.map((v: any) => (
                        <a key={v.id} href={`https://www.youtube.com/watch?v=${v.id}`} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/30 p-3 text-sm hover:bg-accent/40">
                          <span className="line-clamp-1">{v.title}</span>
                          <span className="shrink-0 text-muted-foreground">{Number(v.views || 0).toLocaleString()} views · {Number(v.likes || 0).toLocaleString()} likes · {Number(v.comments || 0).toLocaleString()} comments <ExternalLink className="ml-1 inline h-3 w-3" /></span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
                
                {((liveStats.recent && liveStats.recent.error) || liveStats.analyticsError) && !refreshMut.isPending && (
                  <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4 text-sm text-yellow-600 dark:text-yellow-500">
                    <p className="font-semibold">Recent analytics unavailable</p>
                    <p>{liveStats.recent?.error || liveStats.analyticsError}</p>
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
              Grant channel, analytics, and upload permissions. Also add devanshu9655@gmail.com as a Google OAuth test user if your app is still in Testing mode.
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

function InfoTile({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 break-words font-medium ${small ? "text-xs" : "text-sm"}`}>{value}</p>
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
