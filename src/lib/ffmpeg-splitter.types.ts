export type SplitStage =
  | "loading-ffmpeg"
  | "reading-file"
  | "probing"
  | "encoding"
  | "polishing"
  | "uploading"
  | "upscaling"
  | "done"
  | "error";

export type ClipProgress = {
  index: number;
  total: number;
  stage: SplitStage;
  percent: number;
  clipPercent: number;
  etaSeconds: number | null;
  elapsedSeconds?: number;
  fps: number | null;
  uploadMBps: number | null;
  uploadedBytes?: number;
  totalBytes?: number;
  lastLog?: string;
  updatedAt?: number;
  message: string;
};

export type SplitOptions = {
  clipLength: number;
  maxClips: number;
  // "hd" = instant polished 1080p (default).
  // "4k-smart" = instant polished 1080p first, then background 4K upscale.
  resolution: "hd" | "4k-smart";
  // Apply cinematic polish (lanczos scale, sharpen, vignette, fades, color).
  // Default true — this is what stops shorts from looking like raw cuts.
  polish: boolean;
  onProgress: (p: ClipProgress) => void;
  onClip?: (clip: ClipResult) => void;
  maxProcessingSeconds?: number;
};

export type ClipResult = {
  index: number;
  startSeconds: number;
  endSeconds: number;
  mp4: Uint8Array;
  mimeType?: "video/mp4" | "video/webm";
  thumbnailJpg: Uint8Array;
  // 3 JPEG frames (data:image/jpeg;base64,...) sampled at 15%, 50%, 85%.
  // Fed to Gemini vision for accurate, content-aware AI titles.
  frames: string[];
  title: string;
  // For smart-4K queue: rendered 1080p first, upscaled later.
  needsUpscale: boolean;
};
