import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const navigate = useNavigate();
  const { data: profile, refetch } = useQuery({
    queryKey: ["profile"],
    queryFn: async () => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) return null;
      const { data } = await supabase.from("profiles").select("*").eq("id", user.user.id).single();
      return { profile: data, email: user.user.email };
    },
  });

  const saveName = async (name: string) => {
    if (!profile?.profile) return;
    const { error } = await supabase.from("profiles").update({ display_name: name }).eq("id", profile.profile.id);
    if (error) toast.error(error.message);
    else { toast.success("Saved"); refetch(); }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/" });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6 md:p-10">
      <div>
        <h1 className="font-display text-3xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your account.</p>
      </div>

      <Card className="glass p-6">
        <h2 className="font-display text-lg font-semibold">Profile</h2>
        <div className="mt-4 space-y-4">
          <div>
            <Label>Email</Label>
            <Input value={profile?.email ?? ""} disabled className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="dname">Display name</Label>
            <div className="mt-1.5 flex gap-2">
              <Input id="dname" defaultValue={profile?.profile?.display_name ?? ""}
                onBlur={(e) => saveName(e.target.value)} placeholder="Your name" />
            </div>
          </div>
        </div>
      </Card>

      <Card className="glass p-6">
        <h2 className="font-display text-lg font-semibold">Session</h2>
        <Button variant="destructive" className="mt-4" onClick={signOut}>Sign out</Button>
      </Card>
    </div>
  );
}
