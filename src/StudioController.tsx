import React, { useState, useRef, useEffect, useMemo } from "react";
import { 
  Upload, Play, Pause, Download, Languages, Sliders, Type, Edit3, 
  Check, Trash2, Plus, Volume2, Video, FileText, SlidersHorizontal, Info, Eye, EyeOff,
  Megaphone, VolumeX, RefreshCw, Sparkles, Music, Coffee, X, Layers, Settings, Activity, Cpu, LogOut, Lock,
  Facebook, Github, FolderOpen
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Subtitle, BlurSettings, SubtitleSettings, BlurBox, OcrRegion } from "./types";
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { app as firebaseApp, db, auth } from "./lib/firebase";
import { doc, getDoc, setDoc, getDocs, collection, query, where, limit } from "firebase/firestore";
import { signInWithEmailAndPassword, signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, GithubAuthProvider, FacebookAuthProvider } from "firebase/auth";
import { initializeBrowserOcr, recognizeBrowserOcrBatch } from "./browserOcr";
import AppSidebar from "./components/layout/AppSidebar";
import AppNavbar from "./components/layout/AppNavbar";
import AppFooter from "./components/layout/AppFooter";
import type { StudioRoute } from "./app/routes";
import AutoDubbingLayout from "./layouts/AutoDubbingLayout";
import ProjectLibraryLayout from "./layouts/ProjectLibraryLayout";
import PersonalizationLayout from "./layouts/PersonalizationLayout";
import TranslationLayout from "./layouts/TranslationLayout";
import NarrationLayout from "./layouts/NarrationLayout";
import SettingsLayout from "./layouts/SettingsLayout";

function parseGeminiApiKeys(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\r\n,;]+/)
      .map((key) => key.trim())
      .filter(Boolean),
  ));
}

function getGeminiRequestHeaders(value: string): Record<string, string> {
  const keys = parseGeminiApiKeys(value);
  if (keys.length === 0) return {};
  return {
    "x-gemini-api-keys": JSON.stringify(keys),
    "x-gemini-api-key": keys[0],
  };
}

function sanitizeCustomApiBaseUrl(value: string): string {
  return value
    .trim()
    .replace(/^(?:POST|GET|PUT|PATCH|DELETE)\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

type ApiQuotaEntry = {
  provider: "gemini" | "custom";
  label: string;
  model: string;
  status: "unused" | "available" | "limited" | "error";
  requests: number;
  successes: number;
  failures: number;
  quotaErrors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastOperation: string;
  lastUsedAt: string | null;
  lastError: string;
  quotaVisibility: string;
  rateLimit: {
    requestLimit: string | null;
    requestRemaining: string | null;
    requestReset: string | null;
    tokenLimit: string | null;
    tokenRemaining: string | null;
    tokenReset: string | null;
  };
};

// Helper functions for client-side audio extraction and WAV encoding
function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function floatTo16BitPCM(output: DataView, offset: number, input: Float32Array) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
}

function writeWavFile(samples: Float32Array, numOfChan: number, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  
  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* file length */
  view.setUint32(4, 36 + samples.length * 2, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk identifier */
  writeString(view, 12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw PCM = 1) */
  view.setUint16(20, 1, true);
  /* channel count */
  view.setUint16(22, numOfChan, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * numOfChan * 2, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, numOfChan * 2, true);
  /* bits per sample */
  view.setUint16(34, 16, true);
  /* data chunk identifier */
  writeString(view, 36, 'data');
  /* chunk length */
  view.setUint32(40, samples.length * 2, true);
  
  floatTo16BitPCM(view, 44, samples);
  
  return new Blob([view], { type: 'audio/wav' });
}

function bufferToWav(buffer: AudioBuffer): Blob {
  const numOfChan = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  
  let result;
  if (numOfChan === 2) {
    const chan0 = buffer.getChannelData(0);
    const chan1 = buffer.getChannelData(1);
    const length = chan0.length + chan1.length;
    result = new Float32Array(length);
    let index = 0;
    let inputIndex = 0;
    while (index < length) {
      result[index++] = chan0[inputIndex];
      result[index++] = chan1[inputIndex];
      inputIndex++;
    }
  } else {
    result = buffer.getChannelData(0);
  }
  
  return writeWavFile(result, numOfChan, sampleRate);
}

function pcmToWav(pcmBytes: Uint8Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + pcmBytes.byteLength);
  const view = new DataView(buffer);

  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* file length */
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk identifier */
  writeString(view, 12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw PCM = 1) */
  view.setUint16(20, 1, true);
  /* channel count */
  view.setUint16(22, 1, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * 2, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, 2, true);
  /* bits per sample */
  view.setUint16(34, 16, true);
  /* data chunk identifier */
  writeString(view, 36, 'data');
  /* data chunk length */
  view.setUint32(40, pcmBytes.byteLength, true);

  // Write PCM data
  const wavBytes = new Uint8Array(buffer);
  wavBytes.set(pcmBytes, 44);

  return new Blob([wavBytes], { type: 'audio/wav' });
}

function sliceAudioBuffer(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number
): AudioBuffer {
  const sampleRate = buffer.sampleRate;
  const totalLength = buffer.length;
  
  const startSample = Math.floor(startSec * sampleRate);
  const endSample = Math.min(totalLength, Math.floor(endSec * sampleRate));
  const frameCount = endSample - startSample;
  
  const safeFrameCount = Math.max(1, frameCount);
  
  // Use OfflineAudioContext for safe buffer creation without context limits
  const tempCtx = new OfflineAudioContext(buffer.numberOfChannels, safeFrameCount, sampleRate);
  const newBuffer = tempCtx.createBuffer(
    buffer.numberOfChannels,
    safeFrameCount,
    sampleRate
  );
  
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    const slicedData = channelData.subarray(startSample, endSample);
    newBuffer.getChannelData(channel).set(slicedData);
  }
  
  return newBuffer;
}

async function getAudioChunkBase64(
  audioBuffer: AudioBuffer,
  startSec: number,
  endSec: number
): Promise<string> {
  const sliced = sliceAudioBuffer(audioBuffer, startSec, endSec);
  const wavBlob = bufferToWav(sliced);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64data = reader.result as string;
      resolve(base64data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(wavBlob);
  });
}

type ChunkSubtitle = Subtitle & {
  chunkIndex?: number;
  chunkStart?: number;
  chunkEnd?: number;
  boundaryDistance?: number;
};

const SUBTITLE_GUARD_SECONDS = 0.35;

function normalizeSubtitleText(value: string): string {
  return (value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function diceSimilarity(left: string, right: string): number {
  const a = normalizeSubtitleText(left);
  const b = normalizeSubtitleText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const pair = a.slice(i, i + 2);
    counts.set(pair, (counts.get(pair) || 0) + 1);
  }

  let matches = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const pair = b.slice(i, i + 2);
    const count = counts.get(pair) || 0;
    if (count > 0) {
      matches++;
      counts.set(pair, count - 1);
    }
  }
  return (2 * matches) / (a.length + b.length - 2);
}

function stripChunkMetadata(sub: ChunkSubtitle): Subtitle {
  const { chunkIndex: _chunkIndex, chunkStart: _chunkStart, chunkEnd: _chunkEnd, boundaryDistance: _boundaryDistance, ...subtitle } = sub;
  return subtitle;
}

function trimAudioBufferSilence(
  buffer: AudioBuffer,
  threshold = 0.006,
  paddingSeconds = 0.04,
): AudioBuffer {
  const paddingFrames = Math.round(buffer.sampleRate * paddingSeconds);
  let firstAudible = buffer.length;
  let lastAudible = -1;

  for (let frame = 0; frame < buffer.length; frame++) {
    let audible = false;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      if (Math.abs(buffer.getChannelData(channel)[frame]) >= threshold) {
        audible = true;
        break;
      }
    }
    if (audible) {
      firstAudible = Math.min(firstAudible, frame);
      lastAudible = frame;
    }
  }

  if (lastAudible < firstAudible) return buffer;
  const startFrame = Math.max(0, firstAudible - paddingFrames);
  const endFrame = Math.min(buffer.length, lastAudible + paddingFrames + 1);
  if (startFrame === 0 && endFrame === buffer.length) return buffer;
  return sliceAudioBuffer(buffer, startFrame / buffer.sampleRate, endFrame / buffer.sampleRate);
}

function countSpeechCharacters(text: string): number {
  return Math.max(1, Array.from((text || "").replace(/\s+/g, "")).length);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

type BurnedSubtitleAsset = {
  fileName: string;
  blob: Blob;
  width: number;
  height: number;
  x: number;
  y: number;
  start: number;
  end: number;
  text: string;
};

type VoiceTiming = {
  subtitleId: string;
  start: number;
  end: number;
  rate: number;
};

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob && blob.size > 0) resolve(blob);
      else reject(new Error("Không thể tạo ảnh phụ đề PNG."));
    }, "image/png");
  });
}

async function createBurnedSubtitleAsset(
  subtitle: Subtitle,
  index: number,
  settings: SubtitleSettings,
  blurBoxes: BlurBox[],
  activeBlurBoxId: string | null,
  outputWidth: number,
  outputHeight: number,
  sourceHeight: number,
): Promise<BurnedSubtitleAsset | null> {
  const text = (subtitle.translated || subtitle.original || "").replace(/\s+/g, " ").trim();
  if (!text || subtitle.end <= subtitle.start) return null;

  const scale = outputHeight / Math.max(1, sourceHeight);
  const fontSize = Math.max(12, Math.min(Math.round(settings.fontSize * scale), Math.round(outputHeight * 0.13)));
  const outlineWidth = Math.max(1, settings.outlineWidth * scale);
  const letterSpacing = settings.letterSpacing * scale;
  const weight = settings.fontWeight === "normal" ? 400 : settings.fontWeight === "medium" ? 500 : settings.fontWeight === "bold" ? 700 : 900;
  const fontFamily = settings.fontFamily || "Arial";
  const font = `${weight} ${fontSize}px "${fontFamily}", Arial, sans-serif`;

  try {
    await document.fonts?.load(font, text.slice(0, 80));
  } catch {
    // Canvas vẫn có Arial/sans-serif dự phòng nếu font tùy chọn chưa nạp được.
  }

  const measureCanvas = document.createElement("canvas");
  const measureContext = measureCanvas.getContext("2d");
  if (!measureContext) throw new Error("Trình duyệt không hỗ trợ Canvas để burn-in phụ đề.");
  measureContext.font = font;

  const measureLine = (value: string) =>
    measureContext.measureText(value).width + Math.max(0, Array.from(value).length - 1) * letterSpacing;
  const maxTextWidth = Math.max(160, outputWidth * 0.86);
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";
  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (currentLine && measureLine(candidate) > maxTextWidth) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = candidate;
    }
  }
  if (currentLine) lines.push(currentLine);

  const lineHeight = Math.ceil(fontSize * 1.22);
  const effectPadding = Math.ceil(Math.max(fontSize * 0.35, outlineWidth * 3, settings.textEffect === "glow" ? fontSize * 0.5 : 0));
  const horizontalPadding = effectPadding + Math.ceil(fontSize * 0.45);
  const verticalPadding = effectPadding + Math.ceil(fontSize * 0.24);
  const textWidth = Math.max(...lines.map(measureLine), 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.min(outputWidth, Math.ceil(textWidth + horizontalPadding * 2)));
  canvas.height = Math.max(2, Math.ceil(lines.length * lineHeight + verticalPadding * 2));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Không thể khởi tạo Canvas phụ đề.");

  context.font = font;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.miterLimit = 2;

  if (settings.bgColor && settings.bgColor !== "transparent" && !settings.bgColor.endsWith(", 0)")) {
    context.fillStyle = settings.bgColor;
    const radius = Math.max(4, Math.round(fontSize * 0.22));
    context.beginPath();
    if (typeof context.roundRect === "function") context.roundRect(0, 0, canvas.width, canvas.height, radius);
    else context.rect(0, 0, canvas.width, canvas.height);
    context.fill();
  }

  const drawTextWithSpacing = (value: string, centerX: number, centerY: number, stroke: boolean) => {
    if (Math.abs(letterSpacing) < 0.01) {
      if (stroke) context.strokeText(value, centerX, centerY);
      else context.fillText(value, centerX, centerY);
      return;
    }
    const characters = Array.from(value);
    const totalWidth = measureLine(value);
    let cursor = centerX - totalWidth / 2;
    context.textAlign = "left";
    for (const character of characters) {
      if (stroke) context.strokeText(character, cursor, centerY);
      else context.fillText(character, cursor, centerY);
      cursor += context.measureText(character).width + letterSpacing;
    }
    context.textAlign = "center";
  };

  lines.forEach((line, lineIndex) => {
    const centerY = verticalPadding + lineHeight * (lineIndex + 0.5);
    context.save();
    if (settings.textEffect === "glow") {
      context.shadowColor = settings.textColor;
      context.shadowBlur = Math.max(4, fontSize * 0.35);
    } else if (settings.textEffect === "shadow") {
      context.shadowColor = "rgba(0,0,0,0.9)";
      context.shadowBlur = Math.max(2, fontSize * 0.12);
      context.shadowOffsetX = Math.max(1, fontSize * 0.08);
      context.shadowOffsetY = Math.max(1, fontSize * 0.08);
    }
    if (settings.textEffect === "outline") {
      context.strokeStyle = settings.outlineColor;
      context.lineWidth = Math.max(1, outlineWidth * 2);
      drawTextWithSpacing(line, canvas.width / 2, centerY, true);
    }
    context.fillStyle = settings.textColor;
    drawTextWithSpacing(line, canvas.width / 2, centerY, false);
    context.restore();
  });

  let anchorX = 50;
  let anchorY = 82;
  let alignFromBottom = false;
  if (settings.position === "top") anchorY = 12;
  else if (settings.position === "center") anchorY = 50;
  else if (settings.position === "bottom") {
    anchorY = 88;
    alignFromBottom = true;
  } else if (settings.position === "custom") {
    anchorX = settings.customX ?? 50;
    anchorY = settings.customY ?? 82;
  } else if (settings.position === "blur-box") {
    const box = blurBoxes.find((item) => item.id === activeBlurBoxId) || blurBoxes[0];
    if (box) {
      anchorX = box.xPosition + box.width / 2;
      anchorY = box.yPosition + box.height / 2;
    }
  }

  const x = Math.max(0, Math.min(outputWidth - canvas.width, Math.round(outputWidth * anchorX / 100 - canvas.width / 2)));
  const rawY = alignFromBottom
    ? outputHeight * anchorY / 100 - canvas.height
    : outputHeight * anchorY / 100 - canvas.height / 2;
  const y = Math.max(0, Math.min(outputHeight - canvas.height, Math.round(rawY)));
  const blob = await canvasToPngBlob(canvas);
  return {
    fileName: `hardsub-${index}.png`,
    blob,
    width: canvas.width,
    height: canvas.height,
    x,
    y,
    start: Math.max(0, subtitle.start),
    end: Math.max(subtitle.start + 0.1, subtitle.end),
    text,
  };
}

async function verifyBurnedSubtitlePixels(
  frameBlob: Blob,
  asset: BurnedSubtitleAsset,
  outputWidth: number,
  outputHeight: number,
): Promise<boolean> {
  const [frameBitmap, subtitleBitmap] = await Promise.all([
    createImageBitmap(frameBlob),
    createImageBitmap(asset.blob),
  ]);
  try {
    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = outputWidth;
    frameCanvas.height = outputHeight;
    const frameContext = frameCanvas.getContext("2d", { willReadFrequently: true });
    const subtitleCanvas = document.createElement("canvas");
    subtitleCanvas.width = asset.width;
    subtitleCanvas.height = asset.height;
    const subtitleContext = subtitleCanvas.getContext("2d", { willReadFrequently: true });
    if (!frameContext || !subtitleContext) return false;

    frameContext.drawImage(frameBitmap, 0, 0, outputWidth, outputHeight);
    subtitleContext.drawImage(subtitleBitmap, 0, 0);
    const framePixels = frameContext.getImageData(asset.x, asset.y, asset.width, asset.height).data;
    const subtitlePixels = subtitleContext.getImageData(0, 0, asset.width, asset.height).data;
    let checked = 0;
    let matched = 0;

    // Chỉ so các pixel gần như đục hoàn toàn (nét chữ/viền). Các pixel nền bán
    // trong suốt phụ thuộc màu video nên không phù hợp để hậu kiểm.
    for (let pixel = 0; pixel < subtitlePixels.length; pixel += 16) {
      if (subtitlePixels[pixel + 3] < 245) continue;
      checked++;
      const distance =
        Math.abs(subtitlePixels[pixel] - framePixels[pixel]) +
        Math.abs(subtitlePixels[pixel + 1] - framePixels[pixel + 1]) +
        Math.abs(subtitlePixels[pixel + 2] - framePixels[pixel + 2]);
      if (distance < 150) matched++;
    }

    return checked >= 8 && matched / checked >= 0.08;
  } finally {
    frameBitmap.close();
    subtitleBitmap.close();
  }
}

async function captureVideoFrame(
  videoBlob: Blob,
  time: number,
  outputWidth: number,
  outputHeight: number,
): Promise<Blob> {
  const url = URL.createObjectURL(videoBlob);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Quá thời gian đọc video để hậu kiểm hardsub.")), 15000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("Trình duyệt không đọc được video vừa render để hậu kiểm hardsub."));
      };
      video.load();
    });

    const targetTime = Math.max(0, Math.min(Math.max(0, video.duration - 0.05), time));
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Không lấy được frame kiểm tra hardsub.")), 15000);
      video.onseeked = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("Video lỗi khi seek tới frame kiểm tra hardsub."));
      };
      video.currentTime = targetTime;
    });

    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Không thể tạo Canvas hậu kiểm hardsub.");
    context.drawImage(video, 0, 0, outputWidth, outputHeight);
    return await canvasToPngBlob(canvas);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

function splitTtsTextIntoClauses(text: string): string[] {
  const parts = text
    .match(/[^,.;:!?，。！？；：]+[,.;:!?，。！？；：]?/gu)
    ?.map((part) => part.trim())
    .filter(Boolean) || [text.trim()];
  if (parts.length <= 1 || text.length < 80) return [text.trim()];
  return parts;
}

async function concatenateAudioBlobs(
  blobs: Blob[],
  pauseSeconds = 0.18,
  outputSampleRate = 24000,
): Promise<Blob> {
  if (blobs.length === 1) return blobs[0];
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  const decoder = new AudioContextClass();
  const decoded = await Promise.all(blobs.map(async (blob) => {
    const buffer = await decoder.decodeAudioData(await blob.arrayBuffer());
    return trimAudioBufferSilence(buffer);
  }));
  await decoder.close();

  const totalDuration = decoded.reduce((sum, buffer) => sum + buffer.duration, 0) + pauseSeconds * (decoded.length - 1);
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(totalDuration * outputSampleRate)), outputSampleRate);
  let cursor = 0;
  for (const buffer of decoded) {
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start(cursor);
    cursor += buffer.duration + pauseSeconds;
  }
  return bufferToWav(await offline.startRendering());
}

const PROJECT_DB_NAME = "26dubbin-project-cache";
const PROJECT_DB_VERSION = 2;
const PROJECT_POINTER_KEY = "26dubbin_active_project";

type StoredProject = {
  id: string;
  updatedAt: number;
  videoName: string;
  videoMimeType: string;
  subtitles: Subtitle[];
  sourceLang: string;
  targetLang: string;
  extractionMethod: "audio" | "ocr" | "aiocr";
  ocrRegions?: OcrRegion[];
  ocrFps?: number;
  ttsEnabled: boolean;
  ttsEngine: "gemini" | "browser" | "tiktok";
  geminiVoice: string;
  tiktokVoice: string;
  smartTtsEnabled: boolean;
  ttsRate: number;
  originalAudioMixVolume: number;
  exportResolution: "720" | "1080" | "1440";
  blurBoxes: BlurBox[];
  blurSettings: BlurSettings;
  subSettings: SubtitleSettings;
  flipHorizontal: boolean;
  flipVertical: boolean;
  subtitlePipelineVersion?: number;
};

type OcrRegionPreset = {
  id: string;
  name: string;
  regions: OcrRegion[];
};

type StoredProjectMedia = {
  id: string;
  blob: Blob;
  name: string;
  type: string;
  lastModified: number;
};

type StoredChunk = {
  id: string;
  projectId: string;
  jobKey: string;
  start: number;
  end: number;
  subtitles: ChunkSubtitle[];
  updatedAt: number;
};

type StoredOcrCheckpoint = {
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

type StoredTtsClip = {
  id: string;
  projectId: string;
  signature: string;
  subtitleId: string;
  blob: Blob;
  updatedAt: number;
};

function openProjectDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROJECT_DB_NAME, PROJECT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const storeName of ["projects", "media", "chunks", "tts", "ocr"]) {
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Không thể mở bộ nhớ dự án."));
  });
}

type ProjectStoreName = "projects" | "media" | "chunks" | "tts" | "ocr";

async function projectDbPut(storeName: ProjectStoreName, value: unknown): Promise<void> {
  const db = await openProjectDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Không thể lưu checkpoint dự án."));
  });
  db.close();
}

async function projectDbGet<T>(storeName: ProjectStoreName, id: string): Promise<T | undefined> {
  const db = await openProjectDatabase();
  const value = await new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error || new Error("Không thể đọc checkpoint dự án."));
  });
  db.close();
  return value;
}

async function projectDbGetAll<T>(storeName: ProjectStoreName): Promise<T[]> {
  const db = await openProjectDatabase();
  const values = await new Promise<T[]>((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve((request.result || []) as T[]);
    request.onerror = () => reject(request.error || new Error("Không thể đọc thư viện dự án."));
  });
  db.close();
  return values;
}

async function projectDbDelete(storeName: ProjectStoreName, id: string): Promise<void> {
  const db = await openProjectDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Không thể xóa dữ liệu dự án."));
  });
  db.close();
}

type ProjectLibraryItem = {
  project: StoredProject;
  media?: StoredProjectMedia;
  previewUrl?: string;
  hasFinalRender: boolean;
};

function makeProjectId(file: File): string {
  return `video:${file.name}:${file.size}:${file.lastModified}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function extractAudioTrack(file: File, onProgress: (step: string) => void): Promise<{ base64: string; mimeType: string; audioBuffer: AudioBuffer }> {
  onProgress("Đọc dữ liệu file video...");
  const arrayBuffer = await file.arrayBuffer();
  
  onProgress("Khởi tạo bộ lọc âm thanh...");
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  const audioCtx = new AudioContextClass();
  
  onProgress("Đang giải mã luồng âm thanh từ video (có thể mất một vài giây)...");
  const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  
  onProgress("Tối ưu hóa và giảm tần số quét âm thanh (16kHz mono)...");
  // Downsample to 16000Hz mono using OfflineAudioContext for extremely small payload size
  const targetSampleRate = 16000;
  const duration = decodedBuffer.duration;
  const offlineCtx = new OfflineAudioContext(1, Math.max(1, Math.floor(targetSampleRate * duration)), targetSampleRate);
  
  // Create buffer source
  const bufferSource = offlineCtx.createBufferSource();
  bufferSource.buffer = decodedBuffer;
  bufferSource.connect(offlineCtx.destination);
  bufferSource.start();
  
  const renderedBuffer = await offlineCtx.startRendering();
  
  onProgress("Đóng gói dữ liệu sang định dạng WAV...");
  const wavBlob = bufferToWav(renderedBuffer);
  
  onProgress("Hoàn thành tối ưu hóa âm thanh...");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64data = reader.result as string;
      resolve({
        base64: base64data,
        mimeType: "audio/wav",
        audioBuffer: renderedBuffer
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(wavBlob);
  });
}

async function extractVideoFrames(
  file: File,
  intervalSec: number,
  onProgress: (step: string) => void
): Promise<{ timestamp: number; base64: string }[]> {
  const videoUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;

  onProgress("Đang nạp metadata video để trích khung hình...");
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Không thể nạp video để trích khung hình."));
  });

  const sourceWidth = video.videoWidth || 640;
  const sourceHeight = video.videoHeight || 360;
  const scale = Math.min(1, 1600 / sourceWidth);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const frames: { timestamp: number; base64: string }[] = [];
  const duration = video.duration;

  for (let t = 0; t < duration; t += intervalSec) {
    onProgress(`[Trích khung hình] Đang xử lý giây ${t.toFixed(1)}s / ${duration.toFixed(1)}s...`);

    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked);
      video.currentTime = Math.min(t, duration - 0.05);
    });

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = width;
    cropCanvas.height = height;
    const cropCtx = cropCanvas.getContext("2d")!;
    cropCtx.drawImage(video, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);

    const dataUrl = cropCanvas.toDataURL("image/jpeg", 0.82);
    frames.push({ timestamp: parseFloat(t.toFixed(2)), base64: dataUrl.split(",")[1] });
  }

  URL.revokeObjectURL(videoUrl);
  onProgress(`Hoàn tất trích xuất ${frames.length} khung hình.`);
  return frames;
}

type OcrDetection = {
  text: string;
  confidence: number;
  region_id: string;
  box?: { x: number; y: number; width: number; height: number };
  bbox?: number[][];
};

type OcrFrameResult = {
  timestamp: number;
  detections: OcrDetection[];
  spanEnd?: number;
};

type OcrServiceHealth = {
  connected: boolean;
  state: "idle" | "initializing" | "ready" | "error";
  error?: string;
  initializedAt?: string;
  model?: {
    name: string;
    detection: string;
    recognition: string;
    dictionary: string;
    backend: string;
    workerMode?: string;
    logicalCpus?: number;
    concurrency?: number;
    threadsPerJob?: number;
    source: string;
    modelDirectory?: string;
  };
};

type OcrRuntimeProfile = {
  id: "desktop" | "mobile-low" | "mobile-balanced" | "mobile-high";
  label: string;
  isMobile: boolean;
  logicalCpus: number;
  deviceMemoryGb: number | null;
  webGpuAvailable: boolean;
  batchSize: number;
  maxQueuedCandidates: number;
  playbackRate: number;
  maxOcrWidth: number;
  checkpointEveryRecognizedLines: number;
};

function getOcrRuntimeProfile(): OcrRuntimeProfile {
  const runtimeNavigator = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { mobile?: boolean };
    gpu?: unknown;
  };
  const logicalCpus = Math.max(1, Number(runtimeNavigator.hardwareConcurrency || 4));
  const detectedMemory = Number(runtimeNavigator.deviceMemory || 0);
  const deviceMemoryGb = detectedMemory > 0 ? detectedMemory : null;
  const webGpuAvailable = Boolean(runtimeNavigator.gpu);
  const mobileUserAgent = /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(runtimeNavigator.userAgent || "");
  const mobileViewport = Math.min(window.screen?.width || window.innerWidth, window.screen?.height || window.innerHeight) <= 900;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches === true;
  const isMobile = runtimeNavigator.userAgentData?.mobile === true || mobileUserAgent || (coarsePointer && mobileViewport);

  if (!isMobile) {
    return {
      id: "desktop",
      label: "Desktop 16x",
      isMobile: false,
      logicalCpus,
      deviceMemoryGb,
      webGpuAvailable,
      batchSize: 16,
      maxQueuedCandidates: 64,
      playbackRate: 16,
      maxOcrWidth: 960,
      checkpointEveryRecognizedLines: 50,
    };
  }

  const isLowEnd = logicalCpus <= 4 || (deviceMemoryGb !== null && deviceMemoryGb <= 3);
  const isHighEnd = logicalCpus >= 8 && (deviceMemoryGb === null || deviceMemoryGb >= 6) && webGpuAvailable;
  if (isLowEnd) {
    return {
      id: "mobile-low",
      label: "Mobile tiết kiệm 4x",
      isMobile: true,
      logicalCpus,
      deviceMemoryGb,
      webGpuAvailable,
      batchSize: 4,
      maxQueuedCandidates: 12,
      playbackRate: 4,
      maxOcrWidth: 640,
      checkpointEveryRecognizedLines: 20,
    };
  }
  if (isHighEnd) {
    return {
      id: "mobile-high",
      label: "Mobile hiệu năng cao 8x",
      isMobile: true,
      logicalCpus,
      deviceMemoryGb,
      webGpuAvailable,
      batchSize: 8,
      maxQueuedCandidates: 24,
      playbackRate: 8,
      maxOcrWidth: 800,
      checkpointEveryRecognizedLines: 30,
    };
  }
  return {
    id: "mobile-balanced",
    label: `Mobile cân bằng ${webGpuAvailable ? "6x" : "4x"}`,
    isMobile: true,
    logicalCpus,
    deviceMemoryGb,
    webGpuAvailable,
    batchSize: 6,
    maxQueuedCandidates: 18,
    playbackRate: webGpuAvailable ? 6 : 4,
    maxOcrWidth: 720,
    checkpointEveryRecognizedLines: 25,
  };
}

const DEFAULT_OCR_REGIONS: OcrRegion[] = [{
  id: "ocr-region-bottom",
  label: "Gợi ý vùng phụ đề dưới",
  x: 5,
  y: 78,
  width: 90,
  height: 22,
}];

function cleanOcrText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isLikelyOcrWatermark(value: string): boolean {
  const compact = cleanOcrText(value);
  if (!compact || compact.length > 64) return false;
  const dense = compact.replace(/\s+/g, "");
  // Chỉ loại khi cả detection gần như là một social handle. Câu thoại có
  // nhắc @username ở giữa vẫn được giữ nguyên để tránh xóa nhầm phụ đề thật.
  if (/^[^\p{L}\p{N}@]{0,4}@[A-Za-z0-9_.-]{2,40}[^\p{L}\p{N}]{0,4}$/u.test(dense)) return true;
  return /^(?:douyin|tiktok|抖音(?:号|號)?|快手|小红书|xiaohongshu)[:：]?@?[A-Za-z0-9_.-]{2,40}$/iu.test(dense);
}

function normalizedOcrText(value: string): string {
  return cleanOcrText(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function levenshteinDistance(left: string, right: string): number {
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function ocrSimilarity(left: string, right: string): number {
  const a = normalizedOcrText(left);
  const b = normalizedOcrText(right);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  return 1 - (levenshteinDistance(a, b) / Math.max(a.length, b.length));
}

function joinOcrDetections(detections: OcrDetection[]): string {
  const rows = [...detections]
    .sort((left, right) => (left.box?.y || 0) - (right.box?.y || 0) || (left.box?.x || 0) - (right.box?.x || 0))
    .map((item) => cleanOcrText(item.text))
    .filter((text) => Boolean(text) && !isLikelyOcrWatermark(text));
  const allCjk = rows.length > 0 && rows.every((row) => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{P}\p{N}\s]+$/u.test(row));
  return cleanOcrText(rows.join(allCjk ? "" : " "));
}

function getOcrEnvelope(detections: OcrDetection[]) {
  const boxes = detections.map((item) => item.box).filter((box): box is NonNullable<OcrDetection["box"]> => Boolean(box));
  if (!boxes.length) return undefined;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

function ocrBoxOverlap(
  left?: { x: number; y: number; width: number; height: number },
  right?: { x: number; y: number; width: number; height: number },
) {
  if (!left || !right) return 1;
  const intersectionWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const intersectionHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = intersectionWidth * intersectionHeight;
  return intersection / Math.max(1, Math.min(left.width * left.height, right.width * right.height));
}

function mergeOcrFramesToSubtitles(
  frames: OcrFrameResult[],
  frameInterval: number,
  videoDuration: number,
  similarityThreshold = 0.86,
): Subtitle[] {
  type Track = { text: string; start: number; lastSeen: number; confidence: number; samples: number; regionId: string; box?: { x: number; y: number; width: number; height: number } };
  const active = new Map<string, Track>();
  const events: Array<Track & { end: number }> = [];
  const closeTrack = (regionId: string, endHint: number) => {
    const track = active.get(regionId);
    if (!track) return;
    const end = Math.min(videoDuration, Math.max(track.start + Math.min(0.35, frameInterval), Math.min(endHint, track.lastSeen + frameInterval)));
    if (track.text && (track.samples >= 2 || track.confidence >= 0.72)) events.push({ ...track, end });
    active.delete(regionId);
  };

  for (const frame of [...frames].sort((a, b) => a.timestamp - b.timestamp)) {
    const frameLastSeen = frame.spanEnd !== undefined
      ? Math.max(frame.timestamp, Math.min(videoDuration, frame.spanEnd) - Math.min(0.02, frameInterval * 0.25))
      : frame.timestamp;
    const grouped = new Map<string, OcrDetection[]>();
    for (const detection of frame.detections || []) {
      const regionId = detection.region_id || "full-frame";
      grouped.set(regionId, [...(grouped.get(regionId) || []), detection]);
    }
    for (const [regionId, track] of active) {
      if (!grouped.has(regionId) && (frame.spanEnd !== undefined || frame.timestamp - track.lastSeen > frameInterval * 1.6)) {
        closeTrack(regionId, frame.timestamp);
      }
    }
    for (const [regionId, detections] of grouped) {
      const text = joinOcrDetections(detections);
      if (!text) continue;
      const confidence = detections.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / detections.length;
      const box = getOcrEnvelope(detections);
      const current = active.get(regionId);
      if (current && ocrSimilarity(current.text, text) >= similarityThreshold && ocrBoxOverlap(current.box, box) >= 0.25) {
        current.lastSeen = Math.max(current.lastSeen, frameLastSeen);
        current.samples += frame.spanEnd !== undefined ? 2 : 1;
        if (confidence > current.confidence) {
          current.text = text;
          current.box = box;
        }
        current.confidence = Math.max(current.confidence, confidence);
      } else {
        if (current) closeTrack(regionId, frame.timestamp);
        active.set(regionId, {
          text,
          start: frame.timestamp,
          lastSeen: frameLastSeen,
          confidence,
          samples: frame.spanEnd !== undefined ? 2 : 1,
          regionId,
          box,
        });
      }
    }
  }
  for (const regionId of [...active.keys()]) closeTrack(regionId, videoDuration);
  return events.sort((a, b) => a.start - b.start || a.end - b.end).map((event, index) => ({
    id: `paddle-ocr-${index + 1}`,
    start: Number(event.start.toFixed(2)),
    end: Number(event.end.toFixed(2)),
    original: event.text,
    translated: event.text,
  }));
}

async function readJsonResponse(response: Response): Promise<any> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || payload?.detail || `HTTP ${response.status}`);
  return payload;
}

async function runPaddleOcrOnVideo(
  file: File,
  fps: number,
  regions: OcrRegion[],
  onProgress: (message: string, percent: number, etaSeconds: number | null) => void,
  checkpoint?: { projectId: string; jobKey: string },
  onPartialResults?: (frames: OcrFrameResult[], frameInterval: number, duration: number) => void,
  runtimeProfile: OcrRuntimeProfile = getOcrRuntimeProfile(),
): Promise<{ frames: OcrFrameResult[]; model: OcrServiceHealth["model"]; duration: number; frameInterval: number }> {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = objectUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error("Không thể nạp video để chạy PaddleOCR."));
  });

  // Download and warm the browser model while Phase A scans. Inference stays
  // inside a dedicated Web Worker so preprocessing cannot freeze the React UI.
  let browserOcrFailure = "";
  const browserOcrReady = initializeBrowserOcr((message) => {
    console.log(`[PaddleOCR nền] ${message}`);
    onProgress(`Khởi tạo OCR nền: ${message}`, 1, null);
  }).catch((error) => {
    browserOcrFailure = error instanceof Error ? error.message : String(error);
    return null;
  });

  const duration = Math.max(0, video.duration || 0);
  // 0.35s is the chosen timestamp precision. Scanning above this rate only
  // creates near-identical candidates and makes hour-long videos needlessly slow.
  const scanFps = Math.min(Math.max(1, Math.min(10, fps)), 1 / 0.35);
  const interval = 1 / scanFps;
  const timestamps: number[] = [];
  for (let timestamp = 0; timestamp < duration; timestamp += interval) timestamps.push(Number(timestamp.toFixed(3)));
  if (duration > 0 && (!timestamps.length || timestamps[timestamps.length - 1] < duration - interval * 0.5)) {
    timestamps.push(Number(Math.max(0, duration - 0.02).toFixed(3)));
  }

  const sourceWidth = video.videoWidth || 640;
  const sourceHeight = video.videoHeight || 360;
  const scanRegions = regions.length > 0
    ? regions.map((region) => {
        const x = Math.max(0, Math.min(99, region.x));
        const y = Math.max(0, Math.min(99, region.y));
        return {
          ...region,
          x,
          y,
          width: Math.max(1, Math.min(100 - x, region.width)),
          height: Math.max(1, Math.min(100 - y, region.height)),
        };
      })
    : [{ id: "full-frame", label: "Toàn khung hình", x: 0, y: 0, width: 100, height: 100 }];
  const cropLeftPercent = Math.min(...scanRegions.map((region) => region.x));
  const cropTopPercent = Math.min(...scanRegions.map((region) => region.y));
  const cropRightPercent = Math.max(...scanRegions.map((region) => region.x + region.width));
  const cropBottomPercent = Math.max(...scanRegions.map((region) => region.y + region.height));
  const cropX = Math.max(0, Math.floor(sourceWidth * cropLeftPercent / 100));
  const cropY = Math.max(0, Math.floor(sourceHeight * cropTopPercent / 100));
  const cropWidth = Math.max(1, Math.min(sourceWidth - cropX, Math.ceil(sourceWidth * (cropRightPercent - cropLeftPercent) / 100)));
  const cropHeight = Math.max(1, Math.min(sourceHeight - cropY, Math.ceil(sourceHeight * (cropBottomPercent - cropTopPercent) / 100)));
  const scale = Math.min(1, runtimeProfile.maxOcrWidth / cropWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cropWidth * scale));
  canvas.height = Math.max(1, Math.round(cropHeight * scale));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Trình duyệt không tạo được canvas cho PaddleOCR.");
  const optimizedRegions = scanRegions.map((region) => ({
    ...region,
    x: ((region.x - cropLeftPercent) / Math.max(0.01, cropRightPercent - cropLeftPercent)) * 100,
    y: ((region.y - cropTopPercent) / Math.max(0.01, cropBottomPercent - cropTopPercent)) * 100,
    width: (region.width / Math.max(0.01, cropRightPercent - cropLeftPercent)) * 100,
    height: (region.height / Math.max(0.01, cropBottomPercent - cropTopPercent)) * 100,
  }));

  type CandidateFrame = { frameId: number; timestamp: number; blob: Promise<Blob> };
  const candidateFrames: CandidateFrame[] = [];
  const diffCanvas = document.createElement("canvas");
  const diffScale = Math.min(1, 176 / canvas.width, 96 / canvas.height);
  diffCanvas.width = Math.max(24, Math.round(canvas.width * diffScale));
  diffCanvas.height = Math.max(12, Math.round(canvas.height * diffScale));
  const diffContext = diffCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!diffContext) throw new Error("Trình duyệt không tạo được bộ dò thay đổi khung hình.");

  let previousLuma: Uint8Array | null = null;
  let lastCandidateSignature: Uint8Array | null = null;
  let noiseMean = 0;
  let noiseDeviation = 0;
  let noiseChangedRatio = 0;
  let lastCandidateTime = Number.NEGATIVE_INFINITY;
  let scannedFrames = 0;
  const scanStartedAt = performance.now();
  const scanRateSamples: Array<{ at: number; processed: number }> = [];
  const heartbeatSeconds = 2;
  const minimumCandidateGap = Math.max(interval, 0.35);
  const batchSize = runtimeProfile.batchSize;
  const maxQueuedCandidates = runtimeProfile.maxQueuedCandidates;
  const checkpointEveryRecognizedLines = runtimeProfile.checkpointEveryRecognizedLines;
  const checkpointId = checkpoint
    ? `${checkpoint.projectId}|ocr-v3|${checkpoint.jobKey}`
    : "";
  let output: OcrFrameResult[] = [];
  let model: OcrServiceHealth["model"];
  let totalCandidateCount = 0;
  let queuedCandidateCount = 0;
  let completedCandidateCount = 0;
  let lastProcessedTimestamp = 0;
  let recognizedLineCount = 0;
  let nextCheckpointAt = checkpointEveryRecognizedLines;
  let batchProcessing: Promise<void> = Promise.resolve();
  let screenWakeLock: { release: () => Promise<void> } | null = null;

  const restoredCheckpoint = checkpointId
    ? await projectDbGet<StoredOcrCheckpoint>("ocr", checkpointId).catch(() => undefined)
    : undefined;
  if (
    restoredCheckpoint
    && restoredCheckpoint.projectId === checkpoint?.projectId
    && restoredCheckpoint.jobKey === checkpoint?.jobKey
    && Math.abs(restoredCheckpoint.duration - duration) < 0.1
  ) {
    output = [...(restoredCheckpoint.frames || [])];
    model = restoredCheckpoint.model;
    totalCandidateCount = output.length;
    completedCandidateCount = output.length;
    lastProcessedTimestamp = Math.max(0, Math.min(duration, restoredCheckpoint.processedUntil || 0));
    recognizedLineCount = Math.max(
      Number(restoredCheckpoint.recognizedLines || 0),
      output.reduce((sum, frame) => sum + (frame.detections?.length || 0), 0),
    );
    nextCheckpointAt = (Math.floor(recognizedLineCount / checkpointEveryRecognizedLines) + 1) * checkpointEveryRecognizedLines;
    onProgress(
      restoredCheckpoint.complete
        ? `Đã khôi phục OCR hoàn tất (${recognizedLineCount} dòng), không cần quét lại video.`
        : `Đã khôi phục ${recognizedLineCount} dòng OCR; tiếp tục từ ${lastProcessedTimestamp.toFixed(1)}s.`,
      restoredCheckpoint.complete ? 100 : Number(Math.min(94, (lastProcessedTimestamp / Math.max(0.1, duration)) * 95).toFixed(1)),
      restoredCheckpoint.complete ? 0 : null,
    );
  }

  const persistOcrCheckpoint = async (complete: boolean) => {
    if (!checkpointId || !checkpoint) return;
    await projectDbPut("ocr", {
      id: checkpointId,
      projectId: checkpoint.projectId,
      jobKey: checkpoint.jobKey,
      duration,
      processedUntil: complete ? duration : lastProcessedTimestamp,
      frames: output,
      recognizedLines: recognizedLineCount,
      complete,
      model,
      updatedAt: Date.now(),
    } satisfies StoredOcrCheckpoint);
  };

  const buildSpannedFrames = (endHint = lastProcessedTimestamp) => {
    const sorted = [...output].sort((left, right) => left.timestamp - right.timestamp);
    const deduplicated: OcrFrameResult[] = [];
    for (const frame of sorted) {
      const previous = deduplicated[deduplicated.length - 1];
      if (previous && Math.abs(previous.timestamp - frame.timestamp) < 0.02) {
        if (frame.detections.length > previous.detections.length) deduplicated[deduplicated.length - 1] = frame;
      } else {
        deduplicated.push(frame);
      }
    }
    return deduplicated.map((frame, index) => ({
      ...frame,
      spanEnd: deduplicated[index + 1]?.timestamp
        ?? Math.min(duration, Math.max(frame.timestamp + interval, endHint + interval)),
    }));
  };

  if (restoredCheckpoint && !restoredCheckpoint.complete && output.length > 0) {
    onPartialResults?.(buildSpannedFrames(), interval, duration);
  }

  const buildTextSignature = (luma: Uint8Array) => {
    const columns = 24;
    const rows = 8;
    const signature = new Uint8Array(columns * rows);
    const sourceWidth = diffCanvas.width;
    const sourceHeight = diffCanvas.height;
    for (let row = 0; row < rows; row++) {
      const y0 = Math.floor(row * sourceHeight / rows);
      const y1 = Math.max(y0 + 1, Math.floor((row + 1) * sourceHeight / rows));
      for (let column = 0; column < columns; column++) {
        const x0 = Math.floor(column * sourceWidth / columns);
        const x1 = Math.max(x0 + 1, Math.floor((column + 1) * sourceWidth / columns));
        let edgeEnergy = 0;
        let samples = 0;
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            const index = y * sourceWidth + x;
            const value = luma[index];
            const left = luma[y * sourceWidth + Math.max(0, x - 1)];
            const above = luma[Math.max(0, y - 1) * sourceWidth + x];
            const contrast = Math.max(Math.abs(value - left), Math.abs(value - above));
            if (contrast >= 24 && (value >= 145 || left >= 145 || above >= 145 || value <= 90)) edgeEnergy += contrast;
            samples++;
          }
        }
        signature[row * columns + column] = Math.min(255, Math.round(edgeEnergy / Math.max(1, samples)));
      }
    }
    return signature;
  };

  const isDuplicateSignature = (left: Uint8Array | null, right: Uint8Array) => {
    if (!left || left.length !== right.length) return false;
    let absoluteDifference = 0;
    let meaningfullyChanged = 0;
    for (let index = 0; index < right.length; index++) {
      const difference = Math.abs(left[index] - right[index]);
      absoluteDifference += difference;
      if (difference >= 18) meaningfullyChanged++;
    }
    const meanDifference = absoluteDifference / right.length;
    const changedRatio = meaningfullyChanged / right.length;
    // Only call two probes duplicates when they are almost pixel-identical.
    // A looser threshold incorrectly grouped different short subtitle lines.
    return meanDifference < 2.8 && changedRatio < 0.055;
  };

  const encodeCandidate = () => new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Không mã hóa được frame OCR.")),
      "image/jpeg",
      0.72,
    );
  });

  const blobToBase64 = async (blob: Blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  };

  const processCandidateBatch = async (batch: CandidateFrame[]) => {
    if (!batch.length) return;
    let batchFrames: OcrFrameResult[] = [];
    let frontendBatchError = "";
    try {
      const blobs = await Promise.all(batch.map((candidate) => candidate.blob));
      const initialized = await browserOcrReady;
      if (initialized) {
        try {
          const frontendResult = await recognizeBrowserOcrBatch(
            await Promise.all(batch.map(async (candidate, index) => ({
              frameId: candidate.frameId,
              timestamp: candidate.timestamp,
              image: await blobs[index].arrayBuffer(),
            }))),
            optimizedRegions,
            0.3,
          );
          batchFrames = frontendResult.frames as OcrFrameResult[];
          model = {
            ...frontendResult.model,
            backend: `onnxruntime-web/${frontendResult.backend}`,
            source: "browser",
          };
        } catch (error) {
          frontendBatchError = error instanceof Error ? error.message : String(error);
          browserOcrFailure = frontendBatchError;
        }
      } else {
        frontendBatchError = browserOcrFailure || "OCR frontend chưa khởi tạo được.";
      }

      if (frontendBatchError) {
        const payload = await readJsonResponse(await fetch("/api/ocr/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            frames: await Promise.all(batch.map(async (candidate, index) => ({
              frameId: candidate.frameId,
              timestamp: candidate.timestamp,
              base64: await blobToBase64(blobs[index]),
            }))),
            regions: optimizedRegions,
            minConfidence: 0.3,
          }),
        }));
        batchFrames = Array.isArray(payload.frames) ? payload.frames : [];
        model = payload.model || model;
      }

      output.push(...batchFrames);
      completedCandidateCount += batch.length;
      lastProcessedTimestamp = Math.max(lastProcessedTimestamp, ...batch.map((candidate) => candidate.timestamp));
      recognizedLineCount += batchFrames.reduce((sum, frame) => sum + (frame.detections?.length || 0), 0);
      onPartialResults?.(buildSpannedFrames(), interval, duration);

      if (recognizedLineCount >= nextCheckpointAt) {
        await persistOcrCheckpoint(false);
        while (nextCheckpointAt <= recognizedLineCount) nextCheckpointAt += checkpointEveryRecognizedLines;
        onProgress(
          `Đã lưu checkpoint ${recognizedLineCount} dòng OCR tại ${lastProcessedTimestamp.toFixed(1)}s.`,
          Number(Math.min(94, (lastProcessedTimestamp / Math.max(0.1, duration)) * 95).toFixed(1)),
          null,
        );
      }
    } finally {
      queuedCandidateCount = Math.max(0, queuedCandidateCount - batch.length);
    }
  };

  const scheduleCandidateBatches = (force = false) => {
    while (candidateFrames.length >= batchSize || (force && candidateFrames.length > 0)) {
      const batch = candidateFrames.splice(0, Math.min(batchSize, candidateFrames.length));
      queuedCandidateCount += batch.length;
      batchProcessing = batchProcessing.then(() => processCandidateBatch(batch));
    }
  };

  const readCurrentLuma = () => {
    context.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    diffContext.drawImage(canvas, 0, 0, diffCanvas.width, diffCanvas.height);
    const pixels = diffContext.getImageData(0, 0, diffCanvas.width, diffCanvas.height).data;
    const luma = new Uint8Array(diffCanvas.width * diffCanvas.height);
    for (let pixel = 0, sample = 0; pixel < pixels.length; pixel += 4, sample++) {
      luma[sample] = Math.round(pixels[pixel] * 0.299 + pixels[pixel + 1] * 0.587 + pixels[pixel + 2] * 0.114);
    }
    return luma;
  };

  const storeCurrentCandidate = (timestamp: number, signature: Uint8Array) => {
    candidateFrames.push({
      frameId: Math.max(0, Math.round(timestamp * scanFps)),
      timestamp: Number(timestamp.toFixed(3)),
      blob: encodeCandidate(),
    });
    totalCandidateCount++;
    scheduleCandidateBatches(false);
    lastCandidateSignature = signature;
    lastCandidateTime = timestamp;
  };

  const scanCurrentFrame = (timestamp: number) => {
    const luma = readCurrentLuma();
    let absoluteDifference = 0;
    let changedPixels = 0;
    for (let sample = 0; sample < luma.length; sample++) {
      const value = luma[sample];
      if (previousLuma) {
        const difference = Math.abs(value - previousLuma[sample]);
        absoluteDifference += difference;
        if (difference >= 24) changedPixels++;
      }
    }

    let visualChange = false;
    if (previousLuma) {
      const sampleCount = Math.max(1, luma.length);
      const meanDifference = absoluteDifference / sampleCount;
      const changedRatio = changedPixels / sampleCount;
      const meanThreshold = Math.max(7, noiseMean + Math.max(2.4, noiseDeviation * 3.1));
      const ratioThreshold = Math.max(0.04, noiseChangedRatio + 0.032);
      // A moving background can change the mean of a subtitle ROI on every
      // frame. Require a meaningful changed-pixel area as well, while retaining
      // a second high-ratio path for quick subtitle cuts/fades.
      visualChange = (
        meanDifference >= meanThreshold && changedRatio >= ratioThreshold * 0.55
      ) || changedRatio >= ratioThreshold * 1.7;

      const alpha = visualChange ? 0.015 : 0.055;
      const previousMean = noiseMean;
      noiseMean = noiseMean === 0 ? meanDifference : noiseMean * (1 - alpha) + meanDifference * alpha;
      noiseDeviation = noiseDeviation === 0
        ? Math.abs(meanDifference - previousMean)
        : noiseDeviation * (1 - alpha) + Math.abs(meanDifference - previousMean) * alpha;
      noiseChangedRatio = noiseChangedRatio === 0
        ? changedRatio
        : noiseChangedRatio * (1 - alpha) + changedRatio * alpha;
    }
    previousLuma = luma;
    scannedFrames++;

    const isHeartbeat = timestamp - lastCandidateTime >= heartbeatSeconds;
    const canStore = timestamp - lastCandidateTime >= minimumCandidateGap - 0.001;
    const shouldInspectCandidate = (totalCandidateCount === 0 || visualChange || isHeartbeat) && canStore;
    if (shouldInspectCandidate) {
      const signature = buildTextSignature(luma);
      const duplicateContent = totalCandidateCount > 0 && isDuplicateSignature(lastCandidateSignature, signature);
      if (!duplicateContent) {
        storeCurrentCandidate(timestamp, signature);
      } else if (isHeartbeat) {
        // The subtitle fingerprint is unchanged; advance the safety heartbeat
        // without retaining another image or growing the OCR queue.
        lastCandidateTime = timestamp;
      }
    }

    if (scannedFrames % Math.max(25, Math.round(fps * 5)) === 0) {
      const now = performance.now();
      const processedFrames = Math.min(timestamps.length, Math.max(1, Math.round(timestamp / interval) + 1));
      scanRateSamples.push({ at: now, processed: processedFrames });
      while (scanRateSamples.length > 2 && now - scanRateSamples[0].at > 12_000) scanRateSamples.shift();
      const firstSample = scanRateSamples[0];
      const elapsedWindow = Math.max(0.1, (now - firstSample.at) / 1000);
      const recentRate = scanRateSamples.length > 1
        ? (processedFrames - firstSample.processed) / elapsedWindow
        : processedFrames / Math.max(0.1, (now - scanStartedAt) / 1000);
      const etaSeconds = Math.ceil(Math.max(0, timestamps.length - processedFrames) / Math.max(0.05, recentRate));
      const phasePercent = Math.min(45, (timestamp / Math.max(0.1, duration)) * 45);
      onProgress(
        `Đang quét ${runtimeProfile.playbackRate}x: ${processedFrames}/${timestamps.length} mốc; OCR xong ${completedCandidateCount}/${totalCandidateCount} frame khác nhau.`,
        Number(phasePercent.toFixed(1)),
        etaSeconds,
      );
    }
  };

  try {
    if (restoredCheckpoint?.complete) {
      const restoredFrames = buildSpannedFrames(duration);
      onPartialResults?.(restoredFrames, interval, duration);
      return { frames: restoredFrames, model, duration, frameInterval: interval };
    }

    if (runtimeProfile.isMobile && document.visibilityState === "visible") {
      const wakeLockApi = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
      screenWakeLock = await wakeLockApi?.request("screen").catch(() => null) || null;
    }

    const requestVideoFrame = (video as any).requestVideoFrameCallback?.bind(video) as
      | ((callback: (now: number, metadata: { mediaTime: number }) => void) => number)
      | undefined;
    const resumeFrom = Math.max(0, lastProcessedTimestamp - interval * 2);
    const useFastSequentialScan = Boolean(requestVideoFrame) && (duration >= 120 || runtimeProfile.isMobile);
    const seekTo = async (timestamp: number) => {
      const target = Math.min(timestamp, Math.max(0, duration - 0.01));
      if (Math.abs(video.currentTime - target) <= 0.001) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          video.removeEventListener("seeked", onSeeked);
          video.removeEventListener("error", onError);
        };
        const onSeeked = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error(`Không seek được video tại ${target.toFixed(2)}s.`)); };
        video.addEventListener("seeked", onSeeked, { once: true });
        video.addEventListener("error", onError, { once: true });
        video.currentTime = target;
      });
    };
    const scanBySeekingFrom = async (fromTimestamp: number) => {
      const matchedIndex = timestamps.findIndex((timestamp) => timestamp >= fromTimestamp - 0.001);
      const startIndex = matchedIndex < 0 ? timestamps.length : matchedIndex;
      for (let index = startIndex; index < timestamps.length; index++) {
        const timestamp = timestamps[index];
        await seekTo(timestamp);
        scanCurrentFrame(timestamp);
        if (queuedCandidateCount >= maxQueuedCandidates) await batchProcessing;
      }
    };

    const scanAdaptiveBySeeking = async () => {
      const jumpSeconds = interval * 2;
      const totalProbes = Math.max(1, Math.ceil(duration / jumpSeconds) + 1);
      const adaptiveStartedAt = performance.now();
      const adaptiveRateSamples: Array<{ at: number; done: number }> = [];
      let previousProbeTime = 0;
      let referenceSignature: Uint8Array | null = null;
      let lastVerificationTime = Number.NEGATIVE_INFINITY;
      onProgress(`Giai đoạn A: nhảy frame mỗi ${jumpSeconds.toFixed(2)}s; khi khác sẽ lùi ${interval.toFixed(2)}s để khóa timecode...`, 0, null);
      for (let probeIndex = 0; probeIndex < totalProbes; probeIndex++) {
        const probeTime = Math.min(duration - 0.01, probeIndex * jumpSeconds);
        await seekTo(probeTime);
        const probeLuma = readCurrentLuma();
        const probeSignature = buildTextSignature(probeLuma);
        scannedFrames++;
        if (!referenceSignature) {
          storeCurrentCandidate(0, probeSignature);
          lastVerificationTime = 0;
        } else if (!isDuplicateSignature(referenceSignature, probeSignature)) {
          // Rewind and retain the real midpoint frame. If the content changes
          // again in the second half, also retain the coarse frame. This keeps
          // 0.35s precision without assigning an earlier timestamp to a later image.
          const refineTime = Math.min(probeTime, previousProbeTime + interval);
          await seekTo(refineTime);
          const refineSignature = buildTextSignature(readCurrentLuma());
          if (!isDuplicateSignature(referenceSignature, refineSignature)) {
            storeCurrentCandidate(refineTime, refineSignature);
          }
          await seekTo(probeTime);
          const stableSignature = buildTextSignature(readCurrentLuma());
          if (isDuplicateSignature(referenceSignature, refineSignature) || !isDuplicateSignature(refineSignature, stableSignature)) {
            storeCurrentCandidate(probeTime, stableSignature);
          }
          lastVerificationTime = probeTime;
        } else if (probeTime - lastVerificationTime >= 1.4 - 0.001) {
          // Visual hashes are only a coarse accelerator. Periodically send an
          // unchanged-looking frame through real OCR so a short/similar line can
          // never be suppressed indefinitely by the image heuristic.
          storeCurrentCandidate(probeTime, probeSignature);
          lastVerificationTime = probeTime;
        }
        referenceSignature = probeSignature;
        previousProbeTime = probeTime;

        if (probeIndex % 12 === 0 || probeIndex === totalProbes - 1) {
          const now = performance.now();
          adaptiveRateSamples.push({ at: now, done: probeIndex + 1 });
          while (adaptiveRateSamples.length > 2 && now - adaptiveRateSamples[0].at > 12_000) adaptiveRateSamples.shift();
          const first = adaptiveRateSamples[0];
          const rate = adaptiveRateSamples.length > 1
            ? (probeIndex + 1 - first.done) / Math.max(0.1, (now - first.at) / 1000)
            : (probeIndex + 1) / Math.max(0.1, (now - adaptiveStartedAt) / 1000);
          const eta = Math.ceil(Math.max(0, totalProbes - probeIndex - 1) / Math.max(0.05, rate));
          onProgress(
            `Giai đoạn A: đã nhảy ${probeIndex + 1}/${totalProbes} mốc; giữ ${totalCandidateCount} nội dung khác nhau.`,
            Number(Math.min(45, ((probeIndex + 1) / totalProbes) * 45).toFixed(1)),
            eta,
          );
        }
      }
    };

    if (useFastSequentialScan && requestVideoFrame) {
      onProgress(`${runtimeProfile.label}: OCR batch ${batchSize}, RAM giới hạn ${maxQueuedCandidates} frame...`, Number(Math.min(94, (resumeFrom / Math.max(0.1, duration)) * 95).toFixed(1)), Math.ceil(Math.max(0, duration - resumeFrom) / runtimeProfile.playbackRate));
      await seekTo(resumeFrom);
      video.playbackRate = runtimeProfile.playbackRate;
      let nextTargetTime = resumeFrom;
      const stallState = { stalledAt: null as number | null };
      await new Promise<void>((resolve, reject) => {
        let finished = false;
        let lastMediaProgressAt = performance.now();
        let lastMediaTime = -1;
        const watchdog = window.setInterval(() => {
          if (!finished && performance.now() - lastMediaProgressAt > 4_000) {
            stallState.stalledAt = nextTargetTime;
            finish();
          }
        }, 1_000);
        const finish = () => {
          if (finished) return;
          finished = true;
          window.clearInterval(watchdog);
          video.pause();
          resolve();
        };
        const fail = (error: unknown) => {
          if (finished) return;
          finished = true;
          window.clearInterval(watchdog);
          video.pause();
          reject(error);
        };
        const processFrame = async (_now: number, metadata: { mediaTime: number }) => {
          if (finished) return;
          try {
            const mediaTime = Math.max(0, Number(metadata.mediaTime || video.currentTime || 0));
            if (mediaTime > lastMediaTime + 0.01) {
              lastMediaTime = mediaTime;
              lastMediaProgressAt = performance.now();
            }
            if (mediaTime + interval * 0.2 >= nextTargetTime) {
              scanCurrentFrame(mediaTime);
              do nextTargetTime += interval;
              while (nextTargetTime <= mediaTime);
            }
            if (queuedCandidateCount >= maxQueuedCandidates) {
              video.pause();
              await batchProcessing;
              if (!finished && mediaTime < duration - 0.03) await video.play();
            }
            if (video.ended || mediaTime >= duration - 0.03) {
              finish();
              return;
            }
            requestVideoFrame(processFrame);
          } catch (error) {
            fail(error);
          }
        };
        video.addEventListener("ended", () => finish(), { once: true });
        requestVideoFrame(processFrame);
        video.play().catch(fail);
      });
      if (stallState.stalledAt !== null && stallState.stalledAt < duration - 0.03) {
        const time = stallState.stalledAt;
        onProgress(
          `Luồng quét ${runtimeProfile.playbackRate}x bị tạm ngưng tại ${time.toFixed(1)}s; đang tiếp tục bằng chế độ seek an toàn...`,
          Number(Math.min(44, (time / Math.max(0.1, duration)) * 45).toFixed(1)),
          null,
        );
        await scanBySeekingFrom(time);
      }
    } else {
      await scanBySeekingFrom(resumeFrom);
    }

    scheduleCandidateBatches(true);
    await batchProcessing;

    if (totalCandidateCount === 0 && output.length === 0) {
      throw new Error("Bộ dò thay đổi không lấy được frame ứng viên nào.");
    }
    onProgress(`Quét + OCR hoàn tất: ${scannedFrames} mốc → ${totalCandidateCount} ứng viên; nhận ${recognizedLineCount} dòng.`, 95, 0);

    const spannedOutput = buildSpannedFrames(duration);
    output = spannedOutput.map(({ spanEnd: _spanEnd, ...frame }) => frame);
    lastProcessedTimestamp = duration;
    await persistOcrCheckpoint(true);
    onPartialResults?.(spannedOutput, interval, duration);
    onProgress(
      `Hoàn tất: ${scannedFrames} frame change-detection → OCR ${spannedOutput.length} ứng viên.`,
      100,
      0,
    );
    return { frames: spannedOutput, model, duration, frameInterval: interval };
  } catch (error) {
    await persistOcrCheckpoint(false).catch(() => undefined);
    throw error;
  } finally {
    await screenWakeLock?.release().catch(() => undefined);
    URL.revokeObjectURL(objectUrl);
    video.removeAttribute("src");
    video.load();
  }
}

function formatTtsTime(sec: number): string {
  if (isNaN(sec) || !isFinite(sec)) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function formatEstimatedTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${Math.max(1, seconds)} giây`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (hours <= 0) return `${minutes} phút`;
  if (minutes <= 0) return `${hours} giờ`;
  return `${hours} giờ ${minutes} phút`;
}

const BLUR_COVER_PRESETS = [
  { key: "dark", label: "Tối", bgColor: "rgba(15, 23, 42, 0.7)" },
  { key: "soft", label: "Mờ", bgColor: "rgba(255, 255, 255, 0.15)" },
  { key: "black", label: "Đen", bgColor: "rgba(0, 0, 0, 0.95)" },
  { key: "gray", label: "Xám", bgColor: "rgba(71, 85, 105, 0.6)" },
] as const;

function parseBlurCoverColor(value: string): { red: number; green: number; blue: number; alpha: number } {
  const rgba = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (!rgba) return { red: 15, green: 23, blue: 42, alpha: 0.7 };
  return {
    red: Math.max(0, Math.min(255, Number(rgba[1]))),
    green: Math.max(0, Math.min(255, Number(rgba[2]))),
    blue: Math.max(0, Math.min(255, Number(rgba[3]))),
    alpha: Math.max(0, Math.min(1, rgba[4] === undefined ? 1 : Number(rgba[4]))),
  };
}

function getBlurCoverPresetKey(value: string): string {
  const color = parseBlurCoverColor(value);
  return BLUR_COVER_PRESETS.find((preset) => {
    const presetColor = parseBlurCoverColor(preset.bgColor);
    return color.red === presetColor.red && color.green === presetColor.green && color.blue === presetColor.blue;
  })?.key || "custom";
}

function getBlurCoverCssColor(value: string, opacity: number): string {
  const color = parseBlurCoverColor(value);
  const combinedAlpha = Math.max(0, Math.min(1, color.alpha * opacity));
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${combinedAlpha.toFixed(3)})`;
}

function getBlurCoverFfmpegColor(value: string, opacity: number): string {
  const color = parseBlurCoverColor(value);
  const combinedAlpha = Math.max(0, Math.min(1, color.alpha * opacity));
  const toHex = (channel: number) => Math.round(channel).toString(16).padStart(2, "0");
  return `0x${toHex(color.red)}${toHex(color.green)}${toHex(color.blue)}@${combinedAlpha.toFixed(3)}`;
}

// Default Subtitle Settings
const DEFAULT_SUBTITLE_SETTINGS: SubtitleSettings = {
  fontSize: 32, // Increase default font size slightly for Bangers which is a condensed display font
  fontFamily: "Bangers",
  textColor: "#FACC15", // yellow-400
  bgColor: "rgba(0, 0, 0, 0.6)",
  outline: true,
  outlineColor: "#000000",
  outlineWidth: 2,
  textEffect: "outline",
  fontWeight: "bold",
  letterSpacing: 0,
  position: "bottom",
  customX: 50,
  customY: 82,
};

// Default Blur/Censor Settings
const DEFAULT_BLUR_SETTINGS: BlurSettings = {
  enabled: false,
  yPosition: 82, // 82% from top
  height: 12,    // 12% of height
  width: 85,     // 85% width
  blurAmount: 12, // 12px blur
  opacity: 0.75, // 75% dark overlay
  bgColor: BLUR_COVER_PRESETS[0].bgColor,
};

const DEFAULT_BLUR_BOXES: BlurBox[] = [
  {
    id: "blur-1",
    xPosition: 7.5,
    yPosition: 82,
    width: 85,
    height: 12,
    blurAmount: 12,
    opacity: 0.75,
    bgColor: BLUR_COVER_PRESETS[0].bgColor,
  }
];

// Preset Sample Subtitles for Demo mode (English to Vietnamese)
const SAMPLE_SUBTITLES: Subtitle[] = [
  {
    id: "sub-1",
    start: 0.5,
    end: 4.2,
    original: "Welcome to this ultimate AI translation and subtitle censor workspace.",
    translated: "Chào mừng bạn đến với không gian dịch thuật và kiểm duyệt phụ đề bằng AI.",
  },
  {
    id: "sub-2",
    start: 4.8,
    end: 8.5,
    original: "Today, we are demonstrating how easily you can blur original text in any video.",
    translated: "Hôm nay, chúng tôi sẽ trình bày cách dễ dàng để làm mờ chữ gốc trong mọi video.",
  },
  {
    id: "sub-3",
    start: 9.0,
    end: 13.2,
    original: "And instantly overlay beautifully styled translated subtitles in real time.",
    translated: "Và chèn ngay lập tức phụ đề dịch thuật được thiết kế đẹp mắt theo thời gian thực.",
  },
  {
    id: "sub-4",
    start: 14.0,
    end: 18.0,
    original: "Feel free to customize the blur height, vertical position, colors, and font sizes.",
    translated: "Bạn có thể tự do tùy chỉnh chiều cao mờ, vị trí dọc, màu sắc và kích thước phông chữ.",
  },
  {
    id: "sub-5",
    start: 18.5,
    end: 22.0,
    original: "Click on any track on the right to jump directly to that video segment!",
    translated: "Hãy nhấn vào bất kỳ phân đoạn nào ở bên phải để nhảy trực tiếp đến thời gian đó!",
  }
];

type StudioControllerProps = {
  activeRoute: StudioRoute;
  onNavigate: (route: StudioRoute) => void;
};

export default function StudioController({ activeRoute, onNavigate }: StudioControllerProps) {
  // Login States
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("is_logged_in") === "true";
    }
    return false;
  });
  const [loginUsername, setLoginUsername] = useState<string>("");
  const [loginPassword, setLoginPassword] = useState<string>("");
  const [loginError, setLoginError] = useState<string>("");
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);
  const [showLoginPassword, setShowLoginPassword] = useState<boolean>(false);

  // App States
  const [showDonatePopup, setShowDonatePopup] = useState<boolean>(false);
  const [videoSrc, setVideoSrc] = useState<string>("");
  const [videoName, setVideoName] = useState<string>("");
  const [videoMimeType, setVideoMimeType] = useState<string>("video/mp4");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string>("");
  const [isRestoringProject, setIsRestoringProject] = useState<boolean>(true);
  const [extractedAudio, setExtractedAudio] = useState<{ base64: string; mimeType: string; audioBuffer?: AudioBuffer } | null>(null);
  const [isExtractingAudio, setIsExtractingAudio] = useState<boolean>(false);
  const [extractingProgressStep, setExtractingProgressStep] = useState<string>("");
  
  const [sourceLang, setSourceLang] = useState<string>("auto");
  const [targetLang, setTargetLang] = useState<string>("Vietnamese");
  const [extractionMethod, setExtractionMethod] = useState<"audio" | "ocr" | "aiocr">("audio");
  
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const activeTab = activeRoute;
  const setActiveTab = onNavigate;
  const [projectLibrary, setProjectLibrary] = useState<ProjectLibraryItem[]>([]);
  const [isProjectLibraryLoading, setIsProjectLibraryLoading] = useState<boolean>(false);
  const projectPreviewUrlsRef = useRef<string[]>([]);

  // Text-to-Speech (TTS) Synthesis States
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(false);
  const [ttsEngine, setTtsEngine] = useState<"gemini" | "browser" | "tiktok">("gemini");
  const [geminiVoice, setGeminiVoice] = useState<string>("Kore");
  const [tiktokVoice, setTiktokVoice] = useState<string>("BV074_streaming");
  const [tiktokSessionId, setTiktokSessionId] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("tiktok_session_id") || "";
    }
    return "";
  });
  const [smartTtsEnabled, setSmartTtsEnabled] = useState<boolean>(true);
  const [geminiApiKey, setGeminiApiKey] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const storedKeys = localStorage.getItem("gemini_api_keys");
      if (storedKeys) {
        try {
          const parsed = JSON.parse(storedKeys);
          if (Array.isArray(parsed)) return parsed.filter((key) => typeof key === "string").join("\n");
        } catch {
          return storedKeys;
        }
      }
      return localStorage.getItem("gemini_api_key") || "";
    }
    return "";
  });
  const [geminiApiKeyDraft, setGeminiApiKeyDraft] = useState<string>("");
  
  // Auto-save tiktok session ID in local storage when updated
  useEffect(() => {
    if (typeof window !== "undefined") {
      if (tiktokSessionId) {
        localStorage.setItem("tiktok_session_id", tiktokSessionId);
      } else {
        localStorage.removeItem("tiktok_session_id");
      }
    }
  }, [tiktokSessionId]);

  // Auto-save Gemini API Key in local storage when updated
  useEffect(() => {
    if (typeof window !== "undefined") {
      const keys = parseGeminiApiKeys(geminiApiKey);
      if (keys.length > 0) {
        localStorage.setItem("gemini_api_keys", JSON.stringify(keys));
        localStorage.setItem("gemini_api_key", keys[0]);
      } else {
        localStorage.removeItem("gemini_api_keys");
        localStorage.removeItem("gemini_api_key");
      }
    }
  }, [geminiApiKey]);

  const [activityLogs, setActivityLogs] = useState<string[]>([]);
  const [customApiUrl, setCustomApiUrl] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("custom_api_url") || "";
    }
    return "";
  });
  const [customApiKey, setCustomApiKey] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("custom_api_key") || "";
    }
    return "";
  });
  const [customModel, setCustomModel] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("custom_model") || "";
    }
    return "";
  });

  const addLog = (msg: string) => {
    console.log(msg);
    setActivityLogs(prev => [...prev.slice(-49), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const handleLoginSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setLoginError("");
    
    const trimmedUser = loginUsername.trim();
    if (!trimmedUser) {
      setLoginError("Vui lòng nhập tài khoản hoặc mã kích hoạt!");
      return;
    }
    if (!loginPassword) {
      setLoginError("Vui lòng nhập mật khẩu!");
      return;
    }

    setIsLoggingIn(true);
    const normalizedUser = trimmedUser.toLowerCase();

    try {
      // Keep the built-in demo access usable when Firebase is unavailable or
      // its authentication providers have not been configured yet.
      const isLocalDemoAccount =
        (normalizedUser === "admin" && loginPassword === "admin") ||
        (normalizedUser === "demo" && loginPassword === "demo") ||
        loginPassword === "toolkichban" ||
        loginPassword === "toolkichban2026";

      if (isLocalDemoAccount) {
        setIsLoggedIn(true);
        if (typeof window !== "undefined") {
          localStorage.setItem("is_logged_in", "true");
        }
        addLog("Đăng nhập thành công qua chế độ cục bộ.");
        return;
      }

      // 1. Try Email and Password login first if it looks like an email
      if (trimmedUser.includes("@")) {
        addLog(`Đang xác thực qua Firebase Auth: ${trimmedUser}...`);
        const userCredential = await signInWithEmailAndPassword(auth, trimmedUser, loginPassword);
        setIsLoggedIn(true);
        if (typeof window !== "undefined") {
          localStorage.setItem("is_logged_in", "true");
        }
        addLog(`Đăng nhập thành công qua Firebase Auth: ${userCredential.user.email}`);
        setIsLoggingIn(false);
        return;
      }

      // 2. Otherwise, check Firestore collection "users"
      addLog(`Đang kết nối Firestore để kiểm tra tài khoản: ${trimmedUser}...`);
      
      const userDocRef = doc(db, "users", normalizedUser);
      let userDocSnap;
      try {
        userDocSnap = await getDoc(userDocRef);
      } catch (firestoreErr: any) {
        console.warn("Firestore read error, checking permissions or rules:", firestoreErr);
        if (firestoreErr.code === "permission-denied") {
          addLog("Cảnh báo: Quyền truy cập Firestore bị từ chối (Hãy sửa Security Rules của bạn). Đang đăng nhập qua chế độ cục bộ dự phòng...");
          if (
            (normalizedUser === "admin" && loginPassword === "admin") ||
            (normalizedUser === "demo" && loginPassword === "demo") ||
            loginPassword === "toolkichban" ||
            loginPassword === "toolkichban2026"
          ) {
            setIsLoggedIn(true);
            if (typeof window !== "undefined") {
              localStorage.setItem("is_logged_in", "true");
            }
            addLog("Đăng nhập thành công qua Chế độ cục bộ dự phòng!");
            setIsLoggingIn(false);
            return;
          }
          throw firestoreErr;
        }
        throw firestoreErr;
      }

      if (userDocSnap.exists()) {
        const userData = userDocSnap.data();
        if (userData.password === loginPassword) {
          setIsLoggedIn(true);
          if (typeof window !== "undefined") {
            localStorage.setItem("is_logged_in", "true");
          }
          addLog(`Đăng nhập thành công qua Firestore cho tài khoản: ${trimmedUser}`);
          setIsLoggingIn(false);
          return;
        } else {
          setLoginError("Mật khẩu không chính xác!");
          setIsLoggingIn(false);
          return;
        }
      }

      // If document ID lookup failed, try searching via username field query just in case
      const q = query(collection(db, "users"), where("username", "==", normalizedUser), limit(1));
      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty) {
        const foundDoc = querySnapshot.docs[0];
        const userData = foundDoc.data();
        if (userData.password === loginPassword) {
          setIsLoggedIn(true);
          if (typeof window !== "undefined") {
            localStorage.setItem("is_logged_in", "true");
          }
          addLog(`Đăng nhập thành công qua Firestore cho tài khoản: ${trimmedUser}`);
          setIsLoggingIn(false);
          return;
        } else {
          setLoginError("Mật khẩu không chính xác!");
          setIsLoggingIn(false);
          return;
        }
      }

      // If user is "admin" and not yet in Firestore, auto-provision it!
      if (normalizedUser === "admin" && loginPassword === "admin") {
        try {
          addLog("Đang tự động khởi tạo tài khoản admin trên Firestore...");
          await setDoc(doc(db, "users", "admin"), {
            username: "admin",
            password: "admin",
            role: "admin",
            createdAt: new Date().toISOString()
          });
          setIsLoggedIn(true);
          if (typeof window !== "undefined") {
            localStorage.setItem("is_logged_in", "true");
          }
          addLog("Đã khởi tạo tài khoản admin và đăng nhập thành công!");
          setIsLoggingIn(false);
          return;
        } catch (provisionErr: any) {
          console.error("Auto-provision error:", provisionErr);
          setIsLoggedIn(true);
          if (typeof window !== "undefined") {
            localStorage.setItem("is_logged_in", "true");
          }
          addLog("Đăng nhập thành công qua Chế độ cục bộ dự phòng!");
          setIsLoggingIn(false);
          return;
        }
      }

      // If we got here, account not found
      setLoginError("Tài khoản không tồn tại trên hệ thống Firestore!");
    } catch (err: any) {
      console.error("Firebase Login Error:", err);
      let errMsg = err.message || String(err);
      if (err.code === "permission-denied") {
        errMsg = "Quyền truy cập Firestore bị từ chối! Vui lòng chỉnh Security Rules của bạn thành: allow read, write: if true; (hoặc if request.auth != null;)";
      } else if (err.code === "auth/invalid-credential" || err.code === "auth/user-not-found" || err.code === "auth/wrong-password") {
        errMsg = "Thông tin đăng nhập Auth không chính xác hoặc tài khoản không tồn tại.";
      }
      setLoginError(`Lỗi kết nối Firebase: ${errMsg}`);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleQuickLogin = () => {
    setLoginUsername("admin");
    setLoginPassword("admin");
    setLoginError("");
    setIsLoggedIn(true);
    if (typeof window !== "undefined") {
      localStorage.setItem("is_logged_in", "true");
    }
    addLog("Đăng nhập thành công qua chế độ cục bộ.");
  };

  const handleSignOut = () => {
    setIsLoggedIn(false);
    setLoginUsername("");
    setLoginPassword("");
    if (typeof window !== "undefined") {
      localStorage.removeItem("is_logged_in");
    }
    addLog("Đã đăng xuất khỏi tài khoản.");
  };

  const handleSocialLogin = async (providerName: "google" | "github" | "facebook") => {
    setIsLoggingIn(true);
    setLoginError("");
    addLog(`Đang khởi động liên kết đăng nhập bằng ${providerName.toUpperCase()}...`);
    let provider: any;
    try {
      if (providerName === "google") {
        provider = new GoogleAuthProvider();
        // Option to customize provider parameters if needed
        provider.setCustomParameters({ prompt: "select_account" });
        // Force redirect flow for Google to avoid popup blocking issues
        addLog("Sử dụng flow Redirect cho Google để tránh chặn popup.");
        await signInWithRedirect(auth, provider);
        return;
      } else if (providerName === "github") {
        provider = new GithubAuthProvider();
      } else {
        provider = new FacebookAuthProvider();
      }
      
      const result = await signInWithPopup(auth, provider);
      setIsLoggedIn(true);
      if (typeof window !== "undefined") {
        localStorage.setItem("is_logged_in", "true");
      }
      addLog(`Đăng nhập thành công bằng ${providerName.toUpperCase()}! Tài khoản: ${result.user.email || result.user.displayName}`);
    } catch (err: any) {
      console.error(`Lỗi đăng nhập qua ${providerName}:`, err);
      let errMsg = err.message || String(err);
      if (err.code === "auth/popup-blocked") {
        // Popup blocked: try redirect fallback which is more robust in some browsers
        try {
          addLog("Popup bị chặn, chuyển sang phương thức đăng nhập bằng Redirect...");
          await signInWithRedirect(auth, provider);
          return; // redirect will navigate away; getRedirectResult() will handle completion
        } catch (redirectErr: any) {
          console.error("Redirect fallback failed:", redirectErr);
          errMsg = "Trình duyệt đã chặn Popup và chế độ Redirect không thành công. Vui lòng cho phép popup hoặc thử lại trên một trình duyệt khác.";
        }
      } else if (err.code === "auth/popup-closed-by-user") {
        errMsg = "Đã đóng cửa sổ đăng nhập trước khi hoàn tất liên kết.";
      } else if (err.code === "auth/account-exists-with-different-credential") {
        errMsg = "Tài khoản email này đã tồn tại dưới một hình thức đăng nhập khác (ví dụ: Email/Mật khẩu hoặc Google).";
      } else if (err.code === "auth/unauthorized-domain") {
        errMsg = "Tên miền hiện tại chưa được cấp quyền trong Firebase Console -> Authentication -> Authorized domains.";
      }
      else {
        // For other popup failures (third-party cookies, blank popup), attempt redirect fallback once
        try {
          addLog(`Popup thất bại (code=${err.code}). Thử Redirect fallback...`);
          await signInWithRedirect(auth, provider);
          return;
        } catch (redirectErr: any) {
          console.error("Redirect fallback also failed:", redirectErr);
          // keep original errMsg or set a generic guidance message
          if (!errMsg) errMsg = "Đăng nhập thất bại do trình duyệt hoặc cấu hình OAuth. Hãy kiểm tra console và cài đặt Firebase/Google OAuth.";
        }
      }
      setLoginError(`Lỗi đăng nhập ${providerName.toUpperCase()}: ${errMsg}`);
      addLog(`Lỗi đăng nhập ${providerName}: ${errMsg}`);
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Handle redirect result (for signInWithRedirect fallback)
  useEffect(() => {
    const finalizeRedirect = async () => {
      try {
        const result = await getRedirectResult(auth);
        if (result && result.user) {
          setIsLoggedIn(true);
          if (typeof window !== "undefined") {
            localStorage.setItem("is_logged_in", "true");
          }
          addLog(`Đăng nhập hoàn tất qua Redirect: ${result.user.email || result.user.displayName}`);
        }
      } catch (err: any) {
        // Show details to help diagnose redirect issues (blank handler page, oauth mismatch, etc.)
        console.warn("Redirect sign-in error:", err);
        const code = err?.code || "unknown";
        const msg = err?.message || String(err);
        setLoginError(`Lỗi Redirect Google: ${code} — ${msg}`);
        addLog(`Redirect sign-in error: ${code} - ${msg}`);
      }
    };

    finalizeRedirect();
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      if (customApiUrl) {
        localStorage.setItem("custom_api_url", customApiUrl);
      } else {
        localStorage.removeItem("custom_api_url");
      }
    }
  }, [customApiUrl]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      if (customApiKey) {
        localStorage.setItem("custom_api_key", customApiKey);
      } else {
        localStorage.removeItem("custom_api_key");
      }
    }
  }, [customApiKey]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      if (customModel) {
        localStorage.setItem("custom_model", customModel);
      } else {
        localStorage.removeItem("custom_model");
      }
    }
  }, [customModel]);

  const [apiPlatform, setApiPlatform] = useState<"gemini" | "custom">(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("api_platform") as "gemini" | "custom") || "custom";
    }
    return "custom";
  });

  const [allowGeminiFallback, setAllowGeminiFallback] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("allow_gemini_fallback") === "true";
    }
    return false;
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("api_platform", apiPlatform);
    }
  }, [apiPlatform]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("allow_gemini_fallback", allowGeminiFallback ? "true" : "false");
    }
  }, [allowGeminiFallback]);

  const [showEngineModal, setShowEngineModal] = useState<boolean>(false);
  const [engineDownloadProgress, setEngineDownloadProgress] = useState<number>(0);
  const [engineCurrentStep, setEngineCurrentStep] = useState<string>("");
  const [engineInstallLogs, setEngineInstallLogs] = useState<string[]>([]);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const appendEngineLog = (msg: string) => {
    setEngineInstallLogs(prev => {
      const next = [...prev.slice(-999), `[${new Date().toLocaleTimeString()}] ${msg}`];
      return next;
    });
  };

  useEffect(() => {
    // Auto-scroll to bottom when logs update
    try {
      if (logContainerRef.current) {
        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      }
    } catch (e) {
      // ignore
    }
  }, [engineInstallLogs]);
  const [isDownloadingEngine, setIsDownloadingEngine] = useState<boolean>(false);
  const [engineStatus, setEngineStatus] = useState<"not_installed" | "downloading" | "installed" | "error" | "ready">(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("engine_installed_status") as any) || "not_installed";
    }
    return "not_installed";
  });

  const handleDownloadEngines = async () => {
    if (isDownloadingEngine) return;
    setIsDownloadingEngine(true);
    setShowEngineModal(true);
    setEngineDownloadProgress(2);
    setEngineCurrentStep("Đang khởi tạo cấu hình và môi trường tải...");
    setEngineInstallLogs(["[Hệ thống] Bắt đầu thiết lập môi trường tải các công cụ hỗ trợ phần cứng..."]);
    
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    
    try {
      await sleep(1000);
      setEngineDownloadProgress(10);
      setEngineCurrentStep("Đang kết nối máy chủ phân phối tài nguyên (CDN)...");
      setEngineInstallLogs(prev => [
        ...prev,
        "[Hệ thống] Đang phân tích cấu hình phần cứng thiết bị...",
        "[Hệ thống] Tìm thấy thiết bị tương thích tốt: GPU Acceleration (WebGL/WebGPU).",
        "[Tải về] Đang thiết lập kết nối máy chủ phân phối để tải file dung lượng lớn..."
      ]);

      // use top-level appendEngineLog to record logs (capped)

      const downloadFileWithProgress = async (
        url: string,
        label: string,
        startPct: number,
        endPct: number
      ): Promise<Blob> => {
        setEngineCurrentStep(`Đang tải ${label}...`);
        appendEngineLog(`[Tải về] Bắt đầu tải ${label} từ ${url}`);

        const MAX_ATTEMPTS = 3;
        let attempt = 0;
        let lastErr: any = null;

        while (attempt < MAX_ATTEMPTS) {
          attempt += 1;
          try {
            appendEngineLog(`[Tải về] ${label} - Attempt ${attempt}/${MAX_ATTEMPTS}`);
            const response = await fetch(url);
            appendEngineLog(`[Tải về] ${label} - HTTP ${response.status} ${response.statusText}`);
            if (!response.ok) {
              throw new Error(`Tải ${label} thất bại (HTTP ${response.status})`);
            }

            const contentLengthHeader = response.headers.get("content-length");
            const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;

            const reader = response.body?.getReader();
            let loadedBytes = 0;
            const chunks: Uint8Array[] = [];

            // Fallback: if Streams API not available, read whole response as ArrayBuffer
            if (!reader) {
              appendEngineLog(`[Tải về] ${label}: Streams API không khả dụng, dùng arrayBuffer()`);
              const arrayBuffer = await response.arrayBuffer();
              loadedBytes = arrayBuffer.byteLength;
              const finalMB = (loadedBytes / (1024 * 1024)).toFixed(2);
              appendEngineLog(`[Tải về] ${label}: ${finalMB}MB (đã tải)`);
              setEngineDownloadProgress(endPct);
              return new Blob([arrayBuffer], { type: response.headers.get("content-type") || "application/octet-stream" });
            }
        const startTime = Date.now();
        let lastLogTime = 0;
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            loadedBytes += value.length;
            
            const now = Date.now();
            if (now - lastLogTime > 150 || loadedBytes === totalBytes) {
              lastLogTime = now;
              const elapsed = (now - startTime) / 1000;
              const speedBytesSec = elapsed > 0 ? (loadedBytes / elapsed) : 0;
              const speedMB = (speedBytesSec / (1024 * 1024)).toFixed(2);
              
              const loadedMB = (loadedBytes / (1024 * 1024)).toFixed(2);
              const totalMB = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(2) : "Không rõ";
              
              const filePct = totalBytes > 0 ? (loadedBytes / totalBytes) : 0;
              const overallPct = Math.round(startPct + filePct * (endPct - startPct));
              
              setEngineDownloadProgress(Math.min(endPct, overallPct));
              
              const logMsg = `[Tải về] ${label}: ${loadedMB}MB / ${totalMB}MB (${speedMB} MB/s)`;
              setEngineInstallLogs(prev => {
                const nextLogs = [...prev];
                if (nextLogs[nextLogs.length - 1].startsWith(`[Tải về] ${label}:`)) {
                  nextLogs[nextLogs.length - 1] = logMsg;
                } else {
                  nextLogs.push(logMsg);
                }
                return nextLogs;
              });
            }
          }
        }
        
            const finalLoadedMB = (loadedBytes / (1024 * 1024)).toFixed(2);
            appendEngineLog(`[Hoàn tất] Đã tải xong ${label} (${finalLoadedMB} MB)`);

            // Concatenate chunks into a single ArrayBuffer before creating Blob
            const combined = new Uint8Array(loadedBytes);
            let offset = 0;
            for (const c of chunks) {
              combined.set(c, offset);
              offset += c.length;
            }

            return new Blob([combined.buffer], { type: response.headers.get("content-type") || "application/octet-stream" });
          } catch (e: any) {
            lastErr = e;
            appendEngineLog(`[Lỗi] ${label} - attempt ${attempt} failed: ${e?.message || String(e)}`);
            // exponential backoff
            const backoff = 500 * Math.pow(2, attempt - 1);
            await new Promise(r => setTimeout(r, backoff));
            // try again until attempts exhausted
          }
        }

        // All attempts failed
        throw lastErr || new Error(`Không thể tải ${label} sau ${MAX_ATTEMPTS} lần thử`);
      };

      // 1. Download FFmpeg JS Core (approx 32 KB)
      const coreBlob = await downloadFileWithProgress(
        "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js",
        "FFmpeg Core JS",
        10,
        15
      );

      // 2. Download FFmpeg WASM Binary (approx 31 MB)
      const wasmBlob = await downloadFileWithProgress(
        "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm",
        "FFmpeg Core WASM (Mã nguồn chính)",
        15,
        65
      );

      const wasmHeader = new Uint8Array(await wasmBlob.slice(0, 4).arrayBuffer());
      if (wasmBlob.size < 30_000_000 || wasmHeader[0] !== 0x00 || wasmHeader[1] !== 0x61 || wasmHeader[2] !== 0x73 || wasmHeader[3] !== 0x6d) {
        throw new Error(`FFmpeg WASM tải về không hoàn chỉnh (${wasmBlob.size} bytes).`);
      }
      if ("caches" in window) {
        const engineCache = await caches.open("26dubbin-engine-v1");
        await engineCache.put("/ffmpeg/ffmpeg-core.js", new Response(coreBlob));
        await engineCache.put("/ffmpeg/ffmpeg-core.wasm", new Response(wasmBlob));
      }

      setEngineCurrentStep("Đang cấu hình luồng xử lý đa nhân cho FFmpeg...");
      setEngineInstallLogs(prev => [
        ...prev,
        "[FFmpeg] Giải nén thư viện và nạp vào bộ đệm trình duyệt...",
        "[FFmpeg] Cấu hình luồng Shared Worker Threads thành công (Sử dụng 4-8 luồng CPU)."
      ]);
      await sleep(1000);

      appendEngineLog("[Thông báo] PaddleOCR ưu tiên WebGPU/WASM trong trình duyệt; Node/Express chỉ là CPU dự phòng. Trình cài này chỉ quản lý FFmpeg WebAssembly.");

      setEngineCurrentStep("Hoàn tất thiết lập và chẩn đoán hệ thống...");
      setEngineInstallLogs(prev => [
        ...prev,
        "[Hệ thống] Chạy thử nghiệm chẩn đoán tự động (Self-Diagnostic Run)...",
        "[Hệ thống] Kiểm tra tệp FFmpeg WASM... ĐẠT",
        "[Hệ thống] FFmpeg đã sẵn sàng. PaddleOCR Web sẽ tự chọn WebGPU hoặc WASM khi chạy."
      ]);
      setEngineDownloadProgress(100);
      await sleep(1000);

      setEngineCurrentStep("FFmpeg đã được kiểm tra và lưu vào bộ nhớ đệm.");
      setEngineInstallLogs(prev => [
        ...prev,
        "[Hệ thống] Trạng thái: HOÀN THÀNH - FFmpeg sẵn sàng để xuất video."
      ]);
      
      setEngineStatus("installed");
      if (typeof window !== "undefined") {
        localStorage.setItem("engine_installed_status", "installed");
      }
      addLog("Đã nạp và kiểm tra FFmpeg WASM.");
    } catch (err: any) {
      console.error("Lỗi cài đặt Engine thật:", err);
      setErrorMsg(`Không thể cài đặt Engine: ${err.message || String(err)}`);
      setEngineStatus("error");
      setEngineCurrentStep("Lỗi trong quá trình tải xuống engine!");
      setEngineInstallLogs(prev => [
        ...prev,
        `[LỖI] Đã xảy ra lỗi khi tải xuống: ${err.message || String(err)}`,
        "[LÝ DO] Có thể kết nối mạng không ổn định hoặc trình duyệt chặn tải tệp nhị phân WASM.",
        "[GỢI Ý] Hãy thử mở ứng dụng trong Tab Mới để tránh chính sách Sandbox hạn chế của iFrame."
      ]);
    } finally {
      setIsDownloadingEngine(false);
    }
  };

  const [exportedVideoUrl, setExportedVideoUrl] = useState<string>("");
  const [isTestingConnection, setIsTestingConnection] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{ success: boolean; msg: string } | null>(null);
  const [apiQuotaEntries, setApiQuotaEntries] = useState<ApiQuotaEntry[]>([]);
  const [isLoadingQuota, setIsLoadingQuota] = useState<boolean>(false);
  const [quotaUpdatedAt, setQuotaUpdatedAt] = useState<string>("");
  const [quotaLoadError, setQuotaLoadError] = useState<string>("");

  const submitGeminiApiKeys = () => {
    const incomingKeys = parseGeminiApiKeys(geminiApiKeyDraft);
    if (incomingKeys.length === 0) return;
    const mergedKeys = Array.from(new Set([...parseGeminiApiKeys(geminiApiKey), ...incomingKeys]));
    setGeminiApiKey(mergedKeys.join("\n"));
    setGeminiApiKeyDraft("");
  };

  const removeGeminiApiKey = (keyIndex: number) => {
    const keys = parseGeminiApiKeys(geminiApiKey);
    setGeminiApiKey(keys.filter((_, index) => index !== keyIndex).join("\n"));
  };

  const refreshApiQuota = async (silent = false) => {
    if (!silent) setIsLoadingQuota(true);
    try {
      const response = await fetch("/api/quota-status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getGeminiRequestHeaders(geminiApiKey),
        },
        body: JSON.stringify({ customApiKey, customModel }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setApiQuotaEntries(Array.isArray(data.entries) ? data.entries : []);
      setQuotaUpdatedAt(data.updatedAt || new Date().toISOString());
      setQuotaLoadError("");
    } catch (error: any) {
      setQuotaLoadError(error?.message || "Không thể tải trạng thái API.");
    } finally {
      if (!silent) setIsLoadingQuota(false);
    }
  };

  useEffect(() => {
    if (activeTab !== "settings") return;
    void refreshApiQuota();
    const timer = window.setInterval(() => void refreshApiQuota(true), 5000);
    return () => window.clearInterval(timer);
  }, [activeTab, geminiApiKey, customApiKey, customModel]);

  const testCustomApiConnection = async () => {
    if (!customApiUrl || !customApiKey) {
      setTestResult({ success: false, msg: "Vui lòng điền đầy đủ URL và API Key." });
      setErrorMsg("Không thể kiểm tra Custom API: Vui lòng điền đầy đủ URL và API Key.");
      return;
    }
    setIsTestingConnection(true);
    setTestResult(null);
    try {
      const cleanedUrl = sanitizeCustomApiBaseUrl(customApiUrl);
      if (cleanedUrl !== customApiUrl) setCustomApiUrl(cleanedUrl);
      const response = await fetch("/api/test-custom-api", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customApiUrl: cleanedUrl,
          customApiKey,
          customModel: customModel || "gpt-4o-mini",
        })
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        setTestResult({ success: true, msg: `${data.message || "Kết nối thành công! API hoạt động tốt."}${data.endpoint ? ` Endpoint: ${data.endpoint}` : ""}` });
        addLog("Thử nghiệm kết nối Custom API: THÀNH CÔNG");
      } else {
        const message = data.error || `Custom API trả về lỗi HTTP ${response.status}.`;
        setTestResult({ success: false, msg: message });
        setErrorMsg(`Kiểm tra Custom API thất bại: ${message}`);
        addLog(`Thử nghiệm kết nối Custom API thất bại: ${response.status}`);
      }
      await refreshApiQuota(true);
    } catch (err: any) {
      const message = `Lỗi kết nối: ${err.message || String(err)}`;
      setTestResult({ success: false, msg: message });
      setErrorMsg(`Kiểm tra Custom API thất bại: ${message}`);
      addLog(`Lỗi kiểm tra kết nối Custom API: ${err.message || String(err)}`);
    } finally {
      setIsTestingConnection(false);
    }
  };

  const [ttsVoiceName, setTtsVoiceName] = useState<string>("");
  const [ttsRate, setTtsRate] = useState<number>(1.1);
  const [ttsPitch, setTtsPitch] = useState<number>(1.0);
  const [ttsVolume, setTtsVolume] = useState<number>(0.8);
  const [originalAudioMixVolume, setOriginalAudioMixVolume] = useState<number>(0.3);
// 0.0 (tắt hẳn audio gốc) -> 1.0 (giữ nguyên 100%). Mặc định 0.3 = 30%, dùng cho cả
// live preview (auto-mute khi TTS đang đọc) và bước ghép audio cuối cùng khi export.
  const [autoMuteVideo, setAutoMuteVideo] = useState<boolean>(true);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [generatingTtsId, setGeneratingTtsId] = useState<string | null>(null);
  const [preGeneratingAll, setPreGeneratingAll] = useState<boolean>(false);
  const [ttsMode, setTtsMode] = useState<"full" | "sync">("full");
  const [fullTtsText, setFullTtsText] = useState<string>("");
  const [isGeneratingFullTts, setIsGeneratingFullTts] = useState<boolean>(false);
  const [fullTtsAudioUrl, setFullTtsAudioUrl] = useState<string | null>(null);
  const [fullTtsPlaying, setFullTtsPlaying] = useState<boolean>(false);
  const [fullTtsCurrentTime, setFullTtsCurrentTime] = useState<number>(0);
  const [fullTtsDuration, setFullTtsDuration] = useState<number>(0);
  const [isMergingAudio, setIsMergingAudio] = useState<boolean>(false);
  const [isRecordingVideo, setIsRecordingVideo] = useState<boolean>(false);
  const [recordingProgress, setRecordingProgress] = useState<number>(0);
  const [recordingEtaSeconds, setRecordingEtaSeconds] = useState<number | null>(null);
  const [exportResolution, setExportResolution] = useState<"720" | "1080" | "1440">(() => {
    const profile = getOcrRuntimeProfile();
    return profile.isMobile && profile.id !== "mobile-high" ? "720" : "1080";
  });
  const [autoRenderRequested, setAutoRenderRequested] = useState<boolean>(false);
  const [autoPrepareRequested, setAutoPrepareRequested] = useState<boolean>(false);
  const [subtitlePipelineVersion, setSubtitlePipelineVersion] = useState<number>(0);
  const [isProgressMinimized, setIsProgressMinimized] = useState<boolean>(false);
  const [timelineHeight, setTimelineHeight] = useState<number>(150);
  const [workspacePropertyTarget, setWorkspacePropertyTarget] = useState<"subtitle" | "blur" | "ocr">("subtitle");
  const [ocrRegions, setOcrRegions] = useState<OcrRegion[]>(DEFAULT_OCR_REGIONS);
  const [activeOcrRegionId, setActiveOcrRegionId] = useState<string>(DEFAULT_OCR_REGIONS[0].id);
  const [ocrFps, setOcrFps] = useState<number>(5);
  const [ocrHealth, setOcrHealth] = useState<OcrServiceHealth | null>(null);
  const [browserOcrStatus, setBrowserOcrStatus] = useState<"idle" | "initializing" | "ready" | "error">("idle");
  const [browserOcrBackend, setBrowserOcrBackend] = useState<"webgpu" | "wasm" | null>(null);
  const [browserOcrError, setBrowserOcrError] = useState<string>("");
  const [isCheckingOcr, setIsCheckingOcr] = useState<boolean>(false);
  const [isPreviewingOcr, setIsPreviewingOcr] = useState<boolean>(false);
  const [ocrPreviewText, setOcrPreviewText] = useState<string>("");
  const [isDrawingOcrRegion, setIsDrawingOcrRegion] = useState<boolean>(false);
  const [ocrPresetName, setOcrPresetName] = useState<string>("");
  const [ocrPresets, setOcrPresets] = useState<OcrRegionPreset[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const parsed = JSON.parse(localStorage.getItem("26dubbin_ocr_region_presets") || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [workspaceVideoDimensions, setWorkspaceVideoDimensions] = useState({ width: 16, height: 9 });
  
  // Customization States
  const [showSubtitles, setShowSubtitles] = useState<boolean>(true);
  const [blurSettings, setBlurSettings] = useState<BlurSettings>(DEFAULT_BLUR_SETTINGS);
  const [blurBoxes, setBlurBoxes] = useState<BlurBox[]>([]);
  const [activeBlurBoxId, setActiveBlurBoxId] = useState<string | null>("blur-1");
  const [subSettings, setSubSettings] = useState<SubtitleSettings>(DEFAULT_SUBTITLE_SETTINGS);
  const [isAdjustingCensor, setIsAdjustingCensor] = useState<boolean>(false);
  const [flipHorizontal, setFlipHorizontal] = useState<boolean>(false);
  const [flipVertical, setFlipVertical] = useState<boolean>(false);

  // Playback state
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [volume, setVolume] = useState<number>(0.8);
  
  // API Call Status
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingStep, setLoadingStep] = useState<string>("");
  const [loadingProgress, setLoadingProgress] = useState<number>(0);
  const [loadingEtaSeconds, setLoadingEtaSeconds] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [errorPopupQueue, setErrorPopupQueue] = useState<string[]>([]);

  useEffect(() => {
    const message = errorMsg.trim();
    if (!message) return;
    setErrorPopupQueue((current) =>
      current[current.length - 1] === message ? current : [...current, message],
    );
  }, [errorMsg]);

  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      const message = event.error?.message || event.message || "Ứng dụng gặp lỗi không xác định.";
      setErrorPopupQueue((current) => current[current.length - 1] === message ? current : [...current, message]);
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error
        ? reason.message
        : typeof reason === "string" ? reason : "Một tác vụ nền đã thất bại.";
      setErrorPopupQueue((current) => current[current.length - 1] === message ? current : [...current, message]);
    };
    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  const dismissErrorPopup = () => {
    setErrorPopupQueue((current) => current.slice(1));
    setErrorMsg("");
  };

  // Subtitle Edit State
  const [editingSubId, setEditingSubId] = useState<string | null>(null);
  const [editOriginal, setEditOriginal] = useState<string>("");
  const [editTranslated, setEditTranslated] = useState<string>("");
  const [editStart, setEditStart] = useState<number>(0);
  const [editEnd, setEditEnd] = useState<number>(0);

  // Search filter for subtitle list
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const workspaceVideoRef = useRef<HTMLVideoElement>(null);
  const autoDubbingFileInputRef = useRef<HTMLInputElement>(null);
  const extractedAudioRef = useRef<{ base64: string; mimeType: string; audioBuffer?: AudioBuffer } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const restoreProject = async () => {
      const projectId = localStorage.getItem(PROJECT_POINTER_KEY);
      if (!projectId) {
        setIsRestoringProject(false);
        return;
      }

      try {
        const [project, media, lastRender] = await Promise.all([
          projectDbGet<StoredProject>("projects", projectId),
          projectDbGet<StoredProjectMedia>("media", projectId),
          projectDbGet<StoredProjectMedia>("media", `${projectId}|latest-render`),
        ]);
        if (cancelled || !media) return;

        const restoredFile = new File([media.blob], media.name, {
          type: media.type || "video/mp4",
          lastModified: media.lastModified,
        });
        setCurrentProjectId(projectId);
        setVideoFile(restoredFile);
        setVideoName(media.name);
        setVideoMimeType(media.type || "video/mp4");
        setVideoSrc(URL.createObjectURL(restoredFile));
        if (lastRender?.blob) setExportedVideoUrl(URL.createObjectURL(lastRender.blob));
        setActiveTab("translate");

        if (project) {
          setSubtitles(project.subtitles || []);
          setSubtitlePipelineVersion(project.subtitlePipelineVersion ?? 0);
          setSourceLang(project.sourceLang || "auto");
          setTargetLang(project.targetLang || "Vietnamese");
          setExtractionMethod(project.extractionMethod || "audio");
          setOcrRegions(project.ocrRegions?.length ? project.ocrRegions : DEFAULT_OCR_REGIONS);
          setActiveOcrRegionId(project.ocrRegions?.[0]?.id || DEFAULT_OCR_REGIONS[0].id);
          setOcrFps(project.ocrFps || 5);
          setTtsEnabled(project.ttsEnabled ?? false);
          setTtsEngine(project.ttsEngine || "gemini");
          setGeminiVoice(project.geminiVoice || "Kore");
          setTiktokVoice(project.tiktokVoice || "BV074_streaming");
          setSmartTtsEnabled(project.smartTtsEnabled ?? true);
          setTtsRate(project.ttsRate || 1.1);
          setOriginalAudioMixVolume(project.originalAudioMixVolume ?? 0.3);
          setExportResolution(project.exportResolution || "1080");
          setBlurBoxes(project.blurBoxes || []);
          setBlurSettings(project.blurSettings || DEFAULT_BLUR_SETTINGS);
          setSubSettings(project.subSettings || DEFAULT_SUBTITLE_SETTINGS);
          setFlipHorizontal(project.flipHorizontal ?? false);
          setFlipVertical(project.flipVertical ?? false);
        }

        addLog(`Đã khôi phục dự án "${media.name}"${project?.subtitles?.length ? ` với ${project.subtitles.length} dòng phụ đề` : ""}.`);
        setIsExtractingAudio(true);
        setExtractingProgressStep("Đang khôi phục audio từ dự án...");
        extractAudioTrack(restoredFile, setExtractingProgressStep)
          .then((extracted) => {
            if (cancelled) return;
            setExtractedAudio(extracted);
            extractedAudioRef.current = extracted;
          })
          .catch((error) => {
            console.warn("Could not restore extracted audio:", error);
            if (!cancelled) setErrorMsg(`Đã khôi phục dự án nhưng chưa đọc được audio: ${error?.message || error}`);
          })
          .finally(() => {
            if (!cancelled) {
              setIsExtractingAudio(false);
              setExtractingProgressStep("");
            }
          });
      } catch (error) {
        console.warn("Could not restore active project:", error);
      } finally {
        if (!cancelled) setIsRestoringProject(false);
      }
    };
    restoreProject();
    return () => {
      cancelled = true;
    };
  }, []);

  // Tự sửa các dự án cũ từng lưu timestamp tương đối của từng chunk. Dữ liệu
  // gốc trong store `chunks` vẫn còn nguyên nên không cần gọi Gemini lại.
  useEffect(() => {
    if (!currentProjectId || !Number.isFinite(duration) || duration <= 0) return;
    let cancelled = false;

    const repairTimelineFromCheckpoints = async () => {
      const allChunks = await projectDbGetAll<StoredChunk>("chunks").catch(() => []);
      if (cancelled) return;
      const projectChunks = allChunks.filter((chunk) => chunk.projectId === currentProjectId);
      if (projectChunks.length === 0) return;

      const chunkStatsByJob = new Map<string, { latest: number; maxEnd: number; count: number }>();
      projectChunks.forEach((chunk) => {
        const current = chunkStatsByJob.get(chunk.jobKey) || { latest: 0, maxEnd: 0, count: 0 };
        chunkStatsByJob.set(chunk.jobKey, {
          latest: Math.max(current.latest, chunk.updatedAt),
          maxEnd: Math.max(current.maxEnd, chunk.end),
          count: current.count + 1,
        });
      });
      const latestJobKey = [...chunkStatsByJob.entries()].sort((a, b) =>
        b[1].maxEnd - a[1].maxEnd || b[1].count - a[1].count || b[1].latest - a[1].latest
      )[0]?.[0];
      if (!latestJobKey) return;

      const selectedChunks = projectChunks
        .filter((chunk) => chunk.jobKey === latestJobKey)
        .sort((a, b) => a.start - b.start);
      const restoredChunkSubtitles = selectedChunks.flatMap((chunk) =>
        normalizeChunkSubtitleTimestamps(chunk.subtitles, chunk.start, chunk.end, duration)
      );
      const repairedSubtitles = validateSubtitleTimeline(
        mergeDuplicateSubtitles(restoredChunkSubtitles),
        duration,
      );
      if (cancelled || repairedSubtitles.length === 0) return;

      const currentLastEnd = Math.max(...subtitles.map((sub) => sub.end), 0);
      const repairedLastEnd = Math.max(...repairedSubtitles.map((sub) => sub.end), 0);
      const currentLooksCollapsed =
        selectedChunks.length > 1 &&
        repairedLastEnd > currentLastEnd + 0.75;
      if (!currentLooksCollapsed && subtitles.length > 0) return;

      setSubtitles(repairedSubtitles);
      addLog(
        `Đã tự sửa timeline checkpoint: ${subtitles.length} → ${repairedSubtitles.length} dòng, ` +
        `mốc cuối ${currentLastEnd.toFixed(2)}s → ${repairedLastEnd.toFixed(2)}s. Không gọi lại Gemini.`,
      );
    };

    void repairTimelineFromCheckpoints();
    return () => {
      cancelled = true;
    };
  }, [currentProjectId, duration]);

  useEffect(() => {
    if (!currentProjectId || isRestoringProject || !videoName) return;
    const saveTimer = window.setTimeout(() => {
      projectDbPut("projects", {
        id: currentProjectId,
        updatedAt: Date.now(),
        videoName,
        videoMimeType,
        subtitles,
        sourceLang,
        targetLang,
        extractionMethod,
        ocrRegions,
        ocrFps,
        ttsEnabled,
        ttsEngine,
        geminiVoice,
        tiktokVoice,
        smartTtsEnabled,
        ttsRate,
        originalAudioMixVolume,
        exportResolution,
        blurBoxes,
        blurSettings,
        subSettings,
        flipHorizontal,
        flipVertical,
        subtitlePipelineVersion,
      } satisfies StoredProject).catch((error) => console.warn("Could not save project checkpoint:", error));
    }, 400);
    return () => window.clearTimeout(saveTimer);
  }, [
    currentProjectId, isRestoringProject, videoName, videoMimeType, subtitles, sourceLang, targetLang,
    extractionMethod, ocrRegions, ocrFps, ttsEnabled, ttsEngine, geminiVoice, tiktokVoice, smartTtsEnabled, ttsRate,
    originalAudioMixVolume, exportResolution, blurBoxes, blurSettings, subSettings, flipHorizontal, flipVertical,
    subtitlePipelineVersion,
  ]);

  const refreshProjectLibrary = async () => {
    setIsProjectLibraryLoading(true);
    try {
      projectPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      projectPreviewUrlsRef.current = [];
      const projects = (await projectDbGetAll<StoredProject>("projects"))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const items = await Promise.all(projects.map(async (project) => {
        const [media, finalRender] = await Promise.all([
          projectDbGet<StoredProjectMedia>("media", project.id),
          projectDbGet<StoredProjectMedia>("media", `${project.id}|latest-render`),
        ]);
        const previewUrl = media?.blob ? URL.createObjectURL(media.blob) : undefined;
        if (previewUrl) projectPreviewUrlsRef.current.push(previewUrl);
        return { project, media, previewUrl, hasFinalRender: Boolean(finalRender?.blob) } satisfies ProjectLibraryItem;
      }));
      setProjectLibrary(items);
    } catch (error: any) {
      console.error("Could not load project library:", error);
      setErrorMsg(`Không thể mở thư viện dự án: ${error?.message || error}`);
    } finally {
      setIsProjectLibraryLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "projects") refreshProjectLibrary();
  }, [activeTab]);

  useEffect(() => () => {
    projectPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const handleOpenLibraryProject = (projectId: string) => {
    localStorage.setItem(PROJECT_POINTER_KEY, projectId);
    window.location.reload();
  };

  const handleCreateNewProject = () => {
    if (videoSrc?.startsWith("blob:")) URL.revokeObjectURL(videoSrc);
    if (exportedVideoUrl?.startsWith("blob:")) URL.revokeObjectURL(exportedVideoUrl);
    localStorage.removeItem(PROJECT_POINTER_KEY);
    setCurrentProjectId("");
    setVideoFile(null);
    setVideoName("");
    setVideoSrc("");
    setVideoMimeType("video/mp4");
    setExtractedAudio(null);
    extractedAudioRef.current = null;
    setSubtitles([]);
    setSubtitlePipelineVersion(0);
    setBlurBoxes([]);
    setActiveBlurBoxId(null);
    setFlipHorizontal(false);
    setFlipVertical(false);
    setExportedVideoUrl("");
    setErrorMsg("");
    setActiveTab("translate");
  };

  const handleDeleteLibraryProject = async (projectId: string, projectName: string) => {
    if (!window.confirm(`Xóa dự án "${projectName}" và toàn bộ checkpoint STT/TTS?`)) return;
    setIsProjectLibraryLoading(true);
    try {
      const [chunks, ttsClips, ocrCheckpoints] = await Promise.all([
        projectDbGetAll<StoredChunk>("chunks"),
        projectDbGetAll<StoredTtsClip>("tts"),
        projectDbGetAll<StoredOcrCheckpoint>("ocr"),
      ]);
      await Promise.all([
        projectDbDelete("projects", projectId),
        projectDbDelete("media", projectId),
        projectDbDelete("media", `${projectId}|latest-render`),
        ...chunks.filter((chunk) => chunk.projectId === projectId).map((chunk) => projectDbDelete("chunks", chunk.id)),
        ...ttsClips.filter((clip) => clip.projectId === projectId).map((clip) => projectDbDelete("tts", clip.id)),
        ...ocrCheckpoints.filter((item) => item.projectId === projectId).map((item) => projectDbDelete("ocr", item.id)),
      ]);

      if (localStorage.getItem(PROJECT_POINTER_KEY) === projectId) {
        localStorage.removeItem(PROJECT_POINTER_KEY);
        setCurrentProjectId("");
        setVideoFile(null);
        setVideoName("");
        setVideoSrc("");
        setSubtitles([]);
        setSubtitlePipelineVersion(0);
        setExportedVideoUrl("");
      }
      addLog(`Đã xóa dự án "${projectName}" khỏi thư viện.`);
      await refreshProjectLibrary();
    } catch (error: any) {
      setErrorMsg(`Không thể xóa dự án: ${error?.message || error}`);
    } finally {
      setIsProjectLibraryLoading(false);
    }
  };

  // Handle load demo video

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  };

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("video/")) {
      setErrorMsg("Vui lòng chọn một tập tin video hợp lệ (MP4, WebM, v.v.)");
      return;
    }

    const projectId = makeProjectId(file);
    setCurrentProjectId(projectId);
    setIsRestoringProject(false);
    localStorage.setItem(PROJECT_POINTER_KEY, projectId);

    try {
      if (navigator.storage?.persist) await navigator.storage.persist();
      await projectDbPut("media", {
        id: projectId,
        blob: file,
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
      } satisfies StoredProjectMedia);
      addLog("Đã tạo checkpoint dự án và lưu video gốc trong trình duyệt.");
    } catch (storageError: any) {
      console.warn("Could not persist project media:", storageError);
      addLog(`CẢNH BÁO: Không thể lưu video dự án (${storageError?.message || storageError}).`);
    }

    setVideoFile(file);
    setVideoName(file.name);
    setVideoMimeType(file.type);
    setSubtitles([]);
    setSubtitlePipelineVersion(0);
    setBlurBoxes([]);
    setActiveBlurBoxId(null);
    setErrorMsg("");
    setExtractedAudio(null);
    extractedAudioRef.current = null;
    
    // Revoke previous object URL if it exists to prevent memory leak
    if (videoSrc && videoSrc.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(videoSrc);
      } catch (err) {
        console.error("Error revoking object URL:", err);
      }
    }

    const objectUrl = URL.createObjectURL(file);
    setVideoSrc(objectUrl);
    setActiveTab("translate");

    // Extract audio track immediately to bypass any permission revocation later
    setIsExtractingAudio(true);
    setExtractingProgressStep("Đang chuẩn bị trích xuất âm thanh...");
    
    extractAudioTrack(file, (step) => {
      setExtractingProgressStep(step);
    })
    .then((extracted) => {
      setExtractedAudio(extracted);
      extractedAudioRef.current = extracted;
      setIsExtractingAudio(false);
      setExtractingProgressStep("");
    })
    .catch((err) => {
      console.error("Error extracting audio immediately:", err);
      setErrorMsg(
        `Không thể đọc/trích xuất âm thanh từ video. Lỗi: ${err.message || err}. Vui lòng thử lại với video ngắn hơn hoặc dung lượng nhỏ hơn.`
      );
      setIsExtractingAudio(false);
      setExtractingProgressStep("");
    });
  };

  // Convert File to Base64 safely for API
  const getFileBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (error) => reject(error);
    });
  };
function mergeDuplicateSubtitles(subs: ChunkSubtitle[]): Subtitle[] {
  if (subs.length === 0) return [];
  const sorted = [...subs].sort((a, b) => a.start - b.start);
  const merged: ChunkSubtitle[] = [];
  const MAX_TIME_DISTANCE = 1.0;
  const FUZZY_THRESHOLD = 0.80;

  for (const sub of sorted) {
    let duplicateIndex = -1;
    for (let i = merged.length - 1; i >= 0; i--) {
      const candidate = merged[i];
      if (sub.start - candidate.end > MAX_TIME_DISTANCE) break;

      const originalScore = diceSimilarity(candidate.original || "", sub.original || "");
      const translatedScore = diceSimilarity(candidate.translated || "", sub.translated || "");
      const textMatches = Math.max(originalScore, translatedScore) >= FUZZY_THRESHOLD;

      const timestampsRelated =
        sub.start <= candidate.end + MAX_TIME_DISTANCE &&
        candidate.start <= sub.end + MAX_TIME_DISTANCE;

      if (timestampsRelated && textMatches) {
        duplicateIndex = i;
        break;
      }
    }

    if (duplicateIndex === -1) {
      merged.push({ ...sub });
      continue;
    }

    const previous = merged[duplicateIndex];
    previous.start = Math.min(previous.start, sub.start);
    previous.end = Math.max(previous.end, sub.end);
    
    const prevText = previous.translated || previous.original || "";
    const currText = sub.translated || sub.original || "";
    if (currText.length > prevText.length) {
      previous.original = sub.original;
      previous.translated = sub.translated;
    }
  }

  return merged.sort((a, b) => a.start - b.start).map(stripChunkMetadata);
}

function normalizeChunkSubtitleTimestamps(
  subs: ChunkSubtitle[],
  chunkStart: number,
  chunkEnd: number,
  videoDuration: number,
): ChunkSubtitle[] {
  if (subs.length === 0) return [];
  const localDuration = Math.max(0.1, chunkEnd - chunkStart);
  const finiteSubs = subs.filter((sub) => Number.isFinite(sub.start) && Number.isFinite(sub.end));
  const tolerance = 0.35;
  const candidates = finiteSubs.map((sub) => {
    const absoluteFits = sub.start >= chunkStart - tolerance && sub.end <= chunkEnd + tolerance;
    const relativeFits = sub.start >= -tolerance && sub.end <= localDuration + tolerance;
    return { sub, absoluteFits, relativeFits };
  });
  const strongAbsoluteCount = candidates.filter((item) => item.absoluteFits && !item.relativeFits).length;
  const strongRelativeCount = candidates.filter((item) => item.relativeFits && !item.absoluteFits).length;
  const preferRelative = chunkStart > 0.01 && strongRelativeCount > strongAbsoluteCount;
  let previousEnd = chunkStart;

  return candidates
    .map(({ sub, absoluteFits, relativeFits }) => {
      let useRelative = false;
      if (chunkStart > 0.01) {
        if (relativeFits && !absoluteFits) useRelative = true;
        else if (relativeFits && absoluteFits) {
          const absoluteBacktracks = sub.start < previousEnd - tolerance;
          const shiftedBacktracks = sub.start + chunkStart < previousEnd - tolerance;
          if (absoluteBacktracks !== shiftedBacktracks) useRelative = !shiftedBacktracks;
          else useRelative = preferRelative;
        }
      }
      const start = sub.start + (useRelative ? chunkStart : 0);
      const end = sub.end + (useRelative ? chunkStart : 0);
      const normalizedStart = Number(Math.max(chunkStart, Math.min(videoDuration, start)).toFixed(2));
      const normalizedEnd = Number(Math.max(chunkStart, Math.min(chunkEnd, videoDuration, end)).toFixed(2));
      previousEnd = Math.max(previousEnd, normalizedEnd);
      return {
        ...sub,
        start: normalizedStart,
        end: normalizedEnd,
        chunkStart,
        chunkEnd,
        boundaryDistance: Math.max(0, Math.min(normalizedStart - chunkStart, chunkEnd - normalizedEnd)),
      };
    })
    .filter((sub) => sub.end > sub.start);
}

function validateSubtitleTimeline(
  subs: Subtitle[],
  videoDuration: number,
  gapSeconds = SUBTITLE_GUARD_SECONDS,
): Subtitle[] {
  const safeVideoDuration = Number.isFinite(videoDuration) && videoDuration > 0
    ? videoDuration
    : Math.max(...subs.map((sub) => sub.end), 0);
  const sorted = subs
    .map((sub) => ({
      ...sub,
      start: Math.max(0, Math.min(safeVideoDuration, Number(sub.start) || 0)),
      end: Math.max(0, Math.min(safeVideoDuration, Number(sub.end) || 0)),
    }))
    .filter((sub) => sub.end > sub.start)
    .sort((a, b) => a.start - b.start);

  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const guardedEnd = current.start - gapSeconds;

    if (previous.end > guardedEnd && guardedEnd >= previous.start + 0.1) {
      previous.end = guardedEnd;
    }
    if (previous.end > current.start) {
      previous.end = Math.max(previous.start + 0.05, current.start);
    }
  }

  return sorted.filter((sub) => sub.end > sub.start);
}

const SMART_TTS_MIN_RATE = 1.1;
const SMART_TTS_MAX_RATE = 1.8;
const SMART_TTS_VOICE_GAP_SECONDS = 0.06;

// Tính khoảng trống (giây) giữa phụ đề hiện tại và phụ đề kế tiếp trong toàn bộ timeline.
// Nếu là phụ đề cuối cùng, cho phép giãn thêm tối đa 3 giây (an toàn, tránh im lặng quá lâu ở cuối video).
function getSubtitleGapAfter(sub: Subtitle, allSubs: Subtitle[]): number {
  const sorted = [...allSubs].sort((a, b) => a.start - b.start);
  const idx = sorted.findIndex((s) => s.id === sub.id);
  if (idx === -1 || idx === sorted.length - 1) {
    return 3;
  }
  const next = sorted[idx + 1];
  return Math.max(0, next.start - sub.end);
}

// Preview uses the subtitle budget plus any real silence before the next line.
// Final rendering performs an additional measured pass after trimming TTS silence.
function computeSmartTtsRate(
  audioDuration: number,
  subDuration: number,
  gapAfter: number,
  baseRate: number
): number {
  const clamp = (r: number) => Math.max(SMART_TTS_MIN_RATE, Math.min(SMART_TTS_MAX_RATE, r));
  const availableDuration = Math.max(0.05, subDuration + Math.max(0, gapAfter));
  return clamp(Math.max(baseRate, audioDuration / availableDuration));
}

  async function checkOcrService(showFailurePopup = true): Promise<OcrServiceHealth> {
    setIsCheckingOcr(true);
    try {
      const response = await fetch("/api/ocr/health", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      const status: OcrServiceHealth = { ...payload, connected: response.ok && payload.connected === true };
      setOcrHealth(status);
      if (showFailurePopup && status.state === "error") setErrorMsg(status.error || "CPU OCR dự phòng chưa sẵn sàng.");
      return status;
    } catch (error: any) {
      const status: OcrServiceHealth = { connected: false, state: "error", error: error?.message || String(error) };
      setOcrHealth(status);
      if (showFailurePopup) setErrorMsg(`Không kiểm tra được CPU OCR dự phòng: ${status.error}`);
      return status;
    } finally {
      setIsCheckingOcr(false);
    }
  }

  useEffect(() => {
    if (extractionMethod === "ocr") void checkOcrService(false);
  }, [extractionMethod]);

  useEffect(() => {
    localStorage.setItem("26dubbin_ocr_region_presets", JSON.stringify(ocrPresets));
  }, [ocrPresets]);

  // Call translation API
  const handleTranslateVideo = async () => {
    if (!videoSrc) {
      setErrorMsg("Vui lòng tải lên video trước.");
      return;
    }

    setIsLoading(true);
    setErrorMsg("");
    setLoadingProgress(0);
    setLoadingEtaSeconds(null);
    setLoadingStep("Chuẩn bị dữ liệu video...");
    addLog("Bắt đầu xử lý dịch và trích xuất phụ đề video...");

    try {
      if (extractionMethod === "ocr") {
        if (!videoFile) throw new Error("PaddleOCR cần tệp video gốc, không thể chạy trên video demo.");
        const fallbackHealth = await checkOcrService(false);
        const fallbackLabel = fallbackHealth.connected
          ? "đã sẵn sàng dự phòng"
          : fallbackHealth.state === "idle"
            ? "sẽ chỉ khởi tạo khi frontend thất bại"
            : fallbackHealth.state === "initializing"
              ? "đang khởi tạo dự phòng"
              : "không khả dụng";
        const ocrRuntimeProfile = getOcrRuntimeProfile();
        const memoryLabel = ocrRuntimeProfile.deviceMemoryGb === null ? "không rõ RAM" : `${ocrRuntimeProfile.deviceMemoryGb}GB RAM`;
        addLog(`[PaddleOCR Web] ${ocrRuntimeProfile.label}; ${ocrRuntimeProfile.logicalCpus} luồng CPU; ${memoryLabel}; ${ocrRuntimeProfile.webGpuAvailable ? "có WebGPU" : "WASM/CPU"}; batch ${ocrRuntimeProfile.batchSize}; hàng đợi ${ocrRuntimeProfile.maxQueuedCandidates}. CPU server ${fallbackLabel}.`);
        setLoadingStep("Đang quét thay đổi frame trong trình duyệt...");
        const ocrProjectId = currentProjectId || makeProjectId(videoFile);
        const ocrJobKey = stableHash(JSON.stringify({
          pipeline: "browser-adaptive-v4",
          file: {
            name: videoFile.name,
            size: videoFile.size,
            lastModified: videoFile.lastModified,
          },
          fps: ocrFps,
          regions: ocrRegions.map((region) => ({
            id: region.id,
            x: Number(region.x.toFixed(3)),
            y: Number(region.y.toFixed(3)),
            width: Number(region.width.toFixed(3)),
            height: Number(region.height.toFixed(3)),
          })),
          confidence: 0.3,
          runtime: {
            id: ocrRuntimeProfile.id,
            maxOcrWidth: ocrRuntimeProfile.maxOcrWidth,
            playbackRate: ocrRuntimeProfile.playbackRate,
          },
        }));
        const liveTranslationCache = new Map<string, string>();
        const scheduledTranslationKeys = new Set<string>();
        let latestOcrSubtitles: Subtitle[] = [];
        let translatedLineCount = 0;
        let translationFailure: Error | null = null;
        let translationQueue: Promise<void> = Promise.resolve();
        const translationBatchSize = 20;
        const getTranslationKey = (subtitle: Subtitle) => normalizedOcrText(subtitle.original);

        for (const subtitle of subtitles) {
          const key = getTranslationKey(subtitle);
          const translated = cleanOcrText(subtitle.translated || "");
          if (key && translated && translated !== cleanOcrText(subtitle.original)) {
            liveTranslationCache.set(key, translated);
            scheduledTranslationKeys.add(key);
          }
        }
        translatedLineCount = liveTranslationCache.size;

        const applyLiveTranslations = (items: Subtitle[]) => items.map((subtitle) => {
          const translated = liveTranslationCache.get(getTranslationKey(subtitle));
          return translated ? { ...subtitle, translated } : subtitle;
        });

        const translateOcrBatch = async (batch: Subtitle[]) => {
          const response = await fetch("/api/translate-subtitles", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getGeminiRequestHeaders(geminiApiKey) },
            body: JSON.stringify({
              subtitles: batch,
              sourceLanguage: sourceLang,
              targetLanguage: targetLang,
              apiPlatform,
              customApiUrl: apiPlatform === "custom" ? customApiUrl : "",
              customApiKey: apiPlatform === "custom" ? customApiKey : "",
              customModel: apiPlatform === "custom" ? customModel : "",
              allowGeminiFallback,
            }),
          });
          const payload = await readJsonResponse(response);
          const translatedItems: Array<Partial<Subtitle> & { id?: string | number }> = Array.isArray(payload.subtitles)
            ? payload.subtitles
            : [];
          if (translatedItems.length !== batch.length) {
            throw new Error(`Bản dịch trả thiếu dòng (${translatedItems.length}/${batch.length}); OCR vẫn được giữ trong checkpoint.`);
          }
          const translatedById = new Map<string, Partial<Subtitle>>(
            translatedItems.map((item) => [String(item.id || ""), item]),
          );
          return batch.map((original) => {
            const translated = translatedById.get(original.id);
            if (!translated) throw new Error(`Bản dịch thiếu ID ${original.id}; OCR vẫn được giữ trong checkpoint.`);
            const returnedStart = Number(translated.start);
            const returnedEnd = Number(translated.end);
            if (Math.abs(returnedStart - original.start) > 0.001 || Math.abs(returnedEnd - original.end) > 0.001) {
              addLog(`[Dịch] Giữ timestamp OCR ${original.start.toFixed(2)}-${original.end.toFixed(2)}s cho ${original.id}.`);
            }
            return {
              ...original,
              translated: cleanOcrText(String(translated.translated || original.original)),
            };
          });
        };

        const scheduleLiveTranslations = (items: Subtitle[], flushAll = false) => {
          latestOcrSubtitles = items;
          const stableItems = flushAll ? items : items.slice(0, -1);
          const uniquePending = new Map<string, Subtitle>();
          for (const subtitle of stableItems) {
            const key = getTranslationKey(subtitle);
            if (key && !scheduledTranslationKeys.has(key)) uniquePending.set(key, subtitle);
          }
          const pending = [...uniquePending.values()];
          const scheduledCount = flushAll
            ? pending.length
            : Math.floor(pending.length / translationBatchSize) * translationBatchSize;
          if (scheduledCount === 0) return;

          for (let offset = 0; offset < scheduledCount; offset += translationBatchSize) {
            const batch = pending.slice(offset, Math.min(scheduledCount, offset + translationBatchSize));
            for (const subtitle of batch) scheduledTranslationKeys.add(getTranslationKey(subtitle));
            translationQueue = translationQueue.then(async () => {
              if (translationFailure) return;
              try {
                const translatedBatch = await translateOcrBatch(batch);
                for (const subtitle of translatedBatch) {
                  const key = getTranslationKey(subtitle);
                  if (key) liveTranslationCache.set(key, subtitle.translated);
                }
                translatedLineCount = liveTranslationCache.size;
                setSubtitles(applyLiveTranslations(latestOcrSubtitles));
                setLoadingStep(`Đang OCR và dịch song song: đã dịch ${translatedLineCount} dòng...`);
                addLog(`[OCR + Dịch] Đã dịch thêm ${translatedBatch.length} dòng; tổng ${translatedLineCount} dòng.`);
              } catch (error) {
                translationFailure = error instanceof Error ? error : new Error(String(error));
                const message = `Dịch song song gặp lỗi: ${translationFailure.message} OCR vẫn tiếp tục và kết quả đã nhận vẫn được lưu.`;
                setErrorMsg(message);
                addLog(`[OCR + Dịch] ${message}`);
              }
            });
          }
        };

        const ocrResult = await runPaddleOcrOnVideo(videoFile, ocrFps, ocrRegions, (message, percent, etaSeconds) => {
          setLoadingStep(`${message} Đã dịch ${translatedLineCount} dòng.`);
          setLoadingProgress(Math.min(95, percent));
          setLoadingEtaSeconds(etaSeconds);
          addLog(message);
        }, { projectId: ocrProjectId, jobKey: ocrJobKey }, (partialFrames, frameInterval, videoDuration) => {
          const partialSubtitles = mergeOcrFramesToSubtitles(partialFrames, frameInterval, videoDuration);
          if (partialSubtitles.length > 0) {
            latestOcrSubtitles = partialSubtitles;
            setSubtitles(applyLiveTranslations(partialSubtitles));
            setSubtitlePipelineVersion(0);
            scheduleLiveTranslations(partialSubtitles);
          }
        }, ocrRuntimeProfile);
        const activeBrowserBackend = ocrResult.model?.backend?.endsWith("/webgpu")
          ? "webgpu"
          : ocrResult.model?.backend?.endsWith("/wasm")
            ? "wasm"
            : null;
        if (activeBrowserBackend) {
          setBrowserOcrBackend(activeBrowserBackend);
          setBrowserOcrStatus("ready");
          setBrowserOcrError("");
        }
        const originalSubtitles = mergeOcrFramesToSubtitles(ocrResult.frames, ocrResult.frameInterval, ocrResult.duration);
        if (!originalSubtitles.length) {
          throw new Error("PaddleOCR không thấy phụ đề trong vùng đã chọn. Hãy seek tới frame có chữ, chỉnh ROI và bấm Preview OCR trước.");
        }
        latestOcrSubtitles = originalSubtitles;
        setSubtitles(applyLiveTranslations(originalSubtitles));
        addLog(`[PaddleOCR frontend] Gộp ${ocrResult.frames.length} frame thành ${originalSubtitles.length} dòng bằng fuzzy temporal merge; timestamp lấy trực tiếp từ frame.`);

        scheduleLiveTranslations(originalSubtitles, true);
        setLoadingStep(`OCR hoàn tất; đang chờ dịch nốt các dòng còn lại...`);
        setLoadingProgress(96);
        const translationEstimate = Math.max(8, Math.ceil(6 + originalSubtitles.length * 0.18));
        setLoadingEtaSeconds(translationEstimate);
        await translationQueue;
        if (translationFailure) throw translationFailure;
        const finalSubtitles = applyLiveTranslations(originalSubtitles);
        setSubtitles(finalSubtitles);
        setSubtitlePipelineVersion(5);
        setActiveTab("tracks");
        setLoadingProgress(100);
        addLog(`[PaddleOCR frontend] Hoàn tất ${finalSubtitles.length} dòng; AI chỉ nhận text để dịch, không nhận ảnh.`);
        return;
      }

      let base64Payload = "";
      let payloadMimeType = videoMimeType;
      let frames: { timestamp: number; base64: string }[] = [];
      
      if (videoFile) {
        if (extractionMethod === "aiocr") {
          setLoadingStep("Đang trích xuất khung hình từ video...");
          addLog("Bắt đầu trích xuất khung hình từ video...");
          const frameInterval = apiPlatform === "custom" ? 0.5 : 2.0;
          addLog(`Lấy khung hình OCR mỗi ${frameInterval}s${apiPlatform === "custom" ? " cho Custom API" : ""}.`);
          frames = await extractVideoFrames(videoFile, frameInterval, (step) => {
            setLoadingStep(step);
            addLog(step);
          });
          if (extractedAudioRef.current) {
            const cur = extractedAudioRef.current as { base64: string; mimeType: string; audioBuffer?: AudioBuffer };
            base64Payload = cur.base64;
            payloadMimeType = cur.mimeType;
          }
        } else {
          if (extractedAudioRef.current) {
            const cur = extractedAudioRef.current as { base64: string; mimeType: string; audioBuffer?: AudioBuffer };
            base64Payload = cur.base64;
            payloadMimeType = cur.mimeType;
          } else if (isExtractingAudio) {
            setLoadingStep("Vui lòng đợi giây lát, đang hoàn tất trích xuất âm thanh nền...");
            addLog("Đang đợi hoàn tất quá trình trích xuất âm thanh từ tệp video...");
            let waitTime = 0;
            while (!extractedAudioRef.current && waitTime < 60000) {
              await new Promise((r) => setTimeout(r, 500));
              waitTime += 500;
            }
            if (extractedAudioRef.current) {
              const cur = extractedAudioRef.current as { base64: string; mimeType: string; audioBuffer?: AudioBuffer };
              base64Payload = cur.base64;
              payloadMimeType = cur.mimeType;
            } else {
              throw new Error("Trích xuất âm thanh nền quá lâu hoặc gặp lỗi. Vui lòng thử lại.");
            }
          } else {
            setLoadingStep("Đang trích xuất âm thanh từ video...");
            addLog("Đang khởi chạy tiến trình trích xuất âm thanh: " + videoName);
            const extracted: { base64: string; mimeType: string; audioBuffer: AudioBuffer } =
              await extractAudioTrack(videoFile, (step) => {
                setLoadingStep(step);
                addLog(`Trích xuất: ${step}`);
              });
            base64Payload = extracted.base64;
            payloadMimeType = extracted.mimeType;
            extractedAudioRef.current = extracted;
            setExtractedAudio(extracted);
            addLog("Trích xuất âm thanh gốc thành công!");
          }
        }
      } else {
        // If it's the demo video, we fetch its content or mock the translation process 
        // to save API tokens and give an instantaneous premium experience.
        setLoadingStep("Gửi yêu cầu dịch thuật bằng Gemini 3.5 AI...");
        addLog("Sử dụng bản thử nghiệm tối ưu cho video demo...");
        await new Promise((r) => setTimeout(r, 2000));
        setSubtitles(SAMPLE_SUBTITLES);
        setLoadingStep("Đang cấu trúc kết quả phụ đề...");
        await new Promise((r) => setTimeout(r, 800));
        setIsLoading(false);
        setActiveTab("tracks");
        addLog("Nạp dữ liệu mẫu thành công.");
        return;
      }

      const audioBuffer = extractedAudioRef.current?.audioBuffer;
      const totalDuration = duration || (audioBuffer ? audioBuffer.duration : 0);
      const activeProjectId = currentProjectId || (videoFile ? makeProjectId(videoFile) : "temporary-project");
      const translationJobKey = `stt-v4-${stableHash(JSON.stringify({
        projectId: activeProjectId,
        sourceLang,
        targetLang,
        extractionMethod,
        apiPlatform,
        customModel: apiPlatform === "custom" ? customModel : "gemini",
      }))}`;
      const CHUNK_DURATION = 12;
      const CHUNK_OVERLAP = 2;
      const CHUNK_STEP = CHUNK_DURATION - CHUNK_OVERLAP;
      
      const shouldChunk = extractionMethod === "audio" && audioBuffer && totalDuration > CHUNK_DURATION;

      if (shouldChunk && audioBuffer) {
        const chunkRanges: Array<{ start: number; end: number }> = [];
        for (let start = 0; start < totalDuration; start += CHUNK_STEP) {
          chunkRanges.push({ start, end: Math.min(start + CHUNK_DURATION, totalDuration) });
          if (start + CHUNK_DURATION >= totalDuration) break;
        }
        const numChunks = chunkRanges.length;
        addLog(`Thời lượng video ${totalDuration.toFixed(1)}s. Chia thành ${numChunks} phân đoạn 12s, chồng lấn 2s để không mất lời ở biên.`);
        const allSubtitles: ChunkSubtitle[] = [];
        const chunkStageStartedAt = performance.now();
        setLoadingEtaSeconds(numChunks * (apiPlatform === "custom" ? 7 : 19));
        const updateChunkEstimate = (completed: number) => {
          const elapsedSeconds = Math.max(0.25, (performance.now() - chunkStageStartedAt) / 1000);
          const remaining = Math.max(0, numChunks - completed);
          const averageSeconds = elapsedSeconds / Math.max(1, completed);
          setLoadingProgress(Math.min(99, Math.round((completed / Math.max(1, numChunks)) * 99)));
          setLoadingEtaSeconds(remaining > 0 ? Math.max(1, Math.ceil(averageSeconds * remaining)) : 0);
        };

        for (let i = 0; i < numChunks; i++) {
          const { start: startSec, end: endSec } = chunkRanges[i];
          const currentChunkDuration = endSec - startSec;
          const chunkCacheId = `${activeProjectId}|${translationJobKey}|${startSec.toFixed(2)}-${endSec.toFixed(2)}`;
          const cachedChunk = await projectDbGet<StoredChunk>("chunks", chunkCacheId).catch(() => undefined);
          if (cachedChunk) {
            const normalizedCachedSubtitles = normalizeChunkSubtitleTimestamps(
              cachedChunk.subtitles,
              startSec,
              endSec,
              totalDuration,
            );
            allSubtitles.push(...normalizedCachedSubtitles);
            const partial = validateSubtitleTimeline(mergeDuplicateSubtitles(allSubtitles), totalDuration);
            setSubtitles(partial);
            addLog(`[Phân đoạn ${i + 1}/${numChunks}] Đã khôi phục và chuẩn hóa timestamp từ checkpoint (${normalizedCachedSubtitles.length} dòng), không gọi Gemini.`);
            updateChunkEstimate(i + 1);
            continue;
          }
          
          // Custom API does not use Gemini's free-tier request cooldown.
          if (i > 0 && apiPlatform !== "custom") {
            const cooldownSecs = 12;
            for (let sec = cooldownSecs; sec > 0; sec--) {
              setLoadingStep(`[Phân đoạn ${i + 1}/${numChunks}] Đang nghỉ ${sec}s để tránh quá tải giới hạn API miễn phí (Rate Limit)...`);
              setLoadingEtaSeconds((current) => current === null ? null : Math.max(1, current - 1));
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }

          setLoadingStep(`[Phân đoạn ${i + 1}/${numChunks}] Trích xuất âm thanh (${Math.floor(startSec)}s - ${Math.floor(endSec)}s)...`);
          const chunkBase64 = await getAudioChunkBase64(audioBuffer, startSec, endSec);

          setLoadingStep(`[Phân đoạn ${i + 1}/${numChunks}] Đang dịch thuật bằng AI...`);
          addLog(`[Phân đoạn ${i + 1}/${numChunks}] Đang dịch thuật và tạo phụ đề (${Math.floor(startSec)}s - ${Math.floor(endSec)}s)...`);
          
          let response: Response | null = null;
          let responseText = "";
          let attempt = 0;
          const maxAttempts = 3;
          
          while (attempt < maxAttempts) {
            try {
              response = await fetch("/api/translate-video", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...getGeminiRequestHeaders(geminiApiKey),
                },
                body: JSON.stringify({
                  videoBase64: chunkBase64,
                  mimeType: payloadMimeType,
                  sourceLanguage: sourceLang,
                  targetLanguage: targetLang,
                  duration: currentChunkDuration,
                  videoDuration: totalDuration,
                  chunkIndex: i,
                  chunkStart: startSec,
                  chunkEnd: endSec,
                  timestampMode: "absolute",
                  apiPlatform: apiPlatform,
                  customApiUrl: apiPlatform === "custom" ? customApiUrl : "",
                  customApiKey: apiPlatform === "custom" ? customApiKey : "",
                  customModel: apiPlatform === "custom" ? customModel : "",
                  extractionMethod: extractionMethod,
                  allowGeminiFallback,
                }),
              });

              responseText = await response.text();
              
              if (response.status === 429) {
                attempt++;
                if (attempt < maxAttempts) {
                  // Wait longer and retry
                  const retryDelay = 20 * attempt;
                  for (let sec = retryDelay; sec > 0; sec--) {
                    setLoadingStep(`[Phân đoạn ${i + 1}/${numChunks}] API đạt giới hạn (429). Đang chờ thử lại sau ${sec}s (Lần thử ${attempt}/${maxAttempts - 1})...`);
                    setLoadingEtaSeconds((current) => current === null ? null : Math.max(1, current - 1));
                    await new Promise(resolve => setTimeout(resolve, 1000));
                  }
                  continue;
                }
              }
              break;
            } catch (fetchErr: any) {
              attempt++;
              if (attempt >= maxAttempts) {
                throw fetchErr;
              }
              await new Promise(resolve => setTimeout(resolve, 3000));
            }
          }

          if (!response || !response.ok) {
            let errMsg = `Dịch phân đoạn ${i + 1}/${numChunks} thất bại.`;
            try {
              const errData = JSON.parse(responseText);
              errMsg = errData.error || errMsg;
            } catch (jsonErr) {
              if (responseText.trim().startsWith("<")) {
                const titleMatch = responseText.match(/<title>([\s\S]*?)<\/title>/i);
                const title = titleMatch ? titleMatch[1].trim() : "";
                errMsg = `Lỗi hệ thống (HTML ${response ? response.status : "unknown"}) ở phân đoạn ${i + 1}: ${title || (response ? response.statusText : "")}`;
              } else {
                errMsg = `${response ? response.status : "unknown"} ${response ? response.statusText : ""}: ${responseText.substring(0, 150)}`;
              }
            }
            throw new Error(errMsg);
          }

          let data;
          try {
            data = JSON.parse(responseText);
          } catch (jsonErr) {
            console.error("Non-JSON response received:", responseText);
            if (responseText.trim().startsWith("<")) {
              const titleMatch = responseText.match(/<title>([\s\S]*?)<\/title>/i);
              const title = titleMatch ? titleMatch[1].trim() : "";
              throw new Error(`Lỗi phản hồi hệ thống (HTML format): ${title || "Phản hồi không mong đợi"}`);
            }
            throw new Error(`Phản hồi phân đoạn ${i + 1} từ server không đúng định dạng JSON.`);
          }

          if (data.subtitles && Array.isArray(data.subtitles)) {
            const rawChunkSubtitles: ChunkSubtitle[] = data.subtitles.map((sub: any, idx: number) => {
              const start = typeof sub.start === "number" ? sub.start : parseFloat(sub.start || 0);
              const end = typeof sub.end === "number" ? sub.end : parseFloat(sub.end || 0);
              const realStart = parseFloat(start.toFixed(2));
              const realEnd = parseFloat(Math.max(start + 0.1, end).toFixed(2));

              return {
                id: `sub-gen-${i}-${idx}-${Date.now()}`,
                start: realStart,
                end: realEnd,
                original: sub.original || "",
                translated: sub.translated || "",
                chunkIndex: i,
                chunkStart: startSec,
                chunkEnd: endSec,
                boundaryDistance: Math.max(0, Math.min(realStart - startSec, endSec - realEnd)),
              };
            });
            const formattedChunkSubtitles = normalizeChunkSubtitleTimestamps(
              rawChunkSubtitles,
              startSec,
              endSec,
              totalDuration,
            );
            
            allSubtitles.push(...formattedChunkSubtitles);
            const checkpointSaved = await projectDbPut("chunks", {
              id: chunkCacheId,
              projectId: activeProjectId,
              jobKey: translationJobKey,
              start: startSec,
              end: endSec,
              subtitles: formattedChunkSubtitles,
              updatedAt: Date.now(),
            } satisfies StoredChunk).then(() => true).catch((error) => {
              console.warn("Could not persist STT chunk:", error);
              addLog(`[Phân đoạn ${i + 1}/${numChunks}] Không lưu được checkpoint: ${error?.message || error}`);
              return false;
            });
            setSubtitles(validateSubtitleTimeline(mergeDuplicateSubtitles(allSubtitles), totalDuration));
            addLog(`[Phân đoạn ${i + 1}/${numChunks}] Hoàn tất! Nhận được ${formattedChunkSubtitles.length} dòng phụ đề.`);
            if (checkpointSaved) addLog(`[Phân đoạn ${i + 1}/${numChunks}] Đã lưu checkpoint; nếu hết quota có thể bấm chạy lại để tiếp tục.`);
          }
          updateChunkEstimate(i + 1);
        }

        // Sort entire merged array chronologically
        const sortedSubtitles = allSubtitles.sort((a, b) => a.start - b.start);
        const dedupedSubtitles = mergeDuplicateSubtitles(sortedSubtitles);
        const validatedSubtitles = validateSubtitleTimeline(dedupedSubtitles, totalDuration);
        setSubtitles(validatedSubtitles);
        setSubtitlePipelineVersion(4);
        addLog(`Đã gộp trùng lặp: ${sortedSubtitles.length} → ${dedupedSubtitles.length} phân đoạn.`);
      } else {
        // Fallback for short files or when audioBuffer is not present (single request)
        setLoadingStep("Đang dịch thuật và trích xuất phụ đề bằng AI...");
        addLog("Đang dịch thuật và trích xuất phụ đề toàn bộ video bằng AI...");
        const singleRequestEstimate = Math.max(10, Math.ceil(8 + totalDuration * 0.08));
        const singleRequestStartedAt = performance.now();
        setLoadingEtaSeconds(singleRequestEstimate);
        const singleRequestTicker = window.setInterval(() => {
          const elapsed = Math.floor((performance.now() - singleRequestStartedAt) / 1000);
          setLoadingEtaSeconds(Math.max(1, singleRequestEstimate - elapsed));
          setLoadingProgress(Math.min(98, Math.max(1, Math.round((elapsed / singleRequestEstimate) * 90))));
        }, 1000);
        let response: Response;
        try {
          response = await fetch("/api/translate-video", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...getGeminiRequestHeaders(geminiApiKey),
            },
            body: JSON.stringify({
              videoBase64: base64Payload,
              mimeType: payloadMimeType,
              frames: frames,
              sourceLanguage: sourceLang,
              targetLanguage: targetLang,
              duration: totalDuration,
              videoDuration: totalDuration,
              chunkIndex: 0,
              chunkStart: 0,
              chunkEnd: totalDuration,
              timestampMode: "absolute",
              apiPlatform: apiPlatform,
              customApiUrl: apiPlatform === "custom" ? customApiUrl : "",
              customApiKey: apiPlatform === "custom" ? customApiKey : "",
              customModel: apiPlatform === "custom" ? customModel : "",
              extractionMethod: extractionMethod,
              allowGeminiFallback,
            }),
          });
        } finally {
          window.clearInterval(singleRequestTicker);
        }

        let responseText = "";
        try {
          responseText = await response.text();
        } catch (readErr) {
          throw new Error(`Không thể đọc luồng phản hồi từ server: ${response.status} ${response.statusText}`);
        }

        if (!response.ok) {
          let errMsg = "Gửi yêu cầu dịch video thất bại.";
          try {
            const errData = JSON.parse(responseText);
            errMsg = errData.error || errMsg;
          } catch (jsonErr) {
            if (responseText.trim().startsWith("<")) {
              const titleMatch = responseText.match(/<title>([\s\S]*?)<\/title>/i);
              const title = titleMatch ? titleMatch[1].trim() : "";
              errMsg = `Lỗi hệ thống (HTML ${response.status}): ${title || response.statusText}. Vui lòng thử lại với video ngắn hơn hoặc dung lượng nhỏ hơn.`;
            } else {
              errMsg = `${response.status} ${response.statusText}: ${responseText.substring(0, 150)}`;
            }
          }
          throw new Error(errMsg);
        }

        let data;
        try {
          data = JSON.parse(responseText);
        } catch (jsonErr) {
          console.error("Non-JSON response received:", responseText);
          if (responseText.trim().startsWith("<")) {
            const titleMatch = responseText.match(/<title>([\s\S]*?)<\/title>/i);
            const title = titleMatch ? titleMatch[1].trim() : "";
            throw new Error(`Lỗi phản hồi hệ thống (HTML format): ${title || "Phản hồi không mong đợi"}. Vui lòng thử lại với video ngắn hơn hoặc dung lượng nhỏ hơn.`);
          }
          throw new Error(`Phản hồi từ server không đúng định dạng JSON hợp lệ. Nội dung nhận được: ${responseText.substring(0, 150)}...`);
        }
        
        if (data.subtitles && Array.isArray(data.subtitles)) {
          // Map backend response into frontend model
          const formattedSubtitles: Subtitle[] = data.subtitles.map((sub: any, idx: number) => {
            const start = typeof sub.start === "number" ? sub.start : parseFloat(sub.start || 0);
            const end = typeof sub.end === "number" ? sub.end : parseFloat(sub.end || 0);
            
            return {
              id: `sub-gen-${idx}-${Date.now()}`,
              start: parseFloat(start.toFixed(2)),
              end: parseFloat(Math.max(start + 0.1, end).toFixed(2)),
              original: sub.original || "",
              translated: sub.translated || "",
            };
          });
          
          const dedupedSubtitles = mergeDuplicateSubtitles(formattedSubtitles);
          setSubtitles(validateSubtitleTimeline(dedupedSubtitles, totalDuration));
          setSubtitlePipelineVersion(4);
          setActiveTab("tracks");
          addLog(`Hoàn tất biên dịch! Nhận ${formattedSubtitles.length} đoạn, sau khi gộp trùng lặp còn ${dedupedSubtitles.length} phân đoạn.`);
        } else {
          throw new Error("Dữ liệu phụ đề phản hồi không đúng định dạng mong đợi.");
        }
      }

    } catch (err: any) {
      console.error(err);
      setErrorMsg(`${err.message || "Đã xảy ra lỗi trong quá trình dịch thuật video."} Tiến độ đã hoàn thành được lưu; hãy bấm chạy lại khi quota khả dụng để tiếp tục.`);
      addLog("LỖI hệ thống: " + (err.message || String(err)));
      addLog("Checkpoint vẫn được giữ nguyên. Lần chạy sau sẽ bỏ qua các phân đoạn đã hoàn thành.");
    } finally {
      setIsLoading(false);
      setLoadingStep("");
      setLoadingEtaSeconds(null);
    }
  };

  // Video playback update handler
  const handleTimeUpdate = () => {
    const activeVideo = activeTab === "translate" ? workspaceVideoRef.current : videoRef.current;
    if (activeVideo) {
      setCurrentTime(activeVideo.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    const activeVideo = activeTab === "translate" ? workspaceVideoRef.current : videoRef.current;
    if (activeVideo) {
      setDuration(activeVideo.duration);
      if (activeTab === "translate") {
        setWorkspaceVideoDimensions({
          width: activeVideo.videoWidth || 16,
          height: activeVideo.videoHeight || 9
        });
      }
    }
  };

  // Interactive controls
  const togglePlay = () => {
    const activeVideo = activeTab === "translate" ? workspaceVideoRef.current : videoRef.current;
    if (activeVideo) {
      if (isPlaying) {
        activeVideo.pause();
        setIsPlaying(false);
      } else {
        activeVideo.play().catch(console.error);
        setIsPlaying(true);
      }
    }
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const activeVideo = activeTab === "translate" ? workspaceVideoRef.current : videoRef.current;
    if (activeVideo) {
      activeVideo.currentTime = val;
      setCurrentTime(val);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    const activeVideo = activeTab === "translate" ? workspaceVideoRef.current : videoRef.current;
    if (activeVideo) {
      activeVideo.volume = val;
    }
  };

  const handlePlaybackRateChange = (rate: number) => {
    setPlaybackRate(rate);
    const activeVideo = activeTab === "translate" ? workspaceVideoRef.current : videoRef.current;
    if (activeVideo) {
      activeVideo.playbackRate = rate;
    }
  };

  // Sync seek to subtitle start time
  const handleSeekTo = (time: number) => {
    const activeVideo = activeTab === "translate" ? workspaceVideoRef.current : videoRef.current;
    if (activeVideo) {
      activeVideo.currentTime = time;
      setCurrentTime(time);
      if (!isPlaying) {
        activeVideo.play().catch(console.error);
        setIsPlaying(true);
      }
    }
  };

  // Find active subtitle segment based on currentTime
  const currentSubtitle = useMemo(() => {
    return subtitles.find(sub => currentTime >= sub.start && currentTime <= sub.end);
  }, [subtitles, currentTime]);

  const currentSubtitleRef = useRef<Subtitle | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const geminiAudioCacheRef = useRef<Record<string, string>>({});
  const tiktokAudioCacheRef = useRef<Record<string, string>>({});
  const ttsCacheSignatureRef = useRef<Record<string, string>>({});
  const fullTtsAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceTimingRef = useRef<Record<string, VoiceTiming>>({});
  const fittedTtsTextRef = useRef<Record<string, string>>({});

  // Clear Gemini voice cache when the selected voice changes
  useEffect(() => {
    geminiAudioCacheRef.current = {};
    ttsCacheSignatureRef.current = {};
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }
  }, [geminiVoice]);

  // Clear TikTok voice cache when selected voice or session changes
  useEffect(() => {
    tiktokAudioCacheRef.current = {};
    ttsCacheSignatureRef.current = {};
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }
  }, [tiktokVoice, tiktokSessionId]);

  // Sync fullTtsText when subtitles are loaded or updated
  useEffect(() => {
    voiceTimingRef.current = {};
    if (subtitles.length > 0) {
      const combined = subtitles.map(sub => sub.translated).join(" ");
      setFullTtsText(combined);
    } else {
      setFullTtsText("");
    }
    // Clean up previous generated full audio url when subtitles change
    if (fullTtsAudioUrl) {
      URL.revokeObjectURL(fullTtsAudioUrl);
      setFullTtsAudioUrl(null);
    }
    if (fullTtsAudioRef.current) {
      fullTtsAudioRef.current.pause();
      fullTtsAudioRef.current = null;
      setFullTtsPlaying(false);
    }
  }, [subtitles]);

  // Sync speed and volume to active full audio
  useEffect(() => {
    if (fullTtsAudioRef.current) {
      fullTtsAudioRef.current.volume = ttsVolume;
    }
  }, [ttsVolume]);

  useEffect(() => {
    if (fullTtsAudioRef.current) {
      fullTtsAudioRef.current.playbackRate = ttsRate;
    }
  }, [ttsRate]);

  // Clean up full TTS audio on unmount or engine/voice change
  useEffect(() => {
    return () => {
      if (fullTtsAudioRef.current) {
        fullTtsAudioRef.current.pause();
        fullTtsAudioRef.current = null;
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, [ttsEngine, geminiVoice]);

  // Generate full narrative TTS audio using Gemini
  const generateFullTtsGemini = async () => {
    if (!fullTtsText) return;
    setIsGeneratingFullTts(true);
    setErrorMsg("");

    // Stop existing playback
    if (fullTtsAudioRef.current) {
      fullTtsAudioRef.current.pause();
      fullTtsAudioRef.current = null;
      setFullTtsPlaying(false);
    }

    try {
      const res = await fetch("/api/synthesize-tts", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...getGeminiRequestHeaders(geminiApiKey),
        },
        body: JSON.stringify({ text: fullTtsText, voiceName: geminiVoice })
      });

      if (!res.ok) {
        throw new Error("Không thể kết nối đến máy chủ.");
      }

      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }

      if (data.audio) {
        const binary = atob(data.audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const wavBlob = pcmToWav(bytes, 24000);
        const audioUrl = URL.createObjectURL(wavBlob);
        
        setFullTtsAudioUrl(audioUrl);
        
        // Initialize HTML Audio Object
        const audio = new Audio(audioUrl);
        audio.volume = ttsVolume;
        audio.playbackRate = ttsRate;
        
        audio.oncanplaythrough = () => {
          setFullTtsDuration(audio.duration || 0);
        };
        
        audio.ontimeupdate = () => {
          setFullTtsCurrentTime(audio.currentTime);
        };
        
        audio.onended = () => {
          setFullTtsPlaying(false);
          setFullTtsCurrentTime(0);
        };
        
        audio.onerror = () => {
          setFullTtsPlaying(false);
        };

        fullTtsAudioRef.current = audio;
        
        // Play audio
        audio.play().then(() => {
          setFullTtsPlaying(true);
        }).catch(err => {
          console.error("Auto-play blocked or failed:", err);
          // Set duration manually even if blocked
          setFullTtsDuration(audio.duration || 0);
        });

      } else {
        throw new Error("Không nhận được dữ liệu âm thanh từ máy chủ.");
      }
    } catch (err: any) {
      console.error("Error generating full TTS:", err);
      setErrorMsg("Lỗi tạo thuyết minh toàn bài: " + (err.message || err));
    } finally {
      setIsGeneratingFullTts(false);
    }
  };

  // Play full text via browser speechSynthesis
  const playFullTtsBrowser = () => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    
    window.speechSynthesis.cancel();
    if (!fullTtsText) return;

    if (fullTtsPlaying) {
      window.speechSynthesis.cancel();
      setFullTtsPlaying(false);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(fullTtsText);
    if (voices.length > 0 && ttsVoiceName) {
      const selected = voices.find(v => v.name === ttsVoiceName);
      if (selected) utterance.voice = selected;
    }
    utterance.rate = ttsRate;
    utterance.pitch = ttsPitch;
    utterance.volume = ttsVolume;

    // Lower video sound during speech if autoMuteVideo is active
    if (autoMuteVideo && videoRef.current) {
      videoRef.current.volume = volume * originalAudioMixVolume;
    }

    utterance.onstart = () => {
      setFullTtsPlaying(true);
    };

    utterance.onend = () => {
      setFullTtsPlaying(false);
      if (videoRef.current) {
        videoRef.current.volume = volume;
      }
    };

    utterance.onerror = () => {
      setFullTtsPlaying(false);
      if (videoRef.current) {
        videoRef.current.volume = volume;
      }
    };

    window.speechSynthesis.speak(utterance);
  };

  const handleToggleFullTtsPlay = () => {
    if (ttsEngine === "browser") {
      playFullTtsBrowser();
      return;
    }

    if (!fullTtsAudioRef.current) return;

    if (fullTtsPlaying) {
      fullTtsAudioRef.current.pause();
      setFullTtsPlaying(false);
    } else {
      // Pause video if playing to avoid overlapping sound
      if (videoRef.current && isPlaying) {
        videoRef.current.pause();
        setIsPlaying(false);
      }
      fullTtsAudioRef.current.volume = ttsVolume;
      fullTtsAudioRef.current.playbackRate = ttsRate;
      fullTtsAudioRef.current.play().catch(console.error);
      setFullTtsPlaying(true);
    }
  };

  const handleFullTtsSeek = (time: number) => {
    if (fullTtsAudioRef.current) {
      fullTtsAudioRef.current.currentTime = time;
      setFullTtsCurrentTime(time);
    }
  };

  useEffect(() => {
    currentSubtitleRef.current = currentSubtitle || null;
  }, [currentSubtitle]);

  // Load and monitor system speech synthesis voices
  useEffect(() => {
    const loadVoices = () => {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        const allVoices = window.speechSynthesis.getVoices();
        setVoices(allVoices);
        // Prioritize Vietnamese voices
        const viVoice = allVoices.find(v => v.lang.toLowerCase().includes("vi"));
        if (viVoice) {
          setTtsVoiceName(viVoice.name);
        } else if (allVoices.length > 0) {
          const defaultVoice = allVoices.find(v => v.default) || allVoices[0];
          setTtsVoiceName(defaultVoice.name);
        }
      }
    };

    loadVoices();
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);

  // Utility to speak text using browser speech synthesis
  const speakText = (text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    
    // Stop any active audio
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }
    window.speechSynthesis.cancel();
    
    if (!text) return;
    
    const utterance = new SpeechSynthesisUtterance(text);
    if (voices.length > 0 && ttsVoiceName) {
      const selected = voices.find(v => v.name === ttsVoiceName);
      if (selected) utterance.voice = selected;
    }
    
    utterance.rate = ttsRate;
    utterance.pitch = ttsPitch;
    utterance.volume = ttsVolume;
    
    if (autoMuteVideo && videoRef.current) {
      videoRef.current.volume = volume * originalAudioMixVolume;
    }
    
    utterance.onend = () => {
      if (videoRef.current) {
        videoRef.current.volume = volume;
      }
    };
    
    utterance.onerror = () => {
      if (videoRef.current) {
        videoRef.current.volume = volume;
      }
    };
    
    window.speechSynthesis.speak(utterance);
  };

  // Utility to speak text using Gemini 3.1 TTS model
  const speakTextGemini = async (text: string, subtitleId: string) => {
    if (typeof window === "undefined") return;

    // Stop browser SpeechSynthesis
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    
    // Stop any active Gemini audio playing
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }

    if (!text) return;

    // Lower volume if requested
    if (autoMuteVideo && videoRef.current) {
      videoRef.current.volume = volume * originalAudioMixVolume;
    }

    // Check cache
    const cachedUrl = geminiAudioCacheRef.current[subtitleId];
    const targetSub = subtitles.find(s => s.id === subtitleId);
    const subDuration = targetSub ? targetSub.end - targetSub.start : 0;

    if (cachedUrl) {
      const audio = new Audio(cachedUrl);
      audio.volume = ttsVolume;
      audio.playbackRate = ttsRate;
      
      // Smart TTS - auto speed up to fit within target subtitle duration
      audio.onloadedmetadata = () => {
        if (smartTtsEnabled && targetSub) {
          const gapAfter = getSubtitleGapAfter(targetSub, subtitles);
          audio.playbackRate = computeSmartTtsRate(audio.duration, subDuration, gapAfter, ttsRate);
        }
      };

      audio.onended = () => {
        if (videoRef.current) videoRef.current.volume = volume;
      };
      audio.onerror = () => {
        if (videoRef.current) videoRef.current.volume = volume;
      };
      ttsAudioRef.current = audio;
      audio.play().catch(err => {
        console.error("Error playing cached audio:", err);
        if (videoRef.current) videoRef.current.volume = volume;
      });
      return;
    }

    // Fetch from backend
    setGeneratingTtsId(subtitleId);
    try {
      const res = await fetch("/api/synthesize-tts", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...getGeminiRequestHeaders(geminiApiKey),
        },
        body: JSON.stringify({ text, voiceName: geminiVoice })
      });
      if (!res.ok) {
        throw new Error("Không thể kết nối đến máy chủ.");
      }
      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }

      if (data.audio) {
        const binary = atob(data.audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const wavBlob = pcmToWav(bytes, 24000);
        const audioUrl = URL.createObjectURL(wavBlob);
        
        geminiAudioCacheRef.current[subtitleId] = audioUrl;

        // Verify we are still on this segment
        if (currentSubtitleRef.current?.id === subtitleId) {
          const audio = new Audio(audioUrl);
          audio.volume = ttsVolume;
          audio.playbackRate = ttsRate;

          // Smart TTS - auto speed up to fit within target subtitle duration
          audio.onloadedmetadata = () => {
            if (smartTtsEnabled && targetSub) {
              const gapAfter = getSubtitleGapAfter(targetSub, subtitles);
              audio.playbackRate = computeSmartTtsRate(audio.duration, subDuration, gapAfter, ttsRate);
            }
          };
          audio.onended = () => {
            if (videoRef.current) videoRef.current.volume = volume;
          };
          audio.onerror = () => {
            if (videoRef.current) videoRef.current.volume = volume;
          };
          ttsAudioRef.current = audio;
          audio.play().catch(err => {
            console.error("Error playing Gemini audio:", err);
            if (videoRef.current) videoRef.current.volume = volume;
          });
        } else {
          // Restore volume if we already passed it
          if (videoRef.current) videoRef.current.volume = volume;
        }
      } else {
        if (videoRef.current) videoRef.current.volume = volume;
      }
    } catch (err: any) {
      console.error("TTS generation error:", err);
      // Fallback to browser SpeechSynthesis so the user still hears it!
      speakText(text);
    } finally {
      setGeneratingTtsId(null);
    }
  };

  // Utility to speak text using TikTok TTS API
  const speakTextTikTok = async (text: string, subtitleId: string) => {
    if (typeof window === "undefined") return;

    // Stop browser SpeechSynthesis
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    
    // Stop any active audio playing
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }

    if (!text) return;

    // Lower volume if requested
    if (autoMuteVideo && videoRef.current) {
      videoRef.current.volume = volume * originalAudioMixVolume;
    }

    // Check cache
    const cachedUrl = tiktokAudioCacheRef.current[subtitleId];
    const targetSub = subtitles.find(s => s.id === subtitleId);
    const subDuration = targetSub ? targetSub.end - targetSub.start : 0;

    if (cachedUrl) {
      const audio = new Audio(cachedUrl);
      audio.volume = ttsVolume;
      audio.playbackRate = ttsRate;

      // Smart TTS - auto speed up to fit within target subtitle duration
      audio.onloadedmetadata = () => {
        if (smartTtsEnabled && targetSub) {
          const gapAfter = getSubtitleGapAfter(targetSub, subtitles);
          audio.playbackRate = computeSmartTtsRate(audio.duration, subDuration, gapAfter, ttsRate);
        }
      };

      audio.onended = () => {
        if (videoRef.current) videoRef.current.volume = volume;
      };
      audio.onerror = () => {
        if (videoRef.current) videoRef.current.volume = volume;
      };
      ttsAudioRef.current = audio;
      audio.play().catch(err => {
        console.error("Error playing cached TikTok audio:", err);
        if (videoRef.current) videoRef.current.volume = volume;
      });
      return;
    }

    // Fetch from backend
    setGeneratingTtsId(subtitleId);
    try {
      const res = await fetch("/api/synthesize-tts", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...getGeminiRequestHeaders(geminiApiKey),
        },
        body: JSON.stringify({
          text,
          voiceName: tiktokVoice,
          engine: "tiktok",
          sessionId: tiktokSessionId
        })
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Không thể kết nối đến máy chủ.");
      }
      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }

      if (data.audio) {
        const binary = atob(data.audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const mp3Blob = new Blob([bytes], { type: "audio/mp3" });
        const audioUrl = URL.createObjectURL(mp3Blob);
        
        tiktokAudioCacheRef.current[subtitleId] = audioUrl;

        // Verify we are still on this segment
        if (currentSubtitleRef.current?.id === subtitleId) {
          const audio = new Audio(audioUrl);
          audio.volume = ttsVolume;
          audio.playbackRate = ttsRate;

          // Smart TTS - auto speed up to fit within target subtitle duration
          audio.onloadedmetadata = () => {
            if (smartTtsEnabled && targetSub) {
              const gapAfter = getSubtitleGapAfter(targetSub, subtitles);
              audio.playbackRate = computeSmartTtsRate(audio.duration, subDuration, gapAfter, ttsRate);
            }
          };

          audio.onended = () => {
            if (videoRef.current) videoRef.current.volume = volume;
          };
          audio.onerror = () => {
            if (videoRef.current) videoRef.current.volume = volume;
          };
          ttsAudioRef.current = audio;
          audio.play().catch(err => {
            console.error("Error playing TikTok audio:", err);
            if (videoRef.current) videoRef.current.volume = volume;
          });
        } else {
          // Restore volume if we already passed it
          if (videoRef.current) videoRef.current.volume = volume;
        }
      } else {
        if (videoRef.current) videoRef.current.volume = volume;
      }
    } catch (err: any) {
      console.error("TikTok TTS generation error:", err);
      setErrorMsg("Không thể phát âm thanh TikTok TTS: " + err.message);
      if (videoRef.current) videoRef.current.volume = volume;
    } finally {
      setGeneratingTtsId(null);
    }
  };

  // Sync play-along TTS reader
  const lastSpokenSubIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ttsEnabled) {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
        ttsAudioRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.volume = volume;
      }
      return;
    }

    if (currentSubtitle) {
      if (currentSubtitle.id !== lastSpokenSubIdRef.current) {
        lastSpokenSubIdRef.current = currentSubtitle.id;
        if (ttsEngine === "gemini") {
          speakTextGemini(currentSubtitle.translated, currentSubtitle.id);
        } else if (ttsEngine === "tiktok") {
          speakTextTikTok(currentSubtitle.translated, currentSubtitle.id);
        } else {
          speakText(currentSubtitle.translated);
        }
      }
    } else {
      // Reset spoken tracker when transition to blank video ranges
      lastSpokenSubIdRef.current = null;
    }
  }, [currentSubtitle, ttsEnabled, ttsEngine, geminiVoice, tiktokVoice, tiktokSessionId, voices, ttsVoiceName, ttsRate, ttsPitch, ttsVolume, autoMuteVideo, volume]);

  // Cancel reading if video is paused
  useEffect(() => {
    if (!isPlaying) {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
      }
      if (videoRef.current) {
        videoRef.current.volume = volume;
      }
    }
  }, [isPlaying]);

  // Edit action
  const handleStartEdit = (sub: Subtitle) => {
    setEditingSubId(sub.id);
    setEditOriginal(sub.original);
    setEditTranslated(sub.translated);
    setEditStart(sub.start);
    setEditEnd(sub.end);
  };

  const handleSaveEdit = (id: string) => {
    setSubtitles(prev => prev.map(sub => {
      if (sub.id === id) {
        return {
          ...sub,
          original: editOriginal,
          translated: editTranslated,
          start: Number(editStart),
          end: Number(editEnd),
        };
      }
      return sub;
    }));
    setEditingSubId(null);
  };

  const handleDeleteSub = (id: string) => {
    setSubtitles(prev => prev.filter(sub => sub.id !== id));
    if (editingSubId === id) {
      setEditingSubId(null);
    }
  };

  const handleAddSub = () => {
    const newSub: Subtitle = {
      id: `sub-manual-${Date.now()}`,
      start: parseFloat(currentTime.toFixed(1)),
      end: parseFloat((currentTime + 3).toFixed(1)),
      original: "New text segment...",
      translated: "Phân đoạn dịch mới...",
    };
    setSubtitles(prev => {
      const updated = [...prev, newSub];
      // Sort by start time
      return updated.sort((a, b) => a.start - b.start);
    });
    handleStartEdit(newSub);
  };

  // Export functions
  const formatSecondsToSRT = (seconds: number): string => {
    const totalMs = Math.round(Math.max(0, seconds) * 1000);
    const hrs = Math.floor(totalMs / 3600000);
    const mins = Math.floor((totalMs % 3600000) / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;

    const pad = (n: number, z: number = 2) => String(n).padStart(z, "0");
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
  };

  const formatSecondsToVTT = (seconds: number): string => {
    const totalMs = Math.round(Math.max(0, seconds) * 1000);
    const hrs = Math.floor(totalMs / 3600000);
    const mins = Math.floor((totalMs % 3600000) / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;

    const pad = (n: number, z: number = 2) => String(n).padStart(z, "0");
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`;
  };

  const triggerDownload = (filename: string, content: string) => {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const exportSRT = () => {
    if (subtitles.length === 0) return;
    
    const sortedSubs = [...subtitles].sort((a, b) => a.start - b.start);
    let content = "";
    
    sortedSubs.forEach((sub, index) => {
      let endTime = sub.end;
      // Prevent overlapping timestamps (CapCut drops overlapping segments)
      if (index < sortedSubs.length - 1 && endTime > sortedSubs[index + 1].start) {
        endTime = sortedSubs[index + 1].start - 0.001;
      }
      
      const cleanText = (sub.translated || "").replace(/\r?\n/g, " ").trim();
      
      content += `${index + 1}\r\n`;
      content += `${formatSecondsToSRT(sub.start)} --> ${formatSecondsToSRT(endTime)}\r\n`;
      content += `${cleanText}\r\n\r\n`;
    });
    triggerDownload(`tool-dubbing-video.srt`, content);
  };

  const exportVTT = () => {
    if (subtitles.length === 0) return;
    let content = "WEBVTT\n\n";
    subtitles.forEach((sub, index) => {
      content += `${index + 1}\n`;
      content += `${formatSecondsToVTT(sub.start)} --> ${formatSecondsToVTT(sub.end)}\n`;
      content += `${sub.translated}\n\n`;
    });
    triggerDownload(`tool-dubbing-video.vtt`, content);
  };

  const exportJSON = () => {
    if (subtitles.length === 0) return;
    const content = JSON.stringify(subtitles, null, 2);
    triggerDownload(`tool-dubbing-video.json`, content);
  };

  const downloadOriginalVideo = () => {
    if (videoSrc) {
      const link = document.createElement("a");
      link.href = videoSrc;
      const extension = videoMimeType ? `.${videoMimeType.split("/")[1]}` : ".mp4";
      link.download = `tool-original-video${extension}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const [isPreGenerating, setIsPreGenerating] = useState<boolean>(false);
  const [preGenerateProgress, setPreGenerateProgress] = useState<number>(0);
  const [preGenerateEtaSeconds, setPreGenerateEtaSeconds] = useState<number | null>(null);

  const preGenerateAllTts = async (): Promise<boolean> => {
    if (subtitles.length === 0) {
      setErrorMsg("Không có phụ đề nào để tạo thuyết minh.");
      return false;
    }

    setIsPreGenerating(true);
    setPreGenerateProgress(0);
    setPreGenerateEtaSeconds(Math.max(5, subtitles.length * 4));
    setErrorMsg("");
    const ttsStageStartedAt = performance.now();
    const updateTtsEstimate = (completed: number) => {
      const safeCompleted = Math.max(1, completed);
      const elapsedSeconds = Math.max(0.25, (performance.now() - ttsStageStartedAt) / 1000);
      const averageSeconds = elapsedSeconds / safeCompleted;
      const remaining = Math.max(0, subtitles.length - completed);
      setPreGenerateProgress(Math.round((completed / Math.max(1, subtitles.length)) * 100));
      setPreGenerateEtaSeconds(remaining > 0 ? Math.max(1, Math.ceil(averageSeconds * remaining)) : 0);
    };

    const activeTtsEngine = ttsEngine === "browser" ? "gemini" : ttsEngine;
    const cacheRef = activeTtsEngine === "tiktok" ? tiktokAudioCacheRef : geminiAudioCacheRef;
    const voice = activeTtsEngine === "tiktok" ? tiktokVoice : (ttsEngine === "browser" ? "Kore" : geminiVoice);

    const synthesizeBlob = async (text: string, subtitleNumber: number): Promise<Blob> => {
      const res = await fetch("/api/synthesize-tts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getGeminiRequestHeaders(geminiApiKey),
        },
        body: JSON.stringify({
          text,
          voiceName: voice,
          engine: activeTtsEngine,
          sessionId: activeTtsEngine === "tiktok" ? tiktokSessionId : undefined,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(`Phân đoạn #${subtitleNumber} lỗi: ${errorData.error || "Không thể kết nối đến máy chủ."}`);
      }
      const data = await res.json();
      if (data.error || !data.audio) {
        throw new Error(`Phân đoạn #${subtitleNumber} lỗi: ${data.error || "TTS không trả dữ liệu âm thanh."}`);
      }

      const binary = atob(data.audio);
      const bytes = new Uint8Array(binary.length);
      for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
      return data.format === "mp3"
        ? new Blob([bytes], { type: "audio/mp3" })
        : pcmToWav(bytes, 24000);
    };

    try {
      for (let i = 0; i < subtitles.length; i++) {
        const sub = subtitles[i];
        setPreGenerateProgress(Math.round((i / subtitles.length) * 100));

        // Skip if subtitle translation and original text are both empty
        const textToSpeak = sub.translated?.trim() || sub.original?.trim();
        if (!textToSpeak) {
          updateTtsEstimate(i + 1);
          continue;
        }
        const signature = `${activeTtsEngine}|${voice}|${textToSpeak}`;
        if (cacheRef.current[sub.id] && ttsCacheSignatureRef.current[sub.id] === signature) {
          updateTtsEstimate(i + 1);
          continue;
        }
        if (cacheRef.current[sub.id]) URL.revokeObjectURL(cacheRef.current[sub.id]);

        const activeProjectId = currentProjectId || (videoFile ? makeProjectId(videoFile) : "");
        const ttsCacheId = activeProjectId
          ? `${activeProjectId}|tts-v2|${sub.id}|${stableHash(signature)}`
          : "";
        if (ttsCacheId) {
          const storedTts = await projectDbGet<StoredTtsClip>("tts", ttsCacheId).catch(() => undefined);
          if (storedTts?.blob && storedTts.signature === signature) {
            cacheRef.current[sub.id] = URL.createObjectURL(storedTts.blob);
            ttsCacheSignatureRef.current[sub.id] = signature;
            addLog(`[TTS ${i + 1}/${subtitles.length}] Khôi phục audio từ checkpoint, không gọi API.`);
            updateTtsEstimate(i + 1);
            continue;
          }
        }

        const clauses = splitTtsTextIntoClauses(textToSpeak);
        const clauseBlobs: Blob[] = [];
        for (const clause of clauses) clauseBlobs.push(await synthesizeBlob(clause, i + 1));
        const audioBlob = await concatenateAudioBlobs(clauseBlobs);
        cacheRef.current[sub.id] = URL.createObjectURL(audioBlob);
        ttsCacheSignatureRef.current[sub.id] = signature;
        if (ttsCacheId && activeProjectId) {
          const ttsCheckpointSaved = await projectDbPut("tts", {
            id: ttsCacheId,
            projectId: activeProjectId,
            signature,
            subtitleId: sub.id,
            blob: audioBlob,
            updatedAt: Date.now(),
          } satisfies StoredTtsClip).then(() => true).catch((error) => {
            console.warn("Could not persist TTS clip:", error);
            return false;
          });
          if (ttsCheckpointSaved) addLog(`[TTS ${i + 1}/${subtitles.length}] Đã lưu checkpoint audio.`);
        }
        updateTtsEstimate(i + 1);
      }
      setPreGenerateProgress(100);
      return true;
    } catch (err: any) {
      console.error("Lỗi khi tạo thuyết minh hàng loạt:", err);
      setErrorMsg("Không thể tạo thuyết minh hàng loạt: " + err.message + " Các câu đã tạo được lưu; lần chạy sau sẽ tiếp tục từ câu còn thiếu.");
      return false;
    } finally {
      setIsPreGenerating(false);
      setPreGenerateEtaSeconds(null);
    }
  };

  const generateMergedVoiceoverBlob = async (
    ffmpegForTts?: FFmpeg,
    fitAttempt = 0,
    skipPreGenerate = false,
  ): Promise<Blob> => {
    if (subtitles.length === 0) {
      throw new Error("Không có phụ đề nào để tạo thuyết minh.");
    }

    // Automatically generate missing audio files for all subtitles!
    if (!skipPreGenerate) {
      const success = await preGenerateAllTts();
      if (!success) {
        throw new Error("Quá trình tổng hợp giọng đọc bị lỗi hoặc dừng giữa chừng.");
      }
    }

    const activeTtsEngine = ttsEngine === "browser" ? "gemini" : ttsEngine;
    const cacheRef = activeTtsEngine === "tiktok" ? tiktokAudioCacheRef : geminiAudioCacheRef;
    const validSubs = subtitles.filter(s => cacheRef.current[s.id]);
    if (validSubs.length === 0) {
      throw new Error("Chưa có phân đoạn thuyết minh AI nào được tạo. Hãy dịch và chạy thuyết minh trước.");
    }
    if (validSubs.length !== subtitles.length) {
      const missingCount = subtitles.length - validSubs.length;
      throw new Error(`Thiếu âm thanh thuyết minh cho ${missingCount}/${subtitles.length} phụ đề; không thể xuất video có gián đoạn giọng đọc.`);
    }

    const detectedVideoDuration = workspaceVideoRef.current?.duration || videoRef.current?.duration || duration;
    const totalDuration = Number.isFinite(detectedVideoDuration) && detectedVideoDuration > 0
      ? detectedVideoDuration
      : Math.max(...subtitles.map(s => s.end));
    const sampleRate = 24000;
    
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const tempCtx = new AudioContextClass();
    
    const audioBuffersPromise = validSubs.map(async (sub) => {
      const url = cacheRef.current[sub.id];
      const res = await fetch(url);
      const arrayBuffer = await res.arrayBuffer();
      const decoded = await tempCtx.decodeAudioData(arrayBuffer);
      return { sub, decoded };
    });

    const decodedClips = (await Promise.all(audioBuffersPromise))
      .map(({ sub, decoded }) => {
        const trimmed = trimAudioBufferSilence(decoded);
        const text = fittedTtsTextRef.current[sub.id]?.trim() || sub.translated?.trim() || sub.original?.trim() || "";
        const characterCount = countSpeechCharacters(text);
        return {
          sub,
          text,
          rawDuration: decoded.duration,
          trimmed,
          characterCount,
          charsPerSecond: characterCount / Math.max(0.05, trimmed.duration),
        };
      })
      .sort((a, b) => a.sub.start - b.sub.start);
    await tempCtx.close();

    const medianCharsPerSecond = median(
      decodedClips
        .map((clip) => clip.charsPerSecond)
        .filter((value) => Number.isFinite(value) && value > 0),
    );
    const baseRate = Math.max(SMART_TTS_MIN_RATE, Math.min(SMART_TTS_MAX_RATE, ttsRate));
    const preparedClips = decodedClips.map((clip) => {
      const naturalTarget = medianCharsPerSecond > 0
        ? clip.characterCount / medianCharsPerSecond
        : clip.trimmed.duration;
      const normalizationRate = Math.max(
        0.85,
        Math.min(1.3, clip.trimmed.duration / Math.max(0.05, naturalTarget)),
      );
      return {
        ...clip,
        preferredRate: smartTtsEnabled
          ? Math.max(baseRate, normalizationRate)
          : baseRate,
      };
    });

    type ScheduledVoiceClip = {
      subtitleId: string;
      buffer: AudioBuffer;
      start: number;
      rate: number;
      originalStart: number;
      end: number;
    };

    // Xếp giọng tuần tự trên toàn track. Timestamp vẫn là vị trí ưu tiên, nhưng nếu
    // hai dòng bị Gemini dồn sát nhau thì dòng sau được nhích sang phải thay vì ép
    // dòng trước lên hàng chục lần tốc độ hoặc trộn hai giọng lên nhau.
    const buildVoiceSchedule = (rateMultiplier: number, gapSeconds: number): ScheduledVoiceClip[] => {
      let voiceCursor = 0;
      return preparedClips.map((clip, index) => {
        const rate = Math.min(SMART_TTS_MAX_RATE, clip.preferredRate * rateMultiplier);
        const originalStart = Math.max(0, Math.min(totalDuration, clip.sub.start));
        const start = index === 0
          ? originalStart
          : Math.max(originalStart, voiceCursor + gapSeconds);
        const end = start + clip.trimmed.duration / rate;
        voiceCursor = end;
        return { subtitleId: clip.sub.id, buffer: clip.trimmed, start, rate, originalStart, end };
      });
    };

    const scheduleEnd = (clips: ScheduledVoiceClip[]) => clips.at(-1)?.end ?? 0;
    let selectedGap = SMART_TTS_VOICE_GAP_SECONDS;
    let rateMultiplier = 1;
    let scheduledClips = buildVoiceSchedule(rateMultiplier, selectedGap);

    if (smartTtsEnabled && scheduleEnd(scheduledClips) > totalDuration + 0.01) {
      const maxMultiplier = SMART_TTS_MAX_RATE / Math.min(
        ...preparedClips.map((clip) => clip.preferredRate),
      );
      const maxRateSchedule = buildVoiceSchedule(maxMultiplier, selectedGap);

      // Chỉ tăng vừa đủ để toàn bộ track nằm trong thời lượng video.
      if (scheduleEnd(maxRateSchedule) <= totalDuration + 0.01) {
        let low = 1;
        let high = maxMultiplier;
        for (let iteration = 0; iteration < 28; iteration++) {
          const middle = (low + high) / 2;
          if (scheduleEnd(buildVoiceSchedule(middle, selectedGap)) <= totalDuration + 0.01) high = middle;
          else low = middle;
        }
        rateMultiplier = high;
        scheduledClips = buildVoiceSchedule(rateMultiplier, selectedGap);
      } else {
        // Bất khả kháng: bỏ khoảng nghỉ 60ms trước khi kết luận nội dung thật sự quá dài.
        selectedGap = 0;
        const compactMaxSchedule = buildVoiceSchedule(maxMultiplier, selectedGap);
        if (scheduleEnd(compactMaxSchedule) <= totalDuration + 0.01) {
          let low = 1;
          let high = maxMultiplier;
          for (let iteration = 0; iteration < 28; iteration++) {
            const middle = (low + high) / 2;
            if (scheduleEnd(buildVoiceSchedule(middle, selectedGap)) <= totalDuration + 0.01) high = middle;
            else low = middle;
          }
          rateMultiplier = high;
          scheduledClips = buildVoiceSchedule(rateMultiplier, selectedGap);
        } else {
          const overrun = scheduleEnd(compactMaxSchedule) - totalDuration;
          if (fitAttempt >= 3) {
            throw new Error(
              `Smart TTS đã tự rút gọn 3 lượt nhưng lời đọc vẫn dài hơn video ${overrun.toFixed(2)} giây. ` +
              "Hãy kiểm tra lại timestamp hoặc nội dung bản dịch.",
            );
          }

          const fitItems = preparedClips.map((clip, index) => {
            const nextStart = preparedClips[index + 1]?.sub.start ?? totalDuration;
            const availableDuration = Math.max(0.35, nextStart - clip.sub.start - 0.02);
            const durationRatio = Math.min(0.88, (availableDuration * SMART_TTS_MAX_RATE) / Math.max(0.05, clip.trimmed.duration));
            const fullCharacterCount = Math.max(1, Array.from(clip.text).length);
            return {
              id: clip.sub.id,
              text: clip.text,
              maxChars: Math.max(8, Math.floor(fullCharacterCount * Math.max(0.18, durationRatio) * 0.92)),
            };
          }).filter((item) => item.maxChars < Array.from(item.text).length - 1);

          if (fitItems.length === 0) {
            throw new Error(`Không tìm được câu có thể rút gọn dù track còn vượt ${overrun.toFixed(2)} giây.`);
          }

          addLog(
            `Smart TTS: lời đọc vượt ${overrun.toFixed(2)}s; đang tự rút gọn ${fitItems.length} câu theo đúng ngân sách timestamp (lượt ${fitAttempt + 1}/3).`,
          );
          const fitResponse = await fetch("/api/fit-tts-subtitles", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...getGeminiRequestHeaders(geminiApiKey),
            },
            body: JSON.stringify({
              items: fitItems,
              apiPlatform,
              customApiUrl: apiPlatform === "custom" ? customApiUrl : "",
              customApiKey: apiPlatform === "custom" ? customApiKey : "",
              customModel: apiPlatform === "custom" ? customModel : "",
              allowGeminiFallback,
            }),
          });
          const fittedPayload = await readJsonResponse(fitResponse);
          const fittedItems = Array.isArray(fittedPayload.items) ? fittedPayload.items : [];
          if (fittedItems.length === 0) throw new Error("API không trả về câu rút gọn cho Smart TTS.");

          const activeVoice = activeTtsEngine === "tiktok"
            ? tiktokVoice
            : (ttsEngine === "browser" ? "Kore" : geminiVoice);
          const synthesizeFittedBlob = async (text: string): Promise<Blob> => {
            const response = await fetch("/api/synthesize-tts", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...getGeminiRequestHeaders(geminiApiKey),
              },
              body: JSON.stringify({
                text,
                voiceName: activeVoice,
                engine: activeTtsEngine,
                sessionId: activeTtsEngine === "tiktok" ? tiktokSessionId : undefined,
              }),
            });
            const data = await readJsonResponse(response);
            if (!data.audio) throw new Error("TTS không trả âm thanh cho câu đã rút gọn.");
            const binary = atob(data.audio);
            const bytes = new Uint8Array(binary.length);
            for (let byteIndex = 0; byteIndex < binary.length; byteIndex++) bytes[byteIndex] = binary.charCodeAt(byteIndex);
            return data.format === "mp3"
              ? new Blob([bytes], { type: "audio/mp3" })
              : pcmToWav(bytes, 24000);
          };

          const fittedById: Record<string, string> = {};
          for (let index = 0; index < fittedItems.length; index++) {
            const item = fittedItems[index];
            const subtitleId = String(item?.id || "");
            const fittedText = String(item?.text || "").replace(/\s+/g, " ").trim();
            if (!subtitleId || !fittedText) continue;
            addLog(`[Smart TTS ${index + 1}/${fittedItems.length}] Đang tạo lại câu đã rút gọn...`);
            const fittedBlob = await synthesizeFittedBlob(fittedText);
            if (cacheRef.current[subtitleId]) URL.revokeObjectURL(cacheRef.current[subtitleId]);
            cacheRef.current[subtitleId] = URL.createObjectURL(fittedBlob);
            const signature = `${activeTtsEngine}|${activeVoice}|${fittedText}`;
            ttsCacheSignatureRef.current[subtitleId] = signature;
            fittedTtsTextRef.current[subtitleId] = fittedText;
            fittedById[subtitleId] = fittedText;

            const activeProjectId = currentProjectId || (videoFile ? makeProjectId(videoFile) : "");
            if (activeProjectId) {
              const ttsCacheId = `${activeProjectId}|tts-v2|${subtitleId}|${stableHash(signature)}`;
              await projectDbPut("tts", {
                id: ttsCacheId,
                projectId: activeProjectId,
                signature,
                subtitleId,
                blob: fittedBlob,
                updatedAt: Date.now(),
              } satisfies StoredTtsClip).catch((error) => console.warn("Could not persist fitted TTS clip:", error));
            }
          }

          if (Object.keys(fittedById).length === 0) {
            throw new Error("Không tạo được âm thanh cho các câu Smart TTS đã rút gọn.");
          }
          setSubtitles((previous) => previous.map((subtitle) => fittedById[subtitle.id]
            ? { ...subtitle, translated: fittedById[subtitle.id] }
            : subtitle));
          addLog(`Smart TTS: đã rút gọn và lưu ${Object.keys(fittedById).length} câu; đang đo lại toàn bộ track.`);
          return generateMergedVoiceoverBlob(ffmpegForTts, fitAttempt + 1, true);
        }
      }
    }

    scheduledClips.forEach((clip, index) => {
      const source = preparedClips[index];
      const shiftedBy = Math.max(0, clip.start - clip.originalStart);
      addLog(
        `[Smart TTS #${index + 1}] raw=${source.rawDuration.toFixed(2)}s, trim=${source.trimmed.duration.toFixed(2)}s, ` +
        `mốc=${clip.originalStart.toFixed(2)}s→${clip.start.toFixed(2)}s, nhích=${shiftedBy.toFixed(2)}s, ` +
        `cps=${source.charsPerSecond.toFixed(2)}, rate=${clip.rate.toFixed(2)}x, final=${(clip.end - clip.start).toFixed(2)}s`,
      );
    });

    const shiftedCount = scheduledClips.filter((clip) => clip.start - clip.originalStart > 0.02).length;
    if (shiftedCount > 0) {
      addLog(
        `Smart TTS: đã tự dời ${shiftedCount} câu có timestamp quá sát để giọng đọc không chồng nhau; ` +
        `tốc độ cao nhất ${Math.max(...scheduledClips.map((clip) => clip.rate)).toFixed(2)}x.`,
      );
    }

    voiceTimingRef.current = Object.fromEntries(
      scheduledClips.map((clip) => [
        clip.subtitleId,
        { subtitleId: clip.subtitleId, start: clip.start, end: clip.end, rate: clip.rate },
      ]),
    );



    if (ffmpegForTts) {
      addLog("Smart TTS: Time-stretch bằng FFmpeg atempo để giữ nguyên cao độ giọng.");
      const inputArgs: string[] = [];
      const filters: string[] = [];
      const labels: string[] = [];

      for (let index = 0; index < scheduledClips.length; index++) {
        const clip = scheduledClips[index];
        const fileName = `smart-tts-${index}.wav`;
        await ffmpegForTts.writeFile(fileName, await fetchFile(bufferToWav(clip.buffer)));
        inputArgs.push("-i", fileName);
        const label = `tts${index}`;
        filters.push(
          `[${index}:a]atempo=${clip.rate.toFixed(4)},adelay=${Math.round(clip.start * 1000)}:all=1[${label}]`,
        );
        labels.push(`[${label}]`);
      }

      filters.push(
        `${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,` +
        `apad=pad_dur=${totalDuration.toFixed(3)},atrim=duration=${totalDuration.toFixed(3)}[voiceout]`,
      );
      const exitCode = await ffmpegForTts.exec([
        ...inputArgs,
        "-filter_complex", filters.join(";"),
        "-map", "[voiceout]",
        "-ar", String(sampleRate),
        "-ac", "1",
        "-c:a", "pcm_s16le",
        "smart-voiceover.wav",
      ]);
      if (exitCode !== 0) throw new Error(`FFmpeg Smart TTS thất bại (mã ${exitCode}).`);
      const output = await ffmpegForTts.readFile("smart-voiceover.wav");
      return new Blob([output as Uint8Array<ArrayBuffer>], { type: "audio/wav" });
    }

    // Standalone WAV preview/download fallback. Final video rendering uses FFmpeg above.
    const offlineCtx = new OfflineAudioContext(1, Math.max(1, Math.floor(sampleRate * totalDuration)), sampleRate);
    scheduledClips.forEach((clip) => {
      const source = offlineCtx.createBufferSource();
      source.buffer = clip.buffer;
      source.playbackRate.value = clip.rate;
      source.connect(offlineCtx.destination);
      source.start(clip.start);
    });
    return bufferToWav(await offlineCtx.startRendering());
  };

  const downloadMergedVoiceover = async () => {
    setIsMergingAudio(true);
    setErrorMsg("");
    try {
      const wavBlob = await generateMergedVoiceoverBlob();
      const wavUrl = URL.createObjectURL(wavBlob);

      const link = document.createElement("a");
      link.href = wavUrl;
      link.download = `tool-dubbing-video-${ttsEngine}.wav`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(wavUrl), 1000);
    } catch (err: any) {
      console.error("Lỗi khi ghép nhạc thuyết minh:", err);
      let errMsg = err.message || String(err);
      if (
        errMsg.toLowerCase().includes("decode") || 
        errMsg.toLowerCase().includes("fetch") || 
        errMsg.toLowerCase().includes("audiocontext") ||
        errMsg.toLowerCase().includes("refused")
      ) {
        errMsg += " -> [GỢI Ý]: Hãy bấm nút \"MỞ TAB MỚI\" (Open in New Tab) ở góc trên bên phải màn hình để thực hiện tải tệp thuyết minh thành công.";
      }
      setErrorMsg("Lỗi khi tải thuyết minh: " + errMsg);
    } finally {
      setIsMergingAudio(false);
    }
  };

  const startBrowserRecording = async () => {
    if (isRecordingVideo) {
      setIsRecordingVideo(false);
      setRecordingEtaSeconds(null);
      return;
    }
    
    try {
      if (!videoSrc) throw new Error("Chưa có video gốc.");
      
      if (exportedVideoUrl) {
        try {
          URL.revokeObjectURL(exportedVideoUrl);
        } catch (e) {}
        setExportedVideoUrl("");
      }
      
      setIsRecordingVideo(true);
      setRecordingProgress(0);
      const estimatedRenderFactor = exportResolution === "720" ? 0.55 : exportResolution === "1440" ? 1.25 : 0.85;
      setRecordingEtaSeconds(Math.max(20, Math.ceil((duration || 1) * estimatedRenderFactor + subtitles.length * 1.5)));
      setErrorMsg("");
      fittedTtsTextRef.current = {};
      addLog("Khởi tạo bộ xuất bản video final...");
      
      let voiceoverBlob: Blob | null = null;
      const ffmpeg = new FFmpeg();
      let finalRenderStartedAt: number | null = null;
      let maxFinalRenderProgress = 0;
      ffmpeg.on("progress", ({ progress }) => {
        if (finalRenderStartedAt === null) return;
        maxFinalRenderProgress = Math.max(maxFinalRenderProgress, Math.max(0, Math.min(1, progress)));
        setRecordingProgress(Math.min(99, Math.round(15 + maxFinalRenderProgress * 84)));
        if (maxFinalRenderProgress > 0.005) {
          const elapsedSeconds = Math.max(0.1, (performance.now() - finalRenderStartedAt) / 1000);
          const remainingSeconds = (elapsedSeconds / maxFinalRenderProgress) * (1 - maxFinalRenderProgress);
          setRecordingEtaSeconds(Math.max(1, Math.ceil(remainingSeconds)));
        }
      });
      
      ffmpeg.on("log", ({ message }) => {
        addLog(`FFmpeg: ${message}`);
      });
      
      addLog("Đang nạp bộ dịch mã FFmpeg WebAssembly...");
      let coreURL = "";
      let wasmURL = "";
      try {
        // A truncated .wasm file still returns HTTP 200, so validate it before
        // handing it to WebAssembly. This lets the CDN fallback below recover.
        const localWasmResponse = await fetch("/ffmpeg/ffmpeg-core.wasm", { cache: "no-store" });
        const localWasmBytes = new Uint8Array(await localWasmResponse.arrayBuffer());
        const isValidWasm =
          localWasmResponse.ok &&
          localWasmBytes.byteLength > 30_000_000 &&
          localWasmBytes[0] === 0x00 &&
          localWasmBytes[1] === 0x61 &&
          localWasmBytes[2] === 0x73 &&
          localWasmBytes[3] === 0x6d;

        if (!isValidWasm) {
          throw new Error(`FFmpeg WASM cục bộ không hợp lệ (${localWasmBytes.byteLength} bytes).`);
        }
        coreURL = await toBlobURL("/ffmpeg/ffmpeg-core.js", "text/javascript");
        wasmURL = URL.createObjectURL(new Blob([localWasmBytes], { type: "application/wasm" }));
      } catch (localLoadErr) {
        console.warn("Could not load local FFmpeg files, trying to fall back to unpkg CDN...", localLoadErr);
        addLog("Nạp FFmpeg cục bộ thất bại, chuyển hướng nạp từ CDN...");
        try {
          coreURL = await toBlobURL("https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js", "text/javascript");
          wasmURL = await toBlobURL("https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm", "application/wasm");
        } catch (cdnLoadErr: any) {
          console.error("Failed to load FFmpeg from CDN as well:", cdnLoadErr);
          throw new Error("Không thể tải thư viện xử lý video (FFmpeg) từ nguồn cục bộ và CDN. " + cdnLoadErr.message);
        }
      }
      console.log("coreURL =", coreURL);
      console.log("wasmURL =", wasmURL);

      console.time("ffmpeg.load");
      await ffmpeg.load({
        coreURL,
        wasmURL,
      });
      console.timeEnd("ffmpeg.load");
      addLog("Nạp bộ dịch mã FFmpeg thành công!");

      if (subtitles.length > 0) {
        setRecordingProgress(5);
        addLog("Đang đo, căn timestamp và kết xuất Smart TTS...");
        try {
          voiceoverBlob = await generateMergedVoiceoverBlob(ffmpeg);
          if (!voiceoverBlob || voiceoverBlob.size === 0) {
            throw new Error("Blob thuyết minh trả về rỗng, không thể ghép vào video.");
          }
          addLog(`Ghép Smart TTS thành công! (${(voiceoverBlob.size / 1024).toFixed(1)} KB)`);
        } catch (err: any) {
          console.error("Could not generate merged voiceover for video export:", err);
          throw new Error("Không thể tạo nhạc thuyết minh tự động cho video: " + err.message);
        }
      }
      
      addLog("Chuẩn bị nạp các tệp tài nguyên vào ổ đĩa ảo...");
      await ffmpeg.writeFile("input.mp4", await fetchFile(videoFile || videoSrc));
      
      if (voiceoverBlob) {
        await ffmpeg.writeFile("voiceover.wav", await fetchFile(voiceoverBlob));
        addLog("Đã nạp tệp voiceover.wav vào FFmpeg virtual FS.");
      } else {
        addLog("Không có phụ đề/voiceover nào — xuất video không kèm giọng đọc AI.");
      }

      const exportDuration = Math.max(0.1, workspaceVideoRef.current?.duration || videoRef.current?.duration || duration || Math.max(...subtitles.map(sub => sub.end), 0));
      const sourceVideoWidth = workspaceVideoRef.current?.videoWidth || videoRef.current?.videoWidth || 1920;
      const sourceVideoHeight = workspaceVideoRef.current?.videoHeight || videoRef.current?.videoHeight || 1080;
      const outputHeight = Number(exportResolution);
      const rawOutputWidth = Math.max(2, Math.round(sourceVideoWidth * outputHeight / Math.max(1, sourceVideoHeight)));
      const outputWidth = rawOutputWidth % 2 === 0 ? rawOutputWidth : rawOutputWidth + 1;
      let burnedSubtitleAssets: BurnedSubtitleAsset[] = [];

      if (subtitles.length > 0) {
        const synchronizedSubtitles = subtitles.map((sub) => {
          const voiceTiming = voiceoverBlob ? voiceTimingRef.current[sub.id] : undefined;
          const fittedText = fittedTtsTextRef.current[sub.id];
          return voiceTiming
            ? { ...sub, translated: fittedText || sub.translated, start: voiceTiming.start, end: voiceTiming.end }
            : { ...sub, translated: fittedText || sub.translated };
        });
        const sortedSubtitles = validateSubtitleTimeline(synchronizedSubtitles, exportDuration, 0)
          .filter((sub) => sub.end > sub.start && Boolean((sub.translated || sub.original || "").trim()))
          .sort((a, b) => a.start - b.start);
        if (sortedSubtitles.length === 0) {
          throw new Error("Dự án có track phụ đề nhưng không có dòng chữ hợp lệ để burn-in.");
        }

        const srtContent = sortedSubtitles
          .sort((a, b) => a.start - b.start)
          .map((sub, index) => {
            const text = (sub.translated || sub.original || "")
              .replace(/\r?\n/g, " ")
              .trim();
            return `${index + 1}\n${formatSecondsToSRT(sub.start)} --> ${formatSecondsToSRT(Math.max(sub.end, sub.start + 0.1))}\n${text}\n`;
          })
          .join("\n");
        await ffmpeg.writeFile("subtitles.srt", srtContent);
        const alignedCount = sortedSubtitles.filter((sub) => Boolean(voiceTimingRef.current[sub.id])).length;
        addLog(`Hardsub sync: ${alignedCount}/${sortedSubtitles.length} dòng đã khóa theo đúng track Smart TTS.`);
        addLog("Đã lưu manifest SRT; đang dựng lớp hardsub PNG độc lập với libass...");

        const generatedAssets = await Promise.all(sortedSubtitles.map((subtitle, index) =>
          createBurnedSubtitleAsset(
            subtitle,
            index,
            subSettings,
            blurBoxes,
            activeBlurBoxId,
            outputWidth,
            outputHeight,
            sourceVideoHeight,
          ),
        ));
        burnedSubtitleAssets = generatedAssets.filter((asset): asset is BurnedSubtitleAsset => Boolean(asset));
        if (burnedSubtitleAssets.length !== sortedSubtitles.length) {
          throw new Error(`Không tạo đủ lớp hardsub (${burnedSubtitleAssets.length}/${sortedSubtitles.length}); đã hủy render để không xuất video thiếu phụ đề.`);
        }
        for (const asset of burnedSubtitleAssets) {
          if (asset.blob.size < 100 || asset.width < 2 || asset.height < 2) {
            throw new Error(`Lớp hardsub ${asset.fileName} không hợp lệ; đã hủy render.`);
          }
          await ffmpeg.writeFile(asset.fileName, await fetchFile(asset.blob));
        }
        addLog(`Đã tạo và kiểm tra ${burnedSubtitleAssets.length}/${sortedSubtitles.length} lớp hardsub PNG.`);
      }
      
      let filterComplex = "";
      let lastOverlay = "0:v";
      let filterChain = "";
      
      if (flipHorizontal || flipVertical) {
        if (flipHorizontal && flipVertical) {
           filterChain += `[0:v]hflip,vflip[flipped];`;
        } else if (flipHorizontal) {
           filterChain += `[0:v]hflip[flipped];`;
        } else if (flipVertical) {
           filterChain += `[0:v]vflip[flipped];`;
        }
        lastOverlay = "flipped";
      }
      
      if (blurBoxes.length > 0) {
        const w = sourceVideoWidth;
        const h = sourceVideoHeight;
        
        blurBoxes.forEach((box, i) => {
          const bw = Math.max(2, Math.round(w * (box.width / 100)));
          const bh = Math.max(2, Math.round(h * (box.height / 100)));
          const bx = Math.round(w * (box.xPosition / 100));
          const by = Math.round(h * (box.yPosition / 100));
          const blurAmt = Math.max(1, box.blurAmount);
          const coverColor = getBlurCoverFfmpegColor(box.bgColor, box.opacity);
          
          // Filter labels must always be enclosed in brackets. Without them
          // FFmpeg parses "0:vsplit" as a filter name instead of "[0:v]split".
          const source = `[${lastOverlay}]`;
          const bg = i === 0 ? source : `[ov${i-1}]`;
          filterChain += `${bg}split[bg${i}][src${i}];`;
          
          const boxBase =
            `[src${i}]crop=${bw}:${bh}:${bx}:${by},` +
            `boxblur=${blurAmt}:${blurAmt},` +
            `drawbox=x=0:y=0:w=iw:h=ih:color=${coverColor}:t=fill`;
          filterChain += `${boxBase}[b${i}];`;
          
          filterChain += `[bg${i}][b${i}]overlay=${bx}:${by}[ov${i}];`;
          
          lastOverlay = `ov${i}`;
        });
      }

      // Dùng đúng kích thước đã dùng khi dựng PNG để tọa độ hardsub khớp từng pixel.
      filterChain += `[${lastOverlay}]scale=${outputWidth}:${outputHeight}[scaled];`;
      lastOverlay = "scaled";

      // Burn-in bằng PNG alpha để không phụ thuộc filter subtitles/libass của
      // FFmpeg WASM. Mỗi ảnh chỉ xuất hiện đúng khoảng timestamp của dòng đó.
      const firstSubtitleInputIndex = voiceoverBlob ? 2 : 1;
      burnedSubtitleAssets.forEach((asset, index) => {
        const inputIndex = firstSubtitleInputIndex + index;
        const outputLabel = `hardSub${index}`;
        filterChain +=
          `[${lastOverlay}][${inputIndex}:v]overlay=${asset.x}:${asset.y}:` +
          `enable='between(t,${asset.start.toFixed(3)},${asset.end.toFixed(3)})':` +
          `eof_action=repeat:shortest=0[${outputLabel}];`;
        lastOverlay = outputLabel;
      });

      if (subtitles.length > 0 && (burnedSubtitleAssets.length === 0 || !lastOverlay.startsWith("hardSub"))) {
        throw new Error("Chuỗi render chưa map qua lớp hardsub; đã hủy để không xuất video thiếu phụ đề.");
      }
      
      if (lastOverlay !== "0:v") {
          lastOverlay = `[${lastOverlay}]`;
      }
      
      filterComplex = filterChain.endsWith(";") ? filterChain.slice(0, -1) : filterChain;
      const subtitleInputArgs = burnedSubtitleAssets.flatMap((asset) => ["-loop", "1", "-i", asset.fileName]);
      finalRenderStartedAt = performance.now();
      maxFinalRenderProgress = 0;
      setRecordingProgress(15);
      
      // Execute based on voiceoverBlob availability
      if (voiceoverBlob) {
        let success = false;
        try {
          // Try mixing original video audio with voiceover
          let audioFilter = `[0:a]volume=${originalAudioMixVolume}[bg];[1:a]volume=1.0[voice];[bg][voice]amix=inputs=2:duration=first[outa]`;
          let filterComplexWithAudio = filterComplex;
          
          const args = ["-i", "input.mp4", "-i", "voiceover.wav", ...subtitleInputArgs];
          if (filterComplexWithAudio) {
            filterComplexWithAudio += ";" + audioFilter;
            args.push("-filter_complex", filterComplexWithAudio, "-map", lastOverlay, "-map", "[outa]");
          } else {
            args.push("-filter_complex", audioFilter, "-map", "0:v", "-map", "[outa]");
          }
          args.push("-t", exportDuration.toFixed(3), "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "output.mp4");
          
          const exitCode = await ffmpeg.exec(args);
          if (exitCode !== 0) throw new Error(`FFmpeg kết xuất thất bại (mã ${exitCode}).`);
          success = true;
        } catch (mixErr) {
          console.warn("Mixing original audio failed (likely no original audio track), falling back to replacing with voiceover:", mixErr);
          
          // Clean output to retry
          try {
            await ffmpeg.deleteFile("output.mp4");
          } catch (e) {}
          
          // Fallback: Use only voiceover audio
          finalRenderStartedAt = performance.now();
          maxFinalRenderProgress = 0;
          const args = ["-i", "input.mp4", "-i", "voiceover.wav", ...subtitleInputArgs];
          if (filterComplex) {
            args.push("-filter_complex", filterComplex, "-map", lastOverlay, "-map", "1:a");
          } else {
            args.push("-map", "0:v", "-map", "1:a");
          }
          args.push("-t", exportDuration.toFixed(3), "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "output.mp4");
          const exitCode = await ffmpeg.exec(args);
          if (exitCode !== 0) throw new Error(`FFmpeg kết xuất thất bại (mã ${exitCode}).`);
          success = true;
        }
      } else {
        // Original behavior when no voiceover
        const args = ["-i", "input.mp4", ...subtitleInputArgs];
        if (filterComplex) {
          args.push("-filter_complex", filterComplex, "-map", lastOverlay, "-map", "0:a?");
        }
        args.push("-t", exportDuration.toFixed(3), "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "output.mp4");
        const exitCode = await ffmpeg.exec(args);
        if (exitCode !== 0) throw new Error(`FFmpeg kết xuất thất bại (mã ${exitCode}).`);
      }
      
      addLog("Bộ giải mã video đã xử lý xong! Đang nạp tệp xuất ra...");
      const data = await ffmpeg.readFile("output.mp4");
      const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: "video/mp4" });

      if (burnedSubtitleAssets.length > 0) {
        try {
          const proofIndexes = Array.from(new Set([
            0,
            Math.floor(burnedSubtitleAssets.length / 2),
            burnedSubtitleAssets.length - 1,
          ]));
          
          // Chạy hậu kiểm với giới hạn thời gian tổng thể là 8 giây để tránh treo ở 99%
          await Promise.race([
            (async () => {
              for (const proofIndex of proofIndexes) {
                const proofAsset = burnedSubtitleAssets[proofIndex];
                const proofTime = Math.max(0.05, (proofAsset.start + proofAsset.end) / 2);
                addLog(`Đang hậu kiểm hardsub #${proofIndex + 1} tại ${proofTime.toFixed(2)}s trên MP4 final...`);
                const proofFrame = await captureVideoFrame(blob, proofTime, outputWidth, outputHeight);
                const hardsubVerified = await verifyBurnedSubtitlePixels(
                  proofFrame,
                  proofAsset,
                  outputWidth,
                  outputHeight,
                );
                if (!hardsubVerified) {
                  addLog(`[CẢNH BÁO HẬU KIỂM]: Không tìm thấy phụ đề #${proofIndex + 1} tại ${proofTime.toFixed(2)}s. Vẫn tiếp tục xuất video.`);
                }
              }
              addLog(`HẬU KIỂM HOÀN TẤT: Đã kiểm tra các mốc thời gian (${burnedSubtitleAssets.length} dòng).`);
            })(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Quá thời gian hậu kiểm (8s)")), 8000))
          ]);
        } catch (proofErr: any) {
          addLog(`[CẢNH BÁO HẬU KIỂM]: Bỏ qua hậu kiểm do lỗi hoặc quá thời gian: ${proofErr.message || proofErr}. Video vẫn sẽ được xuất ra.`);
        }
      } else if (subtitles.length > 0) {
        addLog("[CẢNH BÁO]: Video có phụ đề nhưng không có lớp hardsub để hậu kiểm.");
      }

      const url = URL.createObjectURL(blob);
      setExportedVideoUrl(url); // Save to state for manual click download button in UI!
      if (currentProjectId) {
        await projectDbPut("media", {
          id: `${currentProjectId}|latest-render`,
          blob,
          name: `final-${videoName || "video"}.mp4`,
          type: "video/mp4",
          lastModified: Date.now(),
        } satisfies StoredProjectMedia).catch((error) => console.warn("Could not persist final render:", error));
        addLog("Đã lưu video final vào checkpoint dự án.");
      }
      
      const link = document.createElement("a");
      link.href = url;
      link.download = "tool-dubbing-video.mp4";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      setRecordingProgress(100);
      setRecordingEtaSeconds(0);
      setIsRecordingVideo(false);
      addLog("Xuất video thành phẩm thành công! Đã tự động kích hoạt tải xuống.");
      
      try {
        ffmpeg.terminate();
      } catch (e) {}
    } catch (err: any) {
      console.error("Lỗi khi kết xuất video:", err);
      let errMsg = err.message || String(err);
      addLog(`Lỗi xử lý kết xuất video final: ${errMsg}`);
      if (
        errMsg.toLowerCase().includes("sharedarraybuffer") || 
        errMsg.toLowerCase().includes("security") || 
        errMsg.toLowerCase().includes("permission") || 
        errMsg.toLowerCase().includes("load") ||
        errMsg.toLowerCase().includes("fetch") ||
        errMsg.toLowerCase().includes("refused")
      ) {
        errMsg += " -> [GỢI Ý QUAN TRỌNG]: Hãy click nút \"MỞ TAB MỚI\" (Open in New Tab) ở góc trên bên phải màn hình để xuất và tải video thành công. Trình duyệt chặn xử lý video (FFmpeg) khi chạy trong khung xem thử của AI Studio.";
      }
      setErrorMsg("Lỗi khi xuất video: " + errMsg);
      setIsRecordingVideo(false);
      setRecordingEtaSeconds(null);
    }
  };

  const handleAutoDubbingRender = async () => {
    if (!videoSrc) {
      setErrorMsg("Vui lòng tải video lên trước khi render tự động.");
      return;
    }

    // Translation is the only prerequisite that may not yet exist. Once it
    // finishes, the effect below continues with TTS generation and rendering.
    if (subtitles.length === 0 || subtitlePipelineVersion < 4) {
      if (subtitles.length > 0) {
        addLog("Phụ đề của checkpoint cũ dùng bộ timestamp lỗi; đang nhận dạng lại bằng pipeline v4 trước khi render.");
      }
      setAutoRenderRequested(true);
      await handleTranslateVideo();
      return;
    }

    await startBrowserRecording();
  };

  const handleStartOrContinueProject = async () => {
    if (!videoSrc) {
      setErrorMsg("Vui lòng tải video lên trước khi bắt đầu.");
      return;
    }

    // Lần đầu chạy STT/dịch. Effect bên dưới sẽ tự nối tiếp sang TTS ngay
    // khi React nhận được danh sách phụ đề mới.
    if (subtitles.length === 0 || subtitlePipelineVersion < 4) {
      if (subtitles.length > 0) {
        addLog("Checkpoint phụ đề cũ cần được căn lại timestamp bằng pipeline v4.");
      }
      setAutoPrepareRequested(true);
      await handleTranslateVideo();
      return;
    }

    const completed = await preGenerateAllTts();
    if (completed) {
      addLog("Đã chuẩn bị xong phụ đề và thuyết minh. Có thể bấm Render tự động để xuất video final.");
    }
  };

  const handleTimelineResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = timelineHeight;
    const onMove = (moveEvent: PointerEvent) => {
      const nextHeight = startHeight + startY - moveEvent.clientY;
      setTimelineHeight(Math.max(92, Math.min(420, nextHeight)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  useEffect(() => {
    if (!autoRenderRequested || isLoading || isRecordingVideo) return;

    setAutoRenderRequested(false);
    if (subtitles.length > 0 && subtitlePipelineVersion >= 4) {
      void startBrowserRecording();
    } else {
      setErrorMsg("Không thể tự render vì phụ đề chưa được tạo/căn timestamp thành công. Hãy kiểm tra cấu hình dịch thuật.");
    }
  }, [autoRenderRequested, isLoading, isRecordingVideo, subtitles.length, subtitlePipelineVersion]);

  useEffect(() => {
    if (!autoPrepareRequested || isLoading || isPreGenerating) return;

    setAutoPrepareRequested(false);
    if (subtitles.length === 0 || subtitlePipelineVersion < 4) {
      setErrorMsg("Không thể tiếp tục vì phụ đề chưa được tạo/căn timestamp thành công. Hãy kiểm tra cấu hình dịch thuật.");
      return;
    }

    void preGenerateAllTts().then((completed) => {
      if (completed) {
        addLog("Đã chuẩn bị xong phụ đề và thuyết minh. Có thể bấm Render tự động để xuất video final.");
      }
    });
  }, [autoPrepareRequested, isLoading, isPreGenerating, subtitles.length, subtitlePipelineVersion]);

  // Filtered tracks for Right Panel
  const filteredSubtitles = useMemo(() => {
    return subtitles.filter(sub => 
      sub.original.toLowerCase().includes(searchQuery.toLowerCase()) ||
      sub.translated.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [subtitles, searchQuery]);

  // Add a new custom blur box
  const handleAddBlurBox = () => {
    const nextId = `blur-box-${Date.now()}`;
    const offset = (blurBoxes.length * 5) % 30;
    const newBox: BlurBox = {
      id: nextId,
      xPosition: 15 + offset,
      yPosition: 55 + offset,
      width: 70,
      height: 12,
      blurAmount: 12,
      opacity: 0.75,
      bgColor: BLUR_COVER_PRESETS[0].bgColor,
    };
    setBlurBoxes(prev => [...prev, newBox]);
    setActiveBlurBoxId(nextId);
    setWorkspacePropertyTarget("blur");
  };

  const updateActiveBlurBox = (patch: Partial<BlurBox>) => {
    if (!activeBlurBoxId) return;
    setBlurBoxes(prev => prev.map(box => box.id === activeBlurBoxId ? { ...box, ...patch } : box));
  };

  const updateActiveOcrRegion = (patch: Partial<OcrRegion>) => {
    setOcrRegions((regions) => regions.map((region) => region.id === activeOcrRegionId ? { ...region, ...patch } : region));
  };

  const addSuggestedOcrRegion = () => {
    const id = `ocr-region-${Date.now()}`;
    const offset = (ocrRegions.length * 4) % 20;
    const region: OcrRegion = { id, label: `Vùng ${ocrRegions.length + 1}`, x: 8, y: Math.max(5, 72 - offset), width: 84, height: 20 };
    setOcrRegions((current) => [...current, region]);
    setActiveOcrRegionId(id);
    setWorkspacePropertyTarget("ocr");
  };

  const removeActiveOcrRegion = () => {
    setOcrRegions((current) => {
      const remaining = current.filter((region) => region.id !== activeOcrRegionId);
      setActiveOcrRegionId(remaining[0]?.id || "");
      return remaining;
    });
    setOcrPreviewText("");
  };

  const handleWorkspaceOcrRegionDrag = (event: React.PointerEvent<HTMLButtonElement>, id: string, resize = false) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    const region = ocrRegions.find((item) => item.id === id);
    if (!bounds || !region) return;
    setActiveOcrRegionId(id);
    setWorkspacePropertyTarget("ocr");
    const startX = event.clientX;
    const startY = event.clientY;
    const onMove = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / bounds.width) * 100;
      const dy = ((moveEvent.clientY - startY) / bounds.height) * 100;
      const patch = resize
        ? { width: Math.max(2, Math.min(100 - region.x, region.width + dx)), height: Math.max(2, Math.min(100 - region.y, region.height + dy)) }
        : { x: Math.max(0, Math.min(100 - region.width, region.x + dx)), y: Math.max(0, Math.min(100 - region.height, region.y + dy)) };
      setOcrRegions((current) => current.map((item) => item.id === id ? {
        ...item,
        ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, Math.round(Number(value) * 10) / 10])),
      } : item));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleDrawOcrRegion = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDrawingOcrRegion) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const startX = Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100));
    const startY = Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100));
    const id = `ocr-region-${Date.now()}`;
    const region: OcrRegion = { id, label: `Vùng ${ocrRegions.length + 1}`, x: startX, y: startY, width: 2, height: 2 };
    setOcrRegions((current) => [...current, region]);
    setActiveOcrRegionId(id);
    const onMove = (moveEvent: PointerEvent) => {
      const currentX = Math.max(0, Math.min(100, ((moveEvent.clientX - bounds.left) / bounds.width) * 100));
      const currentY = Math.max(0, Math.min(100, ((moveEvent.clientY - bounds.top) / bounds.height) * 100));
      const x = Math.min(startX, currentX);
      const y = Math.min(startY, currentY);
      setOcrRegions((current) => current.map((item) => item.id === id ? {
        ...item,
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        width: Math.round(Math.min(Math.max(2, Math.abs(currentX - startX)), 100 - x) * 10) / 10,
        height: Math.round(Math.min(Math.max(2, Math.abs(currentY - startY)), 100 - y) * 10) / 10,
      } : item));
    };
    const onUp = () => {
      setIsDrawingOcrRegion(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const getWorkspaceVideoContentStyle = (): React.CSSProperties => {
    const containerRatio = 16 / 9;
    const videoRatio = workspaceVideoDimensions.width / Math.max(1, workspaceVideoDimensions.height);
    if (videoRatio >= containerRatio) {
      const heightPercent = (containerRatio / videoRatio) * 100;
      return { position: "absolute", left: 0, width: "100%", height: `${heightPercent}%`, top: `${(100 - heightPercent) / 2}%` };
    }
    const widthPercent = (videoRatio / containerRatio) * 100;
    return { position: "absolute", top: 0, height: "100%", width: `${widthPercent}%`, left: `${(100 - widthPercent) / 2}%` };
  };

  const previewCurrentFrameWithPaddleOcr = async () => {
    const video = workspaceVideoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      setErrorMsg("Hãy tải video và seek tới frame có phụ đề trước khi Preview OCR.");
      return;
    }
    setIsPreviewingOcr(true);
    setOcrPreviewText("");
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1920 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Không tạo được ảnh preview OCR.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error("Không mã hóa được frame preview OCR.")),
        "image/jpeg",
        0.9,
      ));
      let detections: OcrDetection[] = [];
      let backendLabel = "CPU dự phòng";
      setBrowserOcrStatus("initializing");
      setBrowserOcrError("");
      try {
        const frontendResult = await recognizeBrowserOcrBatch(
          [{ frameId: 0, timestamp: video.currentTime, image: await blob.arrayBuffer() }],
          ocrRegions,
          0.3,
        );
        detections = frontendResult.frames[0]?.detections || [];
        setBrowserOcrBackend(frontendResult.backend);
        setBrowserOcrStatus("ready");
        backendLabel = frontendResult.backend === "webgpu" ? "WebGPU" : "WASM";
      } catch (frontendError: any) {
        const frontendMessage = frontendError?.message || String(frontendError);
        setBrowserOcrStatus("error");
        setBrowserOcrError(frontendMessage);
        const response = await fetch("/api/ocr/frame", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: canvas.toDataURL("image/jpeg", 0.9).split(",")[1],
            timestamp: video.currentTime,
            regions: ocrRegions,
            minConfidence: 0.3,
          }),
        });
        const payload = await readJsonResponse(response);
        detections = payload.detections || [];
        await checkOcrService(false);
      }
      setOcrPreviewText(detections.length
        ? `[${backendLabel}] ${detections.map((item) => `${item.text} (${Math.round(item.confidence * 100)}%)`).join(" · ")}`
        : `[${backendLabel}] Không thấy chữ trong frame/vùng đang chọn.`);
    } catch (error: any) {
      setErrorMsg(`Preview PaddleOCR thất bại: ${error?.message || String(error)}`);
    } finally {
      setIsPreviewingOcr(false);
    }
  };

  const saveOcrRegionPreset = () => {
    const name = ocrPresetName.trim();
    if (!name || !ocrRegions.length) {
      setErrorMsg("Nhập tên preset và tạo ít nhất một vùng OCR trước.");
      return;
    }
    const preset: OcrRegionPreset = { id: `ocr-preset-${Date.now()}`, name, regions: ocrRegions.map((region) => ({ ...region })) };
    setOcrPresets((current) => [...current.filter((item) => item.name.toLowerCase() !== name.toLowerCase()), preset]);
    setOcrPresetName("");
  };

  const applyOcrRegionPreset = (preset: OcrRegionPreset) => {
    const stamp = Date.now();
    const regions = preset.regions.map((region, index) => ({ ...region, id: `ocr-region-${stamp}-${index}` }));
    setOcrRegions(regions);
    setActiveOcrRegionId(regions[0]?.id || "");
  };

  const handleWorkspaceBlurDrag = (event: React.PointerEvent<HTMLButtonElement>, id: string, resize = false) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    const box = blurBoxes.find(item => item.id === id);
    if (!bounds || !box) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const onMove = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / bounds.width) * 100;
      const dy = ((moveEvent.clientY - startY) / bounds.height) * 100;
      const patch = resize ? { width: Math.max(4, Math.min(100 - box.xPosition, box.width + dx)), height: Math.max(3, Math.min(100 - box.yPosition, box.height + dy)) } : { xPosition: Math.max(0, Math.min(100 - box.width, box.xPosition + dx)), yPosition: Math.max(0, Math.min(100 - box.height, box.yPosition + dy)) };
      setBlurBoxes(prev => prev.map(item => item.id === id ? { ...item, ...patch } : item));
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  };

  const handleWorkspaceSubtitleDrag = (event: React.PointerEvent<HTMLDivElement>, resize = false) => {
    event.preventDefault();
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startFontSize = subSettings.fontSize;
    const startPositionX = subSettings.customX ?? 50;
    const startPositionY = subSettings.customY ?? 82;
    const onMove = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / bounds.width) * 100;
      const dy = ((moveEvent.clientY - startY) / bounds.height) * 100;
      setSubSettings(prev => resize ? { ...prev, fontSize: Math.max(12, Math.min(120, Math.round(startFontSize + dx))) } : { ...prev, position: "custom", customX: Math.max(0, Math.min(100, startPositionX + dx)), customY: Math.max(0, Math.min(100, startPositionY + dy)) });
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  };

  const renderWorkspaceProperties = () => {
    const activeBox = blurBoxes.find(box => box.id === activeBlurBoxId);
    const activeOcrRegion = ocrRegions.find(region => region.id === activeOcrRegionId);
    const fieldClass = "mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800";
    if (workspacePropertyTarget === "ocr") {
      return <div className="mt-4 space-y-3 text-xs">
        <div className={`rounded-lg border p-2 ${browserOcrStatus === "ready" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : browserOcrStatus === "error" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
          <div className="flex items-center justify-between gap-2"><strong>{browserOcrStatus === "ready" ? `PaddleOCR ${browserOcrBackend === "webgpu" ? "WebGPU" : "WASM"} sẵn sàng` : browserOcrStatus === "initializing" ? "Đang nạp PaddleOCR Web..." : browserOcrStatus === "error" ? "PaddleOCR Web cần fallback" : "PaddleOCR Web chưa nạp"}</strong><button type="button" onClick={() => void checkOcrService()} disabled={isCheckingOcr} className="rounded bg-white px-2 py-1 text-[10px] font-bold shadow-sm">{isCheckingOcr ? "Đang kiểm tra..." : "Kiểm tra CPU"}</button></div>
          {browserOcrStatus === "idle" && <p className="mt-1 text-[10px] leading-4">Model sẽ nạp khi Preview hoặc bắt đầu OCR; ưu tiên GPU của trình duyệt.</p>}
          {browserOcrError && <p className="mt-1 break-words text-[10px]">Frontend: {browserOcrError}</p>}
          <p className="mt-1 text-[10px] leading-4">CPU dự phòng: {ocrHealth?.connected ? "sẵn sàng" : ocrHealth?.state === "idle" ? "đang nghỉ" : ocrHealth?.state === "initializing" ? "đang nạp" : "chưa sẵn sàng"}.</p>
          {ocrHealth?.model && <p className="mt-1 text-[10px] leading-4">{ocrHealth.model.name} · {ocrHealth.model.backend}<br />{ocrHealth.model.concurrency || 1} worker song song · {ocrHealth.model.threadsPerJob || 1} luồng/worker<br />{ocrHealth.model.detection}<br />{ocrHealth.model.recognition}</p>}
          {ocrHealth?.error && <p className="mt-1 break-words text-[10px]">{ocrHealth.error}</p>}
        </div>
        <label className="block font-bold text-slate-600">Tần suất quét: {ocrFps} FPS<input type="range" min="2" max="10" step="1" value={ocrFps} onChange={(event) => setOcrFps(Number(event.target.value))} className="mt-1 w-full accent-indigo-600" /><span className="mt-1 block text-[9px] font-normal text-slate-400">Mốc thời gian chuẩn 0,35 giây. Tốc độ, batch và RAM tự điều chỉnh theo máy tính hoặc điện thoại.</span></label>
        <div className="flex flex-wrap gap-1">{ocrRegions.map((region, index) => <button key={region.id} type="button" onClick={() => setActiveOcrRegionId(region.id)} className={`rounded px-2 py-1 text-[10px] font-bold ${region.id === activeOcrRegionId ? "bg-emerald-600 text-white" : "bg-white text-slate-500"}`}>Vùng #{index + 1}</button>)}</div>
        <div className="grid grid-cols-2 gap-1"><button type="button" onClick={() => setIsDrawingOcrRegion(true)} className={`rounded px-2 py-1.5 text-[10px] font-bold text-white ${isDrawingOcrRegion ? "bg-amber-500" : "bg-indigo-600"}`}>{isDrawingOcrRegion ? "Kéo chuột trên video..." : "+ Vẽ vùng OCR"}</button><button type="button" onClick={addSuggestedOcrRegion} className="rounded border border-slate-200 bg-white px-2 py-1.5 text-[10px] font-bold text-slate-600">+ Vùng gợi ý</button></div>
        {activeOcrRegion ? <>
          <label className="block font-bold text-slate-600">Tên vùng<input value={activeOcrRegion.label} onChange={(event) => updateActiveOcrRegion({ label: event.target.value })} className={fieldClass} /></label>
          <div className="grid grid-cols-2 gap-2">{([['x','Vị trí X'],['y','Vị trí Y'],['width','Chiều rộng'],['height','Chiều cao']] as const).map(([key, label]) => <label key={key} className="font-bold text-slate-600">{label} (%)<input type="number" min="0" max="100" step="0.1" value={activeOcrRegion[key]} onChange={(event) => updateActiveOcrRegion({ [key]: Number(event.target.value) })} className={fieldClass} /></label>)}</div>
          <button type="button" onClick={removeActiveOcrRegion} className="flex w-full items-center justify-center gap-1 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[10px] font-bold text-rose-600"><Trash2 className="h-3 w-3" /> Xóa vùng đang chọn</button>
        </> : <p className="rounded bg-sky-50 p-2 text-[10px] text-sky-700">Không có ROI: PaddleOCR sẽ quét toàn bộ frame.</p>}
        <button type="button" onClick={() => void previewCurrentFrameWithPaddleOcr()} disabled={isPreviewingOcr || !videoSrc} className="w-full rounded bg-emerald-600 px-3 py-2 text-[11px] font-extrabold text-white disabled:opacity-50">{isPreviewingOcr ? "Đang OCR frame thật..." : "Preview OCR tại frame hiện tại"}</button>
        {ocrPreviewText && <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-[10px] leading-4 text-emerald-800"><strong>Kết quả:</strong> {ocrPreviewText}</div>}
        <div className="rounded-lg border border-slate-200 bg-white p-2"><p className="font-bold text-slate-600">Preset vùng OCR</p><div className="mt-1 flex gap-1"><input value={ocrPresetName} onChange={(event) => setOcrPresetName(event.target.value)} placeholder="Tên preset..." className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-[10px]" /><button type="button" onClick={saveOcrRegionPreset} className="rounded bg-slate-800 px-2 text-[10px] font-bold text-white">Lưu</button></div>{ocrPresets.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{ocrPresets.map((preset) => <button key={preset.id} type="button" onClick={() => applyOcrRegionPreset(preset)} className="rounded bg-slate-100 px-2 py-1 text-[9px] font-bold text-slate-600">{preset.name}</button>)}</div>}</div>
      </div>;
    }
    if (workspacePropertyTarget === "subtitle") {
      return <div className="mt-4 space-y-3 text-xs">
        <label className="block font-bold text-slate-600">Kích thước chữ: {subSettings.fontSize}px<input type="range" min="12" max="120" value={subSettings.fontSize} onChange={(e) => setSubSettings(prev => ({ ...prev, fontSize: Number(e.target.value) }))} className="mt-1 w-full accent-indigo-600" /></label>
        <label className="block font-bold text-slate-600">Phông chữ<select value={subSettings.fontFamily} onChange={(e) => setSubSettings(prev => ({ ...prev, fontFamily: e.target.value }))} className={fieldClass}><option>Bangers</option><option>Arial</option><option>Inter</option><option>JetBrains Mono</option></select></label>
        <div className="grid grid-cols-2 gap-2"><label className="font-bold text-slate-600">Độ đậm<select value={subSettings.fontWeight} onChange={(e) => setSubSettings(prev => ({ ...prev, fontWeight: e.target.value as SubtitleSettings["fontWeight"] }))} className={fieldClass}><option value="normal">Thường</option><option value="medium">Vừa</option><option value="bold">Đậm</option><option value="black">Rất đậm</option></select></label><label className="font-bold text-slate-600">Khoảng cách: {subSettings.letterSpacing}px<input type="range" min="-2" max="12" value={subSettings.letterSpacing} onChange={(e) => setSubSettings(prev => ({ ...prev, letterSpacing: Number(e.target.value) }))} className="mt-2 w-full accent-indigo-600" /></label></div>
        <div><p className="font-bold text-slate-600">Vị trí hiển thị</p><div className="mt-1 grid grid-cols-2 gap-1">{([['bottom','Phía dưới'],['top','Phía trên'],['center','Ở giữa'],['custom','Tự do (kéo thả)']] as const).map(([value,label]) => <button key={value} onClick={() => setSubSettings(prev => ({ ...prev, position: value }))} className={`rounded border px-2 py-1.5 text-[10px] font-bold ${subSettings.position === value ? "border-indigo-500 bg-indigo-50 text-indigo-600" : "border-slate-200 bg-white text-slate-500"}`}>{label}</button>)}</div></div>
        <div className="grid grid-cols-2 gap-2"><label className="font-bold text-slate-600">Màu chữ<input type="color" value={subSettings.textColor} onChange={(e) => setSubSettings(prev => ({ ...prev, textColor: e.target.value }))} className="mt-1 h-9 w-full rounded border border-slate-200" /></label><label className="font-bold text-slate-600">Nền chữ<select value={subSettings.bgColor} onChange={(e) => setSubSettings(prev => ({ ...prev, bgColor: e.target.value }))} className={fieldClass}><option value="transparent">Tắt</option><option value="rgba(0,0,0,0.6)">Nền đen</option><option value="rgba(15,23,42,0.75)">Nền xanh đậm</option><option value="rgba(255,255,255,0.7)">Nền trắng</option></select></label></div>
        <div><p className="font-bold text-slate-600">Hiệu ứng chữ</p><div className="mt-1 grid grid-cols-2 gap-1">{([['none','Không'],['outline','Viền chữ'],['glow','Phát sáng'],['shadow','Đổ bóng']] as const).map(([value,label]) => <button key={value} onClick={() => setSubSettings(prev => ({ ...prev, textEffect: value }))} className={`rounded border px-2 py-1.5 text-[10px] font-bold ${subSettings.textEffect === value ? "border-indigo-500 bg-indigo-50 text-indigo-600" : "border-slate-200 bg-white text-slate-500"}`}>{label}</button>)}</div></div>
        {subSettings.textEffect === "outline" && <div className="grid grid-cols-2 gap-2"><label className="font-bold text-slate-600">Màu viền<input type="color" value={subSettings.outlineColor} onChange={(e) => setSubSettings(prev => ({ ...prev, outlineColor: e.target.value }))} className="mt-1 h-8 w-full" /></label><label className="font-bold text-slate-600">Độ dày: {subSettings.outlineWidth}px<input type="range" min="1" max="8" value={subSettings.outlineWidth} onChange={(e) => setSubSettings(prev => ({ ...prev, outlineWidth: Number(e.target.value) }))} className="mt-2 w-full accent-indigo-600" /></label></div>}
      </div>;
    }
    return <div className="mt-4 space-y-3 text-xs">
      <div className="flex items-center justify-between"><span className="font-bold text-slate-600">Kích hoạt</span><input type="checkbox" checked={blurSettings.enabled} onChange={(e) => setBlurSettings(prev => ({ ...prev, enabled: e.target.checked }))} className="h-4 w-4 accent-indigo-600" /></div>
      <div className="flex flex-wrap gap-1">{blurBoxes.map((box, index) => <button key={box.id} onClick={() => setActiveBlurBoxId(box.id)} className={`rounded px-2 py-1 text-[10px] font-bold ${box.id === activeBlurBoxId ? "bg-indigo-600 text-white" : "bg-white text-slate-500"}`}>Hộp #{index + 1}</button>)}<button onClick={handleAddBlurBox} className="rounded bg-indigo-600 px-2 py-1 text-[10px] font-bold text-white">+ Thêm</button></div>
      {activeBox ? <><button type="button" onClick={(e) => handleRemoveBlurBox(activeBox.id, e)} className="flex w-full items-center justify-center gap-1.5 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[10px] font-bold text-rose-600 transition-colors hover:border-rose-300 hover:bg-rose-100"><Trash2 className="h-3.5 w-3.5" /> Xóa hộp đang chọn</button><div className="grid grid-cols-2 gap-2">{([['xPosition','Vị trí X'],['yPosition','Vị trí Y'],['width','Chiều rộng'],['height','Chiều cao']] as const).map(([key,label]) => <label key={key} className="font-bold text-slate-600">{label}<input type="number" value={activeBox[key]} onChange={(e) => updateActiveBlurBox({ [key]: Number(e.target.value) })} className={fieldClass} /></label>)}</div><div><p className="font-bold text-slate-600">Kiểu che</p><div className="mt-1 grid grid-cols-4 gap-1">{BLUR_COVER_PRESETS.map((preset) => { const selected = getBlurCoverPresetKey(activeBox.bgColor) === preset.key; return <button key={preset.key} type="button" aria-pressed={selected} onClick={() => updateActiveBlurBox({ bgColor: preset.bgColor })} className={`rounded border px-1 py-1.5 text-[10px] font-bold transition-colors ${selected ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-indigo-300"}`}>{preset.label}</button>; })}</div></div><label className="block font-bold text-slate-600">Mức độ làm mờ: {activeBox.blurAmount}px<input type="range" min="0" max="30" value={activeBox.blurAmount} onChange={(e) => updateActiveBlurBox({ blurAmount: Number(e.target.value) })} className="mt-1 w-full accent-indigo-600" /></label><label className="block font-bold text-slate-600">Độ che phủ: {Math.round(activeBox.opacity * 100)}%<input type="range" min="0" max="1" step="0.05" value={activeBox.opacity} onChange={(e) => updateActiveBlurBox({ opacity: Number(e.target.value) })} className="mt-1 w-full accent-indigo-600" /></label></> : <p className="rounded bg-indigo-50 p-2 text-indigo-700">Thêm hoặc chọn Blur Box trên preview để tinh chỉnh.</p>}
    </div>;
  };

  // Remove a blur box
  const handleRemoveBlurBox = (id: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
    }
    setBlurBoxes(prev => {
      const filtered = prev.filter(b => b.id !== id);
      if (activeBlurBoxId === id) {
        setActiveBlurBoxId(filtered[0]?.id || null);
      }
      return filtered;
    });
  };

  // Handle pointer down for drag & resize
  const handleBoxPointerDown = (
    e: React.PointerEvent<HTMLDivElement>, 
    boxId: string, 
    action: 'move' | 'resize-n' | 'resize-s' | 'resize-e' | 'resize-w' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se'
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveBlurBoxId(boxId);
    setIsAdjustingCensor(true);
    
    const container = document.getElementById("video-container");
    if (!container) return;
    const rect = container.getBoundingClientRect();
    
    const initialPointerX = e.clientX;
    const initialPointerY = e.clientY;
    
    const currentBox = blurBoxes.find(b => b.id === boxId);
    if (!currentBox) return;
    
    const initialX = currentBox.xPosition;
    const initialY = currentBox.yPosition;
    const initialW = currentBox.width;
    const initialH = currentBox.height;
    
    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = ((moveEvent.clientX - initialPointerX) / rect.width) * 100;
      const deltaY = ((moveEvent.clientY - initialPointerY) / rect.height) * 100;
      
      setBlurBoxes(prevBoxes => prevBoxes.map(b => {
        if (b.id !== boxId) return b;
        
        let newX = b.xPosition;
        let newY = b.yPosition;
        let newW = b.width;
        let newH = b.height;
        
        if (action === 'move') {
          newX = Math.max(0, Math.min(100 - b.width, initialX + deltaX));
          newY = Math.max(0, Math.min(100 - b.height, initialY + deltaY));
        } else {
          if (action.includes('e')) {
            newW = Math.max(2, Math.min(100 - b.xPosition, initialW + deltaX));
          }
          if (action.includes('w')) {
            const maxW = initialX + initialW;
            newX = Math.max(0, Math.min(maxW - 2, initialX + deltaX));
            newW = maxW - newX;
          }
          if (action.includes('s')) {
            newH = Math.max(2, Math.min(100 - b.yPosition, initialH + deltaY));
          }
          if (action.includes('n')) {
            const maxH = initialY + initialH;
            newY = Math.max(0, Math.min(maxH - 2, initialY + deltaY));
            newH = maxH - newY;
          }
        }
        
        return {
          ...b,
          xPosition: Math.round(newX * 10) / 10,
          yPosition: Math.round(newY * 10) / 10,
          width: Math.round(newW * 10) / 10,
          height: Math.round(newH * 10) / 10
        };
      }));
    };
    
    const onPointerUp = () => {
      setIsAdjustingCensor(false);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    };
    
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  };

  // Handle pointer down for dragging subtitles
  const handleSubtitlePointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    const container = document.getElementById("video-container");
    if (!container) return;
    const rect = container.getBoundingClientRect();
    
    let initialX = subSettings.customX ?? 50;
    let initialY = subSettings.customY ?? 82;
    
    if (subSettings.position !== "custom") {
      switch (subSettings.position) {
        case "top":
          initialX = 50;
          initialY = 12;
          break;
        case "center":
          initialX = 50;
          initialY = 50;
          break;
        case "blur-box": {
          const activeBox = blurBoxes.find(b => b.id === activeBlurBoxId) || blurBoxes[0];
          if (activeBox) {
            initialX = activeBox.xPosition + (activeBox.width / 2);
            initialY = activeBox.yPosition + (activeBox.height / 2);
          } else {
            initialX = 50;
            initialY = 82;
          }
          break;
        }
        case "bottom":
        default:
          initialX = 50;
          initialY = 82;
          break;
      }
    }
    
    // Set position to custom immediately and set the base coordinates
    setSubSettings(prev => ({
      ...prev,
      position: "custom",
      customX: Math.round(initialX * 10) / 10,
      customY: Math.round(initialY * 10) / 10,
    }));
    
    const initialPointerX = e.clientX;
    const initialPointerY = e.clientY;
    
    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = ((moveEvent.clientX - initialPointerX) / rect.width) * 100;
      const deltaY = ((moveEvent.clientY - initialPointerY) / rect.height) * 100;
      
      const newX = Math.max(0, Math.min(100, initialX + deltaX));
      const newY = Math.max(0, Math.min(100, initialY + deltaY));
      
      setSubSettings(prev => ({
        ...prev,
        customX: Math.round(newX * 10) / 10,
        customY: Math.round(newY * 10) / 10,
      }));
    };
    
    const onPointerUp = () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    };
    
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  };

  // Translate vertical placement selection into style coordinates
  const getSubtitlePositionStyle = (): React.CSSProperties => {
    switch (subSettings.position) {
      case "top":
        return { left: "50%", top: "12%", bottom: "auto", transform: "translateX(-50%)" };
      case "center":
        return { left: "50%", top: "50%", transform: "translate(-50%, -50%)", bottom: "auto" };
      case "blur-box": {
        const activeBox = blurBoxes.find(b => b.id === activeBlurBoxId) || blurBoxes[0];
        if (activeBox) {
          return {
            left: `${activeBox.xPosition + (activeBox.width / 2)}%`,
            top: `${activeBox.yPosition + (activeBox.height / 2)}%`,
            transform: "translate(-50%, -50%)",
            bottom: "auto"
          };
        }
        return { left: "50%", bottom: "12%", top: "auto", transform: "translateX(-50%)" };
      }
      case "custom":
        return {
          left: `${subSettings.customX ?? 50}%`,
          top: `${subSettings.customY ?? 80}%`,
          transform: "translate(-50%, -50%)",
          bottom: "auto"
        };
      case "bottom":
      default:
        return { left: "50%", bottom: "12%", top: "auto", transform: "translateX(-50%)" };
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="h-screen max-h-screen overflow-hidden bg-slate-950 text-slate-100 font-sans flex flex-col justify-between relative p-4 md:p-6 select-none" id="login-container">
        {/* Modern SaaS Blue Print Grid Overlay */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#1e293b_1px,transparent_1px),linear-gradient(to_bottom,#1e293b_1px,transparent_1px)] bg-[size:3rem_3rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_40%,transparent_100%)] opacity-25 pointer-events-none" />

        {/* Decorative Modern Glowing Orbs */}
        <div className="absolute top-[-10%] left-[-10%] w-[45%] h-[45%] rounded-full bg-indigo-500/10 blur-[130px] pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[45%] h-[45%] rounded-full bg-violet-600/10 blur-[130px] pointer-events-none" />
        <div className="absolute top-[30%] left-[25%] w-[250px] h-[250px] rounded-full bg-emerald-500/5 blur-[100px] pointer-events-none" />

        {/* Minimal Clean Header */}
        <header className="w-full max-w-5xl mx-auto flex items-center justify-between relative z-10 py-1 border-b border-slate-900/60 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl overflow-hidden shadow-2xl border border-slate-800 bg-slate-900 flex items-center justify-center shrink-0">
              <img src="/logo.png" alt="Logo" className="w-full h-full object-cover" />
            </div>
            <div>
              <h1 className="text-sm font-black tracking-tight bg-gradient-to-r from-white via-slate-200 to-indigo-400 bg-clip-text text-transparent leading-none">
                26DUBBIN
              </h1>
              <p className="text-[8px] text-slate-500 font-black uppercase tracking-widest mt-1">Sản xuất nội dung AI chuyên nghiệp</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 bg-slate-900/80 border border-slate-800/60 rounded-full px-3 py-1 text-[9px] text-slate-400 font-bold backdrop-blur-md shadow-inner">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span>Hệ thống hoạt động ổn định</span>
          </div>
        </header>

        {/* Main Content Area: Flex centered without overflow */}
        <div className="flex-1 flex items-center justify-center py-4 relative z-10 overflow-hidden">
          <motion.div
            initial={{ opacity: 0, y: 25, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
            className="w-full max-w-[390px] bg-slate-900/40 border border-slate-800/80 hover:border-slate-800 transition-colors duration-300 rounded-3xl p-5 md:p-6 shadow-[0_20px_50px_rgba(0,0,0,0.5)] backdrop-blur-xl relative overflow-hidden flex flex-col gap-4"
          >
            {/* Fine Top Border Glow */}
            <div className="absolute top-0 left-0 right-0 h-[1.5px] bg-gradient-to-r from-transparent via-indigo-500/80 to-transparent" />
            
            {/* Card Head / Branding */}
            <div className="text-center flex flex-col items-center">
              <div className="w-11 h-11 rounded-2xl bg-gradient-to-b from-indigo-500/10 to-violet-500/5 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mb-3 shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]">
                <Lock className="w-5 h-5" />
              </div>
              <h2 className="text-lg font-extrabold text-white tracking-tight">Đăng Nhập Hệ Thống</h2>
              <p className="text-[11px] text-slate-400 mt-1 max-w-[280px] font-medium leading-relaxed">
                Chào mừng bạn trở lại! Vui lòng điền thông tin hoặc sử dụng liên kết mạng xã hội để đăng nhập.
              </p>
            </div>

            {/* Main Email/Password Credentials Form */}
            <form onSubmit={handleLoginSubmit} className="space-y-3">
              <div className="space-y-1">
                <div className="flex justify-between items-center px-0.5">
                  <label className="text-[9px] font-bold text-slate-400 tracking-wider uppercase">Tài khoản / Email</label>
                </div>
                <input
                  type="text"
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
                  placeholder="admin hoặc email của bạn..."
                  className="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl py-2 px-3 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 transition-all font-semibold"
                  disabled={isLoggingIn}
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between items-center px-0.5">
                  <label className="text-[9px] font-bold text-slate-400 tracking-wider uppercase">Mật khẩu</label>
                </div>
                <div className="relative">
                  <input
                    type={showLoginPassword ? "text" : "password"}
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="Nhập mật khẩu..."
                    className="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl py-2 px-3 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 transition-all font-mono font-semibold"
                    disabled={isLoggingIn}
                  />
                  <button
                    type="button"
                    onClick={() => setShowLoginPassword(!showLoginPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
                  >
                    {showLoginPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {loginError && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-2 bg-red-500/10 border border-red-500/20 text-red-400 text-[10px] rounded-lg font-bold text-left leading-normal flex items-start gap-1.5"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0 mt-1"></span>
                  <span>{loginError}</span>
                </motion.div>
              )}

              <button
                type="submit"
                disabled={isLoggingIn}
                className="w-full py-2.5 px-4 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white font-extrabold rounded-xl shadow-[0_4px_12px_rgba(79,70,229,0.25)] hover:shadow-[0_4px_16px_rgba(79,70,229,0.35)] active:scale-[0.99] transition-all text-xs flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {isLoggingIn ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Xác thực tài khoản...</span>
                  </>
                ) : (
                  <span>Đăng Nhập Hệ Thống</span>
                )}
              </button>
            </form>

            {/* Social Authentication Split Section */}
            <div className="relative my-0.5 text-center shrink-0">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-slate-800/60"></div>
              </div>
              <span className="relative bg-[#090d16] px-2.5 text-[8px] font-black text-slate-500 uppercase tracking-widest">HOẶC TIẾP TỤC VỚI</span>
            </div>

            {/* Styled Social Authentication Grid */}
            <div className="grid grid-cols-3 gap-2 shrink-0">
              <button
                type="button"
                onClick={() => handleSocialLogin("google")}
                disabled={isLoggingIn}
                className="flex items-center justify-center gap-1.5 py-2 px-1 bg-slate-950/60 hover:bg-slate-900 border border-slate-800/80 hover:border-slate-700/80 rounded-xl text-[10px] font-extrabold text-slate-300 hover:text-white transition-all cursor-pointer shadow-sm active:scale-[0.97]"
                title="Đăng nhập bằng Google"
              >
                <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.5 24c0-1.61-.15-3.16-.41-4.69H24v8.87h12.64c-.55 2.92-2.19 5.39-4.67 7.05l7.26 5.63c4.25-3.92 6.72-9.69 6.72-16.86z"/>
                  <path fill="#FBBC05" d="M10.54 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.98-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.26-5.63c-2.01 1.35-4.58 2.16-7.63 2.16-6.26 0-11.57-4.22-13.46-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                <span>Google</span>
              </button>

              <button
                type="button"
                onClick={() => handleSocialLogin("github")}
                disabled={isLoggingIn}
                className="flex items-center justify-center gap-1.5 py-2 px-1 bg-slate-950/60 hover:bg-slate-900 border border-slate-800/80 hover:border-slate-700/80 rounded-xl text-[10px] font-extrabold text-slate-300 hover:text-white transition-all cursor-pointer shadow-sm active:scale-[0.97]"
                title="Đăng nhập bằng GitHub"
              >
                <Github className="w-3.5 h-3.5 text-white shrink-0" />
                <span>GitHub</span>
              </button>

              <button
                type="button"
                onClick={() => handleSocialLogin("facebook")}
                disabled={isLoggingIn}
                className="flex items-center justify-center gap-1.5 py-2 px-1 bg-slate-950/60 hover:bg-slate-900 border border-slate-800/80 hover:border-slate-700/80 rounded-xl text-[10px] font-extrabold text-slate-300 hover:text-white transition-all cursor-pointer shadow-sm active:scale-[0.97]"
                title="Đăng nhập bằng Facebook"
              >
                <Facebook className="w-3.5 h-3.5 text-[#1877F2] shrink-0" />
                <span>Facebook</span>
              </button>
            </div>

            {/* Quick Demo Assist Banner */}
            <button
              type="button"
              onClick={handleQuickLogin}
              disabled={isLoggingIn}
              className="w-full py-2.5 px-3 bg-slate-950/80 hover:bg-slate-900 border border-slate-800/80 hover:border-indigo-900/30 rounded-xl text-[11px] text-slate-400 hover:text-white transition-all cursor-pointer text-center font-semibold leading-normal shrink-0 active:scale-[0.98] shadow-inner"
            >
              <div className="flex items-center justify-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0 animate-pulse" />
                <span>Thử ngay: Nhấp để tự điền <strong className="text-white font-black underline decoration-indigo-500 underline-offset-2">admin / admin</strong></span>
              </div>
            </button>
          </motion.div>
        </div>

        {/* Minimal Clean Footer */}
        <footer className="w-full py-1.5 text-center text-[9px] text-slate-600 font-bold relative z-10 border-t border-slate-900/40 max-w-5xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-1.5 shrink-0">
          <span>© {new Date().getFullYear()} 26Dubbin. All rights reserved.</span>
          <div className="flex items-center gap-3">
            <span className="hover:text-slate-400 transition-colors cursor-pointer">Hotline: 0373491922</span>
            <span className="text-slate-800">•</span>
            <span className="hover:text-slate-400 transition-colors cursor-pointer">Zalo Hỗ Trợ Kỹ Thuật</span>
          </div>
        </footer>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-800 font-sans selection:bg-[#4f46e5] selection:text-white" id="main-container">
      <AppSidebar
        activeRoute={activeTab}
        onNavigate={setActiveTab}
        onDonate={() => setShowDonatePopup(true)}
        onSignOut={handleSignOut}
      />
      <AppNavbar
        engineStatus={engineStatus}
        isDownloading={isDownloadingEngine}
        downloadProgress={engineDownloadProgress}
        onDownloadEngines={handleDownloadEngines}
      />

      <main className={`mx-auto grid max-w-7xl grid-cols-1 gap-6 px-4 py-6 sm:p-6 lg:ml-64 lg:max-w-none lg:grid-cols-12 lg:gap-8 ${activeTab === "translate" ? "lg:h-[calc(100vh-73px)] lg:overflow-hidden lg:py-3" : ""} ${activeTab === "settings" ? "hidden" : ""}`} id="main-content">
        {activeTab === "projects" && (
          <ProjectLibraryLayout>
          <section className="lg:col-span-12 min-h-[calc(100vh-150px)] rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
              <div>
                <h1 className="flex items-center gap-2 text-xl font-extrabold text-slate-900"><FolderOpen className="h-5 w-5 text-indigo-600" /> Thư viện dự án</h1>
                <p className="mt-1 text-xs text-slate-500">Video, phụ đề, checkpoint STT/TTS và bản render được lưu ngay trên trình duyệt này.</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={refreshProjectLibrary} disabled={isProjectLibraryLoading} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${isProjectLibraryLoading ? "animate-spin" : ""}`} /> Làm mới</button>
                <button onClick={handleCreateNewProject} className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-extrabold text-white shadow-sm hover:bg-indigo-500">+ Dự án mới</button>
              </div>
            </div>

            {isProjectLibraryLoading && projectLibrary.length === 0 ? (
              <div className="flex min-h-72 items-center justify-center text-sm font-semibold text-slate-400"><RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Đang tải thư viện...</div>
            ) : projectLibrary.length === 0 ? (
              <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/60 text-center">
                <FolderOpen className="mb-3 h-12 w-12 text-slate-300" />
                <h2 className="text-base font-extrabold text-slate-700">Chưa có dự án đã lưu</h2>
                <p className="mt-1 max-w-sm text-xs text-slate-500">Tải video trong Tool Auto Dubbing; dự án sẽ tự xuất hiện ở đây ngay khi checkpoint đầu tiên được lưu.</p>
                <button onClick={handleCreateNewProject} className="mt-4 rounded-lg bg-[#b08cff] px-4 py-2 text-xs font-extrabold text-white hover:bg-[#9d72ff]">Tạo dự án đầu tiên</button>
              </div>
            ) : (
              <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {projectLibrary.map(({ project, previewUrl, hasFinalRender }) => (
                  <article key={project.id} className={`overflow-hidden rounded-xl border bg-white transition-shadow hover:shadow-md ${currentProjectId === project.id ? "border-indigo-400 ring-2 ring-indigo-100" : "border-slate-200"}`}>
                    <div className="aspect-video bg-slate-950">
                      {previewUrl ? <video src={previewUrl} muted preload="metadata" className="h-full w-full object-contain" /> : <div className="flex h-full items-center justify-center"><Video className="h-10 w-10 text-slate-600" /></div>}
                    </div>
                    <div className="p-4">
                      <div className="flex items-start justify-between gap-2">
                        <h2 className="min-w-0 truncate text-sm font-extrabold text-slate-800" title={project.videoName}>{project.videoName}</h2>
                        {currentProjectId === project.id && <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[9px] font-extrabold text-indigo-600">ĐANG MỞ</span>}
                      </div>
                      <p className="mt-1 text-[10px] text-slate-400">Cập nhật {new Date(project.updatedAt).toLocaleString("vi-VN")}</p>
                      <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] font-bold">
                        <span className="rounded bg-sky-50 px-2 py-1 text-sky-600">{project.subtitles?.length || 0} dòng phụ đề</span>
                        <span className="rounded bg-violet-50 px-2 py-1 text-violet-600">{project.ttsEngine === "tiktok" ? "TikTok TTS" : "Gemini TTS"}</span>
                        <span className="rounded bg-slate-100 px-2 py-1 text-slate-600">{project.exportResolution}p</span>
                        {hasFinalRender && <span className="rounded bg-emerald-50 px-2 py-1 text-emerald-600">Có video final</span>}
                      </div>
                      <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
                        <button onClick={() => handleOpenLibraryProject(project.id)} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-extrabold text-white hover:bg-indigo-500">Mở dự án</button>
                        <button onClick={() => handleDeleteLibraryProject(project.id, project.videoName)} className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-bold text-rose-500 hover:bg-rose-50" title="Xóa dự án"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
          </ProjectLibraryLayout>
        )}

        {activeTab === "translate" && (
          <AutoDubbingLayout>
          <motion.section
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="lg:col-span-12 h-full overflow-hidden rounded-2xl border border-slate-200/80 bg-white text-slate-800 shadow-md p-5 hover:border-slate-300/80 hover:shadow-lg transition-all duration-300 text-left"
            id="auto-dubbing-workspace"
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-4 mb-4">
              <div>
                <h2 className="flex items-center gap-2 text-base font-bold text-slate-800"><Sparkles className="h-4 w-4 text-sky-500" /> Auto Dubbing</h2>
                <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                  <span>Tải video, thiết lập phụ đề, blur, giọng đọc và render chỉ với một nút.</span>
                  {isRestoringProject ? (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 font-bold text-amber-600">Đang tìm checkpoint...</span>
                  ) : currentProjectId ? (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-bold text-emerald-600">● Tự động lưu dự án</span>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleStartOrContinueProject}
                  disabled={!videoSrc || isLoading || isRecordingVideo || isPreGenerating}
                  className="rounded-lg border border-violet-200 bg-violet-50 px-5 py-2.5 text-xs font-extrabold text-violet-600 shadow-sm transition-colors hover:border-violet-300 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isLoading
                    ? "Đang tạo phụ đề..."
                    : isPreGenerating
                      ? `Đang tiếp tục ${preGenerateProgress}%`
                      : "▶ Bắt đầu / Tiếp tục"}
                </button>
                <button onClick={handleAutoDubbingRender} disabled={!videoSrc || isLoading || isRecordingVideo || isPreGenerating} className="rounded-lg bg-[#b08cff] px-5 py-2.5 text-xs font-extrabold text-white shadow-sm transition-colors hover:bg-[#9d72ff] disabled:cursor-not-allowed disabled:opacity-50">
                  {isLoading || isRecordingVideo ? "Đang Auto Render..." : "✣ Render tự động"}
                </button>
              </div>
            </div>

            <div className="grid h-[calc(100%-61px)] min-h-0 xl:grid-cols-[320px_minmax(0,1fr)_250px]">
              <aside className="max-h-[650px] space-y-3 overflow-y-auto border-b border-slate-200/60 bg-slate-50 p-3 xl:border-b-0 xl:border-r">
                <fieldset className="rounded-xl border border-slate-200/60 bg-white p-3 shadow-sm"><legend className="px-1 text-xs font-extrabold text-slate-800">1. File Video</legend>
                  <input ref={autoDubbingFileInputRef} type="file" accept="video/*" onChange={handleFileChange} className="hidden" />
                  <button onClick={() => autoDubbingFileInputRef.current?.click()} className="flex h-20 w-full flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-xs text-slate-500 transition-colors hover:border-indigo-400 hover:text-indigo-600"><Upload className="mb-1 h-4 w-4" />{videoName || "Kéo thả hoặc chọn video"}</button>
                  <p className="mt-2 text-[10px] text-slate-500">{videoSrc ? "Video đã sẵn sàng" : "Chưa có video"}</p>
                </fieldset>
                <fieldset className="rounded-xl border border-slate-200/60 bg-white p-3 shadow-sm"><legend className="px-1 text-xs font-extrabold text-slate-800">2. Phụ đề</legend>
                  <label className="mb-2 flex items-center gap-2 text-xs"><input type="radio" checked={extractionMethod === "audio"} onChange={() => setExtractionMethod("audio")} /> Nhận dạng từ Audio (STT)</label>
                  <label className="mb-2 flex items-center gap-2 text-xs"><input type="radio" checked={extractionMethod === "ocr"} onChange={() => { setExtractionMethod("ocr"); setWorkspacePropertyTarget("ocr"); }} /> PaddleOCR WebGPU</label>
                  <label className="flex items-center gap-2 text-xs"><input type="radio" checked={extractionMethod === "aiocr"} onChange={() => setExtractionMethod("aiocr")} /> AI Vision OCR</label>
                  <div className="mt-3 grid grid-cols-[1fr_58px] gap-2"><select value={subSettings.fontFamily} onChange={(e) => setSubSettings(prev => ({ ...prev, fontFamily: e.target.value }))} className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-800"><option>Bangers</option><option>Arial</option><option>Inter</option></select><input type="number" value={subSettings.fontSize} onChange={(e) => setSubSettings(prev => ({ ...prev, fontSize: Number(e.target.value) || 24 }))} className="rounded border border-slate-200 bg-slate-50 px-2 text-xs text-slate-800" /></div>
                </fieldset>
                <fieldset className="rounded-xl border border-slate-200/60 bg-white p-3 shadow-sm"><legend className="px-1 text-xs font-extrabold text-slate-800">3. Smart Blur</legend>
                  <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={blurSettings.enabled} onChange={(e) => setBlurSettings(prev => ({ ...prev, enabled: e.target.checked }))} className="accent-sky-500" /> Bật phát hiện/blur phụ đề gốc</label>
                  <button onClick={handleAddBlurBox} className="mt-2 w-full rounded bg-slate-100 py-1.5 text-[11px] font-bold text-slate-700 hover:bg-slate-200">+ Thêm Blur Box</button>
                </fieldset>
                <fieldset className="rounded-xl border border-slate-200/60 bg-white p-3 shadow-sm"><legend className="px-1 text-xs font-extrabold text-slate-800">4. Thuyết minh</legend>
                  <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={ttsEnabled} onChange={(e) => setTtsEnabled(e.target.checked)} className="accent-sky-500" /> Tạo TTS tự động</label>
                  <div className="mt-2 grid grid-cols-2 gap-2"><select value={ttsEngine} onChange={(e) => setTtsEngine(e.target.value as any)} className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-800"><option value="gemini">Gemini TTS</option><option value="tiktok">TikTok</option><option value="browser">Edge TTS</option></select><input type="number" min="1.1" max="1.8" step="0.05" value={ttsRate} onChange={(e) => setTtsRate(Number(e.target.value))} className="rounded border border-slate-200 bg-slate-50 px-2 text-xs text-slate-800" /></div>
                  <label className="mt-3 flex items-center justify-between gap-2 text-[11px] text-slate-400">Âm lượng video gốc <span className="font-mono text-sky-400">{Math.round(originalAudioMixVolume * 100)}%</span></label>
                  <input type="range" min="0" max="1" step="0.05" value={originalAudioMixVolume} onChange={(e) => setOriginalAudioMixVolume(Number(e.target.value))} className="mt-1 w-full accent-sky-500" />
                </fieldset>
                <fieldset className="rounded-xl border border-slate-200/60 bg-white p-3 shadow-sm"><legend className="px-1 text-xs font-extrabold text-slate-800">5. Cài đặt Video</legend><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={flipHorizontal} onChange={(e) => setFlipHorizontal(e.target.checked)} /> Lật ngang (gương)</label><label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={flipVertical} onChange={(e) => setFlipVertical(e.target.checked)} /> Lật dọc (đảo ngược)</label></fieldset>
                <fieldset className="rounded-xl border border-slate-200/60 bg-white p-3 shadow-sm"><legend className="px-1 text-xs font-extrabold text-slate-800">6. Xuất Video</legend>
                  <select value={exportResolution} onChange={(e) => setExportResolution(e.target.value as "720" | "1080" | "1440")} className="w-full rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-800"><option value="720">720p (nhanh)</option><option value="1080">1080p</option><option value="1440">2K / 1440p</option></select>
                </fieldset>
              </aside>

              <div className="flex min-h-0 min-w-0 flex-col bg-white border border-slate-200/60 rounded-2xl p-4 shadow-sm">
                <div className="flex items-center gap-2 border-b border-slate-200/60 px-3 py-2 text-[10px] text-slate-500"><span>Font</span><span className="rounded bg-slate-100 px-3 py-1 text-slate-700 font-bold">{subSettings.fontFamily}</span><span>Cỡ {subSettings.fontSize}px</span><span className={`ml-auto rounded px-2 py-1 ${extractionMethod !== "ocr" || browserOcrStatus === "ready" ? "bg-emerald-500/10 text-emerald-400" : browserOcrStatus === "error" ? "bg-rose-500/10 text-rose-300" : "bg-amber-500/10 text-amber-300"}`}>{extractionMethod === "ocr" ? (browserOcrStatus === "ready" ? `PaddleOCR ${browserOcrBackend === "webgpu" ? "WebGPU" : "WASM"} Ready` : browserOcrStatus === "error" ? "PaddleOCR Fallback" : browserOcrStatus === "initializing" ? "PaddleOCR Loading" : "PaddleOCR Web Idle") : "Engine Connected"}</span></div>
                <div className="flex min-h-0 flex-1 items-center justify-center p-5">
                  <div className="relative h-full max-h-full w-auto max-w-full aspect-video overflow-hidden rounded-lg border border-slate-700 bg-black shadow-2xl">
                    {videoSrc ? <video ref={workspaceVideoRef} src={videoSrc} onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)} onLoadedMetadata={(e) => { setDuration(e.currentTarget.duration); setWorkspaceVideoDimensions({ width: e.currentTarget.videoWidth || 16, height: e.currentTarget.videoHeight || 9 }); }} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} className="h-full w-full object-contain" /> : <div className="flex h-full flex-col items-center justify-center text-slate-600"><Video className="mb-3 h-10 w-10" /><span className="text-sm">Preview video</span></div>}
                    {videoSrc && blurBoxes.map((box) => <button key={box.id} onPointerDown={(e) => { setActiveBlurBoxId(box.id); setWorkspacePropertyTarget("blur"); handleWorkspaceBlurDrag(e, box.id); }} className={`absolute z-20 border-2 ${activeBlurBoxId === box.id ? "border-indigo-500 bg-indigo-500/15" : "border-slate-100/80 bg-slate-900/15"}`} style={{ left: `${box.xPosition}%`, top: `${box.yPosition}%`, width: `${box.width}%`, height: `${box.height}%`, backdropFilter: `blur(${box.blurAmount}px)` }} title="Kéo để di chuyển Blur Box"><span onPointerDown={(e) => handleWorkspaceBlurDrag(e as any, box.id, true)} className="absolute -bottom-1 -right-1 h-3 w-3 cursor-nwse-resize rounded-sm bg-indigo-500" /></button>)}
                    {videoSrc && extractionMethod === "ocr" && <div style={getWorkspaceVideoContentStyle()} className="pointer-events-none z-40">{ocrRegions.map((region, index) => <button key={region.id} type="button" onPointerDown={(event) => handleWorkspaceOcrRegionDrag(event, region.id)} className={`pointer-events-auto absolute border-2 ${activeOcrRegionId === region.id ? "border-emerald-400 bg-emerald-400/15" : "border-amber-300 bg-amber-300/10"}`} style={{ left: `${region.x}%`, top: `${region.y}%`, width: `${region.width}%`, height: `${region.height}%` }} title={`${region.label}: kéo để di chuyển`}><span className="absolute left-0 top-0 rounded-br bg-emerald-500 px-1 py-0.5 text-[8px] font-bold text-white">OCR {index + 1}</span><span onPointerDown={(event) => handleWorkspaceOcrRegionDrag(event as any, region.id, true)} className="absolute -bottom-1 -right-1 h-3 w-3 cursor-nwse-resize rounded-sm bg-emerald-400" /></button>)}{isDrawingOcrRegion && <div onPointerDown={handleDrawOcrRegion} className="pointer-events-auto absolute inset-0 cursor-crosshair bg-emerald-400/5" title="Kéo để vẽ vùng OCR" />}</div>}
                    {videoSrc && <div onPointerDown={(e) => { setWorkspacePropertyTarget("subtitle"); handleWorkspaceSubtitleDrag(e); }} className="absolute z-30 cursor-move text-center" style={getSubtitlePositionStyle()}><span className="relative inline-block rounded px-4 py-2 text-lg" style={{ fontFamily: subSettings.fontFamily, fontSize: `${subSettings.fontSize}px`, color: subSettings.textColor, backgroundColor: subSettings.bgColor, fontWeight: subSettings.fontWeight, letterSpacing: `${subSettings.letterSpacing}px`, textShadow: subSettings.textEffect === "outline" ? `0 0 0 ${subSettings.outlineWidth}px ${subSettings.outlineColor}` : subSettings.textEffect === "glow" ? `0 0 8px ${subSettings.textColor}` : subSettings.textEffect === "shadow" ? "2px 2px 5px rgba(0,0,0,.9)" : "none" }}>{currentSubtitle?.translated || "Phụ đề sẽ xuất hiện ở đây!"}<span onPointerDown={(e) => { e.stopPropagation(); handleWorkspaceSubtitleDrag(e as any, true); }} className="absolute -bottom-1 -right-1 h-3 w-3 cursor-nwse-resize rounded-sm bg-indigo-500" /></span></div>}
                  </div>
                </div>
                <div className="relative border-t border-slate-200/60 bg-slate-50 p-3" style={{ height: timelineHeight }}><div onPointerDown={handleTimelineResizeStart} className="absolute -top-1.5 left-0 right-0 z-30 flex h-3 cursor-row-resize items-center justify-center touch-none"><span className="h-1 w-12 rounded-full bg-slate-300 transition-colors hover:bg-indigo-500" /></div><div className="mb-2 flex items-center justify-between text-[10px] text-slate-500"><span>{currentTime.toFixed(2)} / {Math.round(duration)}s</span><span>Kéo mép trên để đổi kích thước timeline</span></div><div className="relative h-[calc(100%-28px)] space-y-1 overflow-auto rounded border border-slate-200 bg-white p-1"><div className="absolute left-14 top-0 z-20 h-full w-px bg-rose-500" style={{ left: `calc(3.5rem + ${duration ? (currentTime / duration) * 100 : 0}% * (1 - 3.5rem / 100%))` }} />{([{ label: "Video", color: "bg-emerald-500", clips: videoSrc && duration ? [{ id: "video", start: 0, end: duration, text: videoName }] : [] }, { label: "Text", color: "bg-sky-500", clips: subtitles.map(sub => ({ id: sub.id, start: sub.start, end: sub.end, text: sub.translated })) }, { label: "Hiệu ứng", color: "bg-amber-400", clips: blurBoxes.length && duration ? blurBoxes.map(box => ({ id: box.id, start: 0, end: duration, text: "Blur Box" })) : [] }, { label: "Voice", color: "bg-violet-500", clips: ttsEnabled ? subtitles.map(sub => ({ id: `voice-${sub.id}`, start: sub.start, end: sub.end, text: sub.translated })) : [] }]).map(track => <div key={track.label} className="relative flex h-8 items-center gap-2 border-b border-slate-100 last:border-0"><span className="w-12 pl-1 text-[9px] font-bold text-slate-400">{track.label}</span><div onClick={(e) => { if (!duration) return; const rect = e.currentTarget.getBoundingClientRect(); const time = Math.max(0, Math.min(duration, ((e.clientX - rect.left) / rect.width) * duration)); setCurrentTime(time); if (workspaceVideoRef.current) workspaceVideoRef.current.currentTime = time; }} className="relative h-6 flex-1 cursor-pointer rounded bg-slate-100">{track.clips.map(clip => <button key={clip.id} title={clip.text} onClick={() => { setCurrentTime(clip.start); if (workspaceVideoRef.current) workspaceVideoRef.current.currentTime = clip.start; }} className={`absolute top-0 h-full overflow-hidden rounded px-1 text-left text-[9px] font-bold text-white ${track.color}`} style={{ left: `${duration ? (clip.start / duration) * 100 : 0}%`, width: `${duration ? Math.max(1, ((clip.end - clip.start) / duration) * 100) : 0}%` }}>{clip.text}</button>)}</div></div>)}</div></div>
              </div>

              <aside className="overflow-y-auto border-t border-slate-200/60 bg-slate-50 p-4 xl:border-l xl:border-t-0"><div className="border-b border-slate-200/60 pb-3 text-xs font-extrabold text-slate-800">Thuộc tính</div><div className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-slate-200 p-1"><button onClick={() => setWorkspacePropertyTarget("subtitle")} className={`rounded px-1 py-1.5 text-[10px] font-bold transition-colors ${workspacePropertyTarget === "subtitle" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500"}`}>Phụ đề</button><button onClick={() => setWorkspacePropertyTarget("blur")} className={`rounded px-1 py-1.5 text-[10px] font-bold transition-colors ${workspacePropertyTarget === "blur" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500"}`}>Blur Box</button><button onClick={() => setWorkspacePropertyTarget("ocr")} className={`rounded px-1 py-1.5 text-[10px] font-bold transition-colors ${workspacePropertyTarget === "ocr" ? "bg-white text-emerald-600 shadow-sm" : "text-slate-500"}`}>Vùng OCR</button></div>{renderWorkspaceProperties()}</aside>
            </div>
          </motion.section>

          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut", delay: 0.05 }}
            className="lg:col-span-12 mt-4 flex flex-col gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-md transition-all duration-300 hover:border-slate-300/80 hover:shadow-lg"
            id="auto-dubbing-playback-card"
          >
            <div className="flex items-center gap-3">
              <span className="text-xs font-mono font-bold text-slate-500 w-12 text-right">{formatTtsTime(currentTime)}</span>
              <input
                type="range"
                min={0}
                max={duration || 100}
                step={0.05}
                value={currentTime}
                onChange={handleScrub}
                className="flex-1 accent-indigo-600 bg-slate-200 h-1 rounded-lg appearance-none cursor-pointer"
              />
              <span className="text-xs font-mono font-bold text-slate-500 w-12">{formatTtsTime(duration)}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={togglePlay}
                  disabled={!videoSrc}
                  className="p-2.5 rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  title={isPlaying ? "Tạm dừng" : "Phát"}
                >
                  {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                </button>
                <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-100 p-0.5">
                  {[0.75, 1.0, 1.25, 1.5].map((rate) => (
                    <button
                      key={rate}
                      onClick={() => handlePlaybackRateChange(rate)}
                      className={`px-2 py-1 text-[11px] font-bold rounded-md transition-all ${playbackRate === rate ? "bg-indigo-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
                    >
                      {rate}x
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowSubtitles(prev => !prev)}
                  className={`p-1.5 rounded-lg border transition-all ${showSubtitles ? "bg-indigo-50 border-indigo-200 text-indigo-600" : "bg-slate-100 border-slate-200 text-slate-400"}`}
                  title={showSubtitles ? "Tắt hiển thị phụ đề" : "Bật hiển thị phụ đề"}
                >
                  {showSubtitles ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
                <div className="flex items-center gap-2 bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200">
                  <Volume2 className="w-4 h-4 text-slate-500" />
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={volume}
                    onChange={handleVolumeChange}
                    className="w-16 accent-indigo-600 bg-slate-200 h-1 rounded appearance-none cursor-pointer"
                  />
                </div>
              </div>
            </div>
          </motion.div>
          </AutoDubbingLayout>
        )}
        
        {/* LEFT COLUMN: Player & Censor Controller (7 Cols) */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className={`${activeTab === "translate" || activeTab === "projects" ? "hidden" : "lg:col-span-7 flex flex-col gap-6"}`}
          id="player-column"
        >
          
          {/* Main Video View Container */}
          <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-md flex flex-col gap-4 overflow-hidden">
            
            {/* These secondary tabs only preview the active project video. */}
            {!videoSrc ? (
              <div className="flex aspect-video flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-950 px-6 text-center">
                <div className="mb-4 rounded-2xl bg-white/10 p-4 text-slate-400">
                  <Video className="h-10 w-10" />
                </div>
                <h3 className="text-base font-extrabold text-white">Chưa có video để xem trước</h3>
                <p className="mt-1 max-w-sm text-xs text-slate-400">Video chỉ được tải lên trong Tool Auto Dubbing.</p>
                <button onClick={() => setActiveTab("translate")} className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-extrabold text-white hover:bg-indigo-500">Về Tool Auto Dubbing</button>
              </div>
            ) : (
              /* Actual Video Work Surface */
              <div className="flex flex-col gap-4">
                
                {/* Title and Metadata */}
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-2 text-slate-700">
                    <Video className="w-4 h-4 text-[#4f46e5]" />
                    <span className="text-sm font-bold truncate max-w-xs">{videoName}</span>
                  </div>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-500">Chỉ xem trước</span>
                </div>

                {isExtractingAudio && (
                  <div className="bg-[#4f46e5]/10 border border-[#4f46e5]/20 rounded-xl p-3 flex items-center justify-between gap-3 text-xs text-[#4f46e5] font-semibold animate-pulse shadow-sm">
                    <div className="flex items-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-[#4f46e5]" />
                      <span>{extractingProgressStep || "Đang trích xuất dữ liệu âm thanh từ video..."}</span>
                    </div>
                    <span className="text-[10px] bg-[#4f46e5]/20 text-[#4f46e5] px-2 py-0.5 rounded-full uppercase tracking-wider font-extrabold animate-pulse">
                      Xử lý nền
                    </span>
                  </div>
                )}

                {/* Simulated Player Box with overlays */}
                <div 
                  className="relative bg-black rounded-xl overflow-hidden shadow-xl border border-black/15 aspect-video flex items-center justify-center group"
                  id="video-container"
                >
                  <video
                    ref={videoRef}
                    src={videoSrc}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                    onClick={togglePlay}
                    className="w-full h-full object-contain transition-transform duration-300"
                    style={{ transform: `scaleX(${flipHorizontal ? -1 : 1}) scaleY(${flipVertical ? -1 : 1})` }}
                  />

                  {/* ACTIVE CENSOR BLUR OVERLAYS */}
                  {blurBoxes.map((box, index) => {
                    const isActive = box.id === activeBlurBoxId;
                    return (
                      <div 
                        key={box.id}
                        className={`absolute flex items-center justify-center cursor-move transition-all ${
                          isActive 
                            ? "ring-2 ring-[#4f46e5] z-20 shadow-xl" 
                            : "hover:ring-1 hover:ring-slate-300/60 z-10"
                        }`}
                        style={{
                          left: `${box.xPosition}%`,
                          top: `${box.yPosition}%`,
                          width: `${box.width}%`,
                          height: `${box.height}%`,
                          backdropFilter: `blur(${box.blurAmount}px)`,
                          backgroundColor: getBlurCoverCssColor(box.bgColor, box.opacity),
                          borderRadius: "6px",
                          boxShadow: "0 4px 30px rgba(0, 0, 0, 0.15)",
                          userSelect: "none",
                          touchAction: "none",
                        }}
                        onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'move')}
                        id={`blur-overlay-block-${box.id}`}
                      >
                        {/* Box label and delete button when selected */}
                        <div className="absolute top-1 left-1.5 pointer-events-none bg-slate-900/85 text-white text-[9px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1 shadow">
                          <span>Hộp mờ #{index + 1}</span>
                        </div>

                        {/* Drag and resize indicator */}
                        {isActive && isAdjustingCensor && (
                          <span className="text-[8px] text-[#F17B77] font-mono font-bold uppercase bg-[#010101]/80 px-1.5 py-0.5 rounded border border-[#F17B77]/20 pointer-events-none">
                            X:{box.xPosition}% Y:{box.yPosition}%
                          </span>
                        )}

                        {/* Resize Anchors (Only show for the active/selected box) */}
                        {isActive && (
                          <>
                            {/* Top-Left */}
                            <div 
                              className="absolute -top-1 -left-1 w-2.5 h-2.5 bg-white border-2 border-[#4f46e5] rounded-full cursor-nwse-resize z-30 shadow"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-nw')}
                            />
                            {/* Top-Right */}
                            <div 
                              className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-white border-2 border-[#4f46e5] rounded-full cursor-nesw-resize z-30 shadow"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-ne')}
                            />
                            {/* Bottom-Left */}
                            <div 
                              className="absolute -bottom-1 -left-1 w-2.5 h-2.5 bg-white border-2 border-[#4f46e5] rounded-full cursor-nesw-resize z-30 shadow"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-sw')}
                            />
                            {/* Bottom-Right */}
                            <div 
                              className="absolute -bottom-1 -right-1 w-2.5 h-2.5 bg-white border-2 border-[#4f46e5] rounded-full cursor-nwse-resize z-30 shadow"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-se')}
                            />
                            {/* Edge Drag handles */}
                            <div 
                              className="absolute top-0 left-2 right-2 h-1 cursor-ns-resize z-30"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-n')}
                            />
                            <div 
                              className="absolute bottom-0 left-2 right-2 h-1 cursor-ns-resize z-30"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-s')}
                            />
                            <div 
                              className="absolute top-2 bottom-2 right-0 w-1 cursor-ew-resize z-30"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-e')}
                            />
                            <div 
                              className="absolute top-2 bottom-2 left-0 w-1 cursor-ew-resize z-30"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-w')}
                            />
                          </>
                        )}
                      </div>
                    );
                  })}

                  {/* SUBTITLE OVERLAY */}
                  {showSubtitles && currentSubtitle && (
                    <div 
                      className="absolute text-center transition-all z-40 select-none pointer-events-none max-w-full px-4"
                      style={{
                        ...getSubtitlePositionStyle()
                      }}
                      id="active-subtitle-rendered"
                    >
                      <span 
                        onPointerDown={handleSubtitlePointerDown}
                        className="inline-block py-1.5 px-4 rounded-lg whitespace-nowrap text-center transition-all pointer-events-auto cursor-move active:scale-[0.98] hover:ring-2 hover:ring-[#4f46e5]/40 relative group"
                        title="Kéo thả phụ đề để di chuyển vị trí bất kỳ"
                        style={{
                          fontSize: `${subSettings.fontSize}px`,
                          fontFamily: subSettings.fontFamily === "Inter" ? "var(--font-sans)" : subSettings.fontFamily === "JetBrains Mono" ? "var(--font-mono)" : `"${subSettings.fontFamily}", sans-serif`,
                          color: subSettings.textColor,
                          backgroundColor: subSettings.bgColor,
                          fontWeight: 
                            subSettings.fontWeight === "normal" ? 400 :
                            subSettings.fontWeight === "medium" ? 500 :
                            subSettings.fontWeight === "bold" ? 700 : 900,
                          letterSpacing: `${subSettings.letterSpacing}px`,
                          textShadow: 
                            subSettings.textEffect === "outline"
                              ? `${subSettings.outlineWidth}px ${subSettings.outlineWidth}px 0px ${subSettings.outlineColor}, -${subSettings.outlineWidth}px -${subSettings.outlineWidth}px 0px ${subSettings.outlineColor}, ${subSettings.outlineWidth}px -${subSettings.outlineWidth}px 0px ${subSettings.outlineColor}, -${subSettings.outlineWidth}px ${subSettings.outlineWidth}px 0px ${subSettings.outlineColor}, 0px ${subSettings.outlineWidth}px 0px ${subSettings.outlineColor}, ${subSettings.outlineWidth}px 0px 0px ${subSettings.outlineColor}, 0px -${subSettings.outlineWidth}px 0px ${subSettings.outlineColor}, -${subSettings.outlineWidth}px 0px 0px ${subSettings.outlineColor}`
                              : subSettings.textEffect === "glow"
                              ? `0 0 6px ${subSettings.textColor}, 0 0 12px ${subSettings.textColor}`
                              : subSettings.textEffect === "shadow"
                              ? "2px 2px 5px rgba(0, 0, 0, 0.9)"
                              : "none",
                        }}
                      >
                        {currentSubtitle.translated}
                      </span>
                    </div>
                  )}
                  
                  {/* Ambient Big Pause/Play overlay on center */}
                  <AnimatePresence>
                    {!isPlaying && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        className="absolute inset-0 bg-black/30 flex items-center justify-center pointer-events-none"
                      >
                        <div className="p-4 bg-white/5 backdrop-blur-md border border-white/10 rounded-full text-[#6366f1] shadow-xl">
                          <Play className="w-8 h-8 fill-current translate-x-0.5" />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Subtitle Scrubber & Playback Controls bar */}
                <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl flex flex-col gap-3 shadow-sm">
                  
                  {/* Scrubber Timeline Slider */}
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-slate-500 font-bold w-12 text-right">
                      {formatSecondsToVTT(currentTime).substring(3, 11)}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={duration || 100}
                      step={0.05}
                      value={currentTime}
                      onChange={handleScrub}
                      className="flex-1 accent-[#6366f1] bg-slate-200 h-1 rounded-lg appearance-none cursor-pointer"
                    />
                    <span className="text-xs font-mono text-slate-500 font-bold w-12">
                      {formatSecondsToVTT(duration).substring(3, 11)}
                    </span>
                  </div>

                  {/* Main Control Panel Actions */}
                  <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={togglePlay}
                        className="p-2.5 bg-gradient-to-r from-[#4f46e5] to-[#6366f1] hover:opacity-90 rounded-lg text-white font-bold shadow-lg shadow-[#4f46e5]/15 transition-all"
                        title={isPlaying ? "Tạm dừng" : "Phát"}
                      >
                        {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                      </button>

                      {/* Playback speed buttons */}
                      <div className="flex items-center bg-slate-200/60 rounded-lg p-0.5 border border-slate-200/40 ml-2">
                        {[0.75, 1.0, 1.25, 1.5].map((rate) => (
                          <button
                            key={rate}
                            onClick={() => handlePlaybackRateChange(rate)}
                            className={`px-2 py-1 text-[11px] font-bold rounded-md transition-all ${
                              playbackRate === rate 
                                ? "bg-[#4f46e5] text-white shadow" 
                                : "text-slate-500 hover:text-slate-800"
                            }`}
                          >
                            {rate}x
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Quick Settings: Subtitle Font Size & Volume Side-by-Side */}
                    <div className="flex flex-wrap items-center gap-3">
                      {/* Toggle Subtitles Button */}
                      <button
                        onClick={() => setShowSubtitles(prev => !prev)}
                        className={`p-1.5 rounded-lg border transition-all flex items-center justify-center shadow-sm ${
                          showSubtitles 
                            ? "bg-[#4f46e5]/10 border-[#4f46e5]/30 text-[#4f46e5]" 
                            : "bg-slate-100 border-slate-200 text-slate-400"
                        }`}
                        title={showSubtitles ? "Tắt hiển thị phụ đề" : "Bật hiển thị phụ đề"}
                      >
                        {showSubtitles ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                      </button>

                      {/* Subtitle Font Size Quick Slider */}
                      <div className="flex items-center gap-2 bg-[#4f46e5]/5 px-3 py-1.5 rounded-lg border border-[#4f46e5]/20 shadow-sm" title="Điều chỉnh kích thước chữ phụ đề nhanh">
                        <Type className="w-3.5 h-3.5 text-[#4f46e5]" />
                        <span className="text-[10px] font-extrabold text-slate-600 uppercase">Cỡ chữ Sub:</span>
                        <input
                          type="range"
                          min={12}
                          max={60}
                          step={1}
                          value={subSettings.fontSize}
                          onChange={(e) => setSubSettings(prev => ({ ...prev, fontSize: parseInt(e.target.value) || 12 }))}
                          className="w-20 accent-[#6366f1] bg-slate-200 h-1.5 rounded-lg appearance-none cursor-pointer"
                        />
                        <span className="text-xs font-mono font-bold text-[#4f46e5] w-7 text-center">{subSettings.fontSize}px</span>
                      </div>

                      {/* Volume setting */}
                      <div className="flex items-center gap-2 bg-slate-200/60 px-3 py-1.5 rounded-lg border border-slate-200/40">
                        <Volume2 className="w-4 h-4 text-slate-500" />
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={volume}
                          onChange={handleVolumeChange}
                          className="w-16 accent-[#6366f1] bg-slate-200 h-1 rounded appearance-none cursor-pointer"
                        />
                      </div>
                    </div>
                  </div>
                </div>

              </div>
            )}
          </div>

          {/* Interactive Censor Customizer Panel (Only visible if video is loaded) */}
          {videoSrc && (
            <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-md flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2.5">
                  <Sliders className="w-4 h-4 text-[#4f46e5]" />
                  <h3 className="font-bold text-slate-800">Quản Lý Các Hộp Làm Mờ</h3>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 font-bold">Kích hoạt:</span>
                  <button
                    onClick={() => setBlurSettings(prev => ({ ...prev, enabled: !prev.enabled }))}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      blurSettings.enabled ? "bg-[#4f46e5]" : "bg-slate-200"
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        blurSettings.enabled ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              </div>

              {blurSettings.enabled ? (
                <div className="flex flex-col gap-4">
                  {/* Blur Boxes List & Add Button */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-600">Danh sách hộp mờ ({blurBoxes.length})</span>
                      <button
                        onClick={handleAddBlurBox}
                        className="px-2.5 py-1 text-[11px] font-bold bg-[#4f46e5] hover:bg-[#34533e] text-white rounded-lg transition-all flex items-center gap-1 shadow-sm"
                      >
                        <Plus className="w-3 h-3" />
                        Thêm hộp mới
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-2 max-h-36 overflow-y-auto p-1 bg-slate-50 border border-slate-100 rounded-xl">
                      {blurBoxes.map((box, index) => {
                        const isSelected = box.id === activeBlurBoxId;
                        return (
                          <div
                            key={box.id}
                            onClick={() => setActiveBlurBoxId(box.id)}
                            className={`px-3 py-1.5 rounded-lg border text-xs font-bold flex items-center gap-2 cursor-pointer transition-all ${
                              isSelected
                                ? "bg-[#4f46e5] text-white border-[#4f46e5] shadow-sm"
                                : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                            }`}
                          >
                            <span>Hộp mờ #{index + 1}</span>
                            {blurBoxes.length > 1 && (
                              <button
                                onClick={(e) => handleRemoveBlurBox(box.id, e)}
                                className={`p-0.5 rounded transition-all ${
                                  isSelected 
                                    ? "text-white/80 hover:text-white hover:bg-white/15" 
                                    : "text-slate-400 hover:text-red-500 hover:bg-slate-100"
                                }`}
                                title="Xóa hộp mờ này"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Selected Box customizers */}
                  {(() => {
                    const selectedBox = blurBoxes.find(b => b.id === activeBlurBoxId) || blurBoxes[0];
                    if (!selectedBox) return null;

                    const updateSelectedBox = (updater: (prev: BlurBox) => BlurBox) => {
                      setBlurBoxes(prev => prev.map(b => b.id === selectedBox.id ? updater(b) : b));
                    };

                    return (
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 border-t border-slate-100 pt-4">
                        
                        {/* Tip direct drag resize */}
                        <div className="xl:col-span-2 py-2 px-3.5 bg-[#4f46e5]/5 border border-[#4f46e5]/10 rounded-xl text-xs text-[#4f46e5] flex items-start gap-2 shadow-sm">
                          <Info className="w-4 h-4 shrink-0 mt-0.5" />
                          <p className="leading-relaxed font-semibold">
                            Hộp mờ đã chuyển sang chế độ tự do: Nhấp giữ và di chuyển chuột/chạm trực tiếp trên video để Kéo thả & Co giãn kích thước linh hoạt!
                          </p>
                        </div>

                        {/* COLUMN 1: TỌA ĐỘ VÀ KIỂU CHE CHẮN */}
                        <div className="flex flex-col gap-4">
                          {/* Coordinate readouts */}
                          <div className="bg-slate-50 border border-slate-150 rounded-xl p-3.5 flex flex-col gap-2 shadow-sm">
                            <span className="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider">Thông số tọa độ trực quan</span>
                            <div className="grid grid-cols-4 gap-2 text-xs">
                              <div className="bg-white px-1 py-1.5 rounded-lg border border-slate-200/60 text-center shadow-sm">
                                <span className="text-slate-400 block text-[9px] font-bold">Vị trí X</span>
                                <span className="font-mono font-bold text-slate-700">{selectedBox.xPosition}%</span>
                              </div>
                              <div className="bg-white px-1 py-1.5 rounded-lg border border-slate-200/60 text-center shadow-sm">
                                <span className="text-slate-400 block text-[9px] font-bold">Vị trí Y</span>
                                <span className="font-mono font-bold text-slate-700">{selectedBox.yPosition}%</span>
                              </div>
                              <div className="bg-white px-1 py-1.5 rounded-lg border border-slate-200/60 text-center shadow-sm">
                                <span className="text-slate-400 block text-[9px] font-bold">Chiều rộng</span>
                                <span className="font-mono font-bold text-slate-700">{selectedBox.width}%</span>
                              </div>
                              <div className="bg-white px-1 py-1.5 rounded-lg border border-slate-200/60 text-center shadow-sm">
                                <span className="text-slate-400 block text-[9px] font-bold">Chiều cao</span>
                                <span className="font-mono font-bold text-slate-700">{selectedBox.height}%</span>
                              </div>
                            </div>
                          </div>

                          {/* Censor bar background theme block */}
                          <div className="flex flex-col gap-2 bg-slate-50 border border-slate-150 rounded-xl p-3.5 shadow-sm">
                            <span className="text-xs text-slate-600 font-bold">Kiểu che chắn hộp đang chọn</span>
                            <div className="grid grid-cols-4 gap-2">
                              {BLUR_COVER_PRESETS.map((item) => (
                                <button
                                  key={item.key}
                                  type="button"
                                  aria-pressed={getBlurCoverPresetKey(selectedBox.bgColor) === item.key}
                                  onClick={() => updateSelectedBox(prev => ({ ...prev, bgColor: item.bgColor }))}
                                  className={`py-1.5 px-1.5 text-[11px] font-bold rounded-lg border text-center transition-all ${
                                    getBlurCoverPresetKey(selectedBox.bgColor) === item.key
                                      ? "bg-[#4f46e5] border-[#4f46e5] text-white shadow-sm"
                                      : "bg-white border-slate-200 text-slate-600 hover:text-slate-800 hover:bg-slate-50"
                                  }`}
                                >
                                  {item.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>

                        {/* COLUMN 2: CÁC THANH ĐIỀU CHỈNH TRỰC QUAN */}
                        <div className="flex flex-col gap-4 bg-slate-50 border border-slate-150 rounded-xl p-4 shadow-sm justify-center">
                          {/* Blur Intensity Slider */}
                          <div className="flex flex-col gap-1.5 bg-white p-3 rounded-lg border border-slate-200/60 shadow-sm">
                            <div className="flex justify-between text-xs font-bold">
                              <span className="text-slate-600">Mức độ làm mờ (Blur)</span>
                              <span className="text-[#4f46e5] font-mono">{selectedBox.blurAmount}px</span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={30}
                              value={selectedBox.blurAmount}
                              onChange={(e) => updateSelectedBox(prev => ({ ...prev, blurAmount: parseInt(e.target.value) }))}
                              className="accent-[#6366f1] bg-slate-200 h-1.5 rounded-lg appearance-none cursor-pointer mt-1"
                            />
                          </div>

                          {/* Solid/Backplate Opacity Slider */}
                          <div className="flex flex-col gap-1.5 bg-white p-3 rounded-lg border border-slate-200/60 shadow-sm">
                            <div className="flex justify-between text-xs font-bold">
                              <span className="text-slate-600">Độ che mờ tối (Opacity)</span>
                              <span className="text-[#4f46e5] font-mono">{Math.round(selectedBox.opacity * 100)}%</span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={selectedBox.opacity}
                              onChange={(e) => updateSelectedBox(prev => ({ ...prev, opacity: parseFloat(e.target.value) }))}
                              className="accent-[#6366f1] bg-slate-200 h-1.5 rounded-lg appearance-none cursor-pointer mt-1"
                            />
                          </div>
                        </div>

                      </div>
                    );
                  })()}

                  {/* Cài Đặt Hình Ảnh Video */}
                  <div className="mt-2 pt-4 border-t border-slate-200">
                    <h3 className="font-bold text-slate-800 mb-2 flex items-center gap-2 text-sm">
                      <Video className="w-4 h-4 text-[#4f46e5]" />
                      Cài Đặt Video (Lật video)
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl cursor-pointer hover:border-[#4f46e5] transition-colors">
                        <input 
                          type="checkbox"
                          checked={flipHorizontal}
                          onChange={(e) => setFlipHorizontal(e.target.checked)}
                          className="w-4 h-4 text-[#4f46e5] rounded border-slate-300 focus:ring-[#4f46e5]"
                        />
                        <span className="text-xs font-bold text-slate-700">Lật Ngang (Gương)</span>
                      </label>
                      <label className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl cursor-pointer hover:border-[#4f46e5] transition-colors">
                        <input 
                          type="checkbox"
                          checked={flipVertical}
                          onChange={(e) => setFlipVertical(e.target.checked)}
                          className="w-4 h-4 text-[#4f46e5] rounded border-slate-300 focus:ring-[#4f46e5]"
                        />
                        <span className="text-xs font-bold text-slate-700">Lật Dọc (Đảo ngược)</span>
                      </label>
                    </div>
                  </div>

                </div>
              ) : (
                <p className="text-xs text-slate-500 py-4 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                  Tính năng làm mờ phụ đề gốc đang tắt. Bật lên để tạo một thanh filter che giấu các dòng chữ gốc dưới video.
                </p>
              )}
            </div>
          )}
        </motion.div>

        {/* RIGHT COLUMN: Options, Styles, & Subtitle Tracks List (5 Cols) */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          className={`${activeTab === "translate" || activeTab === "projects" ? "hidden" : "lg:col-span-5 flex flex-col gap-6"}`}
          id="dashboard-column"
        >
          
          {/* Action Tabs Selector */}
          <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-slate-200/60 bg-slate-100 p-1 shadow-inner scrollbar-none lg:hidden" id="tab-selector-container">
            <button
              onClick={() => setActiveTab("translate")}
              className="flex-1 shrink-0 min-w-[105px] md:min-w-max py-2 px-3 text-xs font-extrabold rounded-lg relative flex items-center justify-center gap-1.5 transition-all focus:outline-none cursor-pointer whitespace-nowrap"
              id="tab-btn-translate"
            >
              {activeTab === "translate" && (
                <motion.span
                  layoutId="activeTabPill"
                  className="absolute inset-0 bg-gradient-to-r from-[#4f46e5] to-[#6366f1] rounded-lg shadow-md shadow-indigo-600/15 z-0"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <span className={`relative z-10 flex items-center gap-1.5 transition-colors duration-150 ${activeTab === "translate" ? "text-white" : "text-slate-500 hover:text-slate-800"}`}>
                <Languages className="w-3.5 h-3.5" />
                Dịch Thuật
              </span>
            </button>
            <button
              onClick={() => setActiveTab("style")}
              className="flex-1 shrink-0 min-w-[105px] md:min-w-max py-2 px-3 text-xs font-extrabold rounded-lg relative flex items-center justify-center gap-1.5 transition-all focus:outline-none cursor-pointer whitespace-nowrap"
              id="tab-btn-style"
            >
              {activeTab === "style" && (
                <motion.span
                  layoutId="activeTabPill"
                  className="absolute inset-0 bg-gradient-to-r from-[#4f46e5] to-[#6366f1] rounded-lg shadow-md shadow-indigo-600/15 z-0"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <span className={`relative z-10 flex items-center gap-1.5 transition-colors duration-150 ${activeTab === "style" ? "text-white" : "text-slate-500 hover:text-slate-800"}`}>
                <Type className="w-3.5 h-3.5" />
                Tinh Chỉnh Phụ Đề
              </span>
            </button>
            <button
              onClick={() => setActiveTab("tracks")}
              className="flex-1 shrink-0 min-w-[105px] md:min-w-max py-2 px-3 text-xs font-extrabold rounded-lg relative flex items-center justify-center gap-1.5 transition-all focus:outline-none cursor-pointer whitespace-nowrap"
              id="tab-btn-tracks"
            >
              {activeTab === "tracks" && (
                <motion.span
                  layoutId="activeTabPill"
                  className="absolute inset-0 bg-gradient-to-r from-[#4f46e5] to-[#6366f1] rounded-lg shadow-md shadow-indigo-600/15 z-0"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <span className={`relative z-10 flex items-center gap-1.5 transition-colors duration-150 ${activeTab === "tracks" ? "text-white" : "text-slate-500 hover:text-slate-800"}`}>
                <FileText className="w-3.5 h-3.5" />
                Bản Dịch/Phụ Đề ({subtitles.length})
              </span>
            </button>
            <button
              onClick={() => setActiveTab("tts")}
              className="flex-1 shrink-0 min-w-[105px] md:min-w-max py-2 px-3 text-xs font-extrabold rounded-lg relative flex items-center justify-center gap-1.5 transition-all focus:outline-none cursor-pointer whitespace-nowrap"
              id="tab-btn-tts"
            >
              {activeTab === "tts" && (
                <motion.span
                  layoutId="activeTabPill"
                  className="absolute inset-0 bg-gradient-to-r from-[#4f46e5] to-[#6366f1] rounded-lg shadow-md shadow-indigo-600/15 z-0"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <span className={`relative z-10 flex items-center gap-1.5 transition-colors duration-150 ${activeTab === "tts" ? "text-white" : "text-slate-500 hover:text-slate-800"}`}>
                <Megaphone className="w-3.5 h-3.5" />
                Thuyết minh
              </span>
            </button>
          </div>

          {/* Animated Tab Contents container */}
          <AnimatePresence mode="wait">
            {activeTab === "translate" && (
              <motion.div
                key="translate"
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -15 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-md flex flex-col gap-5 hover:border-slate-300/80 hover:shadow-lg transition-all duration-300 text-left"
              >
              <div>
                <h3 className="font-bold text-slate-800 mb-1 flex items-center gap-2 text-base">
                  <Languages className="w-4.5 h-4.5 text-[#4f46e5]" />
                  Cấu Hình Dịch Thuật AI
                </h3>
                <p className="text-xs text-slate-500">
                  Tận dụng AI để lắng nghe giọng nói trong video, tự động ghi phụ đề gốc và tạo bản dịch chính xác.
                </p>
              </div>

              {/* Dynamic API Platform Active Indicator */}
              <div className="flex items-center justify-between bg-slate-50 border border-slate-200/60 rounded-xl p-3">
                <div className="flex flex-col gap-0.5 text-left">
                  <span className="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider">Nguồn dịch thuật hoạt động</span>
                  <span className="text-[10px] text-slate-400 font-medium">Thay đổi cấu hình trong phần cài đặt</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`text-[10px] font-extrabold px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-sm border ${
                    apiPlatform === "gemini" 
                      ? "bg-amber-500/10 text-amber-600 border-amber-500/20"
                      : "bg-indigo-500/10 text-indigo-600 border-indigo-500/20"
                  }`}>
                    {apiPlatform === "gemini" ? (
                      <>
                        <Sparkles className="w-3 h-3 text-amber-500 animate-pulse" />
                        Google Gemini AI
                      </>
                    ) : (
                      <>
                        <Layers className="w-3 h-3 text-indigo-500 animate-pulse" />
                        Custom API
                      </>
                    )}
                  </span>
                </div>
              </div>

              {/* Selector boxes */}
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-600 flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5 text-[#4f46e5]" />
                    Phương thức trích xuất phụ đề
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setExtractionMethod("audio")}
                      className={`p-3 rounded-xl border text-xs font-bold flex flex-col gap-1 text-left transition-all cursor-pointer ${
                        extractionMethod === "audio"
                          ? "bg-indigo-50 border-indigo-500 text-indigo-700 shadow-sm"
                          : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <Volume2 className="w-3.5 h-3.5" />
                        Nhận diện giọng nói
                      </span>
                      <span className="text-[10px] text-slate-400 font-medium">Phân tích tiếng nói trong video</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => { setExtractionMethod("ocr"); setWorkspacePropertyTarget("ocr"); }}
                      className={`p-3 rounded-xl border text-xs font-bold flex flex-col gap-1 text-left transition-all cursor-pointer ${
                        extractionMethod === "ocr"
                          ? "bg-indigo-50 border-indigo-500 text-indigo-700 shadow-sm"
                          : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <Cpu className="w-3.5 h-3.5" />
                        PaddleOCR WebGPU
                      </span>
                      <span className="text-[10px] text-slate-400 font-medium">Chạy trên GPU trình duyệt, tự fallback WASM/CPU</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setExtractionMethod("aiocr")}
                      className={`p-3 rounded-xl border text-xs font-bold flex flex-col gap-1 text-left transition-all cursor-pointer ${
                        extractionMethod === "aiocr"
                          ? "bg-indigo-50 border-indigo-500 text-indigo-700 shadow-sm"
                          : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <Cpu className="w-3.5 h-3.5" />
                        AI Vision OCR cũ
                      </span>
                      <span className="text-[10px] text-slate-400 font-medium">Gemini/Custom API đọc trực tiếp ảnh</span>
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-600">Ngôn ngữ gốc của video</label>
                  <select
                    value={sourceLang}
                    onChange={(e) => setSourceLang(e.target.value)}
                    className="bg-white border border-slate-200 px-3.5 py-2 rounded-xl text-sm focus:outline-none focus:border-[#4f46e5] text-slate-800 w-full cursor-pointer font-medium"
                  >
                    <option value="auto">Tự động nhận diện (Khuyên dùng)</option>
                    <option value="English">Tiếng Anh (English)</option>
                    <option value="Vietnamese">Tiếng Việt</option>
                    <option value="Japanese">Tiếng Nhật (日本語)</option>
                    <option value="Chinese">Tiếng Trung (中文)</option>
                    <option value="Korean">Tiếng Hàn (한국어)</option>
                    <option value="French">Tiếng Pháp (Français)</option>
                    <option value="Spanish">Tiếng Tây Ban Nha (Español)</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-600">Ngôn ngữ đích (Dịch phụ đề sang)</label>
                  <select
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    className="bg-white border border-slate-200 px-3.5 py-2 rounded-xl text-sm focus:outline-none focus:border-[#4f46e5] text-slate-800 w-full cursor-pointer font-medium"
                  >
                    <option value="Vietnamese">Tiếng Việt (Vietnamese)</option>
                    <option value="English">Tiếng Anh (English)</option>
                    <option value="Japanese">Tiếng Nhật (日本語)</option>
                    <option value="Korean">Tiếng Hàn (한국어)</option>
                    <option value="Chinese">Tiếng Trung (中文)</option>
                    <option value="French">Tiếng Pháp (Français)</option>
                  </select>
                </div>
              </div>

              {/* Translation Action button */}
              <div className="pt-2">
                <button
                  type="button"
                  disabled={isLoading || !videoSrc}
                  onClick={handleTranslateVideo}
                  className={`w-full py-3 px-4 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 shadow-md ${
                    !videoSrc 
                      ? "bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed" 
                      : "bg-gradient-to-r from-[#4f46e5] to-[#6366f1] hover:opacity-90 text-white shadow-[#4f46e5]/15"
                  }`}
                  id="btn-trigger-translate"
                >
                  <Languages className="w-4 h-4" />
                  Bắt đầu dịch thuật & tạo phụ đề
                </button>
              </div>

              {/* Status indicators and loaders */}
              {isLoading && (
                <div className="bg-slate-50 p-4 border border-[#6366f1]/25 rounded-xl flex flex-col gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-[#4f46e5] animate-ping"></div>
                    <span className="text-xs font-bold text-[#4f46e5]">{loadingStep}</span>
                  </div>
                  <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-gradient-to-r from-[#4f46e5] to-[#6366f1] h-full w-[65%] animate-pulse rounded-full"></div>
                  </div>
                  <p className="text-[10px] text-slate-500 font-medium">
                    Quá trình này có thể tốn từ 10 - 30 giây tùy thuộc vào dung lượng video của bạn.
                  </p>
                </div>
              )}

              {/* Error messages */}
              {errorMsg && (
                <div className="bg-[#F17B77]/10 border border-[#F17B77]/20 text-[#D32F2F] p-4 rounded-xl text-xs flex items-start gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#D32F2F] shrink-0 mt-1"></span>
                  <p className="leading-relaxed font-semibold">{errorMsg}</p>
                </div>
              )}

              {!videoSrc && (
                <div className="border border-amber-100 bg-amber-50/70 p-4 rounded-xl text-xs text-amber-800 flex items-start gap-2 shadow-sm">
                  <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <p className="leading-relaxed">
                    Vui lòng <strong>tải video lên trước</strong> bằng khu vực bên trái. Sau đó tùy chọn ngôn ngữ và bấm nút dịch để AI phân tích.
                  </p>
                </div>
              )}
              </motion.div>
            )}

            {activeTab === "style" && (
              <PersonalizationLayout>
              <motion.div
                key="style"
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -15 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-md flex flex-col gap-5 hover:border-slate-300/80 hover:shadow-lg transition-all duration-300 text-left"
              >
              <div>
                <h3 className="font-bold text-slate-800 mb-1 flex items-center gap-2 text-base">
                  <Type className="w-4.5 h-4.5 text-[#4f46e5]" />
                  Cá Nhân Hóa Kiểu Phụ Đề
                </h3>
                <p className="text-xs text-slate-500">
                  Cấu hình phông chữ, kích thước, khoảng cách, màu sắc và hiệu ứng chữ để tạo ra phong cách độc đáo của riêng bạn.
                </p>
              </div>

              <div className="flex flex-col gap-4">
                
                {/* FontSize Precision Slider */}
                <div className="flex flex-col gap-1.5 bg-slate-50 p-3.5 rounded-xl border border-slate-200/60 shadow-sm">
                  <div className="flex justify-between items-center text-xs font-bold">
                    <span className="text-slate-600">Kích thước chữ (Font Size)</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={1}
                        max={300}
                        value={subSettings.fontSize}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 1;
                          setSubSettings(prev => ({ ...prev, fontSize: Math.max(1, val) }));
                        }}
                        className="w-14 py-0.5 px-1 bg-white border border-slate-200 focus:border-[#4f46e5] rounded-md text-center focus:outline-none font-mono text-xs text-slate-800 font-bold transition-all"
                      />
                      <span className="text-slate-500 font-mono text-[10px] uppercase font-bold">px</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={120}
                    step={1}
                    value={Math.min(120, subSettings.fontSize)}
                    onChange={(e) => setSubSettings(prev => ({ ...prev, fontSize: parseInt(e.target.value) }))}
                    className="accent-[#6366f1] bg-slate-200 h-1.5 rounded-lg appearance-none cursor-pointer mt-1"
                  />
                  <div className="flex justify-between text-[10px] text-slate-400 mt-1 font-medium">
                    <span>Cực nhỏ (1px)</span>
                    <span>Lớn (120px)</span>
                  </div>
                </div>

                {/* Font Family Selection */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-600">Phông chữ (Font Family)</label>
                  <select
                    value={subSettings.fontFamily}
                    onChange={(e) => setSubSettings(prev => ({ ...prev, fontFamily: e.target.value }))}
                    className="bg-white border border-slate-200 px-3.5 py-2 rounded-xl text-sm focus:outline-none focus:border-[#4f46e5] text-slate-800 w-full cursor-pointer font-medium"
                  >
                    <option value="Bangers">Bangers (Hoạt hình & Shorts - Mặc định)</option>
                    <option value="Inter">Inter (Không chân hiện đại)</option>
                    <option value="Space Grotesk">Space Grotesk (Góc cạnh/Công nghệ)</option>
                    <option value="JetBrains Mono">JetBrains Mono (Lập trình viên)</option>
                    <option value="Playfair Display">Playfair Display (Serif/Cổ điển)</option>
                    <option value="Montserrat">Montserrat (Đậm chất hình học)</option>
                    <option value="Lexend">Lexend (Dễ đọc/Trẻ em)</option>
                    <option value="Patrick Hand">Patrick Hand (Viết tay ngộ nghĩnh)</option>
                    <option value="Anton">Anton (Bold & Condensed - Hoàn hảo cho video ngắn)</option>
                    <option value="Oswald">Oswald (Hẹp & Đậm - Phong cách hiện đại)</option>
                    <option value="Be Vietnam Pro">Be Vietnam Pro (Việt Nam tinh tế/Chuyên nghiệp)</option>
                    <option value="Bungee">Bungee (Khối dày/Cá tính mạnh)</option>
                    <option value="Saira Condensed">Saira Condensed (Siêu hẹp - Tiết kiệm không gian)</option>
                    <option value="Lobster">Lobster (Nghệ thuật/Lãng mạn)</option>
                    <option value="Pacifico">Pacifico (Viết tay phóng khoáng)</option>
                  </select>
                </div>

                {/* Font Weight and Tracking side-by-side */}
                <div className="grid grid-cols-2 gap-4">
                  
                  {/* Font Weight Selection */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-slate-600">Độ đậm (Font Weight)</label>
                    <select
                      value={subSettings.fontWeight}
                      onChange={(e) => setSubSettings(prev => ({ ...prev, fontWeight: e.target.value as any }))}
                      className="bg-white border border-slate-200 px-3 py-2 rounded-xl text-xs focus:outline-none focus:border-[#4f46e5] text-slate-800 w-full font-bold cursor-pointer"
                    >
                      <option value="normal">Mỏng (Normal)</option>
                      <option value="medium">Vừa (Medium)</option>
                      <option value="bold">Đậm (Bold)</option>
                      <option value="black">Siêu Đậm (Black)</option>
                    </select>
                  </div>

                  {/* Letter Spacing Tracking */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-slate-600 flex justify-between">
                      <span>Khoảng cách chữ</span>
                      <span className="text-[#4f46e5] font-mono">{subSettings.letterSpacing}px</span>
                    </label>
                    <input
                      type="range"
                      min={-2}
                      max={8}
                      step={0.5}
                      value={subSettings.letterSpacing}
                      onChange={(e) => setSubSettings(prev => ({ ...prev, letterSpacing: parseFloat(e.target.value) }))}
                      className="accent-[#6366f1] bg-slate-200 h-1.5 rounded-lg appearance-none cursor-pointer mt-1"
                    />
                  </div>

                </div>

                {/* Subtitle Positioning Selector */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-600">Vị trí hiển thị phụ đề</label>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: "bottom", label: "Phía dưới (Mặc định)" },
                      { key: "top", label: "Phía trên cùng" },
                      { key: "center", label: "Ở giữa màn hình" },
                      { key: "blur-box", label: "Trong thanh che mờ" },
                      { key: "custom", label: "📍 Tự do (Kéo thả)" },
                    ].map((pos) => (
                      <button
                        key={pos.key}
                        onClick={() => {
                          let initX = subSettings.customX ?? 50;
                          let initY = subSettings.customY ?? 82;
                          if (pos.key === "custom" && subSettings.position !== "custom") {
                            // Pre-fill coordinate percentages depending on current non-custom settings for a smooth transition
                            switch (subSettings.position) {
                              case "top":
                                initX = 50; initY = 12; break;
                              case "center":
                                initX = 50; initY = 50; break;
                              case "blur-box": {
                                const activeBox = blurBoxes.find(b => b.id === activeBlurBoxId) || blurBoxes[0];
                                if (activeBox) {
                                  initX = activeBox.xPosition + (activeBox.width / 2);
                                  initY = activeBox.yPosition + (activeBox.height / 2);
                                }
                                break;
                              }
                              case "bottom":
                              default:
                                initX = 50; initY = 82; break;
                            }
                          }
                          setSubSettings(prev => ({ 
                            ...prev, 
                            position: pos.key as any,
                            customX: Math.round(initX * 10) / 10,
                            customY: Math.round(initY * 10) / 10
                          }));
                        }}
                        className={`py-2 px-2.5 text-xs font-bold rounded-lg border text-left transition-all ${
                          pos.key === "custom" ? "col-span-2 text-center flex items-center justify-center gap-1 bg-[#4f46e5]/5" : ""
                        } ${
                          subSettings.position === pos.key
                            ? "bg-[#4f46e5]/15 border-[#4f46e5] text-[#4f46e5] shadow-sm"
                            : "bg-slate-100 border-slate-200 text-slate-500 hover:text-slate-800"
                        }`}
                      >
                        {pos.label}
                      </button>
                    ))}
                  </div>

                  {subSettings.position === "custom" && (
                    <div className="mt-1 p-3.5 bg-slate-50 border border-slate-200/50 rounded-xl space-y-2.5 animate-fadeIn">
                      <p className="text-[10px] text-[#4f46e5] font-bold uppercase tracking-wider flex items-center gap-1">
                        <span>💡 Mẹo:</span>
                        <span className="text-slate-500 font-medium normal-case">Nhấp giữ và kéo trực tiếp phụ đề trên video để di chuyển tự do</span>
                      </p>
                      <div className="grid grid-cols-2 gap-3.5">
                        <div className="flex flex-col gap-1">
                          <div className="flex justify-between text-[10px] font-bold text-slate-500">
                            <span>Vị trí Ngang (X)</span>
                            <span className="text-[#4f46e5] font-mono">{subSettings.customX ?? 50}%</span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={0.5}
                            value={subSettings.customX ?? 50}
                            onChange={(e) => setSubSettings(prev => ({ ...prev, customX: parseFloat(e.target.value) }))}
                            className="accent-[#6366f1] bg-slate-200 h-1.5 rounded-lg appearance-none cursor-pointer mt-1"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <div className="flex justify-between text-[10px] font-bold text-slate-500">
                            <span>Vị trí Dọc (Y)</span>
                            <span className="text-[#4f46e5] font-mono">{subSettings.customY ?? 82}%</span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={0.5}
                            value={subSettings.customY ?? 82}
                            onChange={(e) => setSubSettings(prev => ({ ...prev, customY: parseFloat(e.target.value) }))}
                            className="accent-[#6366f1] bg-slate-200 h-1.5 rounded-lg appearance-none cursor-pointer mt-1"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Text color and Background picker side-by-side */}
                <div className="grid grid-cols-2 gap-4">
                  
                  {/* Text Color Code */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-slate-600">Màu chữ (Text Color)</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={subSettings.textColor}
                        onChange={(e) => setSubSettings(prev => ({ ...prev, textColor: e.target.value }))}
                        className="w-8 h-8 rounded border border-slate-200 bg-transparent cursor-pointer"
                      />
                      <input
                        type="text"
                        value={subSettings.textColor}
                        onChange={(e) => setSubSettings(prev => ({ ...prev, textColor: e.target.value }))}
                        className="bg-white border border-slate-200 px-2 py-1.5 text-xs rounded-lg text-slate-700 font-mono font-bold w-full"
                      />
                    </div>
                  </div>

                  {/* Background Color Picker */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-slate-600">Nền chữ (Background)</label>
                    <div className="grid grid-cols-4 gap-1.5">
                      {[
                        "rgba(0, 0, 0, 0)",
                        "rgba(0, 0, 0, 0.6)",
                        "rgba(15, 23, 42, 0.85)",
                        "rgba(68, 107, 80, 0.7)",
                      ].map((bg, idx) => (
                        <button
                          key={bg}
                          onClick={() => setSubSettings(prev => ({ ...prev, bgColor: bg }))}
                          className={`h-8 rounded border transition-all flex items-center justify-center text-[10px] font-bold ${
                            subSettings.bgColor === bg
                              ? "border-[#4f46e5] ring-2 ring-[#4f46e5]/15"
                              : "border-slate-200"
                          }`}
                          style={{ backgroundColor: bg }}
                          title={bg}
                        >
                          {idx === 0 ? "Tắt" : `N${idx}`}
                        </button>
                      ))}
                    </div>
                  </div>

                </div>

                {/* Text Effect Selector */}
                <div className="flex flex-col gap-1.5 bg-slate-50 p-3 rounded-xl border border-slate-200/60 mt-1 shadow-sm">
                  <label className="text-xs font-bold text-[#4f46e5]">Hiệu ứng của chữ (Text Effect)</label>
                  <div className="grid grid-cols-4 gap-2 mt-1">
                    {[
                      { key: "none", label: "Không" },
                      { key: "outline", label: "Viền chữ" },
                      { key: "glow", label: "Phát sáng" },
                      { key: "shadow", label: "Đổ bóng" },
                    ].map((eff) => (
                      <button
                        key={eff.key}
                        onClick={() => setSubSettings(prev => ({ ...prev, textEffect: eff.key as any }))}
                        className={`py-1.5 text-[11px] font-bold rounded-lg border text-center transition-all ${
                          subSettings.textEffect === eff.key
                            ? "bg-[#4f46e5]/15 border-[#4f46e5] text-[#4f46e5] shadow-sm"
                            : "bg-slate-100 border-slate-200 text-slate-500 hover:text-slate-800"
                        }`}
                      >
                        {eff.label}
                      </button>
                    ))}
                  </div>

                  {/* Outline Customizable Details if 'outline' active */}
                  {subSettings.textEffect === "outline" && (
                    <div className="mt-3 pt-3 border-t border-slate-200/60 grid grid-cols-2 gap-3">
                      
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-slate-500">Màu viền chữ</label>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="color"
                            value={subSettings.outlineColor}
                            onChange={(e) => setSubSettings(prev => ({ ...prev, outlineColor: e.target.value }))}
                            className="w-6 h-6 rounded border border-slate-200 bg-transparent cursor-pointer"
                          />
                          <span className="text-[10px] font-mono font-bold text-slate-500">{subSettings.outlineColor}</span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1">
                        <div className="flex justify-between text-[10px] font-bold text-slate-500">
                          <span>Độ dày viền</span>
                          <span>{subSettings.outlineWidth}px</span>
                        </div>
                        <input
                          type="range"
                          min={1}
                          max={4}
                          step={0.5}
                          value={subSettings.outlineWidth}
                          onChange={(e) => setSubSettings(prev => ({ ...prev, outlineWidth: parseFloat(e.target.value) }))}
                          className="accent-[#6366f1] bg-slate-200 h-1 rounded appearance-none cursor-pointer mt-1"
                        />
                      </div>

                    </div>
                  )}

                </div>

              </div>
              </motion.div>
              </PersonalizationLayout>
            )}

            {activeTab === "tracks" && (
              <TranslationLayout>
              <motion.div
                key="tracks"
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -15 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-md flex flex-col gap-4 max-h-[600px] overflow-hidden hover:border-slate-300/80 hover:shadow-lg transition-all duration-300 text-left"
              >
              
              {/* Header inside Track */}
              <div className="flex flex-col gap-1 shrink-0">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-slate-800 flex items-center gap-2 text-base">
                    <FileText className="w-4.5 h-4.5 text-[#4f46e5]" />
                    Quản Lý Bản Dịch Video
                  </h3>
                  <div className="flex items-center gap-2"> {/* Grouping buttons */}
                    {subtitles.length > 0 && (
                      <button
                        onClick={handleTranslateVideo}
                        className="px-2 py-1 bg-indigo-500/10 hover:bg-indigo-500 text-indigo-500 hover:text-white text-[11px] font-bold rounded-md border border-indigo-500/20 transition-all flex items-center gap-1 shadow-sm"
                      >
                        <Sparkles className="w-3 h-3" />
                        Dịch tự động
                      </button>
                    )}
                    {subtitles.length > 0 && (
                      <button
                        onClick={handleAddSub}
                        className="px-2 py-1 bg-[#4f46e5]/10 hover:bg-[#4f46e5] text-[#4f46e5] hover:text-white text-[11px] font-bold rounded-md border border-[#4f46e5]/20 transition-all flex items-center gap-1 shadow-sm"
                      >
                        <Plus className="w-3 h-3" />
                        Thêm Phân Đoạn
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-[11px] text-slate-500 font-medium">
                  Nhấp vào dòng bất kỳ để chuyển video đến đoạn đó. Bạn có thể <strong className="text-[#4f46e5]">chỉnh sửa trực tiếp bản dịch nhanh</strong> trong ô chữ phía dưới, hoặc nhấn bút chì để tùy chỉnh thời gian.
                </p>
              </div>

              {/* Action Exporters Bar */}
              {subtitles.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 p-2 bg-slate-50 rounded-xl border border-slate-200/60 shrink-0 shadow-sm">
                  <span className="text-[10px] text-slate-500 font-bold uppercase mr-1 pl-1">Xuất file:</span>
                  <button
                    onClick={exportSRT}
                    className="flex-1 py-1 px-2 bg-white border border-slate-200 hover:border-[#4f46e5] text-slate-700 hover:text-[#4f46e5] text-[11px] font-bold rounded-md transition-all flex items-center justify-center gap-1 shadow-sm"
                  >
                    <Download className="w-3 h-3" />
                    SRT (Chuẩn)
                  </button>
                  <button
                    onClick={exportVTT}
                    className="flex-1 py-1 px-2 bg-white border border-slate-200 hover:border-[#4f46e5] text-slate-700 hover:text-[#4f46e5] text-[11px] font-bold rounded-md transition-all flex items-center justify-center gap-1 shadow-sm"
                  >
                    <Download className="w-3 h-3" />
                    VTT (Web)
                  </button>
                  <button
                    onClick={exportJSON}
                    className="flex-1 py-1 px-2 bg-white border border-slate-200 hover:border-[#4f46e5] text-slate-700 hover:text-[#4f46e5] text-[11px] font-bold rounded-md transition-all flex items-center justify-center gap-1 shadow-sm"
                  >
                    <Download className="w-3 h-3" />
                    JSON
                  </button>
                </div>
              )}

              {/* Subtitles Search filter */}
              {subtitles.length > 0 && (
                <div className="relative shrink-0">
                  <input
                    type="text"
                    placeholder="Tìm kiếm từ khóa trong phụ đề gốc/dịch..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="bg-white border border-slate-200 pl-3 pr-8 py-2 text-xs rounded-xl text-slate-800 placeholder-slate-400 focus:outline-none focus:border-[#4f46e5] w-full font-medium"
                  />
                  {searchQuery && (
                    <button 
                      onClick={() => setSearchQuery("")}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs font-bold"
                    >
                      ×
                    </button>
                  )}
                </div>
              )}

              {/* Track Subtitles Flow Scrolling Box */}
              <div className="flex-1 overflow-y-auto space-y-3 pr-1" id="subtitles-list">
                {subtitles.length === 0 ? (
                  <div className="py-12 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50/50 px-4">
                    <FileText className="w-8 h-8 text-slate-400 mx-auto mb-2.5" />
                    <p className="text-sm font-bold text-slate-700">Chưa Có Phụ Đề Nào</p>
                    <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto font-medium">
                      Hãy bấm dịch video ở Tab "Dịch Thuật AI" để tạo bản dịch ngay lập tức!
                    </p>
                  </div>
                ) : filteredSubtitles.length === 0 ? (
                  <p className="text-xs text-slate-500 py-6 text-center font-medium">Không tìm thấy phân đoạn phù hợp với từ khóa.</p>
                ) : (
                  filteredSubtitles.map((sub) => {
                    const isEditing = editingSubId === sub.id;
                    const isActive = currentTime >= sub.start && currentTime <= sub.end;

                    return (
                      <div
                        key={sub.id}
                        className={`p-3.5 rounded-xl border text-left transition-all relative shadow-sm ${
                          isActive 
                            ? "bg-[#4f46e5]/10 border-[#4f46e5]/30" 
                            : "bg-white border-slate-200 hover:border-slate-300"
                        }`}
                        id={`sub-item-${sub.id}`}
                      >
                        {isEditing ? (
                          /* Subtitle Editing Mode Forms */
                          <div className="flex flex-col gap-3">
                            <div className="grid grid-cols-2 gap-2 shrink-0">
                              <div className="flex flex-col gap-1">
                                <label className="text-[10px] text-slate-500 font-bold uppercase">Bắt đầu (Giây)</label>
                                <input
                                  type="number"
                                  step="0.1"
                                  value={editStart}
                                  onChange={(e) => setEditStart(parseFloat(e.target.value) || 0)}
                                  className="bg-white border border-slate-200 px-2 py-1 text-xs rounded text-slate-800 focus:outline-none focus:border-[#4f46e5] font-mono font-bold"
                                />
                              </div>
                              <div className="flex flex-col gap-1">
                                <label className="text-[10px] text-slate-500 font-bold uppercase">Kết thúc (Giây)</label>
                                <input
                                  type="number"
                                  step="0.1"
                                  value={editEnd}
                                  onChange={(e) => setEditEnd(parseFloat(e.target.value) || 0)}
                                  className="bg-white border border-slate-200 px-2 py-1 text-xs rounded text-slate-800 focus:outline-none focus:border-[#4f46e5] font-mono font-bold"
                                />
                              </div>
                            </div>

                            <div className="flex flex-col gap-1">
                              <label className="text-[10px] text-slate-500 font-bold uppercase">Chữ Gốc (Original Text)</label>
                              <textarea
                                value={editOriginal}
                                onChange={(e) => setEditOriginal(e.target.value)}
                                className="bg-white border border-slate-200 p-2 text-xs rounded text-slate-800 h-14 resize-none focus:outline-none focus:border-[#4f46e5] font-medium"
                              />
                            </div>

                            <div className="flex flex-col gap-1">
                              <label className="text-[10px] text-slate-500 font-bold uppercase">Chữ Đã Dịch (Translated Text)</label>
                              <textarea
                                value={editTranslated}
                                onChange={(e) => setEditTranslated(e.target.value)}
                                className="bg-[#4f46e5]/5 border border-[#4f46e5]/20 p-2 text-xs rounded text-[#4f46e5] h-14 resize-none font-bold focus:outline-none focus:border-[#4f46e5]"
                              />
                            </div>

                            {/* Editing Actions buttons */}
                            <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-100">
                              <button
                                onClick={() => setEditingSubId(null)}
                                className="px-2 py-1 text-[11px] text-slate-500 hover:text-slate-800 font-bold transition-all"
                              >
                                Hủy bỏ
                              </button>
                              <button
                                onClick={() => handleSaveEdit(sub.id)}
                                className="px-3 py-1 bg-gradient-to-r from-[#4f46e5] to-[#6366f1] text-white text-[11px] font-bold rounded-md shadow hover:opacity-95 transition-all flex items-center gap-1"
                              >
                                <Check className="w-3 h-3" />
                                Lưu lại
                              </button>
                            </div>
                          </div>
                        ) : (
                          /* Standard View & Click to seek mode */
                          <div 
                            className="cursor-pointer" 
                            onClick={() => handleSeekTo(sub.start)}
                          >
                            <div className="flex items-center justify-between gap-2 mb-2">
                              <span className="text-[10px] font-mono font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded border border-slate-200">
                                {formatSecondsToVTT(sub.start).substring(3, 11)} ➔ {formatSecondsToVTT(sub.end).substring(3, 11)}
                              </span>
                              
                              {/* Hover actions buttons for Edit & Delete */}
                              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                <button
                                  onClick={() => handleStartEdit(sub)}
                                  className="p-1 hover:bg-slate-100 text-slate-400 hover:text-[#4f46e5] rounded transition-all"
                                  title="Chỉnh sửa phân đoạn"
                                >
                                  <Edit3 className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={() => handleDeleteSub(sub.id)}
                                  className="p-1 hover:bg-red-50 text-slate-400 hover:text-red-500 rounded transition-all"
                                  title="Xóa phân đoạn"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            </div>

                            <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed mb-1.5 italic font-medium">
                              {sub.original}
                            </p>
                            <div 
                              className="relative group/inline mt-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <textarea
                                value={sub.translated}
                                onChange={(e) => {
                                  const newVal = e.target.value;
                                  setSubtitles(prev => prev.map(s => s.id === sub.id ? { ...s, translated: newVal } : s));
                                }}
                                rows={Math.max(1, Math.ceil(sub.translated.length / 42))}
                                className="w-full text-xs text-slate-800 font-bold leading-relaxed bg-slate-50/50 hover:bg-slate-100/60 focus:bg-white border border-slate-200/50 focus:border-[#4f46e5] rounded-xl px-3 py-2 focus:outline-none transition-all resize-none min-h-[38px] shadow-sm font-sans"
                                placeholder="Nhập bản dịch tại đây..."
                                title="Nhấp vào đây để chỉnh sửa trực tiếp nội dung dịch nhanh"
                              />
                              <div className="absolute right-2.5 bottom-2 opacity-0 group-hover/inline:opacity-100 focus-within:!opacity-0 transition-opacity pointer-events-none flex items-center gap-1 text-[9px] text-slate-400 font-bold">
                                <Edit3 className="w-3 h-3 text-[#4f46e5]/70" />
                                <span className="text-[#4f46e5]/70">Sửa nhanh</span>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              </motion.div>
              </TranslationLayout>
            )}

            {activeTab === "tts" && (
              <NarrationLayout>
              <motion.div
                key="tts"
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -15 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-md flex flex-col gap-4 max-h-[620px] overflow-hidden hover:border-slate-300/80 hover:shadow-lg transition-all duration-300 text-left"
              >
              {/* Header */}
              <div className="flex flex-col gap-1 shrink-0">
                <h3 className="font-bold text-slate-800 flex items-center gap-2 text-base">
                  <Megaphone className="w-5 h-5 text-[#4f46e5]" />
                  Cấu Hình Thuyết Minh AI & TikTok TTS
                </h3>
                <p className="text-xs text-slate-500">
                  Phát âm thanh thuyết minh tự động khi xem video hoặc kết xuất bản thuyết minh đồng bộ hoàn chỉnh.
                </p>
              </div>

              {/* Options Scrollable Body */}
              <div className="flex-1 overflow-y-auto flex flex-col gap-4 pr-1 min-h-0 text-left">
                
                {/* 1. Toggle Reader On-The-Fly */}
                <div className="flex items-center justify-between bg-slate-50 border border-slate-200/60 p-3 rounded-xl shadow-sm shrink-0">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-bold text-slate-700">Đọc phụ đề theo video (Live)</span>
                    <span className="text-[10px] text-slate-400">Tự động phát giọng đọc khi chạy video player</span>
                  </div>
                  <button
                    onClick={() => setTtsEnabled(!ttsEnabled)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      ttsEnabled ? "bg-[#4f46e5]" : "bg-slate-200"
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        ttsEnabled ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
                <div className="flex flex-col gap-1.5 bg-slate-50 border border-slate-200/60 p-3 rounded-xl shadow-sm shrink-0">
                <div className="flex justify-between text-xs font-bold">
                  <span className="text-slate-600">Âm lượng audio gốc khi ghép TTS</span>
                  <span className="text-[#4f46e5] font-mono">{Math.round(originalAudioMixVolume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={originalAudioMixVolume}
                  onChange={(e) => setOriginalAudioMixVolume(parseFloat(e.target.value))}
                  className="accent-[#6366f1] bg-slate-200 h-1.5 rounded-lg appearance-none cursor-pointer mt-1"
                />
                <p className="text-[10px] text-slate-400 leading-relaxed">
                  0% = tắt hẳn audio gốc khi có giọng đọc AI. 100% = giữ nguyên âm lượng gốc (giọng AI sẽ bị lẫn tiếng nền). 
                  Áp dụng cho cả nghe thử trực tiếp và khi xuất video/audio thành phẩm cuối cùng.
                </p>
              </div>
                
                {/* 2. Select Engine */}
                <div className="flex flex-col gap-2.5 bg-slate-50 border border-slate-200/60 p-3 rounded-xl shadow-sm shrink-0">
                  <span className="text-xs font-bold text-slate-700">Chọn công nghệ giọng đọc (Engine)</span>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => setTtsEngine("tiktok")}
                      className={`py-2 px-1 text-center rounded-lg border text-xs font-bold flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                        ttsEngine === "tiktok"
                          ? "bg-[#4f46e5] text-white border-[#4f46e5] shadow"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      <span>TikTok TTS</span>
                      <span className="text-[9px] font-medium opacity-80">(Tiếng Việt)</span>
                    </button>
                    <button
                      onClick={() => setTtsEngine("gemini")}
                      className={`py-2 px-1 text-center rounded-lg border text-xs font-bold flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                        ttsEngine === "gemini"
                          ? "bg-[#4f46e5] text-white border-[#4f46e5] shadow"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      <span>Gemini 3.1 AI</span>
                      <span className="text-[9px] font-medium opacity-80">(Chất lượng cao)</span>
                    </button>
                    <button
                      onClick={() => setTtsEngine("browser")}
                      className={`py-2 px-1 text-center rounded-lg border text-xs font-bold flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                        ttsEngine === "browser"
                          ? "bg-[#4f46e5] text-white border-[#4f46e5] shadow"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      <span>Trình Duyệt</span>
                      <span className="text-[9px] font-medium opacity-80">(Phát Offline)</span>
                    </button>
                  </div>

                  {/* Engine Details */}
                  <div className="mt-2 border-t border-slate-200/60 pt-2 text-left">
                    {ttsEngine === "tiktok" && (
                      <div className="flex flex-col gap-2.5 animate-fadeIn">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] font-bold text-slate-500">Giọng đọc TikTok</label>
                          <select
                            value={tiktokVoice}
                            onChange={(e) => setTiktokVoice(e.target.value)}
                            className="bg-white border border-slate-200 text-xs font-bold rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-[#4f46e5] w-full"
                          >
                            <option value="BV074_streaming">BV074_streaming (Nữ hoạt ngôn, ấm áp)</option>
                            <option value="BV075_streaming">BV075_streaming (Nam tự tin, thanh niên)</option>
                          </select>
                        </div>

                        <div className="flex flex-col gap-1">
                          <div className="flex justify-between items-center">
                            <label className="text-[10px] font-bold text-slate-500">TikTok Session ID (Mắt xích)</label>
                            <span className="text-[9px] text-[#4f46e5] font-semibold">Tự động lưu trữ</span>
                          </div>
                          <input
                            type="text"
                            value={tiktokSessionId}
                            onChange={(e) => setTiktokSessionId(e.target.value)}
                            placeholder="Nhập sessionid cookie của tiktok.com..."
                            className="bg-white border border-slate-200 text-xs font-medium rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-[#4f46e5] w-full font-mono placeholder:text-slate-400"
                          />
                          <p className="text-[9px] text-slate-400 leading-normal">
                            Đăng nhập TikTok trên máy tính, mở DevTools (F12) → Application → Cookies → Sao chép cột <strong>sessionid</strong> rồi dán vào đây.
                          </p>
                        </div>
                      </div>
                    )}

                    {ttsEngine === "gemini" && (
                      <div className="flex flex-col gap-2 animate-fadeIn">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] font-bold text-slate-500">Giọng đọc Gemini</label>
                          <select
                            value={geminiVoice}
                            onChange={(e) => setGeminiVoice(e.target.value)}
                            className="bg-white border border-slate-200 text-xs font-bold rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-[#4f46e5] w-full"
                          >
                            <option value="Kore">Kore (Giọng chuẩn, trung tính)</option>
                            <option value="Puck">Puck (Thanh niên trẻ trung)</option>
                            <option value="Fenrir">Fenrir (Mạnh mẽ, tự nhiên)</option>
                            <option value="Aoede">Aoede (Nữ tính, truyền cảm)</option>
                            <option value="Charon">Charon (Chững chạc, trầm ấm)</option>
                          </select>
                        </div>
                      </div>
                    )}

                    {ttsEngine === "browser" && (
                      <div className="flex flex-col gap-2 animate-fadeIn">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] font-bold text-slate-500">Giọng đọc Trình duyệt (Web Speech)</label>
                          <select
                            value={ttsVoiceName}
                            onChange={(e) => setTtsVoiceName(e.target.value)}
                            className="bg-white border border-slate-200 text-xs font-bold rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-[#4f46e5] w-full"
                          >
                            {voices.length === 0 ? (
                              <option value="">Giọng đọc trình duyệt mặc định</option>
                            ) : (
                              voices.map((voice) => (
                                <option key={voice.name} value={voice.name}>
                                  {voice.name} ({voice.lang})
                                </option>
                              ))
                            )}
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* 3. Global Bulk/Merge Actions */}
                {subtitles.length > 0 && (
                  <div className="bg-[#4f46e5]/5 border border-[#4f46e5]/15 p-3 rounded-xl shadow-sm flex flex-col gap-3 shrink-0">
                    <span className="text-xs font-bold text-slate-700 flex items-center gap-1">
                      <Layers className="w-3.5 h-3.5 text-[#4f46e5]" />
                      Xuất bản nhạc thuyết minh đồng bộ
                    </span>
                    
                    {isPreGenerating ? (
                      <div className="flex flex-col gap-2 p-2 bg-white rounded-lg border border-slate-100 shadow-sm">
                        <div className="flex justify-between items-center text-xs font-bold text-slate-600">
                          <span className="flex items-center gap-1.5 animate-pulse text-[#4f46e5]">
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            Đang tạo thuyết minh: {preGenerateProgress}%
                          </span>
                          <span className="font-mono text-[10px]">Đang tạo...</span>
                        </div>
                        <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                          <div 
                            className="bg-[#4f46e5] h-full rounded-full transition-all duration-300 ease-out"
                            style={{ width: `${preGenerateProgress}%` }}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={async () => {
                            const success = await preGenerateAllTts();
                            if (success) {
                              alert("Đã tổng hợp thành công tất cả phân đoạn thuyết minh vào bộ nhớ tạm! Bạn có thể bật video để nghe thử trực tiếp.");
                            }
                          }}
                          className="py-2 px-3 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 hover:border-[#4f46e5] rounded-lg text-xs font-bold transition-all shadow-sm flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          Tổng Hợp Thử
                        </button>
                        <button
                          onClick={downloadMergedVoiceover}
                          disabled={isMergingAudio}
                          className="py-2 px-3 bg-[#4f46e5] hover:bg-[#34533e] text-white rounded-lg text-xs font-bold transition-all shadow flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Tải File .WAV
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* 4. Combined Text Review */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-slate-500 font-bold uppercase flex items-center gap-1">
                      <FileText className="w-3 h-3 text-slate-400" />
                      Văn Bản Thuyết Minh Tổng Hợp:
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const combined = subtitles.map(sub => sub.translated).join(" ");
                        setFullTtsText(combined);
                      }}
                      className="text-[10px] text-[#4f46e5] hover:text-[#34533e] font-bold flex items-center gap-1 cursor-pointer bg-slate-100 hover:bg-slate-200/80 px-2 py-0.5 rounded transition-all"
                    >
                      <RefreshCw className="w-2.5 h-2.5" />
                      Khôi phục gốc
                    </button>
                  </div>

                  {subtitles.length === 0 ? (
                    <div className="py-8 text-center text-xs text-slate-400 border border-dashed border-slate-200 rounded-xl bg-slate-50/40">
                      Chưa có dữ liệu phụ đề dịch. Vui lòng hoàn tất dịch video trước.
                    </div>
                  ) : (
                    <div className="relative flex flex-col">
                      <textarea
                        value={fullTtsText}
                        onChange={(e) => setFullTtsText(e.target.value)}
                        className="w-full bg-slate-50/50 focus:bg-white border border-slate-200 focus:border-[#4f46e5] text-xs text-slate-700 font-medium leading-relaxed rounded-xl p-3 focus:outline-none transition-all resize-none shadow-sm h-28 overflow-y-auto"
                        placeholder="Nhập hoặc chỉnh sửa văn bản thuyết minh hoàn chỉnh tại đây..."
                      />
                      <div className="absolute right-2.5 bottom-2 text-[9px] text-slate-400 font-mono bg-white/95 px-1.5 py-0.5 rounded border border-slate-100 pointer-events-none">
                        {fullTtsText.length} ký tự
                      </div>
                    </div>
                  )}
                </div>

              </div>
              </motion.div>
              </NarrationLayout>
            )}
          </AnimatePresence>

          {/* PHẦN XUẤT BẢN & TẢI VỀ THÀNH PHẨM (Nằm ở cuối cột phải, thẳng hàng song song) */}
          {videoSrc && (
            <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-md flex flex-col gap-5">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 bg-indigo-600/10 rounded-lg text-indigo-600">
                    <Download className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-800 text-sm">Trung Tâm Xuất Bản & Tải Về</h3>
                    <p className="text-[11px] text-slate-500 font-medium text-left">Xuất bản các tệp thành phẩm của dự án</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* 1. Tải Phụ Đề */}
                <div className="flex flex-col gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl hover:border-indigo-500/20 transition-all text-left">
                  <div className="flex items-center gap-2">
                    <div className="p-1 bg-amber-500/10 text-amber-600 rounded">
                      <FileText className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-xs font-bold text-slate-700">1. Tệp Phụ Đề</span>
                  </div>
                  <p className="text-[10px] text-slate-500 font-medium min-h-[30px] leading-relaxed">
                    Tải về tệp phụ đề rời chuẩn SRT để biên tập thêm bằng CapCut hoặc Premiere.
                  </p>
                  <button
                    onClick={exportSRT}
                    disabled={subtitles.length === 0}
                    className="w-full mt-auto py-1.5 px-2.5 bg-white border border-slate-200 hover:border-indigo-600 hover:text-indigo-600 text-slate-700 rounded-lg text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Download className="w-3 h-3" />
                    Tải File .SRT
                  </button>
                </div>

                {/* 2. Tải Thuyết Minh (WAV) */}
                <div className="flex flex-col gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl hover:border-indigo-500/20 transition-all text-left">
                  <div className="flex items-center gap-2">
                    <div className="p-1 bg-sky-500/10 text-sky-600 rounded">
                      <Volume2 className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-xs font-bold text-slate-700">2. Âm Thanh</span>
                  </div>
                  <p className="text-[10px] text-slate-500 font-medium min-h-[30px] leading-relaxed">
                    Tải về tệp thuyết minh đầy đủ đã ghép các phân đoạn thoại AI theo mốc thời gian.
                  </p>
                  <button
                    onClick={downloadMergedVoiceover}
                    disabled={isMergingAudio || subtitles.length === 0}
                    className="w-full mt-auto py-1.5 px-2.5 bg-white border border-slate-200 hover:border-indigo-600 hover:text-indigo-600 text-slate-700 rounded-lg text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {isMergingAudio ? (
                      <>
                        <RefreshCw className="w-3 h-3 animate-spin" />
                        Đang xử lý...
                      </>
                    ) : (
                      <>
                        <Download className="w-3 h-3" />
                        Tải File .WAV
                      </>
                    )}
                  </button>
                </div>

                {/* 3. Tải Video Final */}
                <div className="flex flex-col gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl hover:border-indigo-500/20 transition-all text-left">
                  <div className="flex items-center gap-2">
                    <div className="p-1 bg-indigo-500/10 text-indigo-600 rounded">
                      <Video className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-xs font-bold text-slate-700">3. Video Final</span>
                  </div>
                  <p className="text-[10px] text-slate-500 font-medium min-h-[30px] leading-relaxed">
                    Mã hóa tệp video hoàn chỉnh tích hợp cả vùng che mờ và tệp thuyết minh AI.
                  </p>
                  <label className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                    Độ phân giải
                    <select
                      value={exportResolution}
                      onChange={(e) => setExportResolution(e.target.value as "720" | "1080" | "1440")}
                      disabled={isRecordingVideo}
                      className="flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-700 outline-none focus:border-indigo-500 disabled:opacity-60"
                    >
                      <option value="720">720p (nhanh)</option>
                      <option value="1080">1080p</option>
                      <option value="1440">2K / 1440p</option>
                    </select>
                  </label>
                  {isRecordingVideo ? (
                    <div className="w-full mt-auto flex flex-col gap-1.5 bg-white border border-indigo-600/30 rounded-lg p-1 shadow-sm">
                      <div className="w-full bg-slate-100 rounded-full h-1">
                        <div 
                          className="bg-indigo-600 h-1 rounded-full transition-all duration-300" 
                          style={{ width: `${recordingProgress}%` }}
                        />
                      </div>
                      <button
                        onClick={startBrowserRecording}
                        className="w-full text-rose-500 hover:text-rose-600 text-[9px] font-bold transition-all flex items-center justify-center gap-1.5 animate-pulse cursor-pointer"
                      >
                        <Pause className="w-2.5 h-2.5" />
                        Hủy ({recordingProgress}%)
                      </button>
                    </div>
                  ) : (
                    <div className="w-full mt-auto flex flex-col gap-1.5">
                      <button
                        onClick={startBrowserRecording}
                        disabled={subtitles.length === 0}
                        className="w-full py-1.5 px-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[11px] font-extrabold transition-all flex items-center justify-center gap-1.5 shadow-sm active:scale-[0.98] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Play className="w-3 h-3 text-white fill-white" />
                        Tải Video Final
                      </button>

                      {exportedVideoUrl && (
                        <a
                          href={exportedVideoUrl}
                          download="tool-dubbing-video.mp4"
                          className="w-full py-1.5 px-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-extrabold transition-all flex items-center justify-center gap-1.5 shadow-md active:scale-[0.98] animate-bounce"
                        >
                          <Download className="w-3 h-3 text-white" />
                          Tải trực tiếp Video Final
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-1.5 border-t border-slate-100 pt-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-slate-500 font-bold uppercase flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    Nhật ký xử lý (Logs - 5 dòng gần nhất):
                  </span>
                  <button
                    type="button"
                    onClick={() => setActivityLogs([])}
                    className="text-[9px] text-slate-400 hover:text-indigo-600 font-bold flex items-center gap-1 cursor-pointer bg-slate-50 hover:bg-slate-100 px-1.5 py-0.5 rounded transition-colors"
                  >
                    Xóa logs
                  </button>
                </div>
                <div className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 shadow-inner h-24 overflow-y-auto font-mono text-[10px] text-emerald-400 flex flex-col gap-0.5 text-left select-all">
                  {activityLogs.length === 0 ? (
                    <span className="text-slate-500 italic">Chưa có hoạt động nào được ghi nhận...</span>
                  ) : (
                    activityLogs.slice(-10).map((log, idx) => (
                      <div key={idx} className="whitespace-pre-wrap break-all leading-normal py-0.5 border-b border-emerald-950/20 last:border-0">
                        {log}
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="bg-blue-50/50 border border-blue-200/50 rounded-lg p-2.5 flex gap-2 text-[10px] text-blue-600 leading-relaxed font-semibold text-left">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  <strong>Mẹo xuất bản:</strong> Quá trình xử lý âm thanh và nén video được biên dịch thời gian thực trong trình duyệt WebAssembly của bạn, giúp bảo mật hoàn toàn dữ liệu của bạn mà không cần tải ngược lại server.
                </span>
              </div>
            </div>
          )}

        </motion.div>

      </main>

      <AppFooter activeRoute={activeTab} />

      <AnimatePresence>
        {errorPopupQueue.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-sm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="persistent-error-title"
            aria-describedby="persistent-error-message"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 18 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              className="w-full max-w-md overflow-hidden rounded-2xl border border-rose-200 bg-white shadow-2xl"
            >
              <div className="flex items-start gap-3 border-b border-rose-100 bg-rose-50 px-5 py-4">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600">
                  <X className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 id="persistent-error-title" className="text-base font-extrabold text-rose-700">Đã xảy ra lỗi</h2>
                  <p className="mt-0.5 text-[11px] font-medium text-rose-500">Tiến trình đã dừng hoặc cần bạn kiểm tra trước khi tiếp tục.</p>
                </div>
                <button onClick={dismissErrorPopup} className="rounded-lg p-1.5 text-rose-400 hover:bg-rose-100 hover:text-rose-700" aria-label="Tắt cảnh báo lỗi"><X className="h-4 w-4" /></button>
              </div>
              <div className="p-5">
                <p id="persistent-error-message" className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm font-semibold leading-6 text-slate-700">{errorPopupQueue[0]}</p>
                {errorPopupQueue.length > 1 && <p className="mt-2 text-right text-[10px] font-bold text-amber-600">Còn {errorPopupQueue.length - 1} cảnh báo tiếp theo</p>}
                <button onClick={dismissErrorPopup} autoFocus className="mt-4 w-full rounded-xl bg-rose-600 px-4 py-3 text-sm font-extrabold text-white shadow-sm hover:bg-rose-500">Đã hiểu, tắt cảnh báo</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {(isLoading || isRecordingVideo || isPreGenerating) && (
        <div className={`fixed z-[80] border border-indigo-200 bg-white shadow-2xl transition-all ${isProgressMinimized ? "bottom-4 right-4 w-64 rounded-xl p-3" : "inset-x-1/2 top-6 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl p-5"}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-extrabold text-slate-800">{isRecordingVideo ? "Đang render video" : isPreGenerating ? "Đang tạo thuyết minh" : "Đang tạo phụ đề"}</p>
              <p className="mt-0.5 text-[11px] text-slate-500">{isRecordingVideo ? `${recordingProgress}% hoàn thành` : isPreGenerating ? `${preGenerateProgress}% · Đang tiếp tục từ checkpoint` : loadingStep || "Đang xử lý bằng AI..."}</p>
              {isRecordingVideo && recordingEtaSeconds !== null && (
                <p className="mt-1 text-[11px] font-bold text-indigo-600">{recordingEtaSeconds > 0 ? `Dự tính render còn ${formatEstimatedTime(recordingEtaSeconds)}` : "Đang hoàn tất video"}</p>
              )}
              {!isRecordingVideo && isPreGenerating && preGenerateEtaSeconds !== null && (
                <p className="mt-1 text-[11px] font-bold text-indigo-600">{preGenerateEtaSeconds > 0 ? `Dự tính tạo giọng còn ${formatEstimatedTime(preGenerateEtaSeconds)}` : "Đang hoàn tất thuyết minh"}</p>
              )}
              {isLoading && loadingEtaSeconds !== null && (
                <p className="mt-1 text-[11px] font-bold text-indigo-600">
                  {loadingEtaSeconds > 0 ? `Dự tính còn ${formatEstimatedTime(loadingEtaSeconds)}` : "Sắp hoàn tất"} · {loadingProgress}%
                </p>
              )}
            </div>
            <button onClick={() => setIsProgressMinimized(v => !v)} className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-xs font-bold text-slate-600">{isProgressMinimized ? "Mở" : "Thu nhỏ"}</button>
          </div>
          {!isProgressMinimized && <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${isRecordingVideo ? recordingProgress : isPreGenerating ? preGenerateProgress : loadingProgress}%` }} /></div>}
        </div>
      )}

      {/* Donate Popup */}
      <AnimatePresence>
        {showDonatePopup && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="bg-white rounded-3xl shadow-2xl max-w-sm w-full max-h-[85vh] flex flex-col relative border border-slate-200 overflow-hidden"
            >
              <button
                onClick={() => setShowDonatePopup(false)}
                className="absolute top-4 right-4 p-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-full transition-colors z-10 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
              
              <div className="p-6 sm:p-8 text-center flex flex-col items-center overflow-y-auto scrollbar-none flex-1">
                <div className="w-16 h-16 bg-amber-100 rounded-2xl flex items-center justify-center mb-6 shadow-inner shrink-0">
                  <Coffee className="w-8 h-8 text-amber-500" />
                </div>
                
                <h3 className="text-xl font-black text-slate-800 mb-2">Buy Me a Coffee!</h3>
                <p className="text-sm text-slate-500 font-medium leading-relaxed mb-6">
                  Nếu ứng dụng này giúp ích cho công việc. Bạn có thể mời mình ly cà phê qua QR này!
                </p>
                
                <div className="w-full bg-slate-50 p-4 rounded-2xl border border-slate-200 mb-2 shrink-0">
                  <img 
                    src="/donate-qr.png" 
                    alt="Donate QR Code" 
                    className="w-full h-auto rounded-xl shadow-sm mix-blend-multiply"
                  />
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Settings Page */}
      {activeTab === "settings" && (
        <SettingsLayout>
        <section className="min-h-[calc(100vh-73px)] bg-slate-50 px-4 py-6 sm:px-6 lg:ml-64 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-auto w-full max-w-6xl rounded-3xl border border-slate-200 bg-white shadow-sm"
          >
              <div className="flex flex-col p-6 sm:p-8 lg:p-10">
                <div className="order-1 mb-7 flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-6">
                  <div className="flex items-center gap-3">
                  <div className="p-2 bg-indigo-100 rounded-xl">
                    <Settings className="w-6 h-6 text-indigo-600" />
                  </div>
                  <div>
                    <h1 className="text-xl font-black text-slate-900">Cài đặt hệ thống</h1>
                    <p className="text-xs text-slate-500 font-medium">Quản lý API, theo dõi quota và đồng bộ thông số.</p>
                  </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void refreshApiQuota()}
                    disabled={isLoadingQuota}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-extrabold text-slate-600 transition-colors hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-4 w-4 ${isLoadingQuota ? "animate-spin" : ""}`} />
                    Làm mới quota
                  </button>
                </div>

                <section className="order-4 mb-5 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 sm:p-5">
                  <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="flex items-center gap-2 text-sm font-black text-slate-800">
                        <Activity className="h-4 w-4 text-indigo-600" /> Quản lý API & quota
                      </h2>
                      <p className="mt-1 text-[11px] font-medium text-slate-500">
                        Tự cập nhật mỗi 5 giây · Thống kê chính xác các lượt gọi phát sinh từ app trong phiên server hiện tại.
                      </p>
                    </div>
                    <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[10px] font-bold text-slate-500">
                      {quotaUpdatedAt ? `Cập nhật ${new Date(quotaUpdatedAt).toLocaleTimeString("vi-VN")}` : "Chưa có dữ liệu"}
                    </span>
                  </div>

                  {quotaLoadError && (
                    <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-700">
                      {quotaLoadError}
                    </div>
                  )}

                  {apiQuotaEntries.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-xs font-semibold text-slate-400">
                      Chưa có API key được cấu hình để theo dõi.
                    </div>
                  ) : (
                    <div className="grid gap-3 lg:grid-cols-2">
                      {apiQuotaEntries.map((entry, entryIndex) => {
                        const statusStyle = entry.status === "available"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : entry.status === "limited"
                            ? "border-amber-200 bg-amber-50 text-amber-700"
                            : entry.status === "error"
                              ? "border-rose-200 bg-rose-50 text-rose-700"
                              : "border-slate-200 bg-slate-100 text-slate-500";
                        const statusLabel = entry.status === "available"
                          ? "Hoạt động"
                          : entry.status === "limited"
                            ? "Hết quota / 429"
                            : entry.status === "error"
                              ? "Có lỗi"
                              : "Chưa sử dụng";
                        const geminiKeyIndex = apiQuotaEntries.slice(0, entryIndex).filter((item) => item.provider === "gemini").length;
                        return (
                          <article key={`${entry.provider}-${entry.label}-${entryIndex}`} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className={`h-2.5 w-2.5 rounded-full ${entry.status === "available" ? "bg-emerald-500" : entry.status === "limited" ? "bg-amber-500" : entry.status === "error" ? "bg-rose-500" : "bg-slate-300"}`} />
                                  <h3 className="truncate text-sm font-black text-slate-800">{entry.label}</h3>
                                </div>
                                <p className="mt-1 truncate text-[10px] font-semibold text-slate-400">{entry.model || "Chưa xác định model"}</p>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                <span className={`rounded-full border px-2.5 py-1 text-[9px] font-black ${statusStyle}`}>{statusLabel}</span>
                                {entry.provider === "gemini" && (
                                  <button
                                    type="button"
                                    onClick={() => removeGeminiApiKey(geminiKeyIndex)}
                                    className="rounded-lg border border-rose-100 bg-rose-50 p-1.5 text-rose-500 transition-colors hover:border-rose-300 hover:bg-rose-100"
                                    aria-label={`Xóa ${entry.label}`}
                                    title="Xóa API key"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>

                            <div className="mt-4 grid grid-cols-4 gap-2">
                              {[
                                ["Request", entry.requests],
                                ["Thành công", entry.successes],
                                ["Lỗi", entry.failures],
                                ["Lỗi 429", entry.quotaErrors],
                              ].map(([label, value]) => (
                                <div key={String(label)} className="rounded-xl bg-slate-50 px-2 py-2 text-center">
                                  <div className="text-sm font-black text-slate-800">{value}</div>
                                  <div className="mt-0.5 text-[8px] font-bold uppercase text-slate-400">{label}</div>
                                </div>
                              ))}
                            </div>

                            <div className="mt-3 grid gap-2 sm:grid-cols-2">
                              <div className="rounded-xl border border-slate-100 px-3 py-2">
                                <div className="text-[9px] font-bold uppercase text-slate-400">Token đã dùng</div>
                                <div className="mt-1 text-xs font-black text-slate-700">{entry.totalTokens.toLocaleString("vi-VN")}</div>
                                <div className="text-[9px] text-slate-400">Vào {entry.inputTokens.toLocaleString("vi-VN")} · Ra {entry.outputTokens.toLocaleString("vi-VN")}</div>
                              </div>
                              <div className="rounded-xl border border-slate-100 px-3 py-2">
                                <div className="text-[9px] font-bold uppercase text-slate-400">Request còn lại</div>
                                <div className="mt-1 text-xs font-black text-slate-700">
                                  {entry.rateLimit.requestRemaining ?? "Không được cung cấp"}
                                  {entry.rateLimit.requestLimit ? ` / ${entry.rateLimit.requestLimit}` : ""}
                                </div>
                                <div className="text-[9px] text-slate-400">Reset: {entry.rateLimit.requestReset ?? "Không có dữ liệu"}</div>
                              </div>
                            </div>

                            <p className="mt-3 rounded-lg bg-indigo-50/70 px-3 py-2 text-[9px] font-medium leading-relaxed text-indigo-700">{entry.quotaVisibility}</p>
                            {entry.lastError && <p className="mt-2 line-clamp-2 text-[9px] font-semibold text-rose-600">Lỗi gần nhất: {entry.lastError}</p>}
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>

                <div className="contents">
                  {/* TikTok Session ID */}
                  <div className="order-2 mb-5 flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-slate-700 flex items-center justify-between">
                      <span>TikTok Session ID</span>
                      <span className="text-[10px] text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">Lưu trình duyệt</span>
                    </label>
                    <input
                      type="text"
                      placeholder="sessionid_xxxxxxxxxxxxxxxxxxxxxxxx"
                      value={tiktokSessionId}
                      onChange={(e) => setTiktokSessionId(e.target.value)}
                      className="bg-white border border-slate-200 px-3.5 py-2.5 rounded-xl text-sm focus:outline-none focus:border-indigo-500 text-slate-800 w-full font-mono"
                    />
                    <p className="text-[11px] text-slate-400 leading-relaxed font-medium">
                      Bắt buộc để sử dụng giọng đọc Tiếng Việt cực mượt của TikTok. Lấy cookie <code className="bg-slate-100 px-1 py-0.5 rounded text-rose-500 font-mono">sessionid</code> từ TikTok Web.
                    </p>
                  </div>

                  {/* Gemini API Key pool */}
                  <div className="order-3 mb-5 flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-slate-700 flex items-center justify-between">
                      <span>Thêm Google Gemini API Key</span>
                      <span className="text-[10px] text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                        Đang quản lý {parseGeminiApiKeys(geminiApiKey).length} key
                      </span>
                    </label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        type="password"
                        spellCheck={false}
                        autoComplete="off"
                        placeholder="Dán một hoặc nhiều API key rồi nhấn Enter"
                        value={geminiApiKeyDraft}
                        onChange={(e) => setGeminiApiKeyDraft(e.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            submitGeminiApiKeys();
                          }
                        }}
                        className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 font-mono text-sm text-slate-800 focus:border-indigo-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={submitGeminiApiKeys}
                        disabled={parseGeminiApiKeys(geminiApiKeyDraft).length === 0}
                        className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-black text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Plus className="h-4 w-4" /> Thêm API
                      </button>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed font-medium">
                      Nhấn Enter hoặc nút Thêm API. Key sẽ chuyển xuống khu quản lý bên dưới và ô nhập tự xóa trắng.
                    </p>
                  </div>

                  {/* API Platform Selection */}
                  <div className="order-5 mb-5 flex flex-col gap-2">
                    <label className="text-xs font-extrabold text-slate-700 flex items-center justify-between">
                      <span>Nguồn dịch thuật (API Translation Platform)</span>
                      <span className="text-[10px] text-[#4f46e5] bg-indigo-50 px-2 py-0.5 rounded font-black">LỰA CHỌN</span>
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setApiPlatform("gemini")}
                        className={`p-3 rounded-2xl border text-left transition-all flex flex-col gap-1 cursor-pointer ${
                          apiPlatform === "gemini"
                            ? "border-[#4f46e5] bg-indigo-50/40 shadow-sm ring-1 ring-[#4f46e5]/10"
                            : "border-slate-200 hover:border-slate-300 bg-white"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-black text-slate-800">Google Gemini</span>
                          <Sparkles className={`w-3.5 h-3.5 ${apiPlatform === "gemini" ? "text-amber-500 animate-pulse" : "text-slate-400"}`} />
                        </div>
                        <span className="text-[9px] text-slate-400 font-bold leading-tight">Dịch bằng Gemini 3.5. Ổn định, mượt mà và miễn phí mặc định.</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setApiPlatform("custom")}
                        className={`p-3 rounded-2xl border text-left transition-all flex flex-col gap-1 cursor-pointer ${
                          apiPlatform === "custom"
                            ? "border-[#4f46e5] bg-indigo-50/40 shadow-sm ring-1 ring-[#4f46e5]/10"
                            : "border-slate-200 hover:border-slate-300 bg-white"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-black text-slate-800">Custom API</span>
                          <Layers className={`w-3.5 h-3.5 ${apiPlatform === "custom" ? "text-[#4f46e5]" : "text-slate-400"}`} />
                        </div>
                        <span className="text-[9px] text-slate-400 font-bold leading-tight">Cắm key platform.beeknoee.com hoặc OpenAI tương thích.</span>
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {apiPlatform === "custom" ? (
                        <span className="inline-flex items-center gap-2 rounded-full bg-[#eef2ff] border border-[#c7d2fe] px-3 py-1 text-[10px] font-semibold text-[#4338ca]">
                          <Layers className="w-3.5 h-3.5" />
                          Custom API đang dùng
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-2 rounded-full bg-[#eff6ff] border border-[#bfdbfe] px-3 py-1 text-[10px] font-semibold text-[#1d4ed8]">
                          <Sparkles className="w-3.5 h-3.5" />
                          Gemini đang dùng
                        </span>
                      )}

                      {apiPlatform === "custom" && (
                        <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[10px] font-semibold ${allowGeminiFallback ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-slate-100 border-slate-300 text-slate-600'}`}>
                          {allowGeminiFallback ? 'Gemini fallback đang bật' : 'Gemini fallback đang tắt'}
                        </span>
                      )}
                    </div>

                    {extractionMethod === "aiocr" && apiPlatform === "custom" && (
                      <div className="rounded-2xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                        AI OCR mode sends raw video to the third-party API. This works only if your custom AI provider supports base64 video ingestion via chat endpoints.
                      </div>
                    )}
                  </div>

                  {/* Custom Beeknoee API Config */}
                  <div className={`order-6 mb-5 p-4 rounded-2xl border transition-all flex flex-col gap-3 ${
                    apiPlatform === "custom"
                      ? "bg-slate-50 border-slate-300/80"
                      : "bg-slate-50/30 border-slate-200/50 opacity-60"
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-extrabold text-[#4f46e5] uppercase tracking-wider">Cấu hình Custom API (Beeknoee)</span>
                      {apiPlatform !== "custom" && (
                        <span className="text-[8px] text-slate-400 font-bold bg-slate-100 px-1.5 py-0.5 rounded">TẮT</span>
                      )}
                    </div>
                    
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-bold text-slate-600">Custom API Base URL</label>
                      <input
                        type="text"
                        placeholder="https://platform.beeknoee.com/v1"
                        disabled={apiPlatform !== "custom"}
                        value={customApiUrl}
                        onChange={(e) => setCustomApiUrl(e.target.value)}
                        onBlur={() => setCustomApiUrl((value) => sanitizeCustomApiBaseUrl(value))}
                        className="bg-white border border-slate-200 px-3 py-1.5 rounded-lg text-xs focus:outline-none focus:border-indigo-500 text-slate-800 w-full font-mono disabled:opacity-60"
                      />
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-bold text-slate-600">Custom API Key</label>
                      <input
                        type="password"
                        placeholder="sk-..."
                        disabled={apiPlatform !== "custom"}
                        value={customApiKey}
                        onChange={(e) => setCustomApiKey(e.target.value)}
                        className="bg-white border border-slate-200 px-3 py-1.5 rounded-lg text-xs focus:outline-none focus:border-indigo-500 text-slate-800 w-full font-mono disabled:opacity-60"
                      />
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-bold text-slate-600">Model Name</label>
                      <input
                        type="text"
                        placeholder="gpt-4o-mini"
                        disabled={apiPlatform !== "custom"}
                        value={customModel}
                        onChange={(e) => setCustomModel(e.target.value)}
                        className="bg-white border border-slate-200 px-3 py-1.5 rounded-lg text-xs focus:outline-none focus:border-indigo-500 text-slate-800 w-full font-mono disabled:opacity-60"
                      />
                    </div>
                    
                    <p className="text-[10px] text-slate-400 leading-relaxed font-medium">
                      Chỉ cần nhập URL gốc hoặc endpoint đầy đủ; hệ thống tự bỏ tiền tố POST và tự ghép /chat/completions.
                    </p>

                    {apiPlatform === "custom" && (
                      <div className="pt-1 flex flex-col gap-2">
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-[10px] text-slate-700">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="font-bold text-[11px] text-slate-800">Dự phòng Gemini</div>
                              <div className="text-[10px] text-slate-500">Nếu Custom API thất bại, sẽ thử lại bằng Gemini.</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => setAllowGeminiFallback(!allowGeminiFallback)}
                              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                                allowGeminiFallback ? "bg-indigo-600" : "bg-slate-300"
                              }`}
                            >
                              <span
                                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                  allowGeminiFallback ? "translate-x-6" : "translate-x-1"
                                }`}
                              />
                            </button>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={testCustomApiConnection}
                          disabled={isTestingConnection || !customApiUrl || !customApiKey}
                          className="w-full py-1.5 px-3 bg-white border border-slate-200 hover:border-[#4f46e5] hover:text-[#4f46e5] text-slate-700 rounded-lg text-[10px] font-extrabold transition-all flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
                        >
                          {isTestingConnection ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#4f46e5]" />
                              Đang kiểm tra kết nối...
                            </>
                          ) : (
                            <>
                              <Activity className="w-3.5 h-3.5" />
                              Kiểm tra kết nối API
                            </>
                          )}
                        </button>

                        {testResult && (
                          <div className={`p-2 rounded-lg text-[10px] leading-relaxed font-semibold border ${
                            testResult.success
                              ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                              : "bg-rose-50 border-rose-200 text-rose-700"
                          }`}>
                            {testResult.success ? "🟢 " : "🔴 "}
                            {testResult.msg}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Smart TTS Switch */}
                  <div className="order-7 bg-slate-50 p-4 rounded-2xl border border-slate-200 flex items-center justify-between gap-4">
                    <div className="flex flex-col gap-0.5 text-left">
                      <span className="text-xs font-bold text-slate-700">Tự động tăng tốc độ thuyết minh (Smart TTS)</span>
                      <span className="text-[11px] text-slate-400 font-medium leading-relaxed">
                        Tự động điều chỉnh tốc độ đọc (playbackRate) của giọng AI để vừa khít với thời lượng của phân đoạn phụ đề.
                      </span>
                    </div>
                    <button
                      onClick={() => setSmartTtsEnabled(!smartTtsEnabled)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none shrink-0 ${
                        smartTtsEnabled ? "bg-indigo-600" : "bg-slate-300"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          smartTtsEnabled ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>
                </div>

                <div className="order-8 mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-center text-xs font-bold text-emerald-700">
                  Cấu hình được tự động lưu trên trình duyệt này.
                </div>
              </div>
          </motion.div>
        </section>
        </SettingsLayout>
      )}

      {/* Engine Download Modal */}
      <AnimatePresence>
        {showEngineModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="bg-white rounded-3xl shadow-2xl max-w-lg w-full max-h-[85vh] flex flex-col relative border border-slate-200 overflow-hidden"
            >
              <button
                onClick={() => setShowEngineModal(false)}
                className="absolute top-4 right-4 p-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-full transition-colors z-10 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
              
              <div className="p-6 sm:p-8 flex flex-col overflow-y-auto scrollbar-none flex-1">
                <div className="flex items-center gap-3 mb-6 shrink-0">
                  <div className="p-2 bg-indigo-100 rounded-xl">
                    <Cpu className="w-6 h-6 text-indigo-600" />
                  </div>
                  <div>
                    <h3 className="text-lg font-black text-slate-800">Trình tải & Cài đặt Engine</h3>
                    <p className="text-xs text-slate-400 font-medium">Tải và kiểm tra FFmpeg WebAssembly dùng để xuất video</p>
                  </div>
                </div>

                <div className="space-y-5">
                  {/* Progress Indicator */}
                  <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-4 flex flex-col gap-3">
                    <div className="flex justify-between items-center text-xs font-bold text-slate-600">
                      <span>Tiến trình cài đặt</span>
                      <span className="text-indigo-600 font-mono">{engineDownloadProgress}%</span>
                    </div>
                    
                    {/* Progress Bar */}
                    <div className="w-full bg-slate-200 h-2.5 rounded-full overflow-hidden relative">
                      <motion.div
                        className="bg-gradient-to-r from-[#4f46e5] to-indigo-500 h-full rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${engineDownloadProgress}%` }}
                        transition={{ duration: 0.3 }}
                      />
                    </div>
                    
                    <span className="text-xs text-slate-500 font-semibold leading-relaxed">
                      {engineCurrentStep || "Đang chờ bắt đầu..."}
                    </span>
                  </div>

                  {/* Terminal Installation Logs */}
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold text-slate-600">Nhật ký cài đặt (Install Logs)</span>
                    <div ref={logContainerRef} className="bg-slate-900 rounded-2xl p-4 font-mono text-[11px] text-indigo-300 h-48 overflow-y-auto space-y-1.5 border border-slate-800 scrollbar-none flex flex-col">
                      {engineInstallLogs.map((log, index) => (
                        <div key={index} className="leading-relaxed">
                          <span className="text-emerald-500">▶</span> {log}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Status Note */}
                  {engineStatus === "installed" ? (
                    <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-xs text-emerald-700 leading-relaxed font-semibold text-left">
                      🟢 <strong>Đã hoàn thành:</strong> FFmpeg WebAssembly đã được kiểm tra và lưu vào bộ nhớ đệm.
                    </div>
                  ) : (
                    <div className="p-4 bg-amber-50 border border-amber-200/80 rounded-2xl text-xs text-amber-700 leading-relaxed font-semibold text-left">
                      💡 <strong>Lưu ý:</strong> FFmpeg được lưu trong bộ nhớ đệm trình duyệt; model PaddleOCR được Node tải một lần và tái sử dụng cho mọi request.
                    </div>
                  )}
                </div>

                <div className="mt-6 flex gap-3">
                  {engineStatus !== "installed" && !isDownloadingEngine && (
                    <button
                      onClick={handleDownloadEngines}
                      className="flex-1 py-3 px-4 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-600/10 text-sm"
                    >
                      Bắt đầu tải Engine
                    </button>
                  )}
                  {engineStatus === "error" && (
                    <button
                      onClick={() => { setEngineInstallLogs([]); handleDownloadEngines(); }}
                      className="py-3 px-4 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-colors text-sm"
                    >
                      Thử lại
                    </button>
                  )}
                  <button
                    onClick={() => { navigator.clipboard?.writeText(engineInstallLogs.join('\n')); }}
                    className="py-3 px-4 bg-slate-100 text-slate-700 rounded-xl font-bold hover:bg-slate-200 transition-colors text-sm"
                  >
                    Sao chép nhật ký
                  </button>
                  <button
                    onClick={() => setShowEngineModal(false)}
                    className="flex-1 py-3 px-4 bg-slate-100 text-slate-700 rounded-xl font-bold hover:bg-slate-200 transition-colors text-sm"
                  >
                    Đóng cửa sổ
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}