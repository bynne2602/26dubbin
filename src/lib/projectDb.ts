import type { Subtitle, BlurBox, BlurSettings, SubtitleSettings, OcrRegion } from "../types";
import type { ChunkSubtitle } from "./subtitle";
import type { OcrFrameResult, OcrServiceHealth } from "./ocr";

const PROJECT_DB_NAME = "26dubbin-project-cache";
const PROJECT_DB_VERSION = 3;
export const PROJECT_POINTER_KEY = "26dubbin_active_project";

export type StoredProject = {
  id: string;
  updatedAt: number;
  videoName: string;
  videoMimeType: string;
  subtitles: Subtitle[];
  sourceLang: string;
  targetLang: string;
  extractionMethod: "audio" | "ocr" | "aiocr" | "localocr";
  ocrRegions?: OcrRegion[];
  watermarkRegions?: OcrRegion[];
  ocrFps?: number;
  ttsEnabled: boolean;
  ttsEngine: "vieneu" | "gemini" | "browser" | "tiktok";
  vieneuVoice?: string;
  geminiVoice?: string;
  tiktokVoice: string;
  smartTtsEnabled: boolean;
  ttsRate: number;
  originalAudioMixVolume: number;
  exportResolution: "720" | "1080" | "1440";
  exportAspectRatio?: "original" | "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  blurBoxes: BlurBox[];
  blurSettings: BlurSettings;
  subSettings: SubtitleSettings;
  flipHorizontal: boolean;
  flipVertical: boolean;
  subtitlePipelineVersion?: number;
};

export type OcrRegionPreset = {
  id: string;
  name: string;
  regions: OcrRegion[];
};

export type StoredProjectMedia = {
  id: string;
  blob: Blob;
  name: string;
  type: string;
  lastModified: number;
};

export type StoredPreparedVoiceover = {
  id: string;
  projectId: string;
  signature: string;
  // Legacy projects may still contain one merged blob. New projects keep the
  // individual WAV clips in `tts` and reference a native FFmpeg mix session.
  // Keeping the blob optional lets old checkpoints continue to render.
  blob?: Blob;
  sessionId?: string;
  duration?: number;
  timing: Record<string, { subtitleId: string; start: number; end: number; rate: number }>;
  fittedText: Record<string, string>;
  updatedAt: number;
};

export type StoredChunk = {
  id: string;
  projectId: string;
  jobKey: string;
  start: number;
  end: number;
  subtitles: ChunkSubtitle[];
  updatedAt: number;
};

export type StoredOcrCheckpoint = {
  id: string;
  projectId: string;
  jobKey: string;
  duration: number;
  processedUntil: number;
  frames: OcrFrameResult[];
  recognizedLines: number;
  complete: boolean;
  model?: OcrServiceHealth["model"];
  updatedAt: number;
};

export type StoredTtsClip = {
  id: string;
  projectId: string;
  signature: string;
  subtitleId: string;
  blob: Blob;
  format?: "wav";
  durationSeconds?: number;
  updatedAt: number;
};

export type ProjectLibraryItem = {
  project: StoredProject;
  media?: StoredProjectMedia;
  previewUrl?: string;
  hasFinalRender: boolean;
};

export type StoredAiShortsProject = {
  id: string;
  updatedAt: number;
  title: string;
  sourceUrl: string;
  script: string;
  metadata?: Record<string, unknown>;
  videoBlob: Blob;
  durationSeconds: number;
  voice: string;
  musicTitle?: string;
};

export type ProjectStoreName = "projects" | "media" | "chunks" | "tts" | "ocr" | "aiShorts";

function openProjectDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROJECT_DB_NAME, PROJECT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const storeName of ["projects", "media", "chunks", "tts", "ocr", "aiShorts"]) {
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Không thể mở bộ nhớ dự án."));
  });
}

export async function projectDbPut(storeName: ProjectStoreName, value: unknown): Promise<void> {
  const db = await openProjectDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Không thể lưu checkpoint dự án."));
  });
  db.close();
}

export async function projectDbGet<T>(storeName: ProjectStoreName, id: string): Promise<T | undefined> {
  const db = await openProjectDatabase();
  const value = await new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error || new Error("Không thể đọc checkpoint dự án."));
  });
  db.close();
  return value;
}

export async function projectDbGetAll<T>(storeName: ProjectStoreName): Promise<T[]> {
  const db = await openProjectDatabase();
  const values = await new Promise<T[]>((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve((request.result || []) as T[]);
    request.onerror = () => reject(request.error || new Error("Không thể đọc thư viện dự án."));
  });
  db.close();
  return values;
}

export async function projectDbDelete(storeName: ProjectStoreName, id: string): Promise<void> {
  const db = await openProjectDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Không thể xóa dữ liệu dự án."));
  });
  db.close();
}

export function makeProjectId(file: File): string {
  return `video:${file.name}:${file.size}:${file.lastModified}`;
}

export function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
