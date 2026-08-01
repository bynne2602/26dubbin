import type { Subtitle, SubtitleSettings, BlurBox } from "../types";
import { canvasToPngBlob } from "./videoCapture";
import { getSubtitleVisualScale } from "./subtitleSizing";

export type BurnedSubtitleAsset = {
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

export type VoiceTiming = {
  subtitleId: string;
  start: number;
  end: number;
  rate: number;
};

export async function createTransparentSubtitleFrame(width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, width);
  canvas.height = Math.max(2, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Không thể tạo khung phụ đề trong suốt.");
  context.clearRect(0, 0, canvas.width, canvas.height);
  return canvasToPngBlob(canvas);
}

export const BLUR_COVER_PRESETS = [
  { key: "dark", label: "Tối", bgColor: "rgba(15, 23, 42, 0.7)" },
  { key: "soft", label: "Mờ", bgColor: "rgba(255, 255, 255, 0.15)" },
  { key: "black", label: "Đen", bgColor: "rgba(0, 0, 0, 0.95)" },
  { key: "gray", label: "Xám", bgColor: "rgba(71, 85, 105, 0.6)" },
] as const;

export function parseBlurCoverColor(value: string): { red: number; green: number; blue: number; alpha: number } {
  const rgba = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (!rgba) return { red: 15, green: 23, blue: 42, alpha: 0.7 };
  return {
    red: Math.max(0, Math.min(255, Number(rgba[1]))),
    green: Math.max(0, Math.min(255, Number(rgba[2]))),
    blue: Math.max(0, Math.min(255, Number(rgba[3]))),
    alpha: Math.max(0, Math.min(1, rgba[4] === undefined ? 1 : Number(rgba[4]))),
  };
}

export function getBlurCoverPresetKey(value: string): string {
  const color = parseBlurCoverColor(value);
  return BLUR_COVER_PRESETS.find((preset) => {
    const presetColor = parseBlurCoverColor(preset.bgColor);
    return color.red === presetColor.red && color.green === presetColor.green && color.blue === presetColor.blue;
  })?.key || "custom";
}

export function getBlurCoverCssColor(value: string, opacity: number): string {
  const color = parseBlurCoverColor(value);
  const combinedAlpha = Math.max(0, Math.min(1, color.alpha * opacity));
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${combinedAlpha.toFixed(3)})`;
}

export function getBlurCoverFfmpegColor(value: string, opacity: number): string {
  const color = parseBlurCoverColor(value);
  const combinedAlpha = Math.max(0, Math.min(1, color.alpha * opacity));
  const toHex = (channel: number) => Math.round(channel).toString(16).padStart(2, "0");
  return `0x${toHex(color.red)}${toHex(color.green)}${toHex(color.blue)}@${combinedAlpha.toFixed(3)}`;
}

export async function createBurnedSubtitleAsset(
  subtitle: Subtitle,
  index: number,
  settings: SubtitleSettings,
  blurBoxes: BlurBox[],
  activeBlurBoxId: string | null,
  outputWidth: number,
  outputHeight: number,
): Promise<BurnedSubtitleAsset | null> {
  const text = (subtitle.translated || subtitle.original || "").replace(/\s+/g, " ").trim();
  if (!text || subtitle.end <= subtitle.start) return null;
  // Must use exactly the same visual scale as the HTML preview.
  const visualScale = getSubtitleVisualScale(outputHeight);
  const fontSize = Math.max(1, Math.round(settings.fontSize * visualScale));
  const outlineWidth = Math.max(1, settings.outlineWidth * visualScale);
  const letterSpacing = settings.letterSpacing * visualScale;
  const weight = settings.fontWeight === "normal" ? 400 : settings.fontWeight === "medium" ? 500 : settings.fontWeight === "bold" ? 700 : 900;
  const fontFamily = settings.fontFamily || "Arial";
  const font = `${weight} ${fontSize}px "${fontFamily}", Arial, sans-serif`;
  try { await document.fonts?.load(font, text.slice(0, 80)); } catch { /* fallback to Arial */ }
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
    if (currentLine && measureLine(candidate) > maxTextWidth) { lines.push(currentLine); currentLine = word; }
    else currentLine = candidate;
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
    if (settings.textEffect === "glow") { context.shadowColor = settings.textColor; context.shadowBlur = Math.max(4, fontSize * 0.35); }
    else if (settings.textEffect === "shadow") { context.shadowColor = "rgba(0,0,0,0.9)"; context.shadowBlur = Math.max(2, fontSize * 0.12); context.shadowOffsetX = Math.max(1, fontSize * 0.08); context.shadowOffsetY = Math.max(1, fontSize * 0.08); }
    if (settings.textEffect === "outline") { context.strokeStyle = settings.outlineColor; context.lineWidth = Math.max(1, outlineWidth * 2); drawTextWithSpacing(line, canvas.width / 2, centerY, true); }
    context.fillStyle = settings.textColor;
    drawTextWithSpacing(line, canvas.width / 2, centerY, false);
    context.restore();
  });
  let anchorX = 50;
  let anchorY = 82;
  let alignFromBottom = false;
  if (settings.position === "top") anchorY = 12;
  else if (settings.position === "center") anchorY = 50;
  else if (settings.position === "bottom") { anchorY = 88; alignFromBottom = true; }
  else if (settings.position === "custom") { anchorX = settings.customX ?? 50; anchorY = settings.customY ?? 82; }
  else if (settings.position === "blur-box") {
    const box = blurBoxes.find((item) => item.id === activeBlurBoxId) || blurBoxes[0];
    if (box) { anchorX = box.xPosition + box.width / 2; anchorY = box.yPosition + box.height / 2; }
  }
  const x = Math.max(0, Math.min(outputWidth - canvas.width, Math.round(outputWidth * anchorX / 100 - canvas.width / 2)));
  const rawY = alignFromBottom ? outputHeight * anchorY / 100 - canvas.height : outputHeight * anchorY / 100 - canvas.height / 2;
  const y = Math.max(0, Math.min(outputHeight - canvas.height, Math.round(rawY)));
  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = outputWidth;
  frameCanvas.height = outputHeight;
  const frameContext = frameCanvas.getContext("2d");
  if (!frameContext) throw new Error("Không thể tạo khung track phụ đề.");
  frameContext.clearRect(0, 0, outputWidth, outputHeight);
  frameContext.drawImage(canvas, x, y);
  const blob = await canvasToPngBlob(frameCanvas);
  return { fileName: `hardsub-${index}.png`, blob, width: outputWidth, height: outputHeight, x: 0, y: 0, start: Math.max(0, subtitle.start), end: Math.max(subtitle.start + 0.1, subtitle.end), text };
}

export async function verifyBurnedSubtitlePixels(
  frameBlob: Blob,
  asset: BurnedSubtitleAsset,
  outputWidth: number,
  outputHeight: number,
): Promise<boolean> {
  const [frameBitmap, subtitleBitmap] = await Promise.all([createImageBitmap(frameBlob), createImageBitmap(asset.blob)]);
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
    for (let pixel = 0; pixel < subtitlePixels.length; pixel += 16) {
      if (subtitlePixels[pixel + 3] < 245) continue;
      checked++;
      const distance = Math.abs(subtitlePixels[pixel] - framePixels[pixel]) + Math.abs(subtitlePixels[pixel + 1] - framePixels[pixel + 1]) + Math.abs(subtitlePixels[pixel + 2] - framePixels[pixel + 2]);
      if (distance < 150) matched++;
    }
    return checked >= 8 && matched / checked >= 0.08;
  } finally {
    frameBitmap.close();
    subtitleBitmap.close();
  }
}
