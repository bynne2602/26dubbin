/**
 * Utility functions for video dubbing workflow
 */

// ============ API Constants ============
export const API_ENDPOINTS = {
  TRANSLATE_VIDEO: '/api/translate-video',
  HEALTH: '/api/health',
} as const;

export const DEFAULT_CONFIG = {
  FRAME_INTERVAL_SEC: 2.0,           // Extract frames every 2 seconds
  FRAME_QUALITY: 0.72,              // JPEG quality (0-1)
  FRAME_MAX_SIZE: 5_242_880,        // Max 5MB per frame
  VIDEO_CHUNK_DURATION: 12,         // Seconds per chunk for safe upload
  REQUEST_TIMEOUT: 120_000,         // 2 minutes timeout
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 3000,
  RATE_LIMIT_DELAY_MS: 20000,       // Delay on 429 rate limit
} as const;

// ============ Type Definitions ============
export interface FrameData {
  timestamp: number;  // in seconds
  base64: string;     // base64 encoded JPEG image
}

export interface TranslateVideoRequest {
  videoBase64?: string;
  mimeType: string;
  frames?: FrameData[];
  sourceLanguage: string;
  targetLanguage: string;
  duration: number;
  apiPlatform: 'gemini' | 'custom';
  customApiUrl?: string;
  customApiKey?: string;
  customModel?: string;
  extractionMethod: 'audio' | 'ocr' | 'aiocr';
  allowGeminiFallback?: boolean;
}

export interface TranslateVideoResponse {
  subtitles: Array<{
    start: number;      // in seconds
    end: number;        // in seconds
    original: string;
    translated: string;
  }>;
}

// ============ Frame Validation ============
export function validateFrameData(frame: any): frame is FrameData {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    typeof frame.timestamp === 'number' &&
    typeof frame.base64 === 'string' &&
    frame.timestamp >= 0 &&
    frame.base64.length > 0
  );
}

export function validateFramesArray(frames: any): frames is FrameData[] {
  return (
    Array.isArray(frames) &&
    frames.length > 0 &&
    frames.every(validateFrameData)
  );
}

export function estimatePayloadSize(
  videoBase64?: string,
  frames?: FrameData[]
): number {
  let size = 0;
  if (videoBase64) {
    size += videoBase64.length * 0.75; // Base64 adds ~33% overhead
  }
  if (frames && Array.isArray(frames)) {
    size += frames.reduce((acc, frame) => acc + frame.base64.length * 0.75, 0);
  }
  return size;
}

// ============ Error Handling ============
export class APIError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public originalError?: any
  ) {
    super(message);
    this.name = 'APIError';
  }

  static fromResponse(status: number, responseText: string): APIError {
    try {
      const data = JSON.parse(responseText);
      return new APIError(status, data.error || `HTTP ${status}`, data);
    } catch {
      // Try to extract error from HTML if it's an error page
      const htmlMatch = responseText.match(/<title>([\s\S]*?)<\/title>/i);
      const title = htmlMatch ? htmlMatch[1].trim() : `HTTP ${status}`;
      return new APIError(status, title);
    }
  }

  static isRateLimit(statusCode: number): boolean {
    return statusCode === 429;
  }

  static isClientError(statusCode: number): boolean {
    return statusCode >= 400 && statusCode < 500;
  }

  static isServerError(statusCode: number): boolean {
    return statusCode >= 500 && statusCode < 600;
  }
}

// ============ Response Parsing ============
export function parseSubtitleResponse(
  responseText: string
): Array<{ start: number; end: number; original: string; translated: string }> {
  let cleanText = responseText.trim();

  // Remove markdown code blocks if present
  if (cleanText.startsWith('```')) {
    cleanText = cleanText.replace(/^```(?:json)?\s*/i, '');
    cleanText = cleanText.replace(/\s*```$/, '');
  }
  cleanText = cleanText.trim();

  // Extract JSON array
  const startIndex = cleanText.indexOf('[');
  const endIndex = cleanText.lastIndexOf(']');

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    cleanText = cleanText.substring(startIndex, endIndex + 1);
  }

  try {
    const parsed = JSON.parse(cleanText);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) =>
        item &&
        typeof item.start !== 'undefined' &&
        typeof item.end !== 'undefined' &&
        typeof item.original === 'string' &&
        typeof item.translated === 'string'
      );
    }
  } catch (e) {
    console.warn('Failed to parse subtitle response:', e);
  }

  return [];
}

