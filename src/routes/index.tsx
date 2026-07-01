import { createFileRoute, Link } from "@tanstack/react-router";
import { Sparkles, Video, Calendar, BarChart3, Zap } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary-glow">
            <Zap className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="font-display text-lg font-semibold">ShortForge</span>
        </div>
        <Link
          to="/auth"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Sign in
        </Link>
      </header>

      <main className="mx-auto max-w-6xl px-6 pt-20 pb-24 text-center">
        <div className="inline-flex items-center gap-2 rounded-full glass px-4 py-1.5 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary-glow" />
          AI-powered YouTube Shorts, end to end
        </div>
        <h1 className="mt-6 font-display text-5xl font-semibold leading-[1.05] sm:text-6xl md:text-7xl">
          Forge viral shorts <br />
          <span className="bg-gradient-to-r from-primary via-primary-glow to-primary bg-clip-text text-transparent">
            while you sleep.
          </span>
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-base text-muted-foreground sm:text-lg">
          Script, voiceover, 9:16 AI video, captions, and scheduled auto-uploads to your channel — all from one dark, focused studio.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link to="/auth" className="rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Start forging free
          </Link>
        </div>

        <div className="mt-24 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: Sparkles, title: "AI scripts", body: "Hooks, scenes, VO, captions, hashtags — editable before you commit." },
            { icon: Video, title: "9:16 video", body: "Real AI video generation, 1080p, saved to your library." },
            { icon: Calendar, title: "Scheduler", body: "Cron-driven generation that runs when your browser is closed." },
            { icon: BarChart3, title: "Real analytics", body: "Live channel data from YouTube — no fake numbers." },
          ].map((f) => (
            <div key={f.title} className="glass rounded-2xl p-5 text-left">
              <f.icon className="h-5 w-5 text-primary-glow" />
              <h3 className="mt-3 font-display text-lg font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
