import express from "express";
import path from "path";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import dotenv from "dotenv";
import { getPaddleOcrHealth, initializePaddleOcr, recognizeOcrBatch, recognizeOcrFrame } from "./src/server/pythonPaddleOcr";
import { preloadNgocHuyen, synthesizeVieNeu } from "./src/server/vieneuTts";
import { verifyLicense } from "./src/server/licenseDb";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import multer from "multer";
import { randomUUID } from "crypto";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { resolveBeeknoeeVoice } from "./src/lib/beeknoeeTts";

// CJS Electron bundle supplies __dirname; tsx development is launched at project root.
// @ts-ignore — __dirname is supplied by the CJS Electron bundle.
const __dirnameCompat: string = typeof __dirname !== "undefined"
  ? __dirname
  : process.cwd();

dotenv.config();

function buildOrderedScriptNarration(script: any): string {
  const parts = [script?.hook, script?.body, script?.ending]
    .map((part) => String(part || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const unique = parts.filter((part, index) => index === 0 || part !== parts[index - 1]);
  if (unique.length) return unique.join("\n\n");
  return String(script?.fullText || "").replace(/\s+/g, " ").trim();
}

function fitShortsNarration(script: any, maxWords = 105): string {
  const clean = (value: unknown) => String(value || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/(?:^|\s)#[\p{L}\p{N}_-]+/gu, "")
    .replace(/[\[({][^\])}]{1,80}[\])}]/g, "")
    .replace(/[*_`~]/g, "")
    .replace(/^\s*(?:hook|body|ending|mở đầu|nội dung|kết thúc)\s*[:\-–—]\s*/i, "")
    .replace(/\.{3,}/g, ".")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const words = (value: string) => value ? value.split(" ") : [];
  const hook = words(clean(script?.hook)).slice(0, 28);
  const ending = words(clean(script?.ending)).slice(0, 28);
  const bodyBudget = Math.max(1, maxWords - hook.length - ending.length);
  const body = words(clean(script?.body)).slice(0, bodyBudget);
  const fitted = [hook.join(" "), body.join(" "), ending.join(" ")].filter(Boolean).join("\n\n");
  return fitted || words(buildOrderedScriptNarration(script)).slice(0, maxWords).join(" ");
}

async function smoothNgocHuyenAudio(audio: Buffer): Promise<Buffer> {
  const ffmpeg = findBundledFfmpeg();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dubbin-ngoc-huyen-"));
  const inputPath = path.join(tempDir, "raw.wav");
  const outputPath = path.join(tempDir, "smooth.wav");
  fs.writeFileSync(inputPath, audio);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
        "-af", "silenceremove=stop_periods=-1:stop_duration=0.20:stop_threshold=-35dB:stop_silence=0.10,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-48dB,areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-48dB,areverse,aresample=48000:async=1:first_pts=0,alimiter=limit=0.95",
        "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outputPath,
      ], { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => code === 0
        ? resolve()
        : reject(new Error(`Không thể làm mượt giọng Ngọc Huyền: ${stderr.slice(-500)}`)));
    });
    return fs.readFileSync(outputPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function concatWavAudio(parts: Buffer[]): Promise<Buffer> {
  if (parts.length === 1) return parts[0];
  const ffmpeg = findBundledFfmpeg();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dubbin-tts-concat-"));
  const outputPath = path.join(tempDir, "voice.wav");
  try {
    const inputs: string[] = [];
    parts.forEach((part, index) => {
      const partPath = path.join(tempDir, `part-${index}.wav`);
      fs.writeFileSync(partPath, part);
      inputs.push("-i", partPath);
    });
    const prepared = parts.map((_part, index) => `[${index}:a]apad=pad_dur=0.12[p${index}]`).join(";");
    const labels = parts.map((_part, index) => `[p${index}]`).join("");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y", ...inputs,
        "-filter_complex", `${prepared};${labels}concat=n=${parts.length}:v=0:a=1[outa]`,
        "-map", "[outa]", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outputPath,
      ], { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => code === 0
        ? resolve()
        : reject(new Error(`Không thể nối các đoạn Ngọc Huyền: ${stderr.slice(-500)}`)));
    });
    return fs.readFileSync(outputPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function synthesizeBeeknoeeGoogle(
  text: string,
  voiceSelection: unknown,
  credentials: { licenseKey: string; hwid: string; tiktokSessionId?: string },
  signal?: AbortSignal,
): Promise<{ audio: Buffer; contentType: string; voice: ReturnType<typeof resolveBeeknoeeVoice> }> {
  const cleanText = text.replace(/\s+/g, " ").trim();
  if (!cleanText) throw new Error("Kịch bản trống, không thể tạo giọng đọc.");
  if (cleanText.length > 4_900) throw new Error(`Kịch bản dài ${cleanText.length} ký tự, vượt ngân sách an toàn 4.900 ký tự của Google TTS.`);
  const voice = resolveBeeknoeeVoice(voiceSelection);
  if (voice.engine === "vieneu") {
    const isNgocHuyen = voice.id.includes("Ngọc Huyền");
    // VieNeu standard performs punctuation-aware splitting and true Torch batch
    // generation internally. Keep one request here so the voice retains context,
    // runs faster, and cannot drift between independently generated fragments.
    const chunks = [cleanText];
    const audioPartPromises: Promise<Buffer>[] = [];
    for (const chunk of chunks) {
      if (signal?.aborted) throw new Error("Tác vụ đã được hủy.");
      const generated = await synthesizeVieNeu(chunk, voice.id, isNgocHuyen ? "tin_tuc" : "tu_nhien");
      const rawAudio = Buffer.from(generated.audio, "base64");
      // Let FFmpeg smooth the completed chunk while the persistent TTS worker
      // immediately starts synthesizing the next one. This overlaps CPU/audio I/O
      // with GPU inference without loading a second model into VRAM.
      audioPartPromises.push(isNgocHuyen ? smoothNgocHuyenAudio(rawAudio) : Promise.resolve(rawAudio));
    }
    const audioParts = await Promise.all(audioPartPromises);
    const audio = await concatWavAudio(audioParts);
    return { audio, contentType: "audio/wav", voice };
  }
  if (voice.engine === "tiktok") {
    const sessionId = String(credentials.tiktokSessionId || process.env.TIKTOK_SESSIONID || "").trim();
    if (!sessionId) throw new Error("Giọng TikTok cần Session ID. Hãy nhập Session ID trong tab Lồng tiếng trước.");
    const url = new URL("https://api16-normal-c-useast1a.tiktokv.com/media/api/text/speech/invoke/");
    url.searchParams.set("text_speaker", voice.id);
    url.searchParams.set("req_text", cleanText);
    url.searchParams.set("speaker_map_type", "0");
    url.searchParams.set("aid", "1233");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": "com.zhiliaoapp.musically/2022600030 (Linux; U; Android 7.1.2; en_US; SM-G973N; Build/N2G48H;tt-ok/3.12.13.1)",
        Cookie: `sessionid=${sessionId}`,
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`TikTok TTS lỗi HTTP ${response.status}.`);
    const payload: any = await response.json();
    if (payload?.status_code !== 0 || !payload?.data?.v_str) {
      if ([1, 2, 5].includes(payload?.status_code) || /session/i.test(String(payload?.message || ""))) {
        throw new Error("TikTok Session ID không hợp lệ hoặc đã hết hạn.");
      }
      throw new Error(`TikTok TTS lỗi: ${payload?.message || payload?.status_code || "không xác định"}.`);
    }
    return { audio: Buffer.from(payload.data.v_str, "base64"), contentType: "audio/mpeg", voice };
  }
  if (!credentials.licenseKey || !credentials.hwid) throw new Error("Thiếu license để sử dụng Google TTS.");
  const proxyUrl = String(process.env.DUBBIN_TTS_PROXY_URL || "https://dubbintool.io.vn/api/tts").trim();
  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: voice.model,
      input: cleanText,
      voice: voice.id,
      licenseKey: credentials.licenseKey,
      hwid: credentials.hwid,
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    let message = detail;
    try { message = JSON.parse(detail)?.error || detail; } catch {}
    throw new Error(`Google TTS lỗi HTTP ${response.status}${message ? `: ${message.slice(0, 500)}` : ""}`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 256) throw new Error("Google TTS Beeknoee trả về audio rỗng.");
  return { audio, contentType: response.headers.get("content-type") || "audio/mpeg", voice };
}

function parseTimeToSeconds(timeVal: any): number {
  if (timeVal === undefined || timeVal === null) return 0;
  if (typeof timeVal === "number") return timeVal;
  
  let str = String(timeVal).trim();
  if (!str) return 0;
  
  // Strip potential wrapping quotes/characters
  str = str.replace(/['"]/g, "");
  
  // If it's a plain number string (e.g., "170.5")
  if (/^\d+(\.\d+)?$/.test(str)) {
    return parseFloat(str);
  }

  // Prefer the documented formats MM:SS.hh and HH:MM:SS.hh.
  // Parse the fractional part by its actual precision so .5, .50 and .500 are all 0.5s.
  const timestampMatch = str.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/);
  if (timestampMatch) {
    const [, hours, minutes, seconds, fraction = ""] = timestampMatch;
    const fractionSeconds = fraction ? Number(`0.${fraction}`) : 0;
    return (Number(hours || 0) * 3600) + (Number(minutes) * 60) + Number(seconds) + fractionSeconds;
  }
  
  // Split by both colon and dot to handle all possible formats:
  const parts = str.split(/[:.]/);
  if (parts.length === 2) {
    const mins = parseFloat(parts[0]) || 0;
    const secs = parseFloat(parts[1]) || 0;
    return mins * 60 + secs;
  } else if (parts.length === 3) {
    const lastDotIndex = str.lastIndexOf('.');
    const lastColonIndex = str.lastIndexOf(':');
    const p0 = parseFloat(parts[0]) || 0;
    const p1 = parseFloat(parts[1]) || 0;
    const p2 = parseFloat(parts[2]) || 0;
    if (lastDotIndex > lastColonIndex) return p0 * 60 + p1 + p2 / 100;
    return p0 < 10 ? p0 * 60 + p1 + p2 / 100 : p0 * 3600 + p1 * 60 + p2;
  } else if (parts.length === 4) {
    const hrs = parseFloat(parts[0]) || 0;
    const mins = parseFloat(parts[1]) || 0;
    const secs = parseFloat(parts[2]) || 0;
    const ms = parseFloat(parts[3]) || 0;
    return hrs * 3600 + mins * 60 + secs + ms / 100;
  }
  
  const parsed = parseFloat(str);
  return isNaN(parsed) ? 0 : parsed;
}

function findBundledFfmpeg(): string {
  const resourceRoot = process.env.OCR_RESOURCES_PATH || path.join(process.cwd(), "resources");
  const candidates = [
    path.join(resourceRoot, "ocr-engine", "_internal", "imageio_ffmpeg", "binaries", "ffmpeg-win-x86_64-v7.1.exe"),
    path.join(process.cwd(), "resources", "ocr-engine", "_internal", "imageio_ffmpeg", "binaries", "ffmpeg-win-x86_64-v7.1.exe"),
    "ffmpeg",
  ];
  return candidates.find((candidate) => candidate === "ffmpeg" || fs.existsSync(candidate)) || "ffmpeg";
}

function isBlockedVideoHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "0.0.0.0" || host === "::1"
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

type VideoPlatform = "youtube" | "tiktok" | "douyin" | "kuaishou" | "bilibili" | "facebook" | "instagram" | "x" | "direct" | "other";

function normalizeVideoUrl(input: unknown): URL {
  const raw = String(input || "").trim();
  const extracted = raw.match(/https?:\/\/[^\s<>"']+/i)?.[0]
    || raw.match(/(?:www\.)?[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>"']*)?/i)?.[0]
    || raw;
  const cleaned = extracted.replace(/[),.;!?]+$/g, "");
  let parsed: URL;
  try { parsed = new URL(/^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`); }
  catch { throw new Error("Link video không hợp lệ. Hãy dán link đầy đủ từ nền tảng."); }
  if (!/^https?:$/.test(parsed.protocol) || isBlockedVideoHost(parsed.hostname)) {
    throw new Error("Link video không được hỗ trợ hoặc không an toàn.");
  }
  return parsed;
}

function identifyVideoPlatform(url: URL): VideoPlatform {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be" || host.endsWith("youtube.com")) return "youtube";
  if (host.endsWith("tiktok.com")) return "tiktok";
  if (host.endsWith("douyin.com") || host.endsWith("iesdouyin.com")) return "douyin";
  if (host.endsWith("kuaishou.com") || host.endsWith("gifshow.com")) return "kuaishou";
  if (host === "b23.tv" || host.endsWith("bilibili.com")) return "bilibili";
  if (host === "fb.watch" || host.endsWith("facebook.com")) return "facebook";
  if (host.endsWith("instagram.com")) return "instagram";
  if (host.endsWith("twitter.com") || host.endsWith("x.com")) return "x";
  if (/\.(mp4|mov|m4v|webm)(?:$|[?#])/i.test(url.href)) return "direct";
  return "other";
}

async function runProcess(binary: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Tác vụ đã được hủy."));
    const child = spawn(binary, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error("Tải video quá thời gian cho phép."));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 100_000) stdout = stdout.slice(-100_000); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 100_000) stderr = stderr.slice(-100_000); });
    const abort = () => { try { child.kill(); } catch {} reject(new Error("Tác vụ đã được hủy.")); };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve({ code, stdout, stderr }); });
  });
}

async function ensureYtDlp(sendStatus?: (message: string) => void): Promise<string> {
  const localRuntime = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "DubbinTool", "runtime");
  const runtimeBinary = path.join(localRuntime, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  const bundledBinary = path.join(process.env.OCR_RESOURCES_PATH || path.join(process.cwd(), "resources"), "media-downloader", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  const developmentBinary = path.join(process.cwd(), ".venv", "Scripts", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  const configured = String(process.env.YT_DLP_BINARY || "").trim();
  const candidates = [configured, bundledBinary, developmentBinary, runtimeBinary, "yt-dlp"].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate !== "yt-dlp" && !fs.existsSync(candidate)) continue;
    try {
      const result = await runProcess(candidate, ["--version"], 8_000);
      if (result.code === 0) return candidate;
    } catch {}
  }
  if (process.platform !== "win32") throw new Error("Máy chưa có yt-dlp để tải video từ nền tảng này.");
  fs.mkdirSync(localRuntime, { recursive: true });
  sendStatus?.("Đang tải bộ nhận diện link video mới nhất...");
  const response = await fetch("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe", { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error("Không thể tải bộ nhận diện link video.");
  const temporary = `${runtimeBinary}.download`;
  await pipeline(Readable.fromWeb(response.body as any), fs.createWriteStream(temporary));
  fs.renameSync(temporary, runtimeBinary);
  return runtimeBinary;
}

function friendlyDownloadError(platform: VideoPlatform, details: string): Error {
  const lower = details.toLowerCase();
  const label = ({ tiktok: "TikTok", douyin: "Douyin", kuaishou: "Kuaishou", youtube: "YouTube", bilibili: "Bilibili", facebook: "Facebook", instagram: "Instagram", x: "X/Twitter" } as Partial<Record<VideoPlatform, string>>)[platform] || "nền tảng này";
  if (/login|cookie|sign in|authentication|private|not available in your region/.test(lower)) {
    return new Error(`${label} yêu cầu đăng nhập, cookie hợp lệ hoặc video không công khai.`);
  }
  if (/unsupported url/.test(lower)) return new Error(`yt-dlp chưa hỗ trợ cấu trúc link ${label} này. Hãy thử link chia sẻ gốc của video.`);
  if (/unable to extract|extractor|rehydration|impersonat/.test(lower)) {
    return new Error(`Bộ tải chưa đọc được dữ liệu từ ${label}. Tool đã thử các chế độ dự phòng; hãy kiểm tra video còn công khai hoặc thử lại sau.`);
  }
  return new Error(`Không tải được video từ ${label}: ${details.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 700)}`);
}

async function downloadWithYtDlp(rawUrl: string, platform: VideoPlatform, sourcePath: string, sendStatus?: (message: string) => void, signal?: AbortSignal): Promise<void> {
  const ytDlp = await ensureYtDlp(sendStatus);
  // Standalone builds can self-update. Failure is non-fatal (offline/firewall).
  const runtimeBinary = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "DubbinTool", "runtime", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  const updateStamp = `${ytDlp}.last-update`;
  const updateDue = ytDlp === runtimeBinary
    && (!fs.existsSync(updateStamp) || Date.now() - fs.statSync(updateStamp).mtimeMs > 24 * 60 * 60_000);
  if (updateDue) {
    try {
      const updated = await runProcess(ytDlp, ["--update-to", "stable@latest"], 90_000);
      if (updated.code === 0) fs.writeFileSync(updateStamp, new Date().toISOString());
    } catch {}
  }

  const common = [
    "--no-playlist", "--no-warnings", "--no-progress", "--restrict-filenames",
    "--retries", "4", "--fragment-retries", "4", "--extractor-retries", "3",
    "--retry-sleep", "http:linear=1:4:1", "--retry-sleep", "fragment:linear=1:4:1",
    "--socket-timeout", "30", "--max-filesize", "300M", "--merge-output-format", "mp4",
    "--output", sourcePath,
  ];
  const format = ["--format", "bv*[height<=720]+ba/b[height<=720]/b"];
  const attempts: string[][] = [[...common, ...format]];

  const targets = await runProcess(ytDlp, ["--list-impersonate-targets"], 15_000).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (targets.code === 0 && /chrome|edge|safari/i.test(targets.stdout)) {
    attempts.push([...common, "--impersonate", "chrome", ...format]);
  }
  if (platform === "tiktok") {
    attempts.push([...common, "--extractor-args", "tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com", ...format]);
  }
  // Final conservative fallback works on extractors that expose only one progressive stream.
  attempts.push([...common, "--format", "b[ext=mp4]/b"]);

  let diagnostics = "";
  for (let index = 0; index < attempts.length; index++) {
    try { if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath); } catch {}
    sendStatus?.(`Đang tải ${platform === "other" ? "video" : platform} · phương án ${index + 1}/${attempts.length}...`);
    const result = await runProcess(ytDlp, [...attempts[index], rawUrl], 240_000, signal);
    diagnostics = `${result.stderr}\n${result.stdout}`;
    if (result.code === 0 && fs.existsSync(sourcePath) && fs.statSync(sourcePath).size >= 1024) return;
  }
  throw friendlyDownloadError(platform, diagnostics || "yt-dlp không trả về dữ liệu video.");
}

// Robust repair of truncated JSON arrays of objects to salvage partial transcription
function tryParsePartialJsonArray(jsonStr: string): any[] {
  let text = jsonStr.trim();
  
  // Try parsing directly first
  try {
    return JSON.parse(text);
  } catch (e) {
    console.log("Direct JSON parse failed. Attempting to repair truncated array...");
  }

  // Find first '[' and last '}'
  const firstBracket = text.indexOf('[');
  if (firstBracket === -1) return [];

  const lastBrace = text.lastIndexOf('}');
  if (lastBrace === -1) return [];

  // Slice from first '[' to last '}' and append ']' to close the array properly
  let partial = text.substring(firstBracket, lastBrace + 1) + ']';

  try {
    return JSON.parse(partial);
  } catch (e2: any) {
    console.warn("Attempt 1 to repair partial JSON failed:", e2.message);
    
    // If it still fails, it might be truncated inside an object, so find the second to last '}'
    const secondsLastBrace = text.substring(0, lastBrace).lastIndexOf('}');
    if (secondsLastBrace !== -1) {
      let partial2 = text.substring(firstBracket, secondsLastBrace + 1) + ']';
      try {
        return JSON.parse(partial2);
      } catch (e3: any) {
        console.warn("Attempt 2 to repair partial JSON failed:", e3.message);
      }
    }
  }

  return [];
}

function parseSubtitleTranslations(responseText: string, expectedCount: number): Map<number, string> {
  const clean = responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: any;
  try {
    parsed = JSON.parse(clean);
  } catch {
    parsed = tryParsePartialJsonArray(clean);
  }

  const nested = !Array.isArray(parsed) && parsed && typeof parsed === "object"
    ? parsed.translations ?? parsed.subtitles ?? parsed.items ?? parsed.results ?? parsed.data ?? parsed
    : parsed;
  const items: any[] = Array.isArray(nested)
    ? nested
    : nested && typeof nested === "object"
      ? Object.entries(nested).map(([index, value]) => ({ index, translated: value }))
      : [];

  const result = new Map<number, string>();
  const explicitIndexes = items
    .map((item) => Number(item && typeof item === "object" ? item.index ?? item.position ?? item.order : NaN))
    .filter(Number.isInteger);
  const oneBased = explicitIndexes.length > 0
    && !explicitIndexes.includes(0)
    && explicitIndexes.every((index) => index >= 1 && index <= expectedCount);

  items.forEach((item, position) => {
    const objectItem = item && typeof item === "object" ? item : null;
    const rawIndex = objectItem ? Number(objectItem.index ?? objectItem.position ?? objectItem.order) : NaN;
    const index = Number.isInteger(rawIndex) ? rawIndex - (oneBased ? 1 : 0) : position;
    const value = objectItem
      ? objectItem.translated ?? objectItem.translation ?? objectItem.translatedText ?? objectItem.text ?? objectItem.output
      : item;
    const translated = String(value ?? "").replace(/\s+/g, " ").trim();
    if (index >= 0 && index < expectedCount && translated) result.set(index, translated);
  });

  return result;
}

function isUntranslated(original: string, translated: string, isSameLanguage: boolean): boolean {
  if (!translated || !translated.trim()) return true;
  if (isSameLanguage) return false;
  
  const cleanOrig = original.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "").trim();
  const cleanTrans = translated.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "").trim();
  
  if (cleanOrig === cleanTrans) {
    const hasLetters = /[a-zA-Z\u00C0-\u024F\u1E00-\u1EFF]/.test(cleanOrig);
    if (hasLetters) {
      const commonUnchanged = ["ok", "okay", "ai", "google", "facebook", "youtube", "tiktok", "instagram", "video", "audio", "sms", "chat", "app", "web", "internet", "wifi"];
      if (commonUnchanged.includes(cleanOrig)) {
        return false;
      }
      return true;
    }
  }
  return false;
}

