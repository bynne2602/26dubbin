import type { OcrRegion, Subtitle } from "../types";

export type OcrDetection = {
  text: string;
  confidence: number;
  region_id: string;
  box?: { x: number; y: number; width: number; height: number };
  bbox?: number[][];
  first_seen_ts?: number;
};

export type OcrFrameResult = {
  timestamp: number;
  detections: OcrDetection[];
  spanEnd?: number;
};

type OcrSubtitleTrack = {
  text: string;
  start: number;
  lastSeen: number;
  confidence: number;
  samples: number;
  regionId: string;
  box?: NonNullable<OcrDetection["box"]>;
};

export type OcrServiceHealth = {
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

export type OcrRuntimeProfile = {
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
};

export const DEFAULT_OCR_REGIONS: OcrRegion[] = [{
  id: "ocr-region-bottom",
  label: "Gợi ý vùng phụ đề dưới",
  x: 5,
  y: 78,
  width: 90,
  height: 22,
}];

export function getOcrRuntimeProfile(): OcrRuntimeProfile {
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
    return { id: "desktop", label: "Desktop 16x", isMobile: false, logicalCpus, deviceMemoryGb, webGpuAvailable, batchSize: 16, maxQueuedCandidates: 64, playbackRate: 16, maxOcrWidth: 960 };
  }
  const isLowEnd = logicalCpus <= 4 || (deviceMemoryGb !== null && deviceMemoryGb <= 3);
  const isHighEnd = logicalCpus >= 8 && (deviceMemoryGb === null || deviceMemoryGb >= 6) && webGpuAvailable;
  if (isLowEnd) return { id: "mobile-low", label: "Mobile tiết kiệm 4x", isMobile: true, logicalCpus, deviceMemoryGb, webGpuAvailable, batchSize: 4, maxQueuedCandidates: 12, playbackRate: 4, maxOcrWidth: 640 };
  if (isHighEnd) return { id: "mobile-high", label: "Mobile hiệu năng cao 8x", isMobile: true, logicalCpus, deviceMemoryGb, webGpuAvailable, batchSize: 8, maxQueuedCandidates: 24, playbackRate: 8, maxOcrWidth: 800 };
  return { id: "mobile-balanced", label: `Mobile cân bằng ${webGpuAvailable ? "6x" : "4x"}`, isMobile: true, logicalCpus, deviceMemoryGb, webGpuAvailable, batchSize: 6, maxQueuedCandidates: 18, playbackRate: webGpuAvailable ? 6 : 4, maxOcrWidth: 720 };
}

export function cleanOcrText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isLikelyOcrWatermark(value: string): boolean {
  const compact = cleanOcrText(value);
  if (!compact || compact.length > 64) return false;
  const dense = compact.replace(/\s+/g, "");
  if (/^[^\p{L}\p{N}@]{0,4}@[A-Za-z0-9_.-]{2,40}[^\p{L}\p{N}]{0,4}$/u.test(dense)) return true;
  return /^(?:douyin|tiktok|抖音(?:号|號)?|快手|小红书|xiaohongshu)[:：]?@?[A-Za-z0-9_.-]{2,40}$/iu.test(dense);
}

