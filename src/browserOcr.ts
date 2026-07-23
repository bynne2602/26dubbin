export type BrowserOcrInputFrame = { frameId: number; timestamp: number; image: ArrayBuffer };
export type BrowserOcrRegion = { id: string; x: number; y: number; width: number; height: number };
export type BrowserOcrDetection = {
  text: string;
  confidence: number;
  region_id: string;
  box?: { x: number; y: number; width: number; height: number };
  bbox?: number[][];
};
export type BrowserOcrFrame = { timestamp: number; detections: BrowserOcrDetection[] };
export type BrowserOcrModel = { name: string; detection: string; recognition: string; dictionary: string };
export type BrowserOcrBackend = { backend: "webgpu" | "wasm"; model: BrowserOcrModel };

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onProgress?: (done: number, total: number) => void;
  onStatus?: (message: string) => void;
};

let worker: Worker | null = null;
let requestId = 1;
let initializePromise: Promise<BrowserOcrBackend> | null = null;
const pending = new Map<number, PendingRequest>();

function rejectAll(error: Error) {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function resetWorker(error?: Error) {
  if (error) rejectAll(error);
  worker?.terminate();
  worker = null;
  initializePromise = null;
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./browserOcr.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event) => {
    const message = event.data || {};
    const current = pending.get(Number(message.id));
    if (!current) return;
    if (message.type === "status") {
      current.onStatus?.(String(message.message || ""));
      return;
    }
    if (message.type === "batch-progress") {
      current.onProgress?.(Number(message.done || 0), Number(message.total || 0));
      return;
    }
    clearTimeout(current.timer);
    pending.delete(Number(message.id));
    if (message.type === "error") current.reject(new Error(String(message.error || "PaddleOCR frontend gặp lỗi.")));
    else current.resolve(message);
  };
  worker.onerror = (event) => resetWorker(new Error(event.message || "Luồng OCR trình duyệt đã dừng."));
  return worker;
}

function requestWorker<T>(
  payload: Record<string, unknown>,
  timeoutMs: number,
  callbacks: Pick<PendingRequest, "onProgress" | "onStatus"> = {},
  transfer: Transferable[] = [],
) {
  const id = requestId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("OCR trình duyệt không phản hồi đúng thời hạn; đã chuyển sang bộ xử lý dự phòng.");
      resetWorker(error);
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, ...callbacks });
    getWorker().postMessage({ ...payload, id }, transfer);
  });
}

export function initializeBrowserOcr(onStatus?: (message: string) => void) {
  if (!initializePromise) {
    initializePromise = requestWorker<BrowserOcrBackend & { type: "ready" }>(
      { type: "init" },
      120_000,
      { onStatus },
    ).then(({ backend, model }) => ({ backend, model })).catch((error) => {
      initializePromise = null;
      throw error;
    });
  }
  return initializePromise;
}

export async function recognizeBrowserOcrBatch(
  frames: BrowserOcrInputFrame[],
  regions: BrowserOcrRegion[],
  minConfidence: number,
  onProgress?: (done: number, total: number) => void,
) {
  const initialized = await initializeBrowserOcr();
  const result = await requestWorker<{
    type: "batch-result";
    frames: BrowserOcrFrame[];
    backend: BrowserOcrBackend["backend"];
    model: BrowserOcrModel;
  }>(
    { type: "recognize-batch", frames, regions, minConfidence },
    90_000,
    { onProgress },
    frames.map((frame) => frame.image),
  );
  return { frames: result.frames, backend: result.backend || initialized.backend, model: result.model || initialized.model };
}
