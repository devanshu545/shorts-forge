// Server-side helper to trigger GitHub Actions workflows via the REST API.
// Uses the fine-grained PAT stored as GITHUB_FINE_GRAINED_PERSONAL_ACCESS_TOKEN
// (also accepted: GITHUB_DISPATCH_TOKEN). Repo is read from GITHUB_REPO
// (default: devanshu545/shorts-forge).
const DEFAULT_REPO = "devanshu545/shorts-forge";

function getToken(): string {
  const token =
    process.env.GITHUB_DISPATCH_TOKEN ||
    process.env.GITHUB_FINE_GRAINED_PERSONAL_ACCESS_TOKEN;
  if (!token) throw new Error("GitHub token missing. Set GITHUB_FINE_GRAINED_PERSONAL_ACCESS_TOKEN.");
  return token;
}

function getRepo(): string {
  return (process.env.GITHUB_REPO || DEFAULT_REPO).trim();
}

export type DispatchResult = {
  ok: boolean;
  status: number;
  message: string;
  runsUrl: string;
  latestRunUrl?: string;
};

async function dispatchWorkflow(workflowFile: string, inputs: Record<string, string>): Promise<DispatchResult> {
  const token = getToken();
  const repo = getRepo();
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "ShortForge-Lovable-App",
  };
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ref: "main", inputs }),
  });

  const runsUrl = `https://github.com/${repo}/actions/workflows/${workflowFile}`;
  if (res.status === 204) {
    // Best-effort: fetch newest run so we can deep-link to it.
    let latestRunUrl: string | undefined;
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const runs = await fetch(
        `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/runs?per_page=1`,
        { headers },
      );
      if (runs.ok) {
        const body = (await runs.json()) as { workflow_runs?: Array<{ html_url?: string }> };
        latestRunUrl = body.workflow_runs?.[0]?.html_url;
      }
    } catch {}
    return { ok: true, status: 204, message: "Workflow dispatched. GitHub will start it in a few seconds.", runsUrl, latestRunUrl };
  }

  const body = await res.text();
  let msg = body.slice(0, 400);
  try { msg = (JSON.parse(body) as { message?: string }).message || msg; } catch {}
  return { ok: false, status: res.status, message: `GitHub API error (${res.status}): ${msg}`, runsUrl };
}

export function triggerAutopilotWorkflow(opts: { forceTest: boolean }) {
  return dispatchWorkflow("autopilot.yml", { force_test: opts.forceTest ? "true" : "false" });
}

export function triggerSplitterWorkflow(opts: { longVideoId?: string; clipId?: string } = {}) {
  const inputs: Record<string, string> = {};
  if (opts.longVideoId) inputs.long_video_id = opts.longVideoId;
  if (opts.clipId) inputs.clip_id = opts.clipId;
  return dispatchWorkflow("splitter.yml", inputs);
}