export function normalizedOcrText(value: string): string {
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
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

export function ocrSimilarity(left: string, right: string): number {
  const a = normalizedOcrText(left);
  const b = normalizedOcrText(right);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  return 1 - (levenshteinDistance(a, b) / Math.max(a.length, b.length));
}

function isLikelyCjkSubtitle(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  if (!t) return false;
  const hanCount = (t.match(/\p{Script=Han}/gu) || []).length;
  const cjkCompat = (t.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  const latinCount = (t.match(/\p{Script=Latin}/gu) || []).length;
  const cyrillicCount = (t.match(/\p{Script=Cyrillic}/gu) || []).length;
  const otherLetter = (t.match(/[\p{Script=Thai}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Bengali}]/gu) || []).length;
  const nonPunct = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  if (nonPunct < 2) return false;
  const cjkTotal = hanCount + cjkCompat;
  if (cjkTotal > 0) return cjkTotal / nonPunct >= 0.25;
  return (latinCount + cyrillicCount + otherLetter) / nonPunct >= 0.4;
}

function joinOcrDetections(detections: OcrDetection[]): string {
  const rows: string[] = [];
  for (const text of [...detections]
    .sort((l, r) => (l.box?.y || 0) - (r.box?.y || 0) || (l.box?.x || 0) - (r.box?.x || 0))
    .map((item) => cleanOcrText(item.text))
    .filter((text) => Boolean(text) && !isLikelyOcrWatermark(text) && isLikelyCjkSubtitle(text))) {
    const normalized = normalizedOcrText(text);
    if (rows.some((row) => {
      const existing = normalizedOcrText(row);
      return existing === normalized || (existing.length > 2 && normalized.length > 2 && (existing.includes(normalized) || normalized.includes(existing) || ocrSimilarity(existing, normalized) >= 0.9));
    })) continue;
    rows.push(text);
  }
  const allCjk = rows.length > 0 && rows.every((row) => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{P}\p{N}\s]+$/u.test(row));
  return cleanOcrText(rows.join(allCjk ? "" : " "));
}

function mergeAdjacentOcrSubtitleEvents(events: Array<OcrSubtitleTrack & { end: number }>, frameInterval: number): Array<OcrSubtitleTrack & { end: number }> {
  const merged: Array<OcrSubtitleTrack & { end: number }> = [];
  const fuzzyGap = Math.max(frameInterval * 2.25, 0.75);
  const exactGap = Math.max(frameInterval * 4, 2.25);
  const mergeInto = (target: OcrSubtitleTrack & { end: number }, event: OcrSubtitleTrack & { end: number }) => {
    target.start = Math.min(target.start, event.start);
    target.end = Math.max(target.end, event.end);
    target.lastSeen = Math.max(target.lastSeen, event.lastSeen);
    target.samples += event.samples;
    if (event.confidence > target.confidence || event.text.length > target.text.length) {
      target.text = event.text;
      target.box = event.box;
    }
    target.confidence = Math.max(target.confidence, event.confidence);
  };
  for (const event of events.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged[merged.length - 1];
    if (previous) {
      const previousText = normalizedOcrText(previous.text);
      const eventText = normalizedOcrText(event.text);
      const gap = Math.max(0, event.start - previous.end);
      const similarity = ocrSimilarity(previous.text, event.text);
      const exact = Boolean(previousText) && previousText === eventText;
      const containment = previousText.length >= 4 && eventText.length >= 4
        && (previousText.includes(eventText) || eventText.includes(previousText));
      const samePosition = ocrBoxOverlap(previous.box, event.box) >= 0.08;

      // Exact consecutive text is overwhelmingly an OCR re-open of the same
      // hard subtitle. Do not require box overlap here: Paddle polygons can
      // jump substantially when a frame is blurred or partially covered.
      if ((exact && gap <= exactGap)
        || (gap <= fuzzyGap && samePosition && (similarity >= 0.78 || containment))) {
        mergeInto(previous, event);
        continue;
      }

      // Repair A → one noisy flash → A. This is a common failure mode when a
      // transition/overlay briefly corrupts one sampled frame.
      const beforeNoise = merged[merged.length - 2];
      if (beforeNoise) {
        const beforeText = normalizedOcrText(beforeNoise.text);
        const noiseDuration = Math.max(0, previous.end - previous.start);
        const surroundingGap = Math.max(0, event.start - beforeNoise.end);
        const isShortNoise = previous.samples <= 2 && noiseDuration <= Math.max(0.55, frameInterval * 1.5);
        if (beforeText && beforeText === eventText && isShortNoise && surroundingGap <= exactGap) {
          merged.pop();
          mergeInto(beforeNoise, event);
          continue;
        }
      }
    }
    merged.push({ ...event });
  }
  return merged;
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
  const iW = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const iH = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return (iW * iH) / Math.max(1, Math.min(left.width * left.height, right.width * right.height));
}

type OcrBox = NonNullable<OcrDetection["box"]>;

