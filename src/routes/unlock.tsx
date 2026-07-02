import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { unlockSite } from "@/lib/gate.functions";

export const Route = createFileRoute("/unlock")({
  component: UnlockPage,
});

function UnlockPage() {
  const router = useRouter();
  const unlock = useServerFn(unlockSite);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await unlock({ data: { username, password } });
      if (res.ok) {
        await router.invalidate();
        await router.navigate({ to: "/" });
      } else {
        setError("Incorrect username or password");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 bg-background">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur-xl shadow-2xl"
      >
        <h1 className="text-2xl font-semibold text-foreground font-display">
          ShortForge
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter access credentials to continue.
        </p>

        <div className="mt-6 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Username
            </label>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              required
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Password
            </label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              required
            />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </div>
      </form>
    </div>
  );
}
