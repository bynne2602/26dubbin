import type { Subtitle } from "../types";

export const SUBTITLE_GUARD_SECONDS = 0.35;

export type ChunkSubtitle = Subtitle & {
  chunkIndex?: number;
  chunkStart?: number;
  chunkEnd?: number;
  boundaryDistance?: number;
};

export function normalizeSubtitleText(value: string): string {
  return (value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function diceSimilarity(left: string, right: string): number {
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

export function stripChunkMetadata(sub: ChunkSubtitle): Subtitle {
  const { chunkIndex: _ci, chunkStart: _cs, chunkEnd: _ce, boundaryDistance: _bd, ...subtitle } = sub;
  return subtitle;
}

export function mergeDuplicateSubtitles(subs: ChunkSubtitle[]): Subtitle[] {
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
      if (timestampsRelated && textMatches) { duplicateIndex = i; break; }
    }
    if (duplicateIndex === -1) { merged.push({ ...sub }); continue; }
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

export function isSubtitleTranslationMissing(subtitle: Pick<Subtitle, "original" | "translated">): boolean {
  const original = normalizeSubtitleText(subtitle.original || "");
  const translated = normalizeSubtitleText(subtitle.translated || "");
  return Boolean(original) && (!translated || translated === original);
}

export type SubtitleOptimizationStats = {
  before: number;
  after: number;
  duplicatesRemoved: number;
  emptyRemoved: number;
  textCleaned: number;
  overlapsFixed: number;
};

function cleanExtractedSubtitleText(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/([!?！？。,.，])\1{2,}/g, "$1$1")
    .trim();
}

function hasUsefulSubtitleText(value: string): boolean {
  const useful = value.match(/[\p{L}\p{N}]/gu)?.length || 0;
  return useful >= 1;
}

/**
 * Final, user-triggered cleanup pass for OCR/STT extraction results.
 * It deliberately looks only at neighboring cues so thousands of subtitles
 * remain fast and legitimate repeated dialogue far apart is preserved.
 */
export function optimizeExtractedSubtitles(
  input: Subtitle[],
  videoDuration?: number,
): { subtitles: Subtitle[]; stats: SubtitleOptimizationStats } {
  const stats: SubtitleOptimizationStats = {
    before: input.length,
    after: 0,
    duplicatesRemoved: 0,
    emptyRemoved: 0,
    textCleaned: 0,
    overlapsFixed: 0,
  };
  const durationLimit = Number.isFinite(videoDuration) && Number(videoDuration) > 0
    ? Number(videoDuration)
    : Number.POSITIVE_INFINITY;
  const cleaned = input
    .map((subtitle) => {
      const original = cleanExtractedSubtitleText(subtitle.original);
      const translated = cleanExtractedSubtitleText(subtitle.translated);
      if (original !== subtitle.original || translated !== subtitle.translated) stats.textCleaned++;
      return {
        ...subtitle,
        original,
        translated,
        start: Math.max(0, Number(subtitle.start) || 0),
        end: Math.min(durationLimit, Math.max(0, Number(subtitle.end) || 0)),
      };
    })
    .filter((subtitle) => {
      const keep = subtitle.end > subtitle.start && hasUsefulSubtitleText(subtitle.original || subtitle.translated);
      if (!keep) stats.emptyRemoved++;
      return keep;
    })
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const optimized: Subtitle[] = [];
  for (const subtitle of cleaned) {
    const current = { ...subtitle };
    const previous = optimized[optimized.length - 1];
    if (previous) {
      const previousText = previous.original || previous.translated;
      const currentText = current.original || current.translated;
      const previousNormalized = normalizeSubtitleText(previousText);
      const currentNormalized = normalizeSubtitleText(currentText);
      const gap = Math.max(0, current.start - previous.end);
      const similarity = diceSimilarity(previousText, currentText);
      const exact = Boolean(previousNormalized) && previousNormalized === currentNormalized;
      const containment = previousNormalized.length >= 3 && currentNormalized.length >= 3
        && (previousNormalized.includes(currentNormalized) || currentNormalized.includes(previousNormalized));
      const duplicate = (exact && gap <= 2.4)
        || (gap <= 1.1 && similarity >= 0.86)
        || (gap <= 0.75 && containment);
      if (duplicate) {
        previous.start = Math.min(previous.start, current.start);
        previous.end = Math.max(previous.end, current.end);
        if (currentNormalized.length > previousNormalized.length) {
          previous.original = current.original;
          previous.translated = current.translated;
        } else if (!previous.translated && current.translated) {
          previous.translated = current.translated;
        }
        stats.duplicatesRemoved++;
        continue;
      }
      if (previous.end > current.start) {
        const trimmedPreviousEnd = current.start - 0.01;
        if (trimmedPreviousEnd >= previous.start + 0.05) {
          previous.end = trimmedPreviousEnd;
        } else if (previous.end + 0.02 >= current.end) {
          previous.end = Math.max(previous.end, current.end);
          previous.original = [previous.original, current.original].filter(Boolean).join("\n");
          previous.translated = [previous.translated, current.translated].filter(Boolean).join("\n");
          stats.overlapsFixed++;
          continue;
        } else {
          current.start = previous.end + 0.01;
        }
        stats.overlapsFixed++;
      }
    }
    if (current.end <= current.start + 0.01) {
      stats.emptyRemoved++;
      continue;
    }
    optimized.push(current);
  }
  const finalSubtitles = optimized.filter((subtitle) => subtitle.end > subtitle.start);
  stats.after = finalSubtitles.length;
  return { subtitles: finalSubtitles, stats };
}

export function normalizeChunkSubtitleTimestamps(
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

export function validateSubtitleTimeline(
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
    if (previous.end > guardedEnd && guardedEnd >= previous.start + 0.1) previous.end = guardedEnd;
    if (previous.end > current.start) previous.end = Math.max(previous.start + 0.05, current.start);
  }
  return sorted.filter((sub) => sub.end > sub.start);
}

export function formatTtsTime(sec: number): string {
  if (isNaN(sec) || !isFinite(sec)) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function formatEstimatedTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${Math.max(1, seconds)} giây`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (hours <= 0) return `${minutes} phút`;
  if (minutes <= 0) return `${hours} giờ`;
  return `${hours} giờ ${minutes} phút`;
}

export const SMART_TTS_MIN_RATE = 1.2;
// 1.3x is the highest automatic rate we allow before shortening the script.
// Faster narration remains intelligible only when pitch-preserving time stretch
// is used, but it still sounds rushed and makes subtitle timing harder to follow.
export const SMART_TTS_MAX_RATE = 1.3;
export const SMART_TTS_VOICE_GAP_SECONDS = 0.06;

export function getSubtitleGapAfter(sub: Subtitle, allSubs: Subtitle[]): number {
  const sorted = [...allSubs].sort((a, b) => a.start - b.start);
  const idx = sorted.findIndex((s) => s.id === sub.id);
  if (idx === -1 || idx === sorted.length - 1) return 3;
  const next = sorted[idx + 1];
  return Math.max(0, next.start - sub.end);
}

export function computeSmartTtsRate(
  audioDuration: number,
  subDuration: number,
  gapAfter: number,
  baseRate: number
): number {
  const clamp = (r: number) => Math.max(SMART_TTS_MIN_RATE, Math.min(SMART_TTS_MAX_RATE, r));
  const availableDuration = Math.max(0.05, subDuration + Math.max(0, gapAfter));
  return clamp(Math.max(baseRate, audioDuration / availableDuration));
}

export function splitTtsTextIntoClauses(text: string): string[] {
  const parts = text
    .match(/[^,.;:!?，。！？；：]+[,.;:!?，。！？；：]?/gu)
    ?.map((part) => part.trim())
    .filter(Boolean) || [text.trim()];
  if (parts.length <= 1 || text.length < 80) return [text.trim()];
  return parts;
}
