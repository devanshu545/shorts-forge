import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Calendar } from "lucide-react";

export const Route = createFileRoute("/_authenticated/schedule")({
  component: SchedulePage,
});

function SchedulePage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 md:p-10">
      <div>
        <h1 className="font-display text-3xl font-semibold">Schedule</h1>
        <p className="text-sm text-muted-foreground">Auto-generate shorts on a cadence.</p>
      </div>
      <Card className="glass grid place-items-center p-16 text-center">
        <Calendar className="h-8 w-8 text-primary-glow" />
        <h3 className="mt-3 font-display text-lg font-semibold">Scheduler wiring up next</h3>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          The pg_cron job and UI land in the next build step. Data model is already live.
        </p>
      </Card>
    </div>
  );
}
