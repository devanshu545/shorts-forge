export type SplitStage =
  | "loading-ffmpeg"
  | "reading-file"
  | "probing"
  | "encoding"
  | "uploading"
  | "done"
  | "error";

export type ClipProgress = {
  index: number;
  total: number;
  stage: SplitStage;
  percent: number;
  clipPercent: number;
  etaSeconds: number | null;
  fps: number | null;
  uploadMBps: number | null;
  message: string;
};

export type SplitOptions = {
  clipLength: number;
  maxClips: number;
  resolution: "1080p" | "4k";
  onProgress: (p: ClipProgress) => void;
};

export type ClipResult = {
  index: number;
  startSeconds: number;
  endSeconds: number;
  mp4: Uint8Array;
  thumbnailJpg: Uint8Array;
  title: string;
};