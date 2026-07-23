import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import dotenv from "dotenv";
import { getPaddleOcrHealth, initializePaddleOcr, recognizeOcrBatch, recognizeOcrFrame } from "./src/server/paddleOcr";

dotenv.config();

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
  try {
    const response = await fetch(targetUrl, init);
    updateRateLimitFromHeaders(stat, response.headers);
    if (response.ok) {
      const usagePayload = await response.clone().json().catch(() => undefined);
      recordApiSuccess(stat, usagePayload);
    } else {
      recordApiFailure(stat, `HTTP ${response.status}`, response.status === 429);
    }
    return response;
  } catch (error: any) {
    recordApiFailure(stat, error, false);
    throw error;
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Native OCR is a lazy safety net. Do not allocate Node worker_threads/model
  // memory unless both WebGPU and browser WASM have actually failed.

  // Set limits to support video upload in JSON payload up to 100GB (unlimited)
  app.use(express.json({ limit: "100gb" }));
  app.use(express.urlencoded({ limit: "100gb", extended: true }));

  // API Endpoints
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date() });
  });

  app.get("/api/ocr/health", async (req, res) => {
    if (req.query.retry === "1" && getPaddleOcrHealth().state === "error") {
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
      const canUseCustom = wantsCustom && customApiUrl && customApiKey;
      if (wantsCustom && !canUseCustom) {
        return res.status(400).json({ error: "Custom API chưa được cấu hình đầy đủ." });
      }
      const translatedById = new Map<string, string>();
      let provider = canUseCustom ? "custom" : "gemini";

      for (let offset = 0; offset < safeSubtitles.length; offset += 40) {
        const chunk = safeSubtitles.slice(offset, offset + 40);
        const compactInput = chunk.map((subtitle: any, index: number) => ({
          index,
          original: subtitle.original,
        }));
        const prompt = `Translate each subtitle from ${sourceLanguage || "auto-detected language"} to ${targetLanguage || "Vietnamese"}.
Return ONLY a JSON array with exactly the same number and order of items.
Each item must be {"index": number, "translated": string}.
Do not change, merge, split, omit, or add any subtitle. Every translation must be a single line.
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

        const parsed = tryParsePartialJsonArray(responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
        chunk.forEach((subtitle: any, index: number) => {
          const translated = parsed.find((item: any) => Number(item?.index) === index)?.translated ?? parsed[index]?.translated;
          translatedById.set(subtitle.id, String(translated || subtitle.original).replace(/\s+/g, " ").trim());
        });
      }

      return res.json({
        subtitles: safeSubtitles.map((subtitle: any) => ({
          ...subtitle,
          translated: translatedById.get(subtitle.id) || subtitle.original,
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
      } = req.body || {};
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "Không có câu thuyết minh cần rút gọn." });
      }

      const safeItems = items.slice(0, 40).map((item: any, index: number) => ({
        index,
        id: String(item?.id || `tts-${index + 1}`),
        text: String(item?.text || "").replace(/\s+/g, " ").trim(),
        maxChars: Math.max(8, Math.min(500, Math.round(Number(item?.maxChars) || 80))),
      })).filter((item: any) => item.text);
      if (safeItems.length === 0) {
        return res.status(400).json({ error: "Các câu thuyết minh cần rút gọn đều trống." });
      }

      const prompt = `Rút gọn các câu thuyết minh tiếng Việt để đọc kịp video.
Giữ nguyên ý chính, tên riêng, con số và quan hệ nhân quả quan trọng.
Dùng câu tự nhiên, dễ nghe, không viết tắt khó đọc, không thêm thông tin mới.
Mỗi kết quả BẮT BUỘC không vượt quá maxChars ký tự (tính cả khoảng trắng).
Trả về duy nhất JSON array, đúng số lượng và thứ tự: {"index":number,"text":string}.
Input: ${JSON.stringify(safeItems.map(({ index, text, maxChars }: any) => ({ index, text, maxChars })))}`;

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

      if (explicitCustomSelection && !hasCustomConfig) {
        return res.status(400).json({
          error: "Custom API chưa được cấu hình đầy đủ. Vui lòng nhập Custom API URL và API Key trong phần Cài đặt."
        });
      }

      if (isRawVideoRequest && (!mimeType || !mimeType.startsWith("video/"))) {
        console.log(`AI OCR request missing or invalid video mimeType. Defaulting to video/mp4 (original mimeType=${mimeType}).`);
        mimeType = "video/mp4";
      }

      const geminiApiKeys = getGeminiApiKeys(req);
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
11. MANDATORY COMPLETE COVERAGE: Cover ALL visual or spoken parts inside the supplied media segment. Do not invent speech outside the supplied segment and never truncate a sentence that is fully audible.${durationText}${chunkTimingText}`;

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

  app.post("/api/synthesize-tts", async (req, res) => {
    try {
      const { text, voiceName, engine, sessionId } = req.body;
      if (!text) {
        return res.status(400).json({ error: "Thiếu nội dung cần tạo giọng đọc." });
      }

      const activeEngine = engine || (voiceName && voiceName.startsWith("BV0") ? "tiktok" : "gemini");

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
          throw new Error("TikTok Session ID không hợp lệ hoặc đã hết hạn. Vui lòng cập nhật Session ID mới.");
        }

        throw new Error(`Lỗi TikTok TTS (mã ${statusCode}): ${message}`);
      } else {
        // Gemini TTS (default)
        const geminiApiKeys = getGeminiApiKeys(req);
        if (geminiApiKeys.length === 0) {
          return res.status(500).json({
            error: "Chưa cấu hình API Key. Vui lòng cấu hình GEMINI_API_KEY trong mục Cài đặt hoặc quản lý Secrets."
          });
        }

        console.log(`Generating speech using gemini-3.1-flash-tts-preview for text: "${text.substring(0, 30)}..." with voice: ${voiceName || "Kore"}`);

        const geminiResponse = await runWithGeminiKeyRotation(geminiApiKeys, "Gemini TTS", (ai) => ai.models.generateContent({
          model: "gemini-3.1-flash-tts-preview",
          contents: [{ parts: [{ text: text }] }],
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voiceName || "Kore" },
              },
            },
          },
        }));

        const base64Audio = geminiResponse?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!base64Audio) {
          console.error("Gemini TTS response missing base64Audio:", geminiResponse);
          return res.status(500).json({ error: "Không thể tạo giọng đọc từ Gemini TTS: Phản hồi không hợp lệ." });
        }

        return res.json({ audio: base64Audio, format: "pcm" });
      }
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

  // Add COOP and COEP headers for ffmpeg.wasm SharedArrayBuffer support only in standalone tab
  app.use((req, res, next) => {
    const dest = req.headers['sec-fetch-dest'];
    const referer = (req.headers['referer'] as string) || '';
    const isIframe = dest === 'iframe' || referer.includes('ai.studio.google') || referer.includes('googleusercontent.com');
    if (!isIframe && dest === 'document') {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    next();
  });

  // ONNX Runtime appends `?import` when it dynamically loads its WebGPU/WASM
  // helper module. Serve these immutable browser assets before Vite so the
  // dev middleware does not interpret that URL as a source-module request.
  const publicPath = path.join(process.cwd(), "public");
  app.use("/ort", express.static(path.join(publicPath, "ort"), {
    setHeaders: (res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  }));
  app.use("/models/paddle-ocr", express.static(path.join(publicPath, "models", "paddle-ocr"), {
    setHeaders: (res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  }));

  // Vite Integration (Vite Middleware in Dev, Static Files in Production)
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
