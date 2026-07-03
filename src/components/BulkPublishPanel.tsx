import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { motion, AnimatePresence } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  Rocket, Wand2, ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle,
  Youtube, Sparkles, ListChecks, Copy,
} from "lucide-react";
import { commitShortsSafeVideo, createShortsSafeVideoUploadUrl, uploadVideoToYouTube } from "@/lib/media.functions";
import { generateShortSEO } from "@/lib/seo.functions";

export type BulkClip = {
  id: string;
  title: string | null;
  description: string | null;
  tags: string[] | null;
  video_url: string | null;
  thumbnail_url: string | null;
  youtube_video_id: string | null;
  clip_start_seconds: number | null;
  clip_end_seconds: number | null;
};

type Privacy = "public" | "unlisted" | "private";

type RowState = {
  clipId: string;
  selected: boolean;
  expanded: boolean;
  title: string;
  description: string;
  tagsCsv: string;
  privacy: Privacy;
  status: "idle" | "seo" | "uploading" | "done" | "failed";
  error?: string;
  ytUrl?: string;
};

// Render a title template. Placeholders:
//   {n}     → clip number starting at 1
//   {i}     → clip number (zero-padded 2 digits)
//   {title} → original clip title
//   {start} / {end} → clip start/end seconds
function renderTemplate(tpl: string, ctx: { n: number; title: string; start: number; end: number }) {
  return tpl
    .replaceAll("{n}", String(ctx.n))
    .replaceAll("{i}", String(ctx.n).padStart(2, "0"))
    .replaceAll("{title}", ctx.title)
    .replaceAll("{start}", String(ctx.start))
    .replaceAll("{end}", String(ctx.end));
}