const geminiKeyCursor = new Map<string, number>();

type ApiUsageStatus = "unused" | "available" | "limited" | "error";

type ApiUsageStat = {
  id: string;
  provider: "gemini" | "custom";
  label: string;
  model: string;
  status: ApiUsageStatus;
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
  rateLimit: {
    requestLimit: string | null;
    requestRemaining: string | null;
    requestReset: string | null;
    tokenLimit: string | null;
    tokenRemaining: string | null;
    tokenReset: string | null;
  };
};

const apiUsageStats = new Map<string, ApiUsageStat>();

function maskApiCredential(value: string): string {
  const suffix = value.trim().slice(-4);
  return suffix ? `••••${suffix}` : "chưa cấu hình";
}

function getApiUsageStat(
  provider: ApiUsageStat["provider"],
  credential: string,
  model: string,
): ApiUsageStat {
  const id = `${provider}:${credential}`;
  let stat = apiUsageStats.get(id);
  if (!stat) {
    stat = {
      id,
      provider,
      label: `${provider === "gemini" ? "Gemini" : "Custom API"} ${maskApiCredential(credential)}`,
      model: model || (provider === "gemini" ? "Chưa sử dụng" : "Chưa chọn model"),
      status: "unused",
      requests: 0,
      successes: 0,
      failures: 0,
      quotaErrors: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastOperation: "",
      lastUsedAt: null,
      lastError: "",
      rateLimit: {
        requestLimit: null,
        requestRemaining: null,
        requestReset: null,
        tokenLimit: null,
        tokenRemaining: null,
        tokenReset: null,
      },
    };
    apiUsageStats.set(id, stat);
  }
  if (model) stat.model = model;
  return stat;
}

function recordApiAttempt(stat: ApiUsageStat, operation: string): void {
  stat.requests++;
  stat.lastOperation = operation;
  stat.lastUsedAt = new Date().toISOString();
}

function recordApiSuccess(stat: ApiUsageStat, result?: any): void {
  stat.successes++;
  stat.status = "available";
  stat.lastError = "";
  const usage = result?.usageMetadata ?? result?.usage ?? {};
  const input = Number(usage.promptTokenCount ?? usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.candidatesTokenCount ?? usage.output_tokens ?? usage.completion_tokens ?? 0);
  const total = Number(usage.totalTokenCount ?? usage.total_tokens ?? input + output);
  if (Number.isFinite(input)) stat.inputTokens += input;
  if (Number.isFinite(output)) stat.outputTokens += output;
  if (Number.isFinite(total)) stat.totalTokens += total;
}

function recordApiFailure(stat: ApiUsageStat, error: any, quotaLimited = false): void {
  stat.failures++;
  stat.lastError = String(error?.message || error || "Lỗi không xác định").slice(0, 300);
  if (quotaLimited) {
    stat.quotaErrors++;
    stat.status = "limited";
  } else {
    stat.status = "error";
  }
}

function updateRateLimitFromHeaders(stat: ApiUsageStat, headers: Headers): void {
  const read = (...names: string[]) => names.map((name) => headers.get(name)).find(Boolean) ?? null;
  stat.rateLimit.requestLimit = read("x-ratelimit-limit-requests", "ratelimit-limit-requests", "x-ratelimit-limit");
  stat.rateLimit.requestRemaining = read("x-ratelimit-remaining-requests", "ratelimit-remaining-requests", "x-ratelimit-remaining");
  stat.rateLimit.requestReset = read("x-ratelimit-reset-requests", "ratelimit-reset-requests", "x-ratelimit-reset");
  stat.rateLimit.tokenLimit = read("x-ratelimit-limit-tokens", "ratelimit-limit-tokens");
  stat.rateLimit.tokenRemaining = read("x-ratelimit-remaining-tokens", "ratelimit-remaining-tokens");
  stat.rateLimit.tokenReset = read("x-ratelimit-reset-tokens", "ratelimit-reset-tokens");
}

function parseGeminiKeyValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(parseGeminiKeyValue);
  }
  if (typeof value !== "string") return [];

  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      return parseGeminiKeyValue(JSON.parse(trimmed));
    } catch {
      // Fall through and parse it as a delimiter-separated value.
    }
  }

  return trimmed
    .split(/[\r\n,;]+/)
    .map((key) => key.trim())
    .filter(Boolean);
}

function getGeminiApiKeys(req: express.Request): string[] {
  const clientKeys = [
    ...parseGeminiKeyValue(req.headers["x-gemini-api-keys"]),
    ...parseGeminiKeyValue(req.headers["x-gemini-api-key"]),
    ...parseGeminiKeyValue(req.body?.geminiApiKeys),
    ...parseGeminiKeyValue(req.body?.geminiApiKey),
  ];
  const configuredKeys = clientKeys.length > 0
    ? clientKeys
    : [
        ...parseGeminiKeyValue(process.env.GEMINI_API_KEYS),
        ...parseGeminiKeyValue(process.env.GEMINI_API_KEY),
      ];
  return Array.from(new Set(configuredKeys));
}

function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function isGeminiQuotaError(error: any): boolean {
  const status = Number(error?.status ?? error?.statusCode ?? error?.code ?? error?.error?.code);
  const message = [
    error?.message,
    error?.statusText,
    error?.error?.message,
    error?.cause?.message,
  ].filter(Boolean).join(" ");
  return status === 429 || /\b429\b|resource[_ -]?exhausted|quota|rate[ _-]?limit/i.test(message);
}

class GeminiKeysExhaustedError extends Error {
  statusCode = 429;

  constructor(keyCount: number, cause?: any) {
    super(`Tất cả ${keyCount} Gemini API key đều đã hết quota hoặc đang bị giới hạn. Vui lòng thêm key mới hoặc thử lại sau.`);
    this.name = "GeminiKeysExhaustedError";
    if (cause) (this as any).cause = cause;
  }
}

async function runWithGeminiKeyRotation<T>(
  apiKeys: string[],
  operationName: string,
  operation: (ai: GoogleGenAI) => Promise<T>,
): Promise<T> {
  if (apiKeys.length === 0) {
    throw new Error("Chưa cấu hình Gemini API Key.");
  }

  // The pool id is kept in memory only and is never written to logs.
  const poolId = apiKeys.join("\u0000");
  const startIndex = Math.min(geminiKeyCursor.get(poolId) ?? 0, apiKeys.length - 1);
  let lastQuotaError: any;

  for (let offset = 0; offset < apiKeys.length; offset++) {
    const keyIndex = (startIndex + offset) % apiKeys.length;
    const stat = getApiUsageStat("gemini", apiKeys[keyIndex], operationName.includes("TTS") ? "gemini-3.1-flash-tts-preview" : "gemini-3.5-flash");
    recordApiAttempt(stat, operationName);
    try {
      const result = await operation(createGeminiClient(apiKeys[keyIndex]));
      recordApiSuccess(stat, result);
      geminiKeyCursor.set(poolId, keyIndex);
      return result;
    } catch (error: any) {
      const quotaLimited = isGeminiQuotaError(error);
      recordApiFailure(stat, error, quotaLimited);
      if (!quotaLimited) throw error;
      lastQuotaError = error;
      console.warn(`${operationName}: Gemini key #${keyIndex + 1}/${apiKeys.length} reached quota; switching to the next key.`);
    }
  }

  throw new GeminiKeysExhaustedError(apiKeys.length, lastQuotaError);
}

function getErrorHttpStatus(error: any): number {
  if (error instanceof GeminiKeysExhaustedError || isGeminiQuotaError(error)) return 429;
  const status = Number(error?.statusCode ?? error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function normalizeCustomApiChatUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error("Custom API URL đang để trống.");
  }

  let cleaned = rawUrl
    .trim()
    .replace(/^(?:POST|GET|PUT|PATCH|DELETE)\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  if (!/^https?:\/\//i.test(cleaned)) cleaned = `https://${cleaned}`;

  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    throw new Error("Custom API URL không hợp lệ. Ví dụ đúng: https://platform.beeknoee.com/v1");
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (!/\/chat\/completions$/i.test(normalizedPath)) {
    url.pathname = `${normalizedPath}/chat/completions`.replace(/\/{2,}/g, "/");
  } else {
    url.pathname = normalizedPath;
  }
  return url.toString();
}

function extractCustomApiText(rawResponse: string): string {
  const trimmed = rawResponse.trim();
  if (!trimmed) return "";

  try {
    const data = JSON.parse(trimmed);
    const content = data?.choices?.[0]?.message?.content
      ?? data?.choices?.[0]?.text
      ?? data?.output_text
      ?? data?.response
      ?? data?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part: any) => typeof part === "string" ? part : (part?.text ?? part?.content ?? ""))
        .filter(Boolean)
        .join("\n");
    }
  } catch {
    // Some compatible providers return the assistant content as plain text.
  }
  return trimmed;
}

function summarizeCustomApiError(status: number, rawResponse: string): string {
  let detail = rawResponse.trim();
  try {
    const data = JSON.parse(detail);
    detail = data?.error?.message ?? data?.message ?? data?.detail ?? detail;
  } catch {
    // Keep the provider's plain-text response.
  }
  const safeDetail = String(detail || "Không có nội dung lỗi từ nhà cung cấp.").slice(0, 500);
  return `Custom API trả về HTTP ${status}: ${safeDetail}`;
}

async function trackedCustomApiFetch(
  targetUrl: string,
  apiKey: string,
  model: string,
  operation: string,
  init: RequestInit,
): Promise<Response> {
  const stat = getApiUsageStat("custom", apiKey, model || "Chưa chọn model");
  recordApiAttempt(stat, operation);
  const timeoutMs = /text-only|subtitle fitting|kiểm tra/i.test(operation) ? 60_000 : 180_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(targetUrl, { ...init, signal: init.signal || controller.signal });
    updateRateLimitFromHeaders(stat, response.headers);
    if (response.ok) {
      const usagePayload = await response.clone().json().catch(() => undefined);
      recordApiSuccess(stat, usagePayload);
    } else {
      recordApiFailure(stat, `HTTP ${response.status}`, response.status === 429);
    }
    return response;
  } catch (error: any) {
    const timedOut = controller.signal.aborted;
    const failure = timedOut
      ? new Error(`Custom API quá thời gian ${Math.round(timeoutMs / 1000)} giây (${operation}). Hãy chọn model nhanh hơn hoặc thử lại.`)
      : error;
    recordApiFailure(stat, failure, false);
    throw failure;
  } finally {
    clearTimeout(timeout);
  }
}