function normalizeOcrBox(box?: OcrDetection["box"]): OcrBox | undefined {
  if (!box) return undefined;
  const x = Number(box.x);
  const y = Number(box.y);
  const width = Number(box.width);
  const height = Number(box.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
  const left = Math.max(0, Math.min(100, x));
  const top = Math.max(0, Math.min(100, y));
  const right = Math.max(left, Math.min(100, x + width));
  const bottom = Math.max(top, Math.min(100, y + height));
  if (right - left < 0.05 || bottom - top < 0.05) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function isDetectionInWatermarkRegion(box: OcrDetection["box"], watermarkRegions: OcrRegion[]): boolean {
  const detection = normalizeOcrBox(box);
  if (!detection || watermarkRegions.length === 0) return false;
  const detectionArea = detection.width * detection.height;
  const centerX = detection.x + detection.width / 2;
  const centerY = detection.y + detection.height / 2;
  for (const region of watermarkRegions) {
    const watermark = normalizeOcrBox(region);
    if (!watermark) continue;
    const overlapWidth = Math.max(0, Math.min(detection.x + detection.width, watermark.x + watermark.width) - Math.max(detection.x, watermark.x));
    const overlapHeight = Math.max(0, Math.min(detection.y + detection.height, watermark.y + watermark.height) - Math.max(detection.y, watermark.y));
    const overlapArea = overlapWidth * overlapHeight;
    const detectionCoverage = overlapArea / detectionArea;
    const centerInside = centerX >= watermark.x && centerX <= watermark.x + watermark.width && centerY >= watermark.y && centerY <= watermark.y + watermark.height;
    // OCR polygons shift and resize between frames. Center containment with
    // substantial overlap catches that jitter, while a mere edge collision
    // cannot remove a nearby subtitle.
    if (detectionCoverage >= 0.55 || (centerInside && detectionCoverage >= 0.3)) return true;
  }
  return false;
}

export function mergeOcrFramesToSubtitles(
  frames: OcrFrameResult[],
  frameInterval: number,
  videoDuration: number,
  similarityThreshold = 0.86,
  watermarkRegions: OcrRegion[] = [],
): Subtitle[] {
  const active = new Map<string, OcrSubtitleTrack>();
  const events: Array<OcrSubtitleTrack & { end: number }> = [];
  const closeTrack = (regionId: string, endHint: number) => {
    const track = active.get(regionId);
    if (!track) return;
    const minDuration = Math.min(0.2, frameInterval);
    const estimatedEnd = track.lastSeen + frameInterval / 2;
    const end = Math.min(videoDuration, Math.max(track.start + minDuration, Math.min(endHint, estimatedEnd)));
    if (track.text && (track.samples >= 1 || track.confidence >= 0.35)) events.push({ ...track, end });
    active.delete(regionId);
  };
  for (const frame of [...frames].sort((a, b) => a.timestamp - b.timestamp)) {
    const frameLastSeen = frame.spanEnd !== undefined
      ? Math.max(frame.timestamp, Math.min(videoDuration, frame.spanEnd) - frameInterval / 2)
      : frame.timestamp;
    const grouped = new Map<string, OcrDetection[]>();
    for (const detection of frame.detections || []) {
      if (isDetectionInWatermarkRegion(detection.box, watermarkRegions)) continue;
      const regionId = detection.region_id || "full-frame";
      grouped.set(regionId, [...(grouped.get(regionId) || []), detection]);
    }
    for (const [regionId, track] of active) {
      if (!grouped.has(regionId)) {
        const gap = frame.timestamp - track.lastSeen;
        if (gap > frameInterval * 1.6) closeTrack(regionId, frame.timestamp);
      }
    }
    for (const [regionId, detections] of grouped) {
      const text = joinOcrDetections(detections);
      if (!text) continue;
      const confidence = detections.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / detections.length;
      const box = getOcrEnvelope(detections);
      const reportedFirstSeen = detections
        .map((item) => Number(item.first_seen_ts))
        .filter((value) => Number.isFinite(value) && value >= 0 && value <= frame.timestamp);
      const visualStart = reportedFirstSeen.length > 0
        ? Math.max(0, Math.min(...reportedFirstSeen) - frameInterval / 2)
        : Math.max(0, frame.timestamp - frameInterval / 2);
      const current = active.get(regionId);
      if (current && ocrSimilarity(current.text, text) >= similarityThreshold && ocrBoxOverlap(current.box, box) >= 0.25) {
        current.lastSeen = Math.max(current.lastSeen, frameLastSeen);
        current.samples += frame.spanEnd !== undefined ? 2 : 1;
        if (confidence > current.confidence) { current.text = text; current.box = box; }
        current.confidence = Math.max(current.confidence, confidence);
      } else {
        if (current) closeTrack(regionId, visualStart);
        active.set(regionId, {
          text,
          start: visualStart,
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
  const deduplicatedEvents = mergeAdjacentOcrSubtitleEvents(events, frameInterval);
  return deduplicatedEvents.map((event, index) => ({
    id: `paddle-ocr-${index + 1}`,
    start: Number(event.start.toFixed(2)),
    end: Number(event.end.toFixed(2)),
    original: event.text,
    translated: event.text,
  }));
}

export async function readJsonResponse(response: Response): Promise<any> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || payload?.detail || `HTTP ${response.status}`);
  return payload;
}

/* Legacy browser ONNX scanner removed. Python PaddleOCR is the sole OCR engine.
export async function runPaddleOcrOnVideo(
  file: File,
  fps: number,
  regions: OcrRegion[],
  onProgress: (message: string, percent: number, etaSeconds: number | null) => void,
  onPartialResults?: (frames: OcrFrameResult[], frameInterval: number, duration: number) => void,
  runtimeProfile: OcrRuntimeProfile = getOcrRuntimeProfile(),
  forceServer = false,
): Promise<{ frames: OcrFrameResult[]; model: OcrServiceHealth["model"]; duration: number; frameInterval: number }> {

  const duration = Math.max(0, video.duration || 0);
  const minGapSeconds = forceServer ? 0.05 : 0.35;
  const scanFps = Math.min(Math.max(1, Math.min(20, fps)), 1 / minGapSeconds);
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
        return { ...region, x, y, width: Math.max(1, Math.min(100 - x, region.width)), height: Math.max(1, Math.min(100 - y, region.height)) };
      })
    : [{ id: "full-frame", label: "Toàn khung hình", x: 0, y: 0, width: 100, height: 100 }];
  const cropLeftPercent = Math.min(...scanRegions.map((r) => r.x));
  const cropTopPercent = Math.min(...scanRegions.map((r) => r.y));
  const cropRightPercent = Math.max(...scanRegions.map((r) => r.x + r.width));
  const cropBottomPercent = Math.max(...scanRegions.map((r) => r.y + r.height));
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
  const heartbeatSeconds = forceServer ? 1 : 2;
  const minimumCandidateGap = Math.max(interval, minGapSeconds);
  const batchSize = runtimeProfile.batchSize;
  const maxQueuedCandidates = runtimeProfile.maxQueuedCandidates;
  let output: OcrFrameResult[] = [];
  let model: OcrServiceHealth["model"];
  let totalCandidateCount = 0;
  let queuedCandidateCount = 0;
  let completedCandidateCount = 0;
  let lastProcessedTimestamp = 0;
  let recognizedLineCount = 0;
  let batchProcessing: Promise<void> = Promise.resolve();
  let screenWakeLock: { release: () => Promise<void> } | null = null;


  const buildSpannedFrames = (endHint = lastProcessedTimestamp) => {
    const sorted = [...output].sort((l, r) => l.timestamp - r.timestamp);
    const deduplicated: OcrFrameResult[] = [];
    for (const frame of sorted) {
      const prev = deduplicated[deduplicated.length - 1];
      if (prev && Math.abs(prev.timestamp - frame.timestamp) < 0.02) {
        if (frame.detections.length > prev.detections.length) deduplicated[deduplicated.length - 1] = frame;
      } else {
        deduplicated.push(frame);
      }
    }
    return deduplicated.map((frame, index) => ({
      ...frame,
      spanEnd: deduplicated[index + 1]?.timestamp ?? Math.min(duration, Math.max(frame.timestamp + interval, endHint + interval)),
    }));
  };


  const buildTextSignature = (luma: Uint8Array) => {
    const columns = 24;
    const rows = 8;
    const signature = new Uint8Array(columns * rows);
    const sw = diffCanvas.width;
    const sh = diffCanvas.height;
    for (let row = 0; row < rows; row++) {
      const y0 = Math.floor(row * sh / rows);
      const y1 = Math.max(y0 + 1, Math.floor((row + 1) * sh / rows));
      for (let column = 0; column < columns; column++) {
        const x0 = Math.floor(column * sw / columns);
        const x1 = Math.max(x0 + 1, Math.floor((column + 1) * sw / columns));
        let edgeEnergy = 0;
        let samples = 0;
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            const idx = y * sw + x;
            const value = luma[idx];
            const left = luma[y * sw + Math.max(0, x - 1)];
            const above = luma[Math.max(0, y - 1) * sw + x];
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
    for (let i = 0; i < right.length; i++) {
      const diff = Math.abs(left[i] - right[i]);
      absoluteDifference += diff;
      if (diff >= 18) meaningfullyChanged++;
    }
    return absoluteDifference / right.length < 5.0 && meaningfullyChanged / right.length < 0.10;
  };

  const encodeCandidate = () => new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Không mã hóa được frame OCR.")), "image/jpeg", 0.72);
  });

  const blobToBase64 = async (blob: Blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    return btoa(binary);
  };

  const processCandidateBatch = async (batch: CandidateFrame[]) => {
    if (!batch.length) return;
    let batchFrames: OcrFrameResult[] = [];
    try {
      const blobs = await Promise.all(batch.map((c) => c.blob));
      const payload = await readJsonResponse(await fetch("/api/ocr/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frames: await Promise.all(batch.map(async (c, i) => ({ frameId: c.frameId, timestamp: c.timestamp, base64: await blobToBase64(blobs[i]) }))),
          regions: optimizedRegions,
          minConfidence: 0.3,
        }),
      }));
      batchFrames = Array.isArray(payload.frames) ? payload.frames : [];
      model = payload.model || model;
      output.push(...batchFrames);
      completedCandidateCount += batch.length;
      lastProcessedTimestamp = Math.max(lastProcessedTimestamp, ...batch.map((c) => c.timestamp));
      recognizedLineCount += batchFrames.reduce((sum, frame) => sum + (frame.detections?.length || 0), 0);
      onPartialResults?.(buildSpannedFrames(), interval, duration);
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
    candidateFrames.push({ frameId: Math.max(0, Math.round(timestamp * scanFps)), timestamp: Number(timestamp.toFixed(3)), blob: encodeCandidate() });
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
      visualChange = (meanDifference >= meanThreshold && changedRatio >= ratioThreshold * 0.55) || changedRatio >= ratioThreshold * 1.7;
      const alpha = visualChange ? 0.015 : 0.055;
      const previousMean = noiseMean;
      noiseMean = noiseMean === 0 ? meanDifference : noiseMean * (1 - alpha) + meanDifference * alpha;
      noiseDeviation = noiseDeviation === 0 ? Math.abs(meanDifference - previousMean) : noiseDeviation * (1 - alpha) + Math.abs(meanDifference - previousMean) * alpha;
      noiseChangedRatio = noiseChangedRatio === 0 ? changedRatio : noiseChangedRatio * (1 - alpha) + changedRatio * alpha;
    }
    previousLuma = luma;
    scannedFrames++;
    const isHeartbeat = timestamp - lastCandidateTime >= heartbeatSeconds;
    const canStore = timestamp - lastCandidateTime >= minimumCandidateGap - 0.001;
    // Python/server mode must inspect every requested interval. Change
    // detection and signature deduplication can hide short or subtle subtitle
    // lines, especially when OCR is configured above 10 FPS.
    const shouldInspect = forceServer ? canStore : (totalCandidateCount === 0 || visualChange || isHeartbeat) && canStore;
    if (shouldInspect) {
      const signature = buildTextSignature(luma);
      const duplicateContent = totalCandidateCount > 0 && isDuplicateSignature(lastCandidateSignature, signature);
      if (forceServer || !duplicateContent) storeCurrentCandidate(timestamp, signature);
      else if (isHeartbeat) lastCandidateTime = timestamp;
    }
    if (scannedFrames % Math.max(25, Math.round(fps * 5)) === 0) {
      const now = performance.now();
      const processedFrames = Math.min(timestamps.length, Math.max(1, Math.round(timestamp / interval) + 1));
      scanRateSamples.push({ at: now, processed: processedFrames });
      while (scanRateSamples.length > 2 && now - scanRateSamples[0].at > 12_000) scanRateSamples.shift();
      const firstSample = scanRateSamples[0];
      const elapsedWindow = Math.max(0.1, (now - firstSample.at) / 1000);
      const recentRate = scanRateSamples.length > 1 ? (processedFrames - firstSample.processed) / elapsedWindow : processedFrames / Math.max(0.1, (now - scanStartedAt) / 1000);
      const etaSeconds = Math.ceil(Math.max(0, timestamps.length - processedFrames) / Math.max(0.05, recentRate));
      onProgress(`Đang quét ${runtimeProfile.playbackRate}x: ${processedFrames}/${timestamps.length} mốc; OCR xong ${completedCandidateCount}/${totalCandidateCount} frame khác nhau.`, Number(Math.min(45, (timestamp / Math.max(0.1, duration)) * 45).toFixed(1)), etaSeconds);
    }
  };

  try {
    if (runtimeProfile.isMobile && document.visibilityState === "visible") {
      const wakeLockApi = (navigator as any).wakeLock;
      screenWakeLock = await wakeLockApi?.request("screen").catch(() => null) || null;
    }
    const requestVideoFrame = (video as any).requestVideoFrameCallback?.bind(video) as
      | ((callback: (now: number, metadata: { mediaTime: number }) => void) => number)
      | undefined;
    const resumeFrom = Math.max(0, lastProcessedTimestamp - interval * 2);
    // Scan each configured interval. The adaptive probe mode only checks every
    // two intervals and estimates the transition time, which can shift OCR
    // timestamps away from the actual hard-sub frame.
    const useFastSequentialScan = Boolean(requestVideoFrame);
    const seekTo = async (timestamp: number) => {
      const target = Math.min(timestamp, Math.max(0, duration - 0.01));
      if (Math.abs(video.currentTime - target) <= 0.001) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { video.removeEventListener("seeked", onSeeked); video.removeEventListener("error", onError); };
        const onSeeked = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error(`Không seek được video tại ${target.toFixed(2)}s.`)); };
        video.addEventListener("seeked", onSeeked, { once: true });
        video.addEventListener("error", onError, { once: true });
        video.currentTime = target;
      });
    };
    const scanBySeekingFrom = async (fromTimestamp: number) => {
      const matchedIndex = timestamps.findIndex((t) => t >= fromTimestamp - 0.001);
      const startIndex = matchedIndex < 0 ? timestamps.length : matchedIndex;
      for (let i = startIndex; i < timestamps.length; i++) {
        await seekTo(timestamps[i]);
        scanCurrentFrame(timestamps[i]);
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
          const refineTime = Math.min(probeTime, previousProbeTime + interval);
          await seekTo(refineTime);
          const refineSignature = buildTextSignature(readCurrentLuma());
          if (!isDuplicateSignature(referenceSignature, refineSignature)) storeCurrentCandidate(refineTime, refineSignature);
          await seekTo(probeTime);
          const stableSignature = buildTextSignature(readCurrentLuma());
          if (isDuplicateSignature(referenceSignature, refineSignature) || !isDuplicateSignature(refineSignature, stableSignature)) storeCurrentCandidate(probeTime, stableSignature);
          lastVerificationTime = probeTime;
        } else if (probeTime - lastVerificationTime >= 1.4 - 0.001) {
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
          const rate = adaptiveRateSamples.length > 1 ? (probeIndex + 1 - first.done) / Math.max(0.1, (now - first.at) / 1000) : (probeIndex + 1) / Math.max(0.1, (now - adaptiveStartedAt) / 1000);
          onProgress(`Giai đoạn A: đã nhảy ${probeIndex + 1}/${totalProbes} mốc; giữ ${totalCandidateCount} nội dung khác nhau.`, Number(Math.min(45, ((probeIndex + 1) / totalProbes) * 45).toFixed(1)), Math.ceil(Math.max(0, totalProbes - probeIndex - 1) / Math.max(0.05, rate)));
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
          if (!finished && performance.now() - lastMediaProgressAt > 4_000) { stallState.stalledAt = nextTargetTime; finish(); }
        }, 1_000);
        const finish = () => { if (finished) return; finished = true; window.clearInterval(watchdog); video.pause(); resolve(); };
        const fail = (error: unknown) => { if (finished) return; finished = true; window.clearInterval(watchdog); video.pause(); reject(error); };
        const processFrame = async (_now: number, metadata: { mediaTime: number }) => {
          if (finished) return;
          try {
            const mediaTime = Math.max(0, Number(metadata.mediaTime || video.currentTime || 0));
            if (mediaTime > lastMediaTime + 0.01) { lastMediaTime = mediaTime; lastMediaProgressAt = performance.now(); }
            if (mediaTime + interval * 0.2 >= nextTargetTime) {
              // Use the actual decoded media time instead of the ideal target
              // time. This avoids assigning a timestamp from the schedule to
              // a nearby frame when the browser callback is delayed.
              scanCurrentFrame(mediaTime);
              do nextTargetTime += interval; while (nextTargetTime <= mediaTime);
            }
            if (queuedCandidateCount >= maxQueuedCandidates) { video.pause(); await batchProcessing; if (!finished && mediaTime < duration - 0.03) await video.play(); }
            if (video.ended || mediaTime >= duration - 0.03) { finish(); return; }
            requestVideoFrame(processFrame);
          } catch (error) { fail(error); }
        };
        video.addEventListener("ended", () => finish(), { once: true });
        requestVideoFrame(processFrame);
        video.play().catch(fail);
      });
      if (stallState.stalledAt !== null && stallState.stalledAt < duration - 0.03) {
        const time = stallState.stalledAt;
        onProgress(`Luồng quét ${runtimeProfile.playbackRate}x bị tạm ngưng tại ${time.toFixed(1)}s; đang tiếp tục bằng chế độ seek an toàn...`, Number(Math.min(44, (time / Math.max(0.1, duration)) * 45).toFixed(1)), null);
        await scanBySeekingFrom(time);
      }
    } else {
      await scanAdaptiveBySeeking();
      scheduleCandidateBatches(true);
      await batchProcessing;
    }
    scheduleCandidateBatches(true);
    await batchProcessing;
    if (totalCandidateCount === 0 && output.length === 0) throw new Error("Bộ dò thay đổi không lấy được frame ứng viên nào.");
    onProgress(`Quét + OCR hoàn tất: ${scannedFrames} mốc → ${totalCandidateCount} ứng viên; nhận ${recognizedLineCount} dòng.`, 95, 0);
    const spannedOutput = buildSpannedFrames(duration);
    output = spannedOutput.map(({ spanEnd: _spanEnd, ...frame }) => frame);
    lastProcessedTimestamp = duration;
    onPartialResults?.(spannedOutput, interval, duration);
    onProgress(`Hoàn tất: ${scannedFrames} frame change-detection → OCR ${spannedOutput.length} ứng viên.`, 100, 0);
    return { frames: spannedOutput, model, duration, frameInterval: interval };
  } catch (error) {
    throw error;
  } finally {
    await screenWakeLock?.release().catch(() => undefined);
    URL.revokeObjectURL(objectUrl);
    video.removeAttribute("src");
    video.load();
  }
}
*/
