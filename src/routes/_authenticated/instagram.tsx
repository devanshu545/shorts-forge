import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Instagram, Loader2, Save, RefreshCcw, Unlink, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import {
  getInstagramConnection,
  saveInstagramConnection,
  disconnectInstagram,
  refreshInstagramStatsFn,
} from "@/lib/instagram.functions";

export const Route = createFileRoute("/_authenticated/instagram")({ component: InstagramPage });

function InstagramPage() {
  const qc = useQueryClient();
  const getFn = useServerFn(getInstagramConnection);
  const saveFn = useServerFn(saveInstagramConnection);
  const disconnectFn = useServerFn(disconnectInstagram);
  const refreshFn = useServerFn(refreshInstagramStatsFn);

  const { data: conn, isLoading } = useQuery({ queryKey: ["ig"], queryFn: () => getFn() });

  const [igId, setIgId] = useState("");
  const [pageId, setPageId] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => {
    if (conn) {
      setIgId(conn.ig_business_account_id || "");
      setPageId(conn.fb_page_id || "");
      setToken("");
    }
  }, [conn]);

  const saveMut = useMutation({
    mutationFn: () => saveFn({ data: { ig_business_account_id: igId.trim(), fb_page_id: pageId.trim() || null, page_access_token: token.trim() } }),
    onSuccess: () => {
      toast.success("Instagram connected!");
      setToken("");
      qc.invalidateQueries({ queryKey: ["ig"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const refreshMut = useMutation({
    mutationFn: () => refreshFn(),
    onSuccess: () => { toast.success("Stats refreshed"); qc.invalidateQueries({ queryKey: ["ig"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const disconnectMut = useMutation({
    mutationFn: () => disconnectFn(),
    onSuccess: () => { toast.success("Instagram disconnected"); qc.invalidateQueries({ queryKey: ["ig"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mx-auto grid max-w-5xl gap-6 p-6 md:p-10 lg:grid-cols-[420px_1fr]">
      <Card className="glass p-6 h-fit">
        <div className="flex items-center gap-2">
          <Instagram className="h-5 w-5 text-primary-glow" />
          <h1 className="font-display text-xl font-semibold">Instagram</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your Instagram Business account so autopilot cross-posts every Short as a Reel.
        </p>

        {isLoading ? <Loader2 className="mt-6 h-5 w-5 animate-spin" /> : conn ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
              <div className="text-sm font-medium">✅ Connected as @{conn.username || "instagram"}</div>
              <div className="text-xs text-muted-foreground">
                {conn.followers_count?.toLocaleString() ?? 0} followers · {conn.media_count?.toLocaleString() ?? 0} posts
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">IG ID: {conn.ig_business_account_id}</div>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending}>
                {refreshMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                Refresh stats
              </Button>
              <Button variant="ghost" size="sm" onClick={() => disconnectMut.mutate()} disabled={disconnectMut.isPending}>
                <Unlink className="h-4 w-4" /> Disconnect
              </Button>
            </div>
            <div className="rounded-lg border border-border/60 bg-background/40 p-3 text-xs text-muted-foreground">
              Paste a new Page Access Token below to rotate credentials (leave blank to keep the current one).
            </div>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">Not connected yet — fill in the fields to link your IG Business account.</p>
        )}

        <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); saveMut.mutate(); }}>
          <div>
            <Label>Instagram Business Account ID</Label>
            <Input value={igId} onChange={(e) => setIgId(e.target.value)} placeholder="17841400000000000" required />
          </div>
          <div>
            <Label>Facebook Page ID (optional)</Label>
            <Input value={pageId} onChange={(e) => setPageId(e.target.value)} placeholder="10151234567890000" />
          </div>
          <div>
            <Label>Long-lived Page Access Token</Label>
            <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="EAAG..." required={!conn} type="password" />
            <p className="mt-1 text-[11px] text-muted-foreground">Stored securely. Only ever sent to Meta Graph API.</p>
          </div>
          <Button type="submit" disabled={saveMut.isPending || !igId || (!conn && !token)} className="w-full">
            {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {conn ? "Update Connection" : "Connect Instagram"}
          </Button>
        </form>
      </Card>

      <Card className="glass p-6">
        <h2 className="font-display text-lg font-semibold">How to get your credentials</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          You need an Instagram <b>Business</b> or <b>Creator</b> account linked to a Facebook Page.
        </p>
        <ol className="mt-5 space-y-4 text-sm">
          <li>
            <div className="font-medium">1. Convert Instagram to a Business account</div>
            <p className="text-muted-foreground text-xs">In the IG app: Settings → Account → Switch to Professional Account → Business.</p>
          </li>
          <li>
            <div className="font-medium">2. Create/connect a Facebook Page</div>
            <p className="text-muted-foreground text-xs">On facebook.com create a Page (or use an existing one). Then in IG Settings → Account → Sharing to other apps → Facebook, link that Page.</p>
          </li>
          <li>
            <div className="font-medium">3. Create a Meta Developer App</div>
            <p className="text-muted-foreground text-xs">
              Go to <a className="text-primary-glow underline" href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">developers.facebook.com/apps <ExternalLink className="inline h-3 w-3" /></a> → Create App → Business → give it a name.
            </p>
          </li>
          <li>
            <div className="font-medium">4. Add these products to the app</div>
            <p className="text-muted-foreground text-xs">Facebook Login for Business, Instagram Graph API.</p>
          </li>
          <li>
            <div className="font-medium">5. Grab a long-lived Page Access Token</div>
            <p className="text-muted-foreground text-xs">
              Open the <a className="text-primary-glow underline" href="https://developers.facebook.com/tools/explorer" target="_blank" rel="noreferrer">Graph API Explorer <ExternalLink className="inline h-3 w-3" /></a> → select your app → “Get User Access Token” with scopes:
              <code className="mx-1 rounded bg-muted px-1">instagram_basic</code>,
              <code className="mx-1 rounded bg-muted px-1">instagram_content_publish</code>,
              <code className="mx-1 rounded bg-muted px-1">pages_show_list</code>,
              <code className="mx-1 rounded bg-muted px-1">pages_read_engagement</code>,
              <code className="mx-1 rounded bg-muted px-1">business_management</code>.
              Then swap it for a long-lived token, then request the Page token (60 days). Paste that Page token here.
            </p>
          </li>
          <li>
            <div className="font-medium">6. Find your Instagram Business Account ID</div>
            <p className="text-muted-foreground text-xs">
              In Graph API Explorer run <code className="rounded bg-muted px-1">GET /me/accounts</code> to get your Page ID, then
              <code className="mx-1 rounded bg-muted px-1">GET /&#123;page-id&#125;?fields=instagram_business_account</code>. Copy the ID it returns.
            </p>
          </li>
          <li>
            <div className="font-medium">7. Paste everything on the left and click Connect</div>
            <p className="text-muted-foreground text-xs">We verify the token instantly by fetching your username, followers, and media count.</p>
          </li>
        </ol>

        <div className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          <b>Note:</b> Page Access Tokens expire every ~60 days. You'll get a notification here when it expires; just repeat step 5 and paste the new token — everything else keeps running.
        </div>
      </Card>
    </div>
  );
}