// ============ Time Conversion ============
export function timeStringToSeconds(timeStr: string): number {
  if (!timeStr) return 0;

  const str = String(timeStr).trim().replace(/['"]/g, '');

  // Check if it's already a number
  if (/^\d+(\.\d+)?$/.test(str)) {
    return parseFloat(str);
  }

  const parts = str.split(/[:.]/);

  if (parts.length === 2) {
    const mins = parseFloat(parts[0]) || 0;
    const secs = parseFloat(parts[1]) || 0;
    return mins * 60 + secs;
  }

  if (parts.length === 3) {
    const lastDotIndex = str.lastIndexOf('.');
    const lastColonIndex = str.lastIndexOf(':');

    const p0 = parseFloat(parts[0]) || 0;
    const p1 = parseFloat(parts[1]) || 0;
    const p2 = parseFloat(parts[2]) || 0;

    if (lastDotIndex > lastColonIndex) {
      // MM:SS.hh
      return p0 * 60 + p1 + p2 / 100;
    }

    if (p0 < 10) {
      return p0 * 60 + p1 + p2 / 100;
    }

    return p0 * 3600 + p1 * 60 + p2;
  }

  if (parts.length === 4) {
    const hrs = parseFloat(parts[0]) || 0;
    const mins = parseFloat(parts[1]) || 0;
    const secs = parseFloat(parts[2]) || 0;
    const ms = parseFloat(parts[3]) || 0;
    return hrs * 3600 + mins * 60 + secs + ms / 100;
  }

  const parsed = parseFloat(str);
  return isNaN(parsed) ? 0 : parsed;
}

export function secondsToTimeString(seconds: number): string {
  if (!Number.isFinite(seconds)) return '00:00.00';

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);

  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// ============ Logging ============
export class Logger {
  static info(msg: string, data?: any) {
    console.log(`[INFO] ${msg}`, data || '');
  }

  static warn(msg: string, data?: any) {
    console.warn(`[WARN] ${msg}`, data || '');
  }

  static error(msg: string, error?: any) {
    console.error(`[ERROR] ${msg}`, error || '');
  }

  static debug(msg: string, data?: any) {
    if (typeof window !== 'undefined' && localStorage.getItem('debug_mode') === 'true') {
      console.debug(`[DEBUG] ${msg}`, data || '');
    }
  }
}

// ============ Retry Logic ============
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = DEFAULT_CONFIG.MAX_RETRIES,
  delayMs: number = DEFAULT_CONFIG.RETRY_DELAY_MS,
  onRetry?: (attempt: number, error: any) => void
): Promise<T> {
  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Don't retry on client errors (except rate limit)
      if (error instanceof APIError && APIError.isClientError(error.statusCode)) {
        if (!APIError.isRateLimit(error.statusCode)) {
          throw error;
        }
      }

      if (attempt < maxAttempts) {
        onRetry?.(attempt, error);
        await new Promise((resolve) =>
          setTimeout(resolve, delayMs * Math.pow(1.5, attempt - 1))
        );
      }
    }
  }

  throw lastError;
}

// ============ Fetch Wrapper ============
export async function apiFetch(
  endpoint: string,
  options: RequestInit & { timeout?: number } = {}
): Promise<Response> {
  const { timeout = DEFAULT_CONFIG.REQUEST_TIMEOUT, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(endpoint, {
      ...fetchOptions,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw APIError.fromResponse(response.status, await response.text());
    }

    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============ Configuration Validation ============
export function validateCustomApiConfig(url?: string, key?: string): { valid: boolean; error?: string } {
  if (!url || !key) {
    return { valid: false, error: 'Custom API URL and Key are required' };
  }

  try {
    new URL(url);
  } catch {
    return { valid: false, error: 'Invalid Custom API URL' };
  }

  if (key.length < 10) {
    return { valid: false, error: 'API Key appears too short' };
  }

  return { valid: true };
}

export function validateGeminiConfig(apiKey?: string): { valid: boolean; error?: string } {
  if (!apiKey) {
    return { valid: false, error: 'Gemini API Key is required' };
  }

  if (apiKey.length < 20) {
    return { valid: false, error: 'API Key appears too short' };
  }

  return { valid: true };
}
