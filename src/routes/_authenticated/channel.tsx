import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Youtube } from "lucide-react";

export const Route = createFileRoute("/_authenticated/channel")({
  component: ChannelPage,
});

function ChannelPage() {
  const { data } = useQuery({
    queryKey: ["yt-connection"],
    queryFn: async () => {
      const { data } = await supabase.from("youtube_channel_info").select("*").maybeSingle();
      return data;
    },
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 md:p-10">
      <div>
        <h1 className="font-display text-3xl font-semibold">Channel</h1>
        <p className="text-sm text-muted-foreground">Connect your YouTube channel for real analytics.</p>
      </div>
      <Card className="glass p-8">
        {data ? (
          <div className="flex items-center gap-4">
            {data.channel_thumbnail && <img src={data.channel_thumbnail} alt="" className="h-14 w-14 rounded-full" />}
            <div>
              <p className="font-display text-lg font-semibold">{data.channel_title}</p>
              <p className="text-xs text-muted-foreground">Connected · {new Date(data.connected_at!).toLocaleDateString()}</p>
            </div>
          </div>
        ) : (
          <div className="text-center">
            <Youtube className="mx-auto h-8 w-8 text-primary-glow" />
            <h3 className="mt-3 font-display text-lg font-semibold">No channel connected</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              YouTube OAuth flow lands in the next build step.
            </p>
            <Button className="mt-5" disabled>Connect YouTube (soon)</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