export function BulkPublishPanel({
  clips,
  hintForClip,
  framesForClip,
  onPublished,
}: {
  clips: BulkClip[];
  hintForClip?: (clip: BulkClip) => string | undefined;
  framesForClip?: (clip: BulkClip) => string[] | undefined;
  onPublished?: () => void;
}) {
  const upload = useServerFn(uploadVideoToYouTube);
  const createSafeUpload = useServerFn(createShortsSafeVideoUploadUrl);
  const commitSafeUpload = useServerFn(commitShortsSafeVideo);
  const seo = useServerFn(generateShortSEO);

  // Master template inputs — applied to all selected clips on demand.
  const [titleTpl, setTitleTpl] = useState("🔥 {title} #shorts");
  const [descTpl, setDescTpl] = useState(
    "{title}\n\nWatch more highlights every day.\n\n#shorts #shortsfeed #viral #fyp",
  );
  const [tagsTpl, setTagsTpl] = useState("shorts, shorts fyp, viral, highlight, clip");
  const [privacy, setPrivacy] = useState<Privacy>("public");
  const [showTemplate, setShowTemplate] = useState(true);

  // Per-clip editable rows, pre-loaded from each clip's current DB values.
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  // Seed rows whenever the incoming clip set changes (add new rows, keep edits
  // for existing rows so mid-typing edits aren't wiped by a refetch).
  useEffect(() => {
    setRows((prev) => {
      const next: Record<string, RowState> = {};
      for (const c of clips) {
        const existing = prev[c.id];
        if (existing) {
          next[c.id] = {
            ...existing,
            // Keep existing edits, but sync published state from server truth.
            status: c.youtube_video_id ? "done" : existing.status,
            ytUrl: c.youtube_video_id
              ? `https://www.youtube.com/shorts/${c.youtube_video_id}`
              : existing.ytUrl,
          };
          continue;
        }
        next[c.id] = {
          clipId: c.id,
          selected: !c.youtube_video_id, // pre-select unpublished clips
          expanded: false,
          title: c.title || "",
          description: c.description || "",
          tagsCsv: (c.tags || []).join(", "),
          privacy,
          status: c.youtube_video_id ? "done" : "idle",
          ytUrl: c.youtube_video_id ? `https://www.youtube.com/shorts/${c.youtube_video_id}` : undefined,
        };
      }
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips.map((c) => `${c.id}:${c.youtube_video_id ?? ""}`).join("|")]);

  const selectedIds = useMemo(
    () => clips.filter((c) => rows[c.id]?.selected && rows[c.id].status !== "done").map((c) => c.id),
    [clips, rows],
  );
  const allSelected = clips.length > 0 && clips.every((c) => rows[c.id]?.selected || rows[c.id]?.status === "done");

  const patchRow = (id: string, patch: Partial<RowState>) =>
    setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));

  const toggleAll = (checked: boolean) => {
    setRows((r) => {
      const next = { ...r };
      for (const c of clips) {
        if (!next[c.id]) continue;
        if (next[c.id].status === "done") continue;
        next[c.id] = { ...next[c.id], selected: checked };
      }
      return next;
    });
  };

  const applyTemplateToAll = () => {
    let applied = 0;
    setRows((r) => {
      const next = { ...r };
      clips.forEach((c, idx) => {
        if (!next[c.id]) return;
        if (next[c.id].status === "done") return;
        const ctx = {
          n: idx + 1,
          title: c.title || `Clip ${idx + 1}`,
          start: Math.round(c.clip_start_seconds ?? 0),
          end: Math.round(c.clip_end_seconds ?? 0),
        };
        next[c.id] = {
          ...next[c.id],
          title: renderTemplate(titleTpl, ctx).slice(0, 100),
          description: renderTemplate(descTpl, ctx).slice(0, 5000),
          tagsCsv: tagsTpl,
          privacy,
        };
        applied += 1;
      });
      return next;
    });
    toast.success(`Applied template to ${applied} clip${applied === 1 ? "" : "s"}`);
  };

  const aiRegenerateAll = async () => {
    const targets = clips.filter((c) => rows[c.id]?.selected && rows[c.id].status !== "done");
    if (!targets.length) {
      toast.info("Select at least one clip first");
      return;
    }
    setBusy(true);
    let ok = 0;
    try {
      for (const c of targets) {
        patchRow(c.id, { status: "seo" });
        try {
          const meta = await seo({ data: {
            hint: hintForClip?.(c) || rows[c.id].title || c.title || "Trending YouTube Short",
            frames: framesForClip?.(c),
          } });
          patchRow(c.id, {
            title: meta.title.slice(0, 100),
            description: (meta.description || "").slice(0, 5000),
            tagsCsv: (meta.tags || []).join(", "),
            status: "idle",
          });
          ok += 1;
        } catch (err) {
          patchRow(c.id, { status: "idle", error: err instanceof Error ? err.message : "SEO failed" });
        }
      }
      toast.success(`AI-optimized ${ok} of ${targets.length}`);
    } finally {
      setBusy(false);
    }
  };

  const publishSelected = async () => {
    if (!selectedIds.length) {
      toast.info("Select at least one unpublished clip");
      return;
    }
    setBusy(true);
    setProgress({ done: 0, total: selectedIds.length });
    let ok = 0;
    let failed = 0;
    try {
      for (let i = 0; i < selectedIds.length; i++) {
        const id = selectedIds[i];
        const row = rows[id];
        if (!row) continue;
        patchRow(id, { status: "uploading", error: undefined });
        try {
          const safeInfo = await createSafeUpload({ data: { videoId: id } });
          const { fetchVideoBytes, prepareShortsSafeMp4, uploadSignedMp4 } = await import("@/lib/shorts-safe.client");
          const sourceBytes = await fetchVideoBytes(safeInfo.sourceUrl);
          const safe = await prepareShortsSafeMp4(sourceBytes, "hd");
          if (safe.changed) {
            await uploadSignedMp4(safeInfo.uploadSignedUrl, safe.bytes);
            await commitSafeUpload({ data: {
              videoId: id,
              videoStoragePath: safeInfo.videoStoragePath,
              fileSizeBytes: safe.bytes.byteLength,
              durationSeconds: safe.durationSeconds,
            } });
          }
          const tags = row.tagsCsv
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 30);
          const result = await upload({ data: {
            videoId: id,
            title: (row.title || `Clip ${i + 1}`).slice(0, 100),
            description: row.description.slice(0, 5000),
            tags,
            privacyStatus: row.privacy,
          } });
          patchRow(id, { status: "done", ytUrl: result.url });
          ok += 1;
        } catch (err) {
          patchRow(id, {
            status: "failed",
            error: err instanceof Error ? err.message : "Publish failed",
          });
          failed += 1;
        }
        setProgress({ done: i + 1, total: selectedIds.length });
      }
      if (failed === 0) toast.success(`Published ${ok} short${ok === 1 ? "" : "s"} 🎉`);
      else toast.warning(`${ok} published · ${failed} failed`);
      onPublished?.();
    } finally {
      setBusy(false);
    }
  };

  const pendingCount = selectedIds.length;
  const doneCount = clips.filter((c) => rows[c.id]?.status === "done").length;

  return (
    <Card className="glass mt-4 overflow-hidden p-0">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-background/40 px-5 py-3">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-primary/15 text-primary-glow">
            <Rocket className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold">Bulk Publish</div>
            <div className="text-[11px] text-muted-foreground">
              {clips.length} clip{clips.length === 1 ? "" : "s"} · {doneCount} live · {pendingCount} ready to ship
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setShowTemplate((s) => !s)}>
            {showTemplate ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Template
          </Button>
          <Button size="sm" variant="outline" onClick={aiRegenerateAll} disabled={busy}>
            <Sparkles className="h-3.5 w-3.5" /> AI titles for selected
          </Button>
          <Button size="sm" onClick={publishSelected} disabled={busy || !pendingCount}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Youtube className="h-3.5 w-3.5" />}
            Publish {pendingCount ? `(${pendingCount})` : ""}
          </Button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {showTemplate && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-b border-border/60 bg-background/30"
          >
            <div className="grid gap-3 p-5 md:grid-cols-2">
              <div className="md:col-span-2">
                <Label className="text-xs">
                  Title template <span className="text-muted-foreground">— use {"{n}"}, {"{i}"}, {"{title}"}, {"{start}"}, {"{end}"}</span>
                </Label>
                <Input
                  value={titleTpl}
                  onChange={(e) => setTitleTpl(e.target.value)}
                  className="mt-1"
                  placeholder="🔥 Epic Moment #{n} — {title}"
                />
              </div>
              <div className="md:col-span-2">
                <Label className="text-xs">Description template</Label>
                <Textarea
                  rows={3}
                  value={descTpl}
                  onChange={(e) => setDescTpl(e.target.value)}
                  className="mt-1 font-mono text-xs"
                />
              </div>
              <div>
                <Label className="text-xs">Tags (comma separated)</Label>
                <Input value={tagsTpl} onChange={(e) => setTagsTpl(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Privacy</Label>
                <Select value={privacy} onValueChange={(v) => setPrivacy(v as Privacy)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">Public</SelectItem>
                    <SelectItem value="unlisted">Unlisted</SelectItem>
                    <SelectItem value="private">Private</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2 md:col-span-2">
                <Button size="sm" variant="secondary" onClick={applyTemplateToAll}>
                  <Wand2 className="h-3.5 w-3.5" /> Apply to all clips
                </Button>
                <Button size="sm" variant="ghost" onClick={() => toggleAll(!allSelected)}>
                  <ListChecks className="h-3.5 w-3.5" /> {allSelected ? "Unselect all" : "Select all"}
                </Button>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  Everything is editable per-clip below.
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {busy && progress.total > 0 && (
        <div className="space-y-1 border-b border-border/60 bg-background/20 px-5 py-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Publishing to YouTube…</span>
            <span>{progress.done} / {progress.total}</span>
          </div>
          <Progress value={(progress.done / progress.total) * 100} className="h-1.5" />
        </div>
      )}

      <div className="divide-y divide-border/60">
        {clips.map((c, idx) => {
          const row = rows[c.id];
          if (!row) return null;
          const isDone = row.status === "done";
          const isBusy = row.status === "seo" || row.status === "uploading";
          return (
            <div key={c.id} className="px-5 py-3">
              <div className="flex items-center gap-3">
                <Checkbox
                  checked={row.selected}
                  disabled={isDone}
                  onCheckedChange={(v) => patchRow(c.id, { selected: !!v })}
                />
                <span className="w-6 text-center text-xs text-muted-foreground">#{idx + 1}</span>
                {c.thumbnail_url ? (
                  <img
                    src={c.thumbnail_url}
                    alt=""
                    className="h-12 w-8 rounded border border-border/60 object-cover"
                  />
                ) : (
                  <div className="h-12 w-8 rounded border border-border/60 bg-background/50" />
                )}
                <Input
                  value={row.title}
                  onChange={(e) => patchRow(c.id, { title: e.target.value.slice(0, 100) })}
                  disabled={isDone || isBusy}
                  className="h-8 flex-1 text-sm"
                  placeholder={`Clip ${idx + 1}`}
                />
                <Select
                  value={row.privacy}
                  onValueChange={(v) => patchRow(c.id, { privacy: v as Privacy })}
                  disabled={isDone || isBusy}
                >
                  <SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">Public</SelectItem>
                    <SelectItem value="unlisted">Unlisted</SelectItem>
                    <SelectItem value="private">Private</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => patchRow(c.id, { expanded: !row.expanded })}
                >
                  {row.expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  Edit
                </Button>
                <div className="w-24 text-right">
                  {row.status === "idle" && <Badge variant="secondary" className="text-[10px]">Ready</Badge>}
                  {row.status === "seo" && (
                    <Badge variant="secondary" className="gap-1 text-[10px]">
                      <Loader2 className="h-3 w-3 animate-spin" /> AI SEO
                    </Badge>
                  )}
                  {row.status === "uploading" && (
                    <Badge variant="secondary" className="gap-1 text-[10px]">
                      <Loader2 className="h-3 w-3 animate-spin" /> Uploading
                    </Badge>
                  )}
                  {row.status === "done" && row.ytUrl && (
                    <a
                      href={row.ytUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/15 px-2 py-1 text-[10px] font-medium text-primary-glow hover:bg-primary/25"
                    >
                      <CheckCircle2 className="h-3 w-3" /> Live
                    </a>
                  )}
                  {row.status === "failed" && (
                    <Badge variant="destructive" className="gap-1 text-[10px]">
                      <XCircle className="h-3 w-3" /> Failed
                    </Badge>
                  )}
                </div>
              </div>

              <AnimatePresence initial={false}>
                {row.expanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-3 grid gap-3 rounded-md border border-border/50 bg-background/30 p-3 md:grid-cols-2">
                      <div className="md:col-span-2">
                        <Label className="text-[11px]">Description</Label>
                        <Textarea
                          rows={4}
                          value={row.description}
                          onChange={(e) => patchRow(c.id, { description: e.target.value.slice(0, 5000) })}
                          disabled={isDone || isBusy}
                          className="mt-1 font-mono text-xs"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <Label className="text-[11px]">Tags (comma separated · max 30)</Label>
                        <Input
                          value={row.tagsCsv}
                          onChange={(e) => patchRow(c.id, { tagsCsv: e.target.value })}
                          disabled={isDone || isBusy}
                          className="mt-1 text-xs"
                        />
                      </div>
                      {row.error && (
                        <div className="text-[11px] text-destructive md:col-span-2">{row.error}</div>
                      )}
                      <div className="flex items-center gap-2 md:col-span-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            const ctx = {
                              n: idx + 1,
                              title: c.title || `Clip ${idx + 1}`,
                              start: Math.round(c.clip_start_seconds ?? 0),
                              end: Math.round(c.clip_end_seconds ?? 0),
                            };
                            patchRow(c.id, {
                              title: renderTemplate(titleTpl, ctx).slice(0, 100),
                              description: renderTemplate(descTpl, ctx).slice(0, 5000),
                              tagsCsv: tagsTpl,
                              privacy,
                            });
                          }}
                          disabled={isDone || isBusy}
                        >
                          <Copy className="h-3.5 w-3.5" /> Apply template to this clip
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