async function startServer() {
  const app = express();

  // Native OCR is a lazy safety net. Do not allocate Node worker_threads/model
  // memory unless both WebGPU and browser WASM have actually failed.

  // Large media uses multipart/streaming routes. Keeping JSON at 100 GB lets a
  // single base64 request exhaust V8 memory before the route can reject it.
  // 512 MB still covers legacy short-video requests without risking a process crash.
  const skipMultipart = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (req.headers["content-type"]?.startsWith("multipart/form-data")) return next();
    express.json({ limit: "512mb" })(req, _res, next);
  };
  const skipMultipartUrlEncoded = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (req.headers["content-type"]?.startsWith("multipart/form-data")) return next();
    express.urlencoded({ limit: "32mb", extended: true })(req, _res, next);
  };
  app.use(skipMultipart);
  app.use(skipMultipartUrlEncoded);

  // API Endpoints
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date() });
  });

  // Trả về HWID của máy hiện tại (Electron truyền qua env)
  app.get("/api/license/hwid", (req, res) => {
    const hwid = process.env.HWID ?? "web-mode";
    res.json({ hwid });
  });

  // Verify license key
  app.post("/api/license/verify", (req, res) => {
    const { key, hwid } = req.body as { key?: string; hwid?: string };
    if (!key || !hwid) {
      return res.status(400).json({ valid: false, reason: "Thiếu key hoặc hwid." });
    }
    const result = verifyLicense(key.trim(), hwid.trim());
    return res.json(result);
  });

  app.get("/api/ocr/health", async (req, res) => {
    const currentHealth = getPaddleOcrHealth();
    if (currentHealth.state === "idle" || (req.query.retry === "1" && currentHealth.state === "error")) {
      await initializePaddleOcr().catch(() => undefined);
    }
    const health = getPaddleOcrHealth();
    return res.status(health.state === "error" ? 503 : 200).json(health);
  });

  app.post("/api/ocr/frame", async (req, res) => {
    try {
      const frame = await recognizeOcrFrame(req.body || {});
      return res.json({ frame, detections: frame.detections, model: getPaddleOcrHealth().model });
    } catch (error: any) {
      console.error("PaddleOCR frame failed:", error);
      return res.status(500).json({ error: error?.message || "PaddleOCR không xử lý được khung hình." });
    }
  });

  app.post("/api/ocr/batch", async (req, res) => {
    try {
      const { frames, regions, minConfidence } = req.body || {};
      if (!Array.isArray(frames) || frames.length === 0) {
        return res.status(400).json({ error: "Không có khung hình để chạy PaddleOCR." });
      }
      if (frames.length > 32) {
        return res.status(400).json({ error: "Mỗi batch chỉ nhận tối đa 32 khung hình để giới hạn bộ nhớ." });
      }
      const output = await recognizeOcrBatch(frames.map((frame) => ({
          image: frame?.base64 || frame?.image,
          timestamp: frame?.timestamp,
          regions,
          minConfidence,
        })));
      return res.json({ frames: output, processed: output.length, model: getPaddleOcrHealth().model });
    } catch (error: any) {
      console.error("PaddleOCR batch failed:", error);
      return res.status(500).json({ error: error?.message || "PaddleOCR không xử lý được batch khung hình." });
    }
  });

  // ─── OCR Video (server-side frame extraction) ──────────────────────────────
  const ocrVideoUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, os.tmpdir()),
      filename: (_req, file, cb) => cb(null, `dubbin-ocrvid-${Date.now()}${path.extname(file.originalname || ".mp4")}`),
    }),
    limits: { fileSize: 10 * 1024 * 1024 * 1024 },
  });

  // Resolve Python OCR script path (works both in dev and when bundled as EXE)
  function resolvePythonScript(name: string): string {
    const candidates = [
      // Electron packaged: resources/app/scripts/
      process.env.DIST_PATH ? path.join(path.dirname(process.env.DIST_PATH), "scripts", name) : "",
      path.join(process.cwd(), "scripts", name),
      path.join(path.dirname(process.execPath), "scripts", name),
      path.join(__dirnameCompat, "scripts", name),
      path.join(__dirnameCompat, "..", "scripts", name),
    ].filter(Boolean);
    return candidates.find((p) => fs.existsSync(p)) || candidates[0];
  }

  function isBundledEngine(executable: string | null | undefined): executable is string {
    return Boolean(executable) && path.basename(executable!).toLowerCase() === "ocr_engine.exe" && fs.existsSync(executable!);
  }

  async function probePythonExe(): Promise<string | null> {
    const projectRootCandidates = [
      process.cwd(),
      path.dirname(process.execPath),
      __dirnameCompat,
      path.join(__dirnameCompat, ".."),
    ].map((p) => path.resolve(p));
    const venvScripts = (venvName: string) => {
      const paths: string[] = [];
      for (const root of projectRootCandidates) {
        paths.push(path.join(root, venvName, "Scripts", "python.exe"));
        paths.push(path.join(root, venvName, "bin", "python"));
      }
      return paths;
    };
    const pythonCmds = [
      String(process.env.PYTHON_PATH || ""),
      ...venvScripts(".venv"),
      ...venvScripts("venv"),
      ...venvScripts("python-venv"),
      // Venv giải nén cạnh app (từ zip CDN)
      path.join(path.dirname(process.execPath).includes("node_modules") ? process.cwd() : path.dirname(process.execPath), "python-venv", "Scripts", "python.exe"),
      path.join(process.cwd(), "python-venv", "Scripts", "python.exe"),
      // Venv cũ có paddlepaddle-gpu đã hoạt động
      "D:\\ORC\\venv\\Scripts\\python.exe",
      "python",
      "python3",
      // Common Windows Python installs
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python311", "python.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python312", "python.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python310", "python.exe"),
      "C:\\Python311\\python.exe",
      "C:\\Python312\\python.exe",
      path.join(path.dirname(process.execPath), "python", "python.exe"),
    ].filter(Boolean);
    for (const cmd of pythonCmds) {
      if (isBundledEngine(cmd)) return cmd;
      try {
        await new Promise<void>((resolve, reject) => {
          const p = spawn(cmd, ["--version"]);
          const t = setTimeout(() => {
            try { p.kill(); } catch {}
            reject(new Error("Timeout"));
          }, 3000);
          p.stdout.on("data", () => {});
          p.stderr.on("data", () => {});
          p.on("close", (code) => {
            clearTimeout(t);
            code === 0 ? resolve() : reject();
          });
          p.on("error", (err) => {
            clearTimeout(t);
            reject(err);
          });
        });
        return cmd;
      } catch { /* try next */ }
    }
    return null;
  }

  async function verifyNativeRenderEngine(): Promise<{ ok: boolean; status: number; detail: any }> {
    const ffmpegExe = resolveNativeFfmpeg();
    if (!ffmpegExe) {
      return {
        ok: false,
        status: 503,
        detail: { ok: false, error: "Không tìm thấy FFmpeg native trong runtime. Hãy cài lại DubbinTool." },
      };
    }
    return new Promise((resolve) => {
      const proc = spawn(ffmpegExe, ["-hide_banner", "-encoders"], { windowsHide: true });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (ok: boolean, detail: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok, status: ok ? 200 : 503, detail });
      };
      const timer = setTimeout(() => {
        try { proc.kill(); } catch {}
        finish(false, { ok: false, error: "Kiểm tra FFmpeg quá thời gian. Hãy cài lại engine." });
      }, 15_000);
      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on("close", (code) => {
        try {
          const available = code === 0 && stdout.includes("libx264") && stdout.includes("aac");
          finish(available, available
            ? { ok: true, engine: "native-ffmpeg", ffmpegPath: ffmpegExe }
            : { ok: false, error: stderr.trim() || "FFmpeg thiếu libx264 hoặc AAC." });
        } catch {
          finish(false, { ok: false, error: stderr.trim() || "Không thể xác minh FFmpeg native. Hãy cài lại engine." });
        }
      });
      proc.on("error", (error) => finish(false, { ok: false, error: error.message }));
    });
  }

  function resolveNativeFfmpeg(): string | null {
    const candidates = [
      String(process.env.FFMPEG_BINARY || ""),
      process.env.OCR_RESOURCES_PATH
        ? path.join(process.env.OCR_RESOURCES_PATH, "ocr-engine", "_internal", "imageio_ffmpeg", "binaries")
        : "",
      path.join(process.cwd(), "resources", "ocr-engine", "_internal", "imageio_ffmpeg", "binaries"),
      "ffmpeg",
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (candidate === "ffmpeg") return candidate;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        const binary = fs.readdirSync(candidate).find((name) => /^ffmpeg.*\.exe$/i.test(name));
        if (binary) return path.join(candidate, binary);
      }
    }
    return null;
  }

  async function nativeVideoHasAudio(ffmpegExe: string, videoPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(ffmpegExe, ["-hide_banner", "-i", videoPath], { windowsHide: true });
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.once("error", () => resolve(false));
      proc.once("close", () => resolve(/Stream #\d+:\d+.*Audio:/i.test(stderr)));
    });
  }

  // Release builds must be self-contained; never accept or install a Python runtime at runtime.
  app.use(["/api/python/install-venv", "/api/python/install-venv-upload"], (_req, res) => {
    res.status(410).json({ ok: false, error: "Runtime Python installation is disabled. Reinstall DubbinTool to restore its bundled engine." });
  });

  // ── /api/python/install-venv-upload ──────────────────────────────────────
  // Nhận file zip từ browser (multipart), lưu temp, giải nén ra python-venv/
  {
    const venvUpload = multer({
      storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, os.tmpdir()),
        filename: (_req, _file, cb) => cb(null, `python-venv-${Date.now()}.zip`),
      }),
      limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB max
    });
    app.post("/api/python/install-venv-upload", venvUpload.single("venvZip"), async (req, res) => {
      const zipFile = req.file;
      if (!zipFile) return res.status(400).json({ ok: false, error: "Thiếu file zip." });

      const appDir = path.dirname(process.execPath).includes("node_modules")
        ? process.cwd()
        : path.dirname(process.execPath);
      const destDir = path.join(appDir, "python-venv");

      try {
        await new Promise<void>((resolve, reject) => {
          const ps = spawn("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command",
            `Expand-Archive -Force -Path '${zipFile.path}' -DestinationPath '${destDir}'`,
          ]);
          let err = "";
          ps.stdout.on("data", () => {});
          ps.stderr.on("data", (d: Buffer) => { err += d.toString(); });
          ps.on("close", (code) => code === 0 ? resolve() : reject(new Error(err || `Exit ${code}`)));
          ps.on("error", reject);
        });
        fs.unlinkSync(zipFile.path); // xóa file tạm
        return res.json({ ok: true, venvPath: destDir });
      } catch (e: any) {
        fs.unlinkSync(zipFile.path);
        return res.status(500).json({ ok: false, error: e.message });
      }
    });
  }

  // ── /api/python/install-venv ─────────────────────────────────────────────
  // Giải nén venv zip (đã tải sẵn, path trong body) vào cạnh thư mục app
  // Body: { zipPath: string }  → giải nén ra <appDir>/python-venv/
  app.post("/api/python/install-venv", express.json(), async (req, res) => {
    const zipPath: string = req.body?.zipPath;
    if (!zipPath || !fs.existsSync(zipPath)) {
      return res.status(400).json({ ok: false, error: "zipPath không hợp lệ hoặc không tồn tại." });
    }

    // Thư mục đích = cạnh file exe app (hoặc cwd)
    const appDir = path.dirname(process.execPath).includes("node_modules")
      ? process.cwd()
      : path.dirname(process.execPath);
    const destDir = path.join(appDir, "python-venv");

    try {
      // Dùng PowerShell Expand-Archive (Windows built-in)
      await new Promise<void>((resolve, reject) => {
        const ps = spawn("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-Command",
          `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'`,
        ]);
        let err = "";
        ps.stdout.on("data", () => {});
        ps.stderr.on("data", (d: Buffer) => { err += d.toString(); });
        ps.on("close", (code) => code === 0 ? resolve() : reject(new Error(err || `Exit ${code}`)));
        ps.on("error", reject);
      });

      return res.json({ ok: true, venvPath: destDir });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── /api/python/verify ───────────────────────────────────────────────────
  // Kiểm tra Python + PaddleOCR có đủ tài nguyên không (import + predict thử)
  app.get("/api/python/verify", async (req, res) => {
    const pythonExe = await probePythonExe();
    if (!pythonExe) {
      return res.status(503).json({ ok: false, error: "Không tìm thấy Python." });
    }

    if (isBundledEngine(pythonExe)) {
      try {
        await initializePaddleOcr();
        return res.json({ ok: true, python: pythonExe, detail: "Bundled OCR engine ready." });
      } catch (error: any) {
        return res.status(503).json({ ok: false, python: pythonExe, error: error?.message || String(error) });
      }
    }

    const result = await new Promise<{ ok: boolean; python: string; detail: string }>((resolve) => {
      // Tạo ảnh 32x32 trắng rồi chạy predict — đủ để test init model
      const code = `
import sys, json
try:
    import cv2, numpy as np
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(lang="ch", use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)
    img = np.ones((32,32,3), dtype=np.uint8) * 255
    predict = getattr(ocr, "predict", None)
    if callable(predict):
      predict(img)
    else:
      ocr.ocr(img, cls=False)
    print(json.dumps({"ok":True}))
except Exception as e:
    print(json.dumps({"ok":False,"error":str(e)}))
`.trim();
      const p = spawn(pythonExe, ["-c", code], {
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      });
      let out = "";
      let settled = false;
      const done = (val: { ok: boolean; python: string; detail: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      };
      // 3 minute timeout — PaddleOCR model init can be slow on first run
      const timer = setTimeout(() => {
        try { p.kill(); } catch {}
        done({ ok: false, python: pythonExe, detail: "Timeout 180s — PaddleOCR init quá lâu." });
      }, 180_000);
      p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      p.stderr.on("data", () => {});
      p.on("close", () => {
        try {
          const parsed = JSON.parse(out.trim().split("\n").pop() || "{}");
          done({ ok: !!parsed.ok, python: pythonExe, detail: parsed.error || "OK" });
        } catch {
          done({ ok: false, python: pythonExe, detail: "Không parse được output" });
        }
      });
      p.on("error", (e) => done({ ok: false, python: pythonExe, detail: e.message }));
    });

    return res.status(result.ok ? 200 : 503).json(result);
  });

  // Native FFmpeg is mandatory for final MP4 render. This is not ffmpeg.wasm.
  app.get("/api/render/verify", async (_req, res) => {
    const result = await verifyNativeRenderEngine();
    return res.status(result.status).json(result.detail);
  });

  // ── /api/setup/stream ────────────────────────────────────────────────────
  // Packaged builds must never download/install Python dependencies at runtime.
  // Retained endpoint name for the UI: it now performs local-only diagnostics.
  app.get("/api/setup/stream", async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (obj: object) => { try { res.write(JSON.stringify(obj) + "\n"); } catch {} };

    try {
      const resourcesPath = process.env.OCR_RESOURCES_PATH;
      const packaged = process.env.ELECTRON === "1" && resourcesPath;
      const engine = packaged ? path.join(resourcesPath, "ocr-engine", "ocr_engine.exe") : "";
      const cuda = packaged ? path.join(resourcesPath, "cuda-libs") : process.env.PADDLE_CUDA_BIN || "";
      send({ type: "log", message: "Kiểm tra engine OCR đã đóng gói...", percent: 20 });
      if (packaged && !fs.existsSync(engine)) throw new Error("Thiếu OCR engine trong bộ cài. Hãy cài lại ứng dụng.");
      send({ type: "log", message: "✅ OCR engine: sẵn sàng", percent: 45 });
      if (packaged && !fs.existsSync(path.join(cuda, "zlibwapi.dll"))) throw new Error("Thiếu CUDA runtime trong bộ cài. Hãy cài lại ứng dụng.");
      send({ type: "log", message: "✅ Thư viện CUDA: sẵn sàng", percent: 70 });
      await initializePaddleOcr();
      const current = getPaddleOcrHealth();
      send({ type: "log", message: `✅ OCR self-test: ${current.model?.backend || "CPU"}`, percent: 95 });
      send({ type: "done", message: "Tài nguyên OCR đã được xác minh. Không có tải/cài đặt runtime.", percent: 100 });
    } catch (err: any) {
      send({ type: "error", message: err?.message || String(err) });
    } finally {
      res.end();
    }
  });

  app.post("/api/ocr/video", ocrVideoUpload.single("video"), async (req, res) => {
    const tmpFiles: string[] = [];
    let activeOcrProcess: ReturnType<typeof spawn> | null = null;
    const stopOcrProcess = () => {
      const proc = activeOcrProcess;
      if (!proc || proc.killed || proc.exitCode !== null) return;
      if (process.platform === "win32" && proc.pid) {
        spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        proc.kill("SIGTERM");
      }
    };
    req.once("aborted", stopOcrProcess);
    res.once("close", () => { if (!res.writableEnded) stopOcrProcess(); });
    try {
      const videoFile = req.file;
      if (!videoFile) return res.status(400).json({ error: "Thiếu file video." });
      tmpFiles.push(videoFile.path);

      const fps = Math.max(0.5, Math.min(20, Number(req.body?.fps || 2)));
      const minConfidence = Math.max(0, Math.min(1, Number(req.body?.minConfidence || 0.25)));
      const startTime = Math.max(0, Number(req.body?.startTime || 0));
      const regionsRaw = String(req.body?.regions || "[]");
      const scanRangesRaw = String(req.body?.scanRanges || "[]");
      const regions = (() => { try { return JSON.parse(regionsRaw); } catch { return []; } })();

      // Set streaming headers immediately
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Transfer-Encoding", "chunked");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // ── Try Python OCR (fast, GPU) ────────────────────────────────────────
      const pythonExe  = await probePythonExe();
      const scriptPath = resolvePythonScript("ocr_video_stream.py");
      const hasPython  = pythonExe && fs.existsSync(scriptPath);

      if (hasPython) {
        console.log(`[OCR Video] Using Python: ${pythonExe} ${scriptPath}`);
        await new Promise<void>((resolve, reject) => {
          const videoArgs = [videoFile.path, String(fps), regionsRaw, String(minConfidence), String(startTime), scanRangesRaw];
          const py = spawn(pythonExe!, isBundledEngine(pythonExe) ? ["ocr_video", ...videoArgs] : [scriptPath, ...videoArgs], { env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION: "python" } });
          activeOcrProcess = py;
          py.once("close", () => { if (activeOcrProcess === py) activeOcrProcess = null; });

          let buf = "";
          py.stdout.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const ln of lines) {
              const trimmed = ln.trim();
              if (!trimmed) continue;
              try {
                const msg = JSON.parse(trimmed);
                // Keep Python stream's top-level frame protocol. The frontend
                // consumes timestamp/detections directly for incremental writes.
                if (msg.type === "frame") {
                  res.write(JSON.stringify({
                    type:      "frame",
                    timestamp: msg.timestamp,
                    detections: msg.detections || [],
                    processed: msg.processed,
                    total:     msg.total,
                    percent:   msg.percent,
                    duration:  msg.duration,
                    elapsed:   msg.elapsed,
                    eta:       msg.eta,
                    speed:     msg.speed,
                    ocr_count: msg.ocr_count,
                  }) + "\n");
                } else {
                  res.write(trimmed + "\n");
                }
              } catch { /* non-JSON line from Python, skip */ }
            }
          });

          let stderrBuf = "";
          py.stderr.on("data", (d: Buffer) => {
            stderrBuf += d.toString();
            console.error("[Python OCR stderr]", d.toString());
          });
          py.on("close", (code) => {
            if (buf.trim()) {
              try { res.write(buf.trim() + "\n"); } catch {}
            }
            if (code === 0) resolve();
            else {
              const detail = stderrBuf.trim().split("\n").slice(-3).join(" | ");
              reject(new Error(`Python OCR exited with code ${code}${detail ? `: ${detail}` : ""}`));
            }
          });
          py.on("error", reject);
        });

        res.end();
        return;
      }

      throw new Error("Không tìm thấy Python/PaddleOCR. Hãy cài OCR Engine trước khi chạy.");

    } catch (err: any) {
      console.error("[OCR Video]", err);
      if (!res.headersSent) return res.status(500).json({ error: err?.message || "OCR video thất bại." });
      try { res.write(JSON.stringify({ type: "error", error: err?.message || "OCR video thất bại." }) + "\n"); } catch {}
      res.end();
    } finally {
      for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
    }
  });

  // ─── Local FFmpeg render (via Python render_video.py) ──────────────────────
  const renderUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, os.tmpdir()),
      // Multiple subtitle PNGs arrive in one millisecond. `fieldname` is always
      // "subtitle", so a timestamp-only name overwrote earlier files.
      filename: (_req, file, cb) => {
        const originalName = path.basename(file.originalname || `${file.fieldname}.bin`);
        cb(null, `dubbin-${Date.now()}-${randomUUID()}-${originalName}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10 GB
  });
  const renderFields = renderUpload.fields([
    { name: "video", maxCount: 1 },
    { name: "voiceover", maxCount: 1 },
    { name: "subtitle", maxCount: 8192 },
    { name: "subtitleBlank", maxCount: 1 },
  ]);

  // Keep completed MP4 files briefly. URLs may be read repeatedly by the
  // preview player and downloader; the old one-time behavior let <video>
  // consume/delete the file before the user clicked Download.
  // Encoding a large video as one base64 JSON string exceeds V8's string limit.
  const completedRenders = new Map<string, { path: string; expiresAt: number }>();
  const cleanupCompletedRenders = () => {
    const now = Date.now();
    for (const [token, item] of completedRenders) {
      if (item.expiresAt > now) continue;
      completedRenders.delete(token);
      try { fs.unlinkSync(item.path); } catch {}
    }
  };

  app.get("/api/render/download/:token", (req, res) => {
    cleanupCompletedRenders();
    const token = String(req.params.token || "");
    const item = completedRenders.get(token);
    if (!item || !fs.existsSync(item.path)) return res.status(404).json({ error: "Tệp render đã hết hạn hoặc không tồn tại." });
    const download = String(req.query.download || "") === "1" || req.get("sec-fetch-dest") !== "video";
    res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="dubbin-final.mp4"`);
    res.sendFile(path.resolve(item.path));
  });

  app.post(
    "/api/render",
    async (_req, res, next) => {
      const result = await verifyNativeRenderEngine();
      if (!result.ok) return res.status(result.status).json(result.detail);
      next();
    },
    (req, res, next) => {
      renderFields(req, res, (err: any) => {
        if (!err) return next();
        const message = err?.code === "LIMIT_UNEXPECTED_FILE"
          ? "Render nhận quá nhiều file phụ đề hoặc field upload không hợp lệ. Giới hạn hiện tại: 8192 subtitle PNG."
          : err?.message || "Upload render thất bại.";
        res.status(400).json({ error: message });
      });
    },
    async (req, res) => {
      const tmpFiles: string[] = [];
      const outputPath = path.join(os.tmpdir(), `dubbin-out-${Date.now()}.mp4`);
      let paramsJsonPath = "";
      let activeRenderProcess: ReturnType<typeof spawn> | null = null;
      const stopRenderProcess = () => {
        const proc = activeRenderProcess;
        if (!proc || proc.killed || proc.exitCode !== null) return;
        if (process.platform === "win32" && proc.pid) {
          spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          proc.kill("SIGTERM");
        }
      };
      req.once("aborted", stopRenderProcess);
      res.once("close", () => { if (!res.writableEnded) stopRenderProcess(); });
      try {
        const files = (req.files || {}) as Record<string, Express.Multer.File[]>;
        const videoFile = files["video"]?.[0];
        if (!videoFile) return res.status(400).json({ error: "Thiếu tệp video. Vui lòng đảm bảo gửi file dưới dạng multipart/form-data." });
        tmpFiles.push(videoFile.path);

        const voiceoverFile = files["voiceover"]?.[0];
        if (voiceoverFile) tmpFiles.push(voiceoverFile.path);

        const subtitleFiles = files["subtitle"] || [];
        for (const f of subtitleFiles) tmpFiles.push(f.path);
        const subtitleBlankFile = files["subtitleBlank"]?.[0];
        if (subtitleBlankFile) tmpFiles.push(subtitleBlankFile.path);

        // Parse render params from JSON body field
        const params = JSON.parse(req.body.params || "{}");
        const {
          filterComplex,
          lastOverlay,
          outputWidth,
          outputHeight,
          exportDuration,
          originalAudioMixVolume = 0.3,
          hasVoiceover,
          useAudio,
          subtitleTimeline = [],
        } = params;

        // Stream progress back via chunked JSON lines
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Transfer-Encoding", "chunked");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        // ── Try Python render first ───────────────────────────────────────────
        // Rendering is launched directly through the persistent FFmpeg binary.
        // The OCR engine contains an immutable embedded Python script and must
        // not control render behavior after a lightweight app update.
        const pythonExe: string | null = null;
        const renderScriptPath = "";
        const hasPython = false;

        if (hasPython) {
          console.log("[render] Using Python render engine:", pythonExe, renderScriptPath);

          // Write params to a temp JSON file so we don't hit CLI arg length limits
          paramsJsonPath = path.join(os.tmpdir(), `dubbin-render-params-${Date.now()}.json`);
          fs.writeFileSync(paramsJsonPath, JSON.stringify({
            videoPath:      videoFile.path,
            voiceoverPath:  voiceoverFile?.path || null,
            subtitlePaths:  subtitleFiles.map(f => f.path),
            filterComplex:  filterComplex || "",
            lastOverlay:    lastOverlay || "",
            outputWidth,
            outputHeight,
            exportDuration,
            originalAudioMixVolume,
            hasVoiceover:   Boolean(hasVoiceover),
            useAudio:       Boolean(useAudio),
            subtitleTimeline: Array.isArray(subtitleTimeline) ? subtitleTimeline : [],
            outputPath,
          }), "utf-8");
          tmpFiles.push(paramsJsonPath);

          await new Promise<void>((resolve, reject) => {
            const proc = spawn(
              pythonExe,
              isBundledEngine(pythonExe) ? ["render_video", paramsJsonPath] : [renderScriptPath, paramsJsonPath],
              { env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } },
            );
            activeRenderProcess = proc;
            proc.once("close", () => { if (activeRenderProcess === proc) activeRenderProcess = null; });
            let buf = "";
            let stderr = "";
            let pythonError = "";
            proc.stdout.on("data", (chunk: Buffer) => {
              buf += chunk.toString();
              const lines = buf.split("\n");
              buf = lines.pop() ?? "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                  const msg = JSON.parse(trimmed);
                  if (msg.type === "progress") {
                    res.write(JSON.stringify({ type: "progress", percent: msg.percent, time: msg.time }) + "\n");
                  } else if (msg.type === "debug") {
                    console.debug("[render/python debug]", msg);
                  } else if (msg.type === "error") {
                    pythonError = String(msg.error || "Python render báo lỗi không xác định.");
                  }
                  // "done" is handled after proc.close
                } catch { /* skip non-JSON lines */ }
              }
            });
            proc.stderr.on("data", (d: Buffer) => {
              stderr += d.toString();
              if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
              console.error("[render/python stderr]", d.toString());
            });
            proc.on("close", (code) => {
              if (code === 0) resolve();
              else {
                const trailingStdout = buf.trim();
                if (!pythonError && trailingStdout) {
                  try {
                    const message = JSON.parse(trailingStdout);
                    if (message.type === "error") pythonError = String(message.error || "");
                  } catch { /* retain stderr below */ }
                }
                const stderrDetail = stderr.trim().split(/\r?\n/).slice(-10).join("\n");
                reject(new Error(pythonError || stderrDetail || `Python render thất bại (exit ${code})`));
              }
            });
            proc.on("error", reject);
          });
        } else {
          // ── Fallback: spawn ffmpeg directly ────────────────────────────────
          console.log("[render] Python not available, falling back to direct ffmpeg spawn");
          if (hasVoiceover && filterComplex && !filterComplex.includes("[outa]")) {
            throw new Error("Render fallback thiếu audio mix [outa]; vui lòng kiểm tra voiceover/filterComplex.");
          }
          const ffmpegExe = resolveNativeFfmpeg();
          if (!ffmpegExe) throw new Error("Không tìm thấy FFmpeg native.");
          let effectiveFilterComplex = filterComplex || "";
          if (hasVoiceover && effectiveFilterComplex.includes("[0:a]") && !(await nativeVideoHasAudio(ffmpegExe, videoFile.path))) {
            const audioStart = effectiveFilterComplex.indexOf("[0:a]");
            effectiveFilterComplex = effectiveFilterComplex.slice(0, audioStart).replace(/;+$/, "");
            if (effectiveFilterComplex) effectiveFilterComplex += ";";
            effectiveFilterComplex += "[1:a]volume=1.0[outa]";
          }
          const args: string[] = ["-y"];
          args.push("-i", videoFile.path);
          if (voiceoverFile) args.push("-i", voiceoverFile.path);
          if (subtitleFiles.length > 0) {
            if (!subtitleBlankFile || subtitleTimeline.length !== subtitleFiles.length) {
              throw new Error("Track phụ đề concat thiếu khung trong suốt hoặc timeline không khớp.");
            }
            const manifestPath = path.join(os.tmpdir(), `dubbin-subtitles-${randomUUID()}.ffconcat`);
            const quoteConcatPath = (value: string) => value.replace(/\\/g, "/").replace(/'/g, "'\\''");
            const entries: Array<{ file: string; duration: number }> = [];
            let cursor = 0;
            subtitleFiles.forEach((file, index) => {
              const timing = subtitleTimeline[index] || {};
              const start = Math.max(cursor, Number(timing.start || 0));
              const end = Math.max(start + 0.04, Number(timing.end || start + 0.1));
              if (start > cursor + 0.001) entries.push({ file: subtitleBlankFile.path, duration: start - cursor });
              entries.push({ file: file.path, duration: end - start });
              cursor = end;
            });
            if (Number(exportDuration) > cursor + 0.001) {
              entries.push({ file: subtitleBlankFile.path, duration: Number(exportDuration) - cursor });
            }
            const lines = ["ffconcat version 1.0"];
            for (const entry of entries) {
              lines.push(`file '${quoteConcatPath(entry.file)}'`, `duration ${Math.max(0.04, entry.duration).toFixed(6)}`);
            }
            lines.push(`file '${quoteConcatPath(entries[entries.length - 1].file)}'`);
            fs.writeFileSync(manifestPath, lines.join("\n") + "\n", "utf-8");
            tmpFiles.push(manifestPath);
            args.push("-f", "concat", "-safe", "0", "-i", manifestPath);
          }

          if (effectiveFilterComplex) {
            args.push("-filter_complex", effectiveFilterComplex);
            args.push("-map", lastOverlay.startsWith("[") ? lastOverlay : `[${lastOverlay}]`);
            if (hasVoiceover) args.push("-map", "[outa]");
            else if (useAudio) args.push("-map", "0:a?");
          } else {
            args.push("-map", "0:v");
            if (hasVoiceover) args.push("-map", "1:a");
            else if (useAudio) args.push("-map", "0:a?");
          }
          const preferred = String(process.env.FFMPEG_VIDEO_ENCODER || "");
          const encoderCandidates = Array.from(new Set([preferred, "h264_nvenc", "h264_qsv", "h264_amf", "libx264"].filter(Boolean)));
          const probeEncoder = (encoder: string) => new Promise<boolean>((resolve) => {
            const probe = spawn(ffmpegExe, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=s=256x256:d=0.08", "-frames:v", "1", "-c:v", encoder, "-f", "null", "-"], { windowsHide: true, stdio: "ignore" });
            let settled = false;
            const finish = (value: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
            const timer = setTimeout(() => { try { probe.kill(); } catch {}; finish(false); }, 8000);
            probe.once("error", () => finish(false));
            probe.once("close", (code) => finish(code === 0));
          });
          let selectedEncoder = "libx264";
          for (const candidate of encoderCandidates) {
            if (await probeEncoder(candidate)) { selectedEncoder = candidate; break; }
          }
          const hardware = selectedEncoder !== "libx264";
          res.write(JSON.stringify({ type: "engine", encoder: selectedEncoder, hardware }) + "\n");
          type RenderRecoveryOptions = {
            safeMode?: boolean;
            voiceOnly?: boolean;
          };
          const createRenderArgs = (encoder: string, recovery: RenderRecoveryOptions = {}) => {
            const result = [...args];
            if (recovery.safeMode) {
              // Put demux/decode recovery flags before the first input.
              result.splice(1, 0, "-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err");
            }
            if (recovery.voiceOnly && voiceoverFile) {
              const filterIndex = result.indexOf("-filter_complex");
              if (filterIndex >= 0) {
                const currentFilter = String(result[filterIndex + 1] || "");
                const audioStart = currentFilter.indexOf("[0:a]");
                let videoOnlyFilter = audioStart >= 0
                  ? currentFilter.slice(0, audioStart).replace(/;+$/, "")
                  : currentFilter;
                if (videoOnlyFilter) videoOnlyFilter += ";";
                result[filterIndex + 1] = `${videoOnlyFilter}[1:a]volume=1.0[outa]`;
              }
            }
            result.push("-t", String(exportDuration), "-c:v", encoder);
            if (encoder === "h264_nvenc") result.push("-preset", "p4", "-cq", "20", "-b:v", "0");
            else if (encoder === "h264_qsv") result.push("-preset", "veryfast", "-global_quality", "20");
            else if (encoder === "h264_amf") result.push("-quality", "balanced", "-rc", "cqp", "-qp_i", "20", "-qp_p", "20");
            else result.push("-preset", "veryfast", "-crf", "20");
            if (recovery.safeMode) {
              result.push("-threads", "2", "-filter_threads", "1", "-max_muxing_queue_size", "4096");
            }
            result.push("-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outputPath);
            return result;
          };
          const runFfmpeg = (renderArgs: string[]) => new Promise<void>((resolve, reject) => {
            console.log("[render/fallback] ffmpeg", renderArgs.join(" "));
            const proc = spawn(ffmpegExe, renderArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
            activeRenderProcess = proc;
            proc.once("close", () => { if (activeRenderProcess === proc) activeRenderProcess = null; });
            let ffmpegStderr = "";
            proc.stderr.on("data", (chunk: Buffer) => {
              ffmpegStderr += chunk.toString();
              if (ffmpegStderr.length > 32_000) ffmpegStderr = ffmpegStderr.slice(-32_000);
              const lines = chunk.toString().split("\n");
              for (const line of lines) {
                const m = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
                if (m && exportDuration > 0) {
                  const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
                  const pct = Math.min(99, Math.round((t / exportDuration) * 100));
                  res.write(JSON.stringify({ type: "progress", percent: pct, time: t }) + "\n");
                }
              }
            });
            proc.on("close", (code) => {
              if (code === 0) return resolve();
              const detail = ffmpegStderr.trim().split(/\r?\n/).slice(-10).join("\n");
              reject(new Error(`FFmpeg thất bại (exit ${code})${detail ? `:\n${detail}` : ""}`));
            });
            proc.on("error", reject);
          });
          type RenderAttempt = {
            encoder: string;
            recovery: RenderRecoveryOptions;
            strategy: string;
          };
          const attempts: RenderAttempt[] = [{
            encoder: selectedEncoder,
            recovery: {},
            strategy: hardware ? `GPU ${selectedEncoder}` : "CPU tiêu chuẩn",
          }];
          const attemptedKeys = new Set<string>();
          const failures: string[] = [];
          let rendered = false;

          while (attempts.length > 0 && failures.length < 3 && !rendered) {
            const attempt = attempts.shift()!;
            const attemptKey = `${attempt.encoder}|${Boolean(attempt.recovery.safeMode)}|${Boolean(attempt.recovery.voiceOnly)}`;
            if (attemptedKeys.has(attemptKey)) continue;
            attemptedKeys.add(attemptKey);
            const attemptNumber = failures.length + 1;
            if (attemptNumber > 1) {
              res.write(JSON.stringify({
                type: "retry",
                attempt: attemptNumber,
                maxAttempts: 3,
                strategy: attempt.strategy,
              }) + "\n");
            }
            try {
              await runFfmpeg(createRenderArgs(attempt.encoder, attempt.recovery));
              rendered = true;
            } catch (error: any) {
              if (req.destroyed) throw error;
              const detail = String(error?.message || error);
              failures.push(`${attempt.strategy}: ${detail.split(/\r?\n/).slice(-3).join(" ")}`);
              console.warn(`[render] Attempt ${attemptNumber} failed (${attempt.strategy}).`, error);
              try { fs.unlinkSync(outputPath); } catch {}

              const isAudioFailure = /(?:0:a|audio|aac|amix|apad|channel|sample rate|error while decoding stream.*a:)/i.test(detail);
              const isResourceFailure = /(?:out of memory|cannot allocate|resource temporarily unavailable|failed to inject frame|buffer queue overflow)/i.test(detail);
              const isTimestampFailure = /(?:non-monoton|invalid dts|invalid pts|timestamp|muxing queue)/i.test(detail);
              const nextRecovery: RenderRecoveryOptions = {
                safeMode: isResourceFailure || isTimestampFailure || attempt.recovery.safeMode,
                voiceOnly: isAudioFailure && Boolean(voiceoverFile),
              };

              if (attempt.encoder !== "libx264") {
                attempts.unshift({
                  encoder: "libx264",
                  recovery: nextRecovery,
                  strategy: nextRecovery.voiceOnly
                    ? "CPU an toàn + chỉ giữ voice thuyết minh"
                    : "CPU libx264 dự phòng",
                });
              } else if (!attempt.recovery.safeMode || (isAudioFailure && !attempt.recovery.voiceOnly)) {
                attempts.unshift({
                  encoder: "libx264",
                  recovery: {
                    safeMode: true,
                    voiceOnly: attempt.recovery.voiceOnly || (isAudioFailure && Boolean(voiceoverFile)),
                  },
                  strategy: isAudioFailure
                    ? "CPU an toàn + bỏ audio gốc bị lỗi, giữ nguyên voice"
                    : "CPU chế độ tương thích, ít luồng và sửa timestamp",
                });
              }
            }
          }

          if (!rendered) {
            throw new Error(
              `Render thất bại sau ${failures.length} chiến lược tự phục hồi:\n`
              + failures.map((failure, index) => `${index + 1}. ${failure}`).join("\n"),
            );
          }
        }

        const outputSize = fs.statSync(outputPath).size;
        const downloadToken = randomUUID();
        completedRenders.set(downloadToken, { path: outputPath, expiresAt: Date.now() + 30 * 60_000 });
        res.write(JSON.stringify({ type: "done", size: outputSize, downloadUrl: `/api/render/download/${downloadToken}` }) + "\n");
        res.end();
      } catch (err: any) {
        console.error("[render] error:", err);
        try { res.write(JSON.stringify({ type: "error", error: err.message || String(err) }) + "\n"); res.end(); } catch {}
      } finally {
        if (![...completedRenders.values()].some((item) => item.path === outputPath)) tmpFiles.push(outputPath);
        for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
      }
    },
  );
  // ────────────────────────────────────────────────────────────────────────────

  app.post("/api/beeknoee-tts/preview", async (req, res) => {
    try {
      const sample = String(req.body?.text || "Xin chào, đây là giọng đọc mẫu của DubbinTool.").slice(0, 240);
      const result = await synthesizeBeeknoeeGoogle(sample, req.body?.voice, {
        licenseKey: String(req.body?.licenseKey || ""),
        hwid: String(req.body?.hwid || ""),
        tiktokSessionId: String(req.body?.tiktokSessionId || ""),
      });
      res.setHeader("Content-Type", result.contentType);
      res.setHeader("Cache-Control", "no-store");
      res.send(result.audio);
    } catch (error: any) {
      res.status(502).json({ error: error?.message || "Không thể nghe thử giọng Google TTS." });
    }
  });

  app.post("/api/ai-script-shorts", async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    const send = (payload: any) => { if (!res.writableEnded) res.write(`${JSON.stringify(payload)}\n`); };
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dubbin-script-shorts-"));
    const jobController = new AbortController();
    req.once("aborted", () => jobController.abort());
    res.once("close", () => { if (!res.writableEnded) jobController.abort(); });
    let remoteFileName = "";
    let remoteClient: GoogleGenAI | null = null;
    try {
      const parsedUrl = normalizeVideoUrl(req.body?.url);
      const rawUrl = parsedUrl.href;
      const requestedMusicVolume = Math.max(0, Math.min(0.25, Number(req.body?.musicVolume ?? 0.12)));
      const requestedMusicStyle = ["funny", "upbeat", "chill", "auto"].includes(String(req.body?.musicStyle))
        ? String(req.body.musicStyle)
        : "funny";
      const requestedVoiceRate = Math.max(1, Math.min(1.2, Number(req.body?.voiceRate ?? 1.12)));
      const requestedVoicePitch = Math.max(0, Math.min(5, Number(req.body?.voicePitch ?? 4)));
      const titleOverlayEnabled = req.body?.titleOverlay !== false;
      const selectedTtsVoice = resolveBeeknoeeVoice(req.body?.voice);
      const isNgocHuyenVoice = selectedTtsVoice.engine === "vieneu" && selectedTtsVoice.id.includes("Ngọc Huyền");
      const narrationWordBudget = isNgocHuyenVoice
        ? { min: 105, max: 130 }
        : selectedTtsVoice.engine === "vieneu"
          ? { min: 135, max: 170 }
          : { min: 155, max: 195 };
      if (selectedTtsVoice.engine === "tiktok" && !String(req.body?.tiktokSessionId || "").trim()) {
        throw new Error("Giọng TikTok cần Session ID hợp lệ. Hãy cập nhật Session ID trong tab Lồng tiếng trước khi Generate.");
      }
      // Load the fine-tuned model while video download and AI understanding run.
      // By the time the UI reaches the TTS stage, the backbone is already in VRAM.
      const ngocHuyenWarmup = preloadNgocHuyen().catch((error) => {
        console.warn(`Ngọc Huyền background warmup failed: ${error?.message || error}`);
      });
      const requestedVoice = resolveBeeknoeeVoice(req.body?.voice);
      const geminiKeys = getGeminiApiKeys(req);
      if (!geminiKeys.length) throw new Error("Chưa cấu hình Gemini API Key trong Cài đặt.");
      const platform = identifyVideoPlatform(parsedUrl);
      const directMedia = platform === "direct";
      const sourcePath = path.join(workDir, "source.mp4");

      send({ type: "progress", percent: 7, message: "Đang nhận diện và tải video..." });
      if (directMedia) {
        const response = await fetch(rawUrl, { redirect: "follow", signal: AbortSignal.any([jobController.signal, AbortSignal.timeout(120_000)]) });
        if (!response.ok || !response.body) throw new Error(`Không tải được video trực tiếp (HTTP ${response.status}).`);
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > 300 * 1024 * 1024) throw new Error("Video vượt giới hạn dung lượng 300 MB.");
        let receivedBytes = 0;
        const sizeGuard = new Transform({
          transform(chunk, _encoding, callback) {
            receivedBytes += chunk.length;
            callback(receivedBytes > 300 * 1024 * 1024 ? new Error("Video vượt giới hạn dung lượng 300 MB.") : null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(response.body as any), sizeGuard, fs.createWriteStream(sourcePath));
      } else {
        await downloadWithYtDlp(rawUrl, platform, sourcePath, (message) => send({ type: "progress", percent: 10, message }), jobController.signal);
      }
      if (jobController.signal.aborted) throw new Error("Tác vụ đã được hủy.");
      if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).size < 1024) throw new Error("Video tải về không hợp lệ.");

      send({ type: "progress", percent: 28, message: "AI đang đọc hình ảnh, lời thoại và chữ trong video..." });
      const ffmpeg = findBundledFfmpeg();
      const duration = await new Promise<number>((resolve, reject) => {
        const child = spawn(ffmpeg, ["-hide_banner", "-i", sourcePath], { windowsHide: true });
        let stderr = ""; child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.once("error", reject); child.once("close", () => {
          const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
          match ? resolve(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) : reject(new Error("Không đọc được thời lượng video."));
        });
      });
      if (duration <= 0 || duration > 60.5) throw new Error(`AI Script Shorts chỉ nhận video tối đa 60 giây. Video này dài ${duration.toFixed(1)} giây.`);

      send({ type: "progress", percent: 40, message: "AI đang phân tích video..." });
      const response = await runWithGeminiKeyRotation(geminiKeys, "AI Script Shorts video understanding", async (ai) => {
        if (jobController.signal.aborted) throw new Error("Tác vụ đã được hủy.");
        remoteClient = ai;
        let uploaded = await ai.files.upload({ file: sourcePath, config: { mimeType: "video/mp4", displayName: "AI Script Shorts source" } });
        remoteFileName = uploaded.name || "";
        for (let attempt = 0; uploaded.state === "PROCESSING" && attempt < 60; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          uploaded = await ai.files.get({ name: uploaded.name! });
        }
        if (uploaded.state === "FAILED") throw new Error(uploaded.error?.message || "AI không xử lý được tệp video.");
        if (!uploaded.uri) throw new Error("AI không nhận được dữ liệu video.");
        send({ type: "progress", percent: 66, message: "Đang xây dựng mạch nội dung..." });
        return ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: [{ role: "user", parts: [
            { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType || "video/mp4" } },
            { text: `Bạn là biên kịch video ngắn tiếng Việt. Hãy thực sự xem và nghe toàn bộ video: hiểu diễn biến, nhân vật, quan hệ, chữ trên màn hình, lời thoại, cao trào, twist, cảm xúc và ý đồ kể chuyện. Tự xây knowledge graph nội bộ nhưng không giải thích quy trình. Viết một kịch bản MỚI dựa trên nội dung cốt lõi; tuyệt đối không chép hoặc paraphrase lần lượt từng câu. Kịch bản phải tự nhiên, cụ thể, giàu nhịp kể, có hook mạnh, body liền mạch và ending rõ ràng. Không dùng câu sáo rỗng, không lặp cấu trúc, không liệt kê vô nghĩa kiểu "tính chiến đấu, tính định hướng, tính...". BẮT BUỘC dài ${narrationWordBudget.min}–${narrationWordBudget.max} từ tiếng Việt để giọng ${selectedTtsVoice.label} đọc ở TỐC ĐỘ GỐC trong khoảng 60–90 giây; câu ngắn, dấu câu tự nhiên, không lặp ý, không chèn tiêu đề, nhãn Hook/Body/Ending hoặc bất kỳ metadata nào vào lời đọc. Xác định tâm điểm chủ thể để crop dọc 9:16 bằng tọa độ chuẩn hóa x/y từ 0 đến 1. Trả về duy nhất JSON hợp lệ theo cấu trúc: {"summary":"...","cropFocus":{"x":0.5,"y":0.5},"script":{"hook":"...","body":"...","ending":"...","fullText":"...","estimatedDurationSeconds":75},"metadata":{"title":"...","description":"...","hashtags":["..."],"thumbnailTitle":"...","thumbnailPrompt":"...","keywords":["..."]}}. fullText phải ghép Hook, Body, Ending thành văn bản sẵn dùng.` },
          ] }],
          config: { responseMimeType: "application/json", temperature: 0.85 },
        });
      });
      send({ type: "progress", percent: 88, message: "Đang hoàn thiện kịch bản Shorts..." });
      const clean = String((response as any).text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      const result = JSON.parse(clean);
      if (!result?.script?.fullText) throw new Error("AI trả về kịch bản không đầy đủ. Vui lòng thử lại.");
      const narrationText = fitShortsNarration(result.script, narrationWordBudget.max);
      if (!narrationText) throw new Error("AI trả về kịch bản rỗng, không thể tạo giọng đọc.");
      // This exact normalized string is both displayed to the user and sent to TTS.
      // Never synthesize title, metadata, labels, or a separately reconstructed copy.
      result.script.fullText = narrationText;
      result.source = { platform, durationSeconds: Number(duration.toFixed(2)) };
      send({ type: "result", result, percent: 88 });

      send({ type: "progress", percent: 90, message: "Đang tạo giọng đọc TTS..." });
      if (jobController.signal.aborted) throw new Error("Tác vụ đã được hủy.");
      await ngocHuyenWarmup;
      const ttsCredentials = {
        licenseKey: String(req.body?.licenseKey || ""),
        hwid: String(req.body?.hwid || ""),
        tiktokSessionId: String(req.body?.tiktokSessionId || ""),
      };
      let tts: Awaited<ReturnType<typeof synthesizeBeeknoeeGoogle>> | undefined;
      let lastTtsError: any;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          tts = await synthesizeBeeknoeeGoogle(narrationText, req.body?.voice, ttsCredentials, jobController.signal);
          break;
        } catch (error: any) {
          lastTtsError = error;
          const permanentCredentialError = /Session ID|license|không hợp lệ|hết hạn/i.test(String(error?.message || ""));
          if (permanentCredentialError || attempt === 2) break;
          send({ type: "progress", percent: 90, message: `${selectedTtsVoice.label} lỗi tạm thời; đang thử lại lần cuối...` });
        }
      }
      if (!tts) throw new Error(`${selectedTtsVoice.label} không tạo được TTS: ${lastTtsError?.message || "lỗi không xác định"}`);
      const voicePath = path.join(workDir, tts.contentType.includes("wav") ? "voice.wav" : "voice.mp3");
      fs.writeFileSync(voicePath, tts.audio);

      const probeDuration = (mediaPath: string) => new Promise<number>((resolve, reject) => {
        const child = spawn(ffmpeg, ["-hide_banner", "-i", mediaPath], { windowsHide: true });
        let output = "";
        child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        child.once("error", reject);
        child.once("close", () => {
          const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
          match ? resolve(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) : reject(new Error("Không đo được thời lượng giọng đọc."));
        });
      });
      const voiceDuration = await probeDuration(voicePath);
      // AI Shorts keeps the selected voice at its original speed. Timing is solved
      // by the script word budget, never by stretching or compressing narration.
      const processedVoiceDuration = voiceDuration / requestedVoiceRate;
      if (processedVoiceDuration > 89.0) {
        throw new Error(`Kịch bản vẫn quá dài (${voiceDuration.toFixed(1)} giây). AI cần tạo lại để video không vượt quá 90 giây.`);
      }
      // The narration is the master clock for AI Shorts. Never pad a short
      // narration to 60s: that used to leave a black/frozen tail with music.
      // FFmpeg loops a short source below and trims a long source here.
      const outputDuration = Math.min(90, processedVoiceDuration);

      send({ type: "progress", percent: 92, message: "Đang đồng bộ phụ đề theo từng từ của voice..." });
      const pythonExe = await probePythonExe();
      if (!pythonExe || isBundledEngine(pythonExe)) throw new Error("Không tìm thấy Python runtime để đồng bộ burnsub theo voice.");
      const alignedWords = await new Promise<Array<{ start: number; end: number; text: string }>>((resolve, reject) => {
        const child = spawn(pythonExe, [resolvePythonScript("align_voice_words.py"), voicePath], {
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code !== 0) return reject(new Error(stderr.trim() || `Aligner dừng với mã ${code}`));
          try {
            const parsed = JSON.parse(stdout.trim());
            if (!Array.isArray(parsed) || parsed.length < 2) throw new Error("Không nhận diện đủ từ trong voice.");
            resolve(parsed);
          } catch (error: any) {
            reject(new Error(`Không đọc được word timestamp: ${error?.message || error}`));
          }
        });
      });

      send({ type: "progress", percent: 93, message: "Đang chọn nhạc nền phù hợp..." });
      const musicApiKey = String(process.env.FREEBGMUSIC_API_KEY || "").trim();
      if (!musicApiKey) throw new Error("Chưa cấu hình FREEBGMUSIC_API_KEY cho kho nhạc nền.");
      const musicResponse = await fetch("https://freebgmusic.info/api/v1/tracks?sort=popular&per_page=100", {
        headers: { "X-API-Key": musicApiKey },
        signal: AbortSignal.timeout(30_000),
      });
      if (!musicResponse.ok) throw new Error(`Kho nhạc nền phản hồi HTTP ${musicResponse.status}.`);
      const musicPayload: any = await musicResponse.json();
      const candidates = (Array.isArray(musicPayload?.data) ? musicPayload.data : []).filter((track: any) =>
        typeof track?.file_path === "string" && /^https:\/\/(?:[^/]+\.)?freebgmusic\.info\//i.test(track.file_path),
      );
      if (!candidates.length) throw new Error("Kho nhạc nền không trả về bài hát có thể tải.");
      const musicKeywords: Record<string, string[]> = {
        funny: ["funny", "comedy", "comic", "quirky", "silly", "playful", "humor", "happy", "ukulele", "whistle"],
        upbeat: ["upbeat", "energetic", "happy", "positive", "dance", "pop", "bright"],
        chill: ["chill", "calm", "soft", "ambient", "relax", "lofi", "acoustic"],
        auto: [],
      };
      const scoreTrack = (track: any) => {
        if (requestedMusicStyle === "auto") return 1;
        const searchable = JSON.stringify(track).toLowerCase();
        return 1 + musicKeywords[requestedMusicStyle].reduce((score, keyword) => score + (searchable.includes(keyword) ? 4 : 0), 0);
      };
      const rankedTracks = candidates.map((track: any) => ({ track, score: scoreTrack(track) })).sort((a: any, b: any) => b.score - a.score);
      const bestScore = rankedTracks[0]?.score || 1;
      const preferredTracks = rankedTracks.filter((item: any) => item.score >= Math.max(2, bestScore - 4)).map((item: any) => item.track);
      const selectionPool = preferredTracks.length ? preferredTracks : candidates;
      const selectedTrack = selectionPool[Math.floor(Math.random() * selectionPool.length)];
      const musicPath = path.join(workDir, "background.mp3");
      const musicDownload = await fetch(selectedTrack.file_path, { signal: AbortSignal.timeout(90_000) });
      if (!musicDownload.ok || !musicDownload.body) throw new Error("Không tải được nhạc nền đã chọn.");
      await pipeline(Readable.fromWeb(musicDownload.body as any), fs.createWriteStream(musicPath));

      send({ type: "progress", percent: 96, message: "Đang crop và render video hoàn chỉnh..." });
      const finalPath = path.join(os.tmpdir(), `dubbin-script-shorts-${Date.now()}-${randomUUID()}.mp4`);
      const voiceFilters = [
        `asetrate=${Math.round(48000 * (1 + requestedVoicePitch / 100))}`,
        "aresample=48000",
        `atempo=${(requestedVoiceRate / (1 + requestedVoicePitch / 100)).toFixed(4)}`,
        "aresample=48000:async=1:first_pts=0",
        "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
        "highpass=f=55",
        "lowpass=f=15500",
        "equalizer=f=2800:t=q:w=1.2:g=2.5",
        "equalizer=f=180:t=q:w=1.0:g=-1.5",
        "alimiter=limit=0.95",
      ].join(",");
      const headline = String(result.metadata?.thumbnailTitle || result.metadata?.title || result.script.hook || "").replace(/\s+/g, " ").trim();
      const headlineWords = headline.split(" ");
      const headlineLines: string[] = [];
      for (const word of headlineWords) {
        const last = headlineLines[headlineLines.length - 1] || "";
        if (!last || `${last} ${word}`.length > 24) headlineLines.push(word);
        else headlineLines[headlineLines.length - 1] = `${last} ${word}`;
      }
      const visibleHeadlineLines = headlineLines.slice(0, 4);
      if (headlineLines.length > 4) {
        visibleHeadlineLines[3] = `${visibleHeadlineLines[3].replace(/[.!?,;:…-]+$/u, "")}…`;
      }
      const displayHeadline = visibleHeadlineLines.join("\n");
      const headlineFontSize = visibleHeadlineLines.length >= 4 ? 43 : visibleHeadlineLines.length === 3 ? 50 : 58;
      const headlineLineSpacing = visibleHeadlineLines.length >= 4 ? 9 : 13;
      const headlinePath = path.join(workDir, "headline.txt");
      fs.writeFileSync(headlinePath, displayHeadline, "utf8");
      const headlineFilterPath = headlinePath
        .replace(/\\/g, "/")
        .replace(/:/g, "\\:")
        .replace(/'/g, "\\'");
      const assTime = (seconds: number) => {
        const centiseconds = Math.max(0, Math.round(seconds * 100));
        const hours = Math.floor(centiseconds / 360000);
        const minutes = Math.floor((centiseconds % 360000) / 6000);
        const secs = Math.floor((centiseconds % 6000) / 100);
        const cs = centiseconds % 100;
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
      };
      const subtitleWords = narrationText.split(/\s+/).filter(Boolean);
      const subtitleGroups: string[] = [];
      for (let index = 0; index < subtitleWords.length;) {
        const first = subtitleWords[index];
        const sentenceEnd = /[.!?,;:]$/u.test(first);
        const take = sentenceEnd || index === subtitleWords.length - 1 ? 1 : 2;
        subtitleGroups.push(subtitleWords.slice(index, index + take).join(" "));
        index += take;
      }
      let consumedScriptWords = 0;
      const subtitleEvents = subtitleGroups.map((group) => {
        const groupWordCount = group.split(/\s+/).length;
        const firstAlignedIndex = Math.min(alignedWords.length - 1, Math.floor(consumedScriptWords * alignedWords.length / subtitleWords.length));
        consumedScriptWords += groupWordCount;
        const lastAlignedIndex = Math.min(alignedWords.length - 1, Math.max(firstAlignedIndex, Math.ceil(consumedScriptWords * alignedWords.length / subtitleWords.length) - 1));
        const start = alignedWords[firstAlignedIndex].start / requestedVoiceRate;
        const end = alignedWords[lastAlignedIndex].end / requestedVoiceRate;
        const groupWords = group.split(/\s+/).filter(Boolean);
        const alignedSlice = alignedWords.slice(firstAlignedIndex, lastAlignedIndex + 1);
        const groupDurationCs = Math.max(12, Math.round((end - start) * 100));
        const rawWeights = groupWords.map((_, wordIndex) => {
          const aligned = alignedSlice[Math.min(alignedSlice.length - 1, Math.floor(wordIndex * alignedSlice.length / groupWords.length))];
          return Math.max(0.08, (aligned?.end || 0) - (aligned?.start || 0));
        });
        const weightTotal = rawWeights.reduce((sum, value) => sum + value, 0) || 1;
        let assignedCs = 0;
        const karaokeText = groupWords.map((word, wordIndex) => {
          const remaining = Math.max(1, groupDurationCs - assignedCs);
          const durationCs = wordIndex === groupWords.length - 1
            ? remaining
            : Math.max(1, Math.min(remaining - (groupWords.length - wordIndex - 1), Math.round(groupDurationCs * rawWeights[wordIndex] / weightTotal)));
          assignedCs += durationCs;
          const safeWord = word.toLocaleUpperCase("vi-VN").replace(/\\/g, "\\\\").replace(/{/g, "\\{").replace(/}/g, "\\}");
          return `{\\k${durationCs}}${safeWord}`;
        }).join(" ");
        // Keep captions in the lower-middle safe zone (the marked area), not
        // against the bottom UI/caption edge of vertical social videos.
        return `Dialogue: 0,${assTime(start)},${assTime(Math.max(start + 0.12, end))},Shorts,,0,0,0,,{\\an5\\pos(540,1120)}${karaokeText}`;
      });
      const subtitlesPath = path.join(workDir, "shorts.ass");
      fs.writeFileSync(subtitlesPath, [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1080",
        "PlayResY: 1920",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
        // White idle text, yellow karaoke fill, heavy black outline.
        "Style: Shorts,Arial,72,&H0000D7FF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,7,1,5,70,70,0,1",
        "",
        "[Events]",
        "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
        ...subtitleEvents,
      ].join("\n"), "utf8");
      const subtitlesFilterPath = subtitlesPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
      const videoFilters = [
        // Keep the whole source visible. Non-9:16 sources get a full-frame blurred copy
        // behind the contained foreground instead of being aggressively center-cropped.
        // The source input is looped by FFmpeg only when narration outlives it.
        // A longer source is simply trimmed at the exact narration endpoint.
        `[0:v]trim=duration=${outputDuration.toFixed(3)},setpts=PTS-STARTPTS,split=2[bgsrc][fgsrc]`,
        "[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=36:luma_power=2:chroma_radius=18:chroma_power=1,eq=brightness=-0.10:saturation=0.85[bg]",
        "[fgsrc]scale=1080:1920:force_original_aspect_ratio=decrease,setsar=1[fg]",
        "[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[base]",
      ];
      if (titleOverlayEnabled && headline) {
        videoFilters.push(
          "[base]drawbox=x=54:y=ih-650:w=972:h=310:color=black@0.86:t=fill:enable='between(t,0,3)'[tagbox]",
          "[tagbox]drawbox=x=54:y=ih-650:w=9:h=310:color=white@0.95:t=fill:enable='between(t,0,3)'[tagaccent]",
          `[tagaccent]drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':textfile='${headlineFilterPath}':fontcolor=white:fontsize=${Math.max(42, headlineFontSize - 3)}:line_spacing=${headlineLineSpacing}:x=max(104\\,(w-text_w)/2):y=max(h-620\\,min(h-380-text_h\\,h-495-text_h/2)):enable='between(t,0,3)'[title]`,
          `[title]subtitles='${subtitlesFilterPath}'[v]`,
        );
      } else {
        videoFilters.push(`[base]subtitles='${subtitlesFilterPath}'[v]`);
      }
      const filter = [
        ...videoFilters,
        `[1:a]${voiceFilters},atrim=duration=${outputDuration.toFixed(3)},volume=1.0[voice]`,
        `[2:a]volume=${requestedMusicVolume.toFixed(3)},atrim=duration=${outputDuration.toFixed(3)},asetpts=N/SR/TB[music]`,
        "[voice][music]amix=inputs=2:duration=shortest:normalize=0:dropout_transition=0[outa]",
      ].join(";");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpeg, [
          "-y", "-stream_loop", "-1", "-i", sourcePath,
          "-i", voicePath,
          "-stream_loop", "-1", "-i", musicPath,
          "-filter_complex", filter, "-map", "[v]", "-map", "[outa]",
          "-t", outputDuration.toFixed(3), "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
          "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", finalPath,
        ], { windowsHide: true });
        const abortRender = () => { try { child.kill(); } catch {} reject(new Error("Tác vụ đã được hủy.")); };
        jobController.signal.addEventListener("abort", abortRender, { once: true });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
        child.once("error", (error) => { jobController.signal.removeEventListener("abort", abortRender); reject(error); });
        child.once("close", (code) => {
          jobController.signal.removeEventListener("abort", abortRender);
          code === 0 && fs.existsSync(finalPath) ? resolve() : reject(new Error(stderr.trim().split(/\r?\n/).slice(-8).join("\n") || `FFmpeg dừng với mã ${code}`));
        });
      });
      cleanupCompletedRenders();
      const videoToken = randomUUID();
      completedRenders.set(videoToken, { path: finalPath, expiresAt: Date.now() + 30 * 60_000 });
      send({
        type: "video",
        percent: 100,
        downloadUrl: `/api/render/download/${videoToken}`,
        durationSeconds: Number(outputDuration.toFixed(2)),
        voiceDurationSeconds: Number(processedVoiceDuration.toFixed(2)),
        musicVolume: requestedMusicVolume,
        musicStyle: requestedMusicStyle,
        voiceRate: requestedVoiceRate,
        voicePitch: requestedVoicePitch,
        voice: tts.voice.label,
        music: { title: selectedTrack.title, artist: selectedTrack.artist, license: selectedTrack.license?.name, licenseUrl: selectedTrack.license?.url },
      });
      res.end();
    } catch (error: any) {
      console.error("AI Script Shorts failed:", error);
      send({ type: "error", error: error?.message || "Không thể tạo kịch bản từ video." });
      res.end();
    } finally {
      if (remoteClient && remoteFileName) { try { await remoteClient.files.delete({ name: remoteFileName }); } catch {} }
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  });

  app.post("/api/translate-subtitles", async (req, res) => {
    try {
      const {
        subtitles,
        sourceLanguage,
        targetLanguage,
        apiPlatform,
        customApiUrl,
        customApiKey,
        customModel,
        allowGeminiFallback,
        translationGlossary,
        translationStyle,
      } = req.body || {};
      if (!Array.isArray(subtitles) || subtitles.length === 0) {
        return res.status(400).json({ error: "Không có phụ đề OCR để dịch." });
      }

      const safeSubtitles = subtitles.map((subtitle: any, index: number) => ({
        id: String(subtitle?.id || `ocr-${index + 1}`),
        start: Number(subtitle?.start || 0),
        end: Number(subtitle?.end || 0),
        original: String(subtitle?.original || subtitle?.text || "").replace(/\s+/g, " ").trim(),
        translated: String(subtitle?.translated || "").replace(/\s+/g, " ").trim(),
      }));
      const invalidSubtitleIndex = safeSubtitles.findIndex((subtitle: any) =>
        !subtitle.original || !Number.isFinite(subtitle.start) || !Number.isFinite(subtitle.end) || subtitle.end <= subtitle.start,
      );
      if (invalidSubtitleIndex >= 0) {
        return res.status(400).json({
          error: `Dòng OCR #${invalidSubtitleIndex + 1} không hợp lệ; đã dừng thay vì âm thầm xóa dòng khi dịch.`,
        });
      }
      if (sourceLanguage && targetLanguage && sourceLanguage !== "auto" && sourceLanguage === targetLanguage) {
        return res.json({
          subtitles: safeSubtitles.map((subtitle: any) => ({ ...subtitle, translated: subtitle.original })),
          provider: "none-same-language",
        });
      }

      const geminiKeys = getGeminiApiKeys(req);
      const wantsCustom = apiPlatform === "custom";
      const canUseCustom = Boolean(wantsCustom && customApiUrl && customApiKey);
      if (wantsCustom && !canUseCustom && geminiKeys.length === 0) {
        return res.status(400).json({ error: "Custom API chưa được cấu hình đầy đủ và không có Gemini API Key để tự chuyển sang dịch dự phòng." });
      }
      const translatedById = new Map<string, string>();
      let provider = canUseCustom ? "custom" : wantsCustom ? "gemini-auto-fallback" : "gemini";

      for (let offset = 0; offset < safeSubtitles.length; offset += 40) {
        const chunk = safeSubtitles.slice(offset, offset + 40);
        const compactInput = chunk.map((subtitle: any, index: number) => ({
          index,
          original: subtitle.original,
        }));
        const glossarySection = translationGlossary?.trim()
          ? `\nTERMINOLOGY GLOSSARY (always use these translations for these terms):\n${translationGlossary.trim()}`
          : "";
        const styleSection = translationStyle?.trim()
          ? `\nTRANSLATION STYLE: ${translationStyle.trim()}`
          : "";
        const prompt = `Translate each subtitle from ${sourceLanguage || "auto-detected language"} to ${targetLanguage || "Vietnamese"}.
Return ONLY a JSON array with exactly the same number and order of items.
Each item must be {"index": number, "translated": string}.
Do not change, merge, split, omit, or add any subtitle. Every translation must be a single line.${glossarySection}${styleSection}
Input: ${JSON.stringify(compactInput)}`;

        let responseText = "";
        if (canUseCustom) {
          try {
            const targetUrl = normalizeCustomApiChatUrl(customApiUrl);
            const modelName = customModel || "gpt-4o-mini";
            const upstream = await trackedCustomApiFetch(targetUrl, customApiKey, modelName, "PaddleOCR text-only translation", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${customApiKey}` },
              body: JSON.stringify({
                model: modelName,
                messages: [
                  { role: "system", content: "You translate subtitle text and return only valid JSON." },
                  { role: "user", content: prompt },
                ],
                temperature: 0.1,
              }),
            });
            if (!upstream.ok) throw new Error(await upstream.text());
            responseText = extractCustomApiText(await upstream.text());
          } catch (customError) {
            if (!allowGeminiFallback || geminiKeys.length === 0) throw customError;
            provider = "gemini-fallback";
          }
        }

        if (!responseText) {
          if (geminiKeys.length === 0) throw new Error("Không có Gemini API Key để dịch kết quả PaddleOCR.");
          const response = await runWithGeminiKeyRotation(geminiKeys, "PaddleOCR text-only translation", (ai) => ai.models.generateContent({
            model: "gemini-3.5-flash",
            contents: prompt,
            config: {
              temperature: 0.1,
              responseMimeType: "application/json",
              thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    index: { type: Type.NUMBER },
                    translated: { type: Type.STRING },
                  },
                  required: ["index", "translated"],
                },
              },
            },
          }));
          responseText = String(response?.text || "");
        }

        const parsedByIndex = parseSubtitleTranslations(responseText, chunk.length);
        const missingIndexes = chunk
          .map((_: any, index: number) => index)
          .filter((index: number) => !parsedByIndex.has(index));
        if (missingIndexes.length > 0) {
          throw new Error(`AI trả thiếu ${missingIndexes.length}/${chunk.length} dòng dịch (vị trí: ${missingIndexes.map((index: number) => index + 1).join(", ")}). Batch sẽ được thử lại, không ghi đè bằng câu gốc.`);
        }
        chunk.forEach((subtitle: any, index: number) => {
          translatedById.set(subtitle.id, parsedByIndex.get(index)!);
        });
      }

      return res.json({
        subtitles: safeSubtitles.map((subtitle: any) => ({
          ...subtitle,
          translated: translatedById.get(subtitle.id)!,
        })),
        provider,
      });
    } catch (error: any) {
      console.error("Text-only subtitle translation failed:", error);
      return res.status(getErrorHttpStatus(error)).json({ error: error?.message || "Không thể dịch kết quả PaddleOCR." });
    }
  });

  app.post("/api/fit-tts-subtitles", async (req, res) => {
    try {
      const {
        items,
        apiPlatform,
        customApiUrl,
        customApiKey,
        customModel,
        allowGeminiFallback,
        translationGlossary,
        translationStyle,
      } = req.body || {};
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "Không có câu thuyết minh cần rút gọn." });
      }

      const safeItems = items.slice(0, 40).map((item: any, index: number) => ({
        index,
        id: String(item?.id || `tts-${index + 1}`),
        text: String(item?.text || "").replace(/\s+/g, " ").trim(),
        previousText: String(item?.previousText || "").replace(/\s+/g, " ").trim().slice(0, 800),
        nextText: String(item?.nextText || "").replace(/\s+/g, " ").trim().slice(0, 800),
        maxSeconds: Math.max(0.2, Math.min(60, Number(item?.maxSeconds) || 3)),
        groupId: String(item?.groupId || ""),
        maxChars: Math.max(8, Math.min(500, Math.round(Number(item?.maxChars) || 80))),
      })).filter((item: any) => item.text);
      if (safeItems.length === 0) {
        return res.status(400).json({ error: "Các câu thuyết minh cần rút gọn đều trống." });
      }

      const prompt = `Rút gọn các câu thuyết minh tiếng Việt để đọc kịp video.
Giữ nguyên ý chính, tên riêng, con số và quan hệ nhân quả quan trọng.
Dùng câu tự nhiên, dễ nghe, không viết tắt khó đọc, không thêm thông tin mới.
Giữ đúng văn phong dự án: ${String(translationStyle || "Tự nhiên, phù hợp ngữ cảnh video").slice(0, 3000)}
Tuân thủ tên riêng và thuật ngữ sau (nếu có): ${String(translationGlossary || "Không có bảng thuật ngữ riêng").slice(0, 5000)}
previousText và nextText chỉ dùng để hiểu ngữ cảnh; KHÔNG gộp nội dung của chúng vào câu hiện tại.
Ưu tiên bỏ từ đệm và diễn đạt cô đọng. Giữ nguyên sắc thái, chủ thể, phủ định, số liệu và quan hệ nhân quả.
maxSeconds là ngân sách đọc tham khảo; maxChars là giới hạn cứng.
Mỗi kết quả BẮT BUỘC không vượt quá maxChars ký tự (tính cả khoảng trắng).
Trả về duy nhất JSON array, đúng số lượng và thứ tự: {"index":number,"text":string}.
Input: ${JSON.stringify(safeItems.map(({ index, text, previousText, nextText, maxSeconds, groupId, maxChars }: any) => ({ index, text, previousText, nextText, maxSeconds, groupId, maxChars })))}`;

      const geminiKeys = getGeminiApiKeys(req);
      const wantsCustom = apiPlatform === "custom";
      const canUseCustom = wantsCustom && customApiUrl && customApiKey;
      let provider = canUseCustom ? "custom" : "gemini";
      let responseText = "";

      if (canUseCustom) {
        try {
          const targetUrl = normalizeCustomApiChatUrl(customApiUrl);
          const modelName = customModel || "gpt-4o-mini";
          const upstream = await trackedCustomApiFetch(targetUrl, customApiKey, modelName, "Smart TTS subtitle fitting", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${customApiKey}` },
            body: JSON.stringify({
              model: modelName,
              messages: [
                { role: "system", content: "You shorten Vietnamese voice-over lines and return only valid JSON." },
                { role: "user", content: prompt },
              ],
              temperature: 0.1,
            }),
          });
          if (!upstream.ok) throw new Error(await upstream.text());
          responseText = extractCustomApiText(await upstream.text());
        } catch (customError) {
          if (!allowGeminiFallback || geminiKeys.length === 0) throw customError;
          provider = "gemini-fallback";
        }
      }

      if (!responseText) {
        if (geminiKeys.length === 0) throw new Error("Không có Gemini API Key để tự rút gọn lời thuyết minh.");
        const response = await runWithGeminiKeyRotation(geminiKeys, "Smart TTS subtitle fitting", (ai) => ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: prompt,
          config: {
            temperature: 0.1,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  index: { type: Type.NUMBER },
                  text: { type: Type.STRING },
                },
                required: ["index", "text"],
              },
            },
          },
        }));
        responseText = String(response?.text || "");
      }

      const parsed = tryParsePartialJsonArray(responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
      const fitted = safeItems.map((item: any, index: number) => {
        const candidate = String(
          parsed.find((entry: any) => Number(entry?.index) === index)?.text ?? parsed[index]?.text ?? item.text,
        ).replace(/\s+/g, " ").trim();
        if (Array.from(candidate).length <= item.maxChars) return { id: item.id, text: candidate, maxChars: item.maxChars };
        const words = candidate.split(/\s+/);
        let shortened = "";
        for (const word of words) {
          const next = shortened ? `${shortened} ${word}` : word;
          if (Array.from(next).length > item.maxChars) break;
          shortened = next;
        }
        return { id: item.id, text: shortened || Array.from(candidate).slice(0, item.maxChars).join(""), maxChars: item.maxChars };
      });

      return res.json({ items: fitted, provider });
    } catch (error: any) {
      console.error("Smart TTS subtitle fitting failed:", error);
      return res.status(getErrorHttpStatus(error)).json({ error: error?.message || "Không thể tự rút gọn lời thuyết minh." });
    }
  });

  app.post("/api/quota-status", (req, res) => {
    const geminiKeys = getGeminiApiKeys(req);
    const customApiKey = typeof req.body?.customApiKey === "string" ? req.body.customApiKey.trim() : "";
    const customModel = typeof req.body?.customModel === "string" ? req.body.customModel.trim() : "";
    const configuredStats: ApiUsageStat[] = [];

    geminiKeys.forEach((key) => {
      const stat = getApiUsageStat("gemini", key, "");
      configuredStats.push(stat);
    });
    if (customApiKey) {
      const stat = getApiUsageStat("custom", customApiKey, customModel || "Chưa chọn model");
      configuredStats.push(stat);
    }

    const entries = configuredStats
      .map(({ id: _internalId, ...safeStat }) => ({
        ...safeStat,
        quotaVisibility: safeStat.provider === "gemini"
          ? "Gemini API không cung cấp số quota còn lại qua API key; số request/token bên dưới là số đo chính xác của app trong phiên server hiện tại."
          : (safeStat.rateLimit.requestRemaining !== null || safeStat.rateLimit.tokenRemaining !== null)
            ? "Hạn mức còn lại được đọc trực tiếp từ rate-limit header của nhà cung cấp."
            : "Nhà cung cấp chưa trả rate-limit header; app vẫn ghi chính xác request, lỗi và token quan sát được.",
      }));

    return res.json({
      entries,
      updatedAt: new Date().toISOString(),
      scope: "current-server-session",
    });
  });

  app.post("/api/test-custom-api", async (req, res) => {
    try {
      const { customApiUrl, customApiKey, customModel } = req.body || {};
      if (!customApiUrl || !customApiKey) {
        return res.status(400).json({ error: "Vui lòng nhập đầy đủ Custom API URL và API Key." });
      }

      const targetUrl = normalizeCustomApiChatUrl(customApiUrl);
      const upstream = await trackedCustomApiFetch(targetUrl, customApiKey, customModel || "gpt-4o-mini", "Kiểm tra kết nối", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${customApiKey}`,
        },
        body: JSON.stringify({
          model: customModel || "gpt-4o-mini",
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          max_tokens: 8,
          temperature: 0,
        }),
      });
      const rawResponse = await upstream.text();
      if (!upstream.ok) {
        return res.status(upstream.status).json({
          error: summarizeCustomApiError(upstream.status, rawResponse),
          endpoint: targetUrl,
        });
      }

      const reply = extractCustomApiText(rawResponse);
      return res.json({
        success: true,
        message: "Kết nối thành công! Custom API hoạt động tốt.",
        endpoint: targetUrl,
        reply: reply.slice(0, 100),
      });
    } catch (error: any) {
      return res.status(400).json({
        error: error?.message || "Không thể kết nối Custom API.",
      });
    }
  });

  app.post("/api/translate-video", async (req, res) => {
    try {
      let {
        videoBase64,
        mimeType,
        frames,
        sourceLanguage,
        targetLanguage,
        duration,
        videoDuration,
        chunkIndex,
        chunkStart,
        chunkEnd,
        timestampMode,
        apiPlatform,
        customApiUrl,
        customApiKey,
        customModel,
        extractionMethod,
        allowGeminiFallback,
        translationGlossary,
        translationStyle,
      } = req.body;
      
      if (extractionMethod === "ocr") {
        return res.status(400).json({
          error: "Chế độ PaddleOCR native phải dùng /api/ocr/batch rồi /api/translate-subtitles; không gửi ảnh vào AI Vision.",
        });
      }
      const isOcr = extractionMethod === "aiocr";
      
      if (isOcr) {
        if (!frames || !Array.isArray(frames) || frames.length === 0) {
          return res.status(400).json({ error: "Không tìm thấy khung hình video để thực hiện OCR." });
        }
      } else {
        if (!videoBase64) {
          return res.status(400).json({ error: "Vui lòng chọn hoặc tải video lên trước." });
        }
      }

      const isRawVideoRequest = extractionMethod === "aiocr";
      const explicitCustomSelection = apiPlatform === "custom";
      const hasCustomConfig = Boolean(customApiUrl && customApiKey);
      const useCustomApi = explicitCustomSelection && hasCustomConfig;
      const allowFallback = allowGeminiFallback === true;

      if (isRawVideoRequest && (!mimeType || !mimeType.startsWith("video/"))) {
        console.log(`AI OCR request missing or invalid video mimeType. Defaulting to video/mp4 (original mimeType=${mimeType}).`);
        mimeType = "video/mp4";
      }

      const geminiApiKeys = getGeminiApiKeys(req);
      if (explicitCustomSelection && !hasCustomConfig && geminiApiKeys.length === 0) {
        return res.status(400).json({
          error: "Custom API chưa được cấu hình đầy đủ và không có Gemini API Key để tự chuyển sang dịch dự phòng."
        });
      }
      const hasRequiredApiKey = useCustomApi ? Boolean(customApiKey) : geminiApiKeys.length > 0;
      if (!hasRequiredApiKey) {
        return res.status(500).json({
          error: "Chưa cấu hình API Key. Vui lòng cấu hình Gemini hoặc Custom API trong mục Cài đặt."
        });
      }

      console.log(`translate-video request: apiPlatform=${apiPlatform || "<missing>"}, useCustomApi=${useCustomApi}, allowFallback=${allowFallback}, geminiKeyCount=${geminiApiKeys.length}, sourceLanguage=${sourceLanguage}, targetLanguage=${targetLanguage}, extractionMethod=${extractionMethod}`);

      // Strip data uri prefix if present
      const base64Data = videoBase64 && videoBase64.includes(";base64,")
        ? videoBase64.split(";base64,")[1]
        : videoBase64;

      const languageMap: Record<string, string> = {
        "vi": "Vietnamese",
        "en": "English",
        "ja": "Japanese",
        "zh": "Chinese",
        "ko": "Korean",
        "fr": "French",
        "es": "Spanish",
      };
      
      const targetLangName = languageMap[targetLanguage] || targetLanguage || "Vietnamese";
      const srcLangName = sourceLanguage === "auto"
        ? "automatically detect the spoken language"
        : (languageMap[sourceLanguage] || sourceLanguage || "automatically detect the spoken language");

      const numericChunkStart = Number.isFinite(Number(chunkStart)) ? Number(chunkStart) : 0;
      const numericChunkEnd = Number.isFinite(Number(chunkEnd)) ? Number(chunkEnd) : numericChunkStart + Number(duration || 0);
      const numericVideoDuration = Number.isFinite(Number(videoDuration)) && Number(videoDuration) > 0
        ? Number(videoDuration)
        : Number(duration || numericChunkEnd || 0);
      const usesAbsoluteTimestamps = timestampMode === "absolute";
      const durationText = numericVideoDuration
        ? ` The total duration of the original video is ${numericVideoDuration.toFixed(2)} seconds. Ensure no subtitle exceeds this duration.`
        : "";
      const chunkTimingText = usesAbsoluteTimestamps
        ? `\nABSOLUTE TIMESTAMP MODE: This supplied media segment starts at ${numericChunkStart.toFixed(2)} seconds and ends at ${numericChunkEnd.toFixed(2)} seconds in the original video. Return start and end as ABSOLUTE numeric seconds in the original video, never relative to this clip. Example: if speech starts 1.25 seconds into a chunk beginning at 10.00, return 11.25, not 1.25.`
        : "";

      const ocrGoal = isOcr
        ? `Your main goal is to act as a visual AI OCR and subtitle translation assistant: detect and extract hardcoded (burned-in) on-screen subtitles present visually on the video frames, transcribe them verbatim in the original language (${srcLangName}), and translate them to the target language (${targetLangName}).`
        : `Your main goal is to analyze the audio and visual speech in this video and generate comfortable, highly synchronized subtitle segments matching the spoken dialogue. Transcribe verbatim in the original language (${srcLangName}) and translate accurately into ${targetLangName}.`;

      let prompt = `You are an expert video transcribing, OCR, and translation assistant.
${ocrGoal}

CRITICAL RULES FOR SUBTITLE CHUNKING:
1. Divide the detected speech or on-screen subtitles into short, comfortable, easy-to-read segments.
2. Each segment MUST be short: maximum 8-12 words or under 55 characters per segment. Do NOT clump multiple sentences or long paragraphs into a single segment.
3. If a sentence is long or contains multiple clauses, split it logically and chronologically into separate sequential segments.
4. Each segment's duration (end minus start) should typically be 1.5 to 4.5 seconds. NEVER let a single segment exceed 6 seconds.
5. EXACT TIMING: Timestamps must be accurate to 0.01 seconds, using the first audible phoneme and the final audible phoneme. Do not round to whole seconds or 0.5-second boundaries. There are no overlapping durations.
6. You MUST specify start and end as JSON numbers measured in seconds with two decimal places.
7. Transcribe verbatim in the original language (${srcLangName}).
8. Translate accurately into ${targetLangName}. Keep translations concise, natural, and clear.
9. 1-LINE SUBTITLES: You must NEVER use line breaks (\\n). Both the original and translated text MUST be formatted as a single row string.
10. Return the result strictly in JSON matching the requested schema. If there are no spoken parts or subtitles, return an empty array [] without failing.
11. MANDATORY COMPLETE COVERAGE: Cover ALL visual or spoken parts inside the supplied media segment. Do not invent speech outside the supplied segment and never truncate a sentence that is fully audible.${durationText}${chunkTimingText}${translationGlossary?.trim() ? `\n\nTERMINOLOGY GLOSSARY (always use these translations for these terms):\n${translationGlossary.trim()}` : ""}${translationStyle?.trim() ? `\n\nTRANSLATION STYLE: ${translationStyle.trim()}` : ""}`;

      console.log(`Sending video to AI service for transcription and translation to ${targetLangName}...`);

      if (isOcr && frames && frames.length > 0) {
        prompt += `\n\nHere are the video frames extracted at regular intervals. Each frame is labeled with its timestamp. Use these frames to detect and translate the subtitles.\n\nFrame timestamps:\n${frames.map((f: any, idx: number) => `Frame ${idx + 1}: ${f.timestamp}s`).join("\n")}`;
      }

      let response: any;
      if (useCustomApi) {
        console.log('Using Custom API directly because apiPlatform is custom.');
        try {
          const targetUrl = normalizeCustomApiChatUrl(customApiUrl);

          const modelName = customModel || 'gpt-4o-mini';
          const customPrompt = `AI video OCR/transcription and translation prompt.\n\n${prompt}`;

          let messages: any[] = [
            { role: 'system', content: 'You are an expert subtitle transcription and translation engine. Output ONLY a valid JSON array of subtitle objects.' }
          ];

          if (isOcr && frames && frames.length > 0) {
            const contentArray: any[] = [
              { type: 'text', text: customPrompt }
            ];
            for (const frame of frames) {
              contentArray.push({
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${frame.base64}`
                }
              });
            }
            messages.push({
              role: 'user',
              content: contentArray
            });
          } else {
            messages.push({
              role: 'user',
              content: `Video data (base64): ${base64Data}\n\nInstructions:\n${customPrompt}`
            });
          }

          const customResponse = await trackedCustomApiFetch(targetUrl, customApiKey, modelName, "Custom transcription", {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${customApiKey}`
            },
            body: JSON.stringify({
              model: modelName,
              messages: messages,
              temperature: 0.2
            })
          });

          if (!customResponse.ok) {
            const text = await customResponse.text();
            throw new Error(`Custom API request failed: ${customResponse.status} ${text}`);
          }

          const customResultText = await customResponse.text();
          response = { text: extractCustomApiText(customResultText) };
        } catch (customErr: any) {
          if (allowFallback && geminiApiKeys.length > 0) {
            console.warn('Custom API failed, falling back to Gemini due to fallback setting.');
          } else {
            throw customErr;
          }
        }
      }

      if (!response) {
        if (geminiApiKeys.length === 0) {
          throw new Error("Không có Gemini API Key để fallback. Vui lòng bật 'allowGeminiFallback' với Gemini API Key hợp lệ, hoặc kiểm tra cấu hình Custom API.");
        }
        try {
          let parts: any[] = [];
          if (isOcr && frames && frames.length > 0) {
            parts = frames.map((frame: any) => ({
              inlineData: {
                mimeType: "image/jpeg",
                data: frame.base64,
              }
            }));
          } else {
            parts = [
              {
                inlineData: {
                  mimeType: mimeType || "audio/wav",
                  data: base64Data,
                }
              }
            ];
          }
          parts.push({ text: prompt });

          response = await runWithGeminiKeyRotation(geminiApiKeys, "Gemini translation", (geminiAi) => geminiAi.models.generateContent({
            model: "gemini-3.5-flash",
            contents: {
              parts: parts
            },
            config: {
              systemInstruction: "You are an expert video transcribing and translation assistant. Your job is to extract ALL spoken dialogue or visual subtitles from the video, generate highly accurate synchronized subtitles with PRECISE timing matching the video, and translate them perfectly into the requested target language. You must ensure subtitles NEVER contain line breaks (they must be exactly one single line). You never omit, truncate, or skip any part of the spoken dialogue or visual subtitles. You must transcribe and translate chronologically from the very beginning to the absolute end of the video.",
              temperature: 0.1,
              responseMimeType: "application/json",
              maxOutputTokens: 8192,
              thinkingConfig: {
                thinkingLevel: ThinkingLevel.MINIMAL,
              },
              responseSchema: {
                type: Type.ARRAY,
                description: "List of subtitle segments with precise timing and translation.",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    start: {
                      type: Type.NUMBER,
                      description: "Absolute start time in the original video, expressed as numeric seconds accurate to 0.01s."
                    },
                    end: {
                      type: Type.NUMBER,
                      description: "Absolute end time in the original video, expressed as numeric seconds accurate to 0.01s."
                    },
                    original: {
                      type: Type.STRING,
                      description: "The original spoken sentence or words."
                    },
                    translated: {
                      type: Type.STRING,
                      description: "The translated sentence or words in the target language."
                    }
                  },
                  required: ["start", "end", "original", "translated"]
                }
              }
            }
          }));
        } catch (gemErr: any) {
          console.warn('Gemini generation failed:', gemErr?.message || gemErr);
          if (useCustomApi && allowFallback) {
            console.log('Gemini failed, falling back to Custom API because fallback is enabled.');
          } else {
            throw gemErr;
          }
        }
      }

      if (!response && useCustomApi) {
        try {
          const targetUrl = normalizeCustomApiChatUrl(customApiUrl);

          const modelName = customModel || 'gpt-4o-mini';
          const customPrompt = `AI video OCR/transcription and translation prompt.\n\n${prompt}`;

          let messages: any[] = [
            { role: 'system', content: 'You are an expert subtitle transcription and translation engine. Output ONLY a valid JSON array of subtitle objects.' }
          ];

          if (isOcr && frames && frames.length > 0) {
            const contentArray: any[] = [
              { type: 'text', text: customPrompt }
            ];
            for (const frame of frames) {
              contentArray.push({
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${frame.base64}`
                }
              });
            }
            messages.push({
              role: 'user',
              content: contentArray
            });
          } else {
            messages.push({
              role: 'user',
              content: `Video data (base64): ${base64Data}\n\nInstructions:\n${customPrompt}`
            });
          }

          const customResponse = await trackedCustomApiFetch(targetUrl, customApiKey, modelName, "Custom transcription fallback", {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${customApiKey}`
            },
            body: JSON.stringify({
              model: modelName,
              messages: messages,
              temperature: 0.2
            })
          });

          if (!customResponse.ok) {
            const text = await customResponse.text();
            throw new Error(`Custom API request failed: ${customResponse.status} ${text}`);
          }

          const customResultText = await customResponse.text();
          response = { text: extractCustomApiText(customResultText) };
        } catch (customErr: any) {
          console.error('Custom API request failed during fallback or initial custom use:', customErr?.message || customErr);
          throw customErr;
        }
      }

      let responseText = "";
      try {
        // Handle Gemini response (has .text() method)
        if (response && response.text && typeof response.text === 'function') {
          responseText = await response.text();
        } else if (response && response.text && typeof response.text === 'string') {
          responseText = response.text;
        } else if (response && response.candidates && Array.isArray(response.candidates)) {
          // Gemini response with candidates but no .text() method
          const candidate = response.candidates[0];
          if (candidate && candidate.content && candidate.content.parts) {
            const textPart = candidate.content.parts.find((p: any) => p.text);
            if (textPart) {
              responseText = textPart.text;
            }
          }
        } else if (response && typeof response === 'object' && response !== null) {
          // For other response types (e.g., direct from custom API), assume it's already a string or can be JSON.parsed
          try {
            responseText = JSON.stringify(response);
          } catch (jsonError) {
            console.warn("Could not stringify response object:", jsonError);
            responseText = String(response);
          }
        }
      } catch (e: any) {
        console.error("Error retrieving or processing response.text:", e);
        throw new Error(`Lỗi nhận hoặc xử lý phản hồi từ AI: ${e.message}`);
      }

      if (!responseText) {
        return res.status(500).json({ error: "Không nhận được phản hồi từ AI. Vui lòng thử lại." });
      }

      console.log("Raw response from Gemini length:", responseText.length);

      // Clean up markdown wrappers if present
      let cleanText = responseText.trim();
      if (cleanText.startsWith("```")) {
        cleanText = cleanText.replace(/^```(?:json)?\s*/i, "");
        cleanText = cleanText.replace(/\s*```$/, "");
      }
      cleanText = cleanText.trim();

      // Robust array extraction: find first '[' and last ']'
      const startIndex = cleanText.indexOf("[");
      const endIndex = cleanText.lastIndexOf("]");
      if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        cleanText = cleanText.substring(startIndex, endIndex + 1);
      }

      let parsedSubtitles = tryParsePartialJsonArray(cleanText);
      if (!parsedSubtitles || parsedSubtitles.length === 0) {
        console.error("Failed to parse cleaned JSON:", cleanText);
        throw new Error("Không thể phân tích định dạng dữ liệu phụ đề từ AI.");
      }

      // Convert start and end strings to numbers of seconds
      let processedSubtitles = parsedSubtitles.map((sub: any) => {
        return {
          ...sub,
          start: parseTimeToSeconds(sub.start),
          end: parseTimeToSeconds(sub.end),
        };
      });
      
      if (usesAbsoluteTimestamps) {
        const localDuration = Math.max(0, numericChunkEnd - numericChunkStart);
        const tolerance = 0.35;
        const timingCandidates = processedSubtitles.map((sub: any) => ({
          sub,
          absoluteFits: sub.start >= numericChunkStart - tolerance && sub.end <= numericChunkEnd + tolerance,
          relativeFits: sub.start >= -tolerance && sub.end <= localDuration + tolerance,
        }));
        const strongAbsoluteCount = timingCandidates.filter((item: any) => item.absoluteFits && !item.relativeFits).length;
        const strongRelativeCount = timingCandidates.filter((item: any) => item.relativeFits && !item.absoluteFits).length;
        const preferRelative = numericChunkStart > 0.01 && strongRelativeCount > strongAbsoluteCount;
        let previousEnd = numericChunkStart;
        let correctedRelativeCount = 0;

        // Gemini đôi khi trả lẫn timestamp local và absolute trong cùng một mảng.
        // Chuẩn hóa từng câu, đồng thời dùng thứ tự thoại để giải quyết các mốc mơ hồ.
        processedSubtitles = timingCandidates.map(({ sub, absoluteFits, relativeFits }: any) => {
          let useRelative = false;
          if (numericChunkStart > 0.01) {
            if (relativeFits && !absoluteFits) useRelative = true;
            else if (relativeFits && absoluteFits) {
              const absoluteBacktracks = sub.start < previousEnd - tolerance;
              const shiftedBacktracks = sub.start + numericChunkStart < previousEnd - tolerance;
              if (absoluteBacktracks !== shiftedBacktracks) useRelative = !shiftedBacktracks;
              else useRelative = preferRelative;
            }
          }
          const normalized = {
            ...sub,
            start: sub.start + (useRelative ? numericChunkStart : 0),
            end: sub.end + (useRelative ? numericChunkStart : 0),
          };
          if (useRelative) correctedRelativeCount++;
          previousEnd = Math.max(previousEnd, normalized.end);
          return normalized;
        });
        if (correctedRelativeCount > 0) {
          console.warn(
            `Chunk #${Number(chunkIndex) + 1}: normalized ${correctedRelativeCount}/${processedSubtitles.length} relative timestamps individually.`,
          );
        }

        processedSubtitles = processedSubtitles
          .filter((sub: any) => Number.isFinite(sub.start) && Number.isFinite(sub.end))
          .filter((sub: any) => sub.end > numericChunkStart && sub.start < numericChunkEnd)
          .map((sub: any) => ({
            ...sub,
            start: Number(Math.max(numericChunkStart, Math.min(numericVideoDuration, sub.start)).toFixed(2)),
            end: Number(Math.max(numericChunkStart, Math.min(numericChunkEnd, numericVideoDuration, sub.end)).toFixed(2)),
          }))
          .filter((sub: any) => sub.end > sub.start);
      } else if (numericVideoDuration > 0) {
        processedSubtitles = processedSubtitles
          .filter((sub: any) => sub.start < numericVideoDuration)
          .map((sub: any) => ({
            ...sub,
            start: Number(Math.max(0, sub.start).toFixed(2)),
            end: Number(Math.min(numericVideoDuration, sub.end).toFixed(2)),
          }))
          .filter((sub: any) => sub.end > sub.start);
      }

      // If Custom API is configured, use it to perform translation/localization refinement
      if (customApiUrl && customApiKey) {
        console.log(`Calling Custom API (${customApiUrl}) for subtitle translation/refinement to ${targetLangName}...`);
        try {
          const targetUrl = normalizeCustomApiChatUrl(customApiUrl);

          const modelName = customModel || "gpt-4o-mini";
          
          // Structure the prompt so the model returns only a JSON array of the translated subtitles
          const customPrompt = `You are an expert subtitle translation and localization engine.
Your task is to translate the following subtitle segments from their original language into ${targetLangName}.

CRITICAL RULES:
1. Preserve the EXACT 'start' and 'end' timing and structure for every single segment.
2. Translate the 'translated' field into beautiful, natural, clear, and idiomatic ${targetLangName}. Keep the 'original' field exactly the same.
3. Ensure the translated text has absolutely NO line breaks (must be exactly one single line per subtitle).
4. Output ONLY a valid JSON array matching the exact structure of the input. Do NOT include markdown formatting, backticks (\`\`\`json), or any conversational prefaces or notes.

Input Subtitles:
${JSON.stringify(processedSubtitles.map((sub: any) => ({
  start: sub.start,
  end: sub.end,
  original: sub.original,
  translated: sub.translated || ""
})))}`;

          const customResponse = await trackedCustomApiFetch(targetUrl, customApiKey, modelName, "Custom translation refinement", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${customApiKey}`
            },
            body: JSON.stringify({
              model: modelName,
              messages: [
                {
                  role: "system",
                  content: "You are a professional video translator. You output ONLY a raw JSON array of subtitle objects without markdown backticks."
                },
                {
                  role: "user",
                  content: customPrompt
                }
              ],
              temperature: 0.2
            })
          });

          if (customResponse.ok) {
            const customResultText = extractCustomApiText(await customResponse.text());
            console.log("Custom API Raw Response length:", customResultText.length);
            
            let cleanCustomText = customResultText.trim();
            if (cleanCustomText.startsWith("```")) {
              cleanCustomText = cleanCustomText.replace(/^```(?:json)?\s*/i, "");
              cleanCustomText = cleanCustomText.replace(/\s*```$/, "");
            }
            cleanCustomText = cleanCustomText.trim();

            const customStartIndex = cleanCustomText.indexOf("[");
            const customEndIndex = cleanCustomText.lastIndexOf("]");
            if (customStartIndex !== -1 && customEndIndex !== -1 && customEndIndex > customStartIndex) {
              cleanCustomText = cleanCustomText.substring(customStartIndex, customEndIndex + 1);
            }

            const parsedCustomSubs = tryParsePartialJsonArray(cleanCustomText);
            if (parsedCustomSubs && parsedCustomSubs.length > 0) {
              // Merge translation back into processedSubtitles
              processedSubtitles = processedSubtitles.map((sub: any, idx: number) => {
                const customSub = parsedCustomSubs[idx] || parsedCustomSubs.find((cs: any) => cs.start === sub.start || cs.original === sub.original);
                return {
                  ...sub,
                  translated: customSub ? (customSub.translated || customSub.original || sub.original) : sub.translated
                };
              });
              console.log("Successfully refined subtitles using Custom Beeknoee API.");
            } else {
              console.warn("Could not parse Custom API JSON response array. Falling back to Gemini subtitles.");
            }
          } else {
            const errText = await customResponse.text();
            console.error(`Custom API returned error status ${customResponse.status}:`, errText);
            // Don't crash, fall back to Gemini subtitles
          }
        } catch (customErr: any) {
          console.error("Error during Custom API translation refinement:", customErr);
          // Don't crash, fallback to Gemini subtitles
        }
      }

      // --- SANITY CHECK & TRANSLATION RE-CORRECTION PASS ---
      const isSameLanguage = sourceLanguage !== "auto" && sourceLanguage === targetLanguage;
      const segmentsToCorrect = processedSubtitles.map((sub: any, idx: number) => ({ ...sub, originalIndex: idx }))
        .filter((sub: any) => isUntranslated(sub.original, sub.translated, isSameLanguage));

      if (segmentsToCorrect.length > 0) {
        console.log(`[Sanity Check] Found ${segmentsToCorrect.length} untranslated/incorrect segments. Starting re-translation correction pass...`);
        try {
          const correctionPrompt = `You are an expert translation auditor.
We detected that the following subtitle segments were not translated into ${targetLangName} (or were left identical to original text).
Please translate them accurately, naturally, and concisely into ${targetLangName} now.

CRITICAL RULES:
1. Translate the 'original' text into high-quality, professional, and clear ${targetLangName}.
2. Ensure there are absolutely NO line breaks.
3. Return ONLY a valid JSON array of objects, each with 'originalIndex' (the index number provided below) and 'translated' (your new translation).
4. Do NOT wrap the JSON in markdown code blocks or backticks (\`\`\`json). Output raw, pure JSON text only.

Input Segments to Correct:
${JSON.stringify(segmentsToCorrect.map((sub: any) => ({
  originalIndex: sub.originalIndex,
  original: sub.original,
  translated: sub.translated || ""
})))}`;

          let correctionResultText = "";
          
          if (customApiUrl && customApiKey) {
            // Use Custom API (Beeknoee / OpenAI) for correcting
            const targetUrl = normalizeCustomApiChatUrl(customApiUrl);
            const modelName = customModel || "gpt-4o-mini";
            const customResponse = await trackedCustomApiFetch(targetUrl, customApiKey, modelName, "Custom translation correction", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${customApiKey}`
              },
              body: JSON.stringify({
                model: modelName,
                messages: [
                  {
                    role: "system",
                    content: "You are a professional video translator. You output ONLY a raw JSON array of correction objects."
                  },
                  {
                    role: "user",
                    content: correctionPrompt
                  }
                ],
                temperature: 0.1
              })
            });

            if (customResponse.ok) {
              correctionResultText = extractCustomApiText(await customResponse.text());
            } else {
              console.warn(`Custom API Correction request failed with status: ${customResponse.status}`);
            }
          } else {
            // Use Google Gemini AI for correcting
            if (geminiApiKeys.length === 0) {
              throw new Error("Không có Gemini API Key để sửa bản dịch. Vui lòng cấu hình GEMINI_API_KEY hoặc bật Custom API.");
            }
            const correctionResponse = await runWithGeminiKeyRotation(geminiApiKeys, "Gemini translation correction", (geminiAi) => geminiAi.models.generateContent({
              model: "gemini-3.5-flash",
              contents: {
                parts: [
                  { text: correctionPrompt }
                ]
              },
              config: {
                systemInstruction: "You are a professional subtitle translator. You output ONLY a raw JSON array of correction objects.",
                temperature: 0.1,
                responseMimeType: "application/json"
              }
            }));
            correctionResultText = correctionResponse.text || "";
          }

          if (correctionResultText) {
            console.log("Correction raw response length:", correctionResultText.length);
            let cleanCorrectionText = correctionResultText.trim();
            if (cleanCorrectionText.startsWith("```")) {
              cleanCorrectionText = cleanCorrectionText.replace(/^```(?:json)?\s*/i, "");
              cleanCorrectionText = cleanCorrectionText.replace(/\s*```$/, "");
            }
            cleanCorrectionText = cleanCorrectionText.trim();

            const firstBracket = cleanCorrectionText.indexOf("[");
            const lastBracket = cleanCorrectionText.lastIndexOf("]");
            if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
              cleanCorrectionText = cleanCorrectionText.substring(firstBracket, lastBracket + 1);
            }

            const parsedCorrections = tryParsePartialJsonArray(cleanCorrectionText);
            if (parsedCorrections && parsedCorrections.length > 0) {
              let appliedCount = 0;
              for (const item of parsedCorrections) {
                if (item && typeof item.originalIndex === "number" && processedSubtitles[item.originalIndex]) {
                  const newTranslation = item.translated || item.translation;
                  if (newTranslation && newTranslation.trim()) {
                    processedSubtitles[item.originalIndex].translated = newTranslation.trim();
                    appliedCount++;
                  }
                }
              }
              console.log(`[Sanity Check] Successfully re-translated and corrected ${appliedCount} segments!`);
            } else {
              console.warn("[Sanity Check] Could not parse any corrections from AI response.");
            }
          }
        } catch (correctionErr: any) {
          console.error("Error during translation sanity correction pass:", correctionErr);
        }
      } else {
        console.log("[Sanity Check] All segments passed translation validation. No correction needed.");
      }

      console.log(`Successfully generated and processed ${processedSubtitles.length} subtitle segments.`);
      return res.json({ subtitles: processedSubtitles });

    } catch (error: any) {
      console.error("Error transcribing video:", error);
      return res.status(getErrorHttpStatus(error)).json({ 
        error: error.message || "Đã xảy ra lỗi trong quá trình dịch thuật video từ Gemini AI." 
      });
    }
  });

  app.post("/api/time-stretch-audio", async (req, res) => {
    const inputPath = path.join(os.tmpdir(), `dubbin-tempo-in-${randomUUID()}.wav`);
    const outputPath = path.join(os.tmpdir(), `dubbin-tempo-out-${randomUUID()}.wav`);
    try {
      const audio = String(req.body?.audio || "");
      const rate = Math.max(1, Math.min(1.3, Number(req.body?.rate) || 1.2));
      if (!audio) return res.status(400).json({ error: "Thiếu audio cần đổi tốc độ." });
      fs.writeFileSync(inputPath, Buffer.from(audio, "base64"));
      const ffmpeg = findBundledFfmpeg();
      await new Promise<void>((resolve, reject) => {
        let stderr = "";
        const child = spawn(ffmpeg, [
          "-y", "-hide_banner", "-loglevel", "error", "-i", inputPath,
          "-af", `atempo=${rate.toFixed(4)}`, "-ac", "1", "-ar", "24000", outputPath,
        ], { windowsHide: true });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.once("error", reject);
        child.once("close", (code) => code === 0
          ? resolve()
          : reject(new Error(stderr.trim() || `FFmpeg atempo dừng (${code}).`)));
      });
      return res.json({ audio: fs.readFileSync(outputPath).toString("base64"), format: "wav", rate });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "Không thể đổi tốc độ audio mà giữ nguyên cao độ." });
    } finally {
      for (const filePath of [inputPath, outputPath]) {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
      }
    }
  });

  app.post("/api/synthesize-tts", async (req, res) => {
    try {
      const { text, voiceName, engine, sessionId } = req.body;
      if (!text) {
        return res.status(400).json({ error: "Thiếu nội dung cần tạo giọng đọc." });
      }
      if (!/[\p{L}\p{N}]/u.test(String(text))) {
        return res.status(422).json({ error: "Nội dung chỉ có dấu câu hoặc ký hiệu, không có ký tự để tạo giọng đọc." });
      }

      const activeEngine = engine || (voiceName && voiceName.startsWith("BV0") ? "tiktok" : "vieneu");

      if (activeEngine === "tiktok") {
        const activeSessionId = sessionId || process.env.TIKTOK_SESSIONID;
        if (!activeSessionId) {
          return res.status(400).json({
            error: "Thiếu TikTok Session ID. Vui lòng cấu hình TIKTOK_SESSIONID trong file .env hoặc điền Session ID trực tiếp trong tab Thuyết Minh."
          });
        }

        const voice = voiceName || "BV074_streaming"; // default to Vietnamese female
        console.log(`Generating speech using TikTok TTS for text: "${text.substring(0, 30)}..." with voice: ${voice}`);

        const url = new URL("https://api16-normal-c-useast1a.tiktokv.com/media/api/text/speech/invoke/");
        url.searchParams.append("text_speaker", voice);
        url.searchParams.append("req_text", text);
        url.searchParams.append("speaker_map_type", "0");
        url.searchParams.append("aid", "1233");

        const response = await fetch(url.toString(), {
          method: "POST",
          headers: {
            "User-Agent": "com.zhiliaoapp.musically/2022600030 (Linux; U; Android 7.1.2; en_US; SM-G973N; Build/N2G48H;tt-ok/3.12.13.1)",
            "Cookie": `sessionid=${activeSessionId}`,
          },
        });

        if (!response.ok) {
          throw new Error(`Lỗi kết nối API TikTok: ${response.statusText} (${response.status})`);
        }

        const data: any = await response.json();
        const statusCode = data.status_code;
        const message = data.message || "";

        if (statusCode === 0) {
          const vStr = data.data?.v_str;
          if (!vStr) {
            throw new Error("Không tìm thấy dữ liệu âm thanh trong phản hồi của TikTok.");
          }
          return res.json({ audio: vStr, format: "mp3" });
        }

        if (statusCode === 1 || statusCode === 2 || statusCode === 5 || message.toLowerCase().includes("session")) {
          return res.status(401).json({
            error: "TikTok Session ID không hợp lệ hoặc đã hết hạn. Vui lòng cập nhật Session ID mới.",
            code: "TIKTOK_SESSION_INVALID",
            tiktokStatusCode: statusCode,
          });
        }

        return res.status(502).json({
          error: `Lỗi TikTok TTS (mã ${statusCode}): ${message || "TikTok không trả về mô tả lỗi."}`,
          code: "TIKTOK_UPSTREAM_ERROR",
          tiktokStatusCode: statusCode,
        });
      }

      if (activeEngine !== "vieneu") {
        return res.status(400).json({ error: `TTS engine không hợp lệ: ${activeEngine}` });
      }
      console.log(`Generating speech using local VieNeu TTS for text: "${text.substring(0, 30)}..." with voice: ${voiceName || "Phạm Tuyên"}`);
      return res.json(await synthesizeVieNeu(text, voiceName || "Phạm Tuyên", req.body.style || "tu_nhien"));
    } catch (error: any) {
      console.error("Error generating TTS:", error);
      return res.status(getErrorHttpStatus(error)).json({
        error: error.message || "Đã xảy ra lỗi trong quá trình tạo giọng đọc."
      });
    }
  });

  // Custom Error Handling Middleware to catch payload limits and parsing errors as JSON
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err) {
      console.error("Express global middleware error caught:", err);
      return res.status(err.status || 500).json({
        error: err.message || "Lỗi tải lên dữ liệu. Vui lòng chọn tệp video nhẹ hơn hoặc định dạng khác."
      });
    }
    next();
  });

  // Vite appends `?import` to dynamically loaded static resources.
  // helper module. Serve these immutable browser assets before Vite so the
  // dev middleware does not interpret that URL as a source-module request.
  // Khi chạy trong Electron production, DIST_PATH trỏ vào resources/app/dist
  const isElectron    = process.env.ELECTRON === "1";
  const isProduction  = process.env.NODE_ENV === "production" || isElectron;
  const resolvedDistPath = process.env.DIST_PATH || path.join(process.cwd(), "dist");
  // public/ assets (models, ort) nằm trong dist khi Electron build (vite copy public/* vào dist/)
  const publicBasePath = isElectron ? resolvedDistPath : path.join(process.cwd(), "public");

  app.use("/ort", express.static(path.join(publicBasePath, "ort"), {
    setHeaders: (res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  }));
  app.use("/models/paddle-ocr", express.static(path.join(publicBasePath, "models", "paddle-ocr"), {
    setHeaders: (res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  }));
  // Vite Integration (Vite Middleware in Dev, Static Files in Production/Electron)
  if (!isProduction) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(resolvedDistPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(resolvedDistPath, "index.html"));
    });
  }
  // Thêm đoạn này để Render kiểm tra xem server còn sống không
  app.get('/', (req, res) => {
    res.status(200).send('Server is running smoothly!');
  });

  // Khai báo PORT lấy từ môi trường đám mây hoặc mặc định là 3000
  const PORT = process.env.PORT || 3000;

  app.listen(Number(PORT), "127.0.0.1", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
