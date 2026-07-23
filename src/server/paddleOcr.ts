import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { V6_SMALL_MODEL } from "ppu-paddle-ocr";

export type OcrRegion = {
  id: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OcrDetection = {
  text: string;
  confidence: number;
  region_id: string;
  box: { x: number; y: number; width: number; height: number };
  bbox: number[][];
};

export type OcrFrameResult = {
  timestamp: number;
  detections: OcrDetection[];
};

type OcrFrameInput = {
  image: unknown;
  timestamp?: unknown;
  regions?: unknown;
  minConfidence?: unknown;
};

type OcrRuntimeState = "idle" | "initializing" | "ready" | "error";
type OcrJob = {
  id: number;
  input: OcrFrameInput;
  resolve: (result: OcrFrameResult) => void;
  reject: (error: Error) => void;
};
type OcrWorkerSlot = {
  worker: Worker;
  busy: boolean;
  currentJobId: number | null;
};

const MODEL_NAME = "PP-OCRv6-small";
const LOGICAL_CPUS = Math.max(1, typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length);
const requestedConcurrency = Number.parseInt(String(process.env.PADDLE_OCR_CONCURRENCY || ""), 10);
const requestedProvider = String(process.env.PADDLE_OCR_PROVIDER || "auto").trim().toLowerCase();
const PREFERRED_PROVIDER: "cpu" | "dml" = requestedProvider === "cpu"
  ? "cpu"
  : requestedProvider === "dml"
    ? "dml"
    : "cpu";
const cpuAutoConcurrency = LOGICAL_CPUS >= 8 ? 4 : LOGICAL_CPUS >= 4 ? 2 : 1;
const configuredCpuConcurrency = Math.max(
  1,
  Math.min(8, LOGICAL_CPUS, Number.isFinite(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : cpuAutoConcurrency),
);
let activeProvider: "cpu" | "dml" = PREFERRED_PROVIDER;
let activeConcurrency = activeProvider === "dml" ? 1 : configuredCpuConcurrency;
let activeThreadsPerJob = activeProvider === "dml" ? 1 : Math.max(1, Math.floor(LOGICAL_CPUS / activeConcurrency));
const MODEL_FILES = {
  detection: "PP-OCRv6_small_det.ort",
  recognition: "PP-OCRv6_small_rec.ort",
  charactersDictionary: "ppocrv6_dict.txt",
} as const;

let workerPool: OcrWorkerSlot[] = [];
let initializePromise: Promise<void> | null = null;
let runtimeState: OcrRuntimeState = "idle";
let runtimeError = "";
let initializedAt = "";
let nextJobId = 1;
const queuedJobs: OcrJob[] = [];
const activeJobs = new Map<number, OcrJob>();

function resolveModelAssets() {
  const configuredDirectory = String(process.env.PADDLE_OCR_MODEL_DIR || "").trim();
  const bundledDirectory = path.join(process.cwd(), "models", "paddle-ocr");
  const candidateDirectory = configuredDirectory || bundledDirectory;
  if (candidateDirectory) {
    const modelDirectory = path.resolve(candidateDirectory);
    const localAssets = {
      detection: path.join(modelDirectory, MODEL_FILES.detection),
      recognition: path.join(modelDirectory, MODEL_FILES.recognition),
      charactersDictionary: path.join(modelDirectory, MODEL_FILES.charactersDictionary),
    };
    if (Object.values(localAssets).every((assetPath) => fs.existsSync(assetPath))) {
      return { assets: localAssets, source: "local" as const, modelDirectory };
    }
    if (configuredDirectory) {
      console.warn(`[PaddleOCR] PADDLE_OCR_MODEL_DIR không đủ 3 model bắt buộc: ${modelDirectory}. Chuyển sang cache/CDN của package.`);
    }
  }
  return { assets: { ...V6_SMALL_MODEL }, source: "package-cache" as const, modelDirectory: "" };
}

const OCR_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");

function asArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function normalizeRegion(region, index) {
  const x = Math.max(0, Math.min(100, Number(region && region.x)));
  const y = Math.max(0, Math.min(100, Number(region && region.y)));
  const width = Math.max(0, Math.min(100 - x, Number(region && region.width)));
  const height = Math.max(0, Math.min(100 - y, Number(region && region.height)));
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return null;
  return { id: String(region.id || "region-" + (index + 1)), x, y, width, height };
}

function parseBase64Image(value) {
  const raw = String(value || "").trim();
  const base64 = raw.includes(";base64,") ? raw.split(";base64,")[1] : raw;
  if (!base64) throw new Error("Ảnh OCR trống.");
  const image = Buffer.from(base64, "base64");
  if (image.byteLength < 16) throw new Error("Dữ liệu ảnh OCR không hợp lệ.");
  return image;
}

function mapRecognitionResult(result, regionId, offsetX, offsetY) {
  const box = {
    x: Math.round(result.box.x + offsetX),
    y: Math.round(result.box.y + offsetY),
    width: Math.round(result.box.width),
    height: Math.round(result.box.height),
  };
  return {
    text: String(result.text || "").replace(/\s+/g, " ").trim(),
    confidence: Number(result.confidence || 0),
    region_id: regionId,
    box,
    bbox: [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]],
  };
}

async function recognizeFrame(service, CanvasProcessor, createCanvas, input) {
  const imageBuffer = parseBase64Image(input.image);
  const sourceCanvas = await CanvasProcessor.prepareCanvas(asArrayBuffer(imageBuffer));
  const requestedRegions = Array.isArray(input.regions)
    ? input.regions.map(normalizeRegion).filter(Boolean)
    : [];
  const regions = requestedRegions.length > 0
    ? requestedRegions
    : [{ id: "full-frame", x: 0, y: 0, width: 100, height: 100 }];
  const minConfidence = Math.max(0, Math.min(1, Number(input.minConfidence == null ? 0.35 : input.minConfidence)));
  const detections = [];

  for (const region of regions) {
    const sourceWidth = sourceCanvas.width;
    const sourceHeight = sourceCanvas.height;
    const sx = Math.max(0, Math.round((region.x / 100) * sourceWidth));
    const sy = Math.max(0, Math.round((region.y / 100) * sourceHeight));
    const sw = Math.max(1, Math.min(sourceWidth - sx, Math.round((region.width / 100) * sourceWidth)));
    const sh = Math.max(1, Math.min(sourceHeight - sy, Math.round((region.height / 100) * sourceHeight)));
    const cropCanvas = createCanvas(sw, sh);
    cropCanvas.getContext("2d").drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    const result = await service.recognize(cropCanvas, { flatten: true, noCache: true, strategy: "per-line" });
    for (const item of result.results) {
      const detection = mapRecognitionResult(item, region.id, sx, sy);
      if (detection.text && detection.confidence >= minConfidence) detections.push(detection);
    }
  }

  return { timestamp: Number(Number(input.timestamp || 0).toFixed(3)), detections };
}

(async () => {
  const [{ PaddleOcrService }, { CanvasProcessor, createCanvas }] = await Promise.all([
    import("ppu-paddle-ocr"),
    import("ppu-ocv"),
  ]);
  const service = new PaddleOcrService({
    model: workerData.assets,
    processing: { engine: "canvas-native" },
    detection: { maxSideLength: 960, minimumAreaThreshold: 30 },
    session: {
      executionProviders: workerData.executionProviders,
      graphOptimizationLevel: "all",
      executionMode: "sequential",
      intraOpNumThreads: workerData.threadsPerJob,
      interOpNumThreads: 1,
      enableMemPattern: workerData.enableMemPattern,
    },
    debugging: { verbose: workerData.verbose, debug: false },
  });
  await service.initialize();
  const warmupCanvas = createCanvas(320, 96);
  const warmupContext = warmupCanvas.getContext("2d");
  warmupContext.fillStyle = "#ffffff";
  warmupContext.fillRect(0, 0, 320, 96);
  warmupContext.fillStyle = "#000000";
  warmupContext.font = "bold 32px sans-serif";
  warmupContext.fillText("OCR 123", 20, 60);
  const warmupResult = await service.recognize(warmupCanvas, { flatten: true, noCache: true, strategy: "per-line" });
  if (!warmupResult.results || warmupResult.results.length === 0 || !warmupResult.text.trim()) {
    throw new Error("OCR provider initialized but failed the recognition warm-up check.");
  }
  parentPort.postMessage({ type: "ready" });
  parentPort.on("message", async (message) => {
    if (!message || message.type !== "recognize") return;
    try {
      const frame = await recognizeFrame(service, CanvasProcessor, createCanvas, message.input);
      parentPort.postMessage({ type: "result", id: message.id, frame });
    } catch (error) {
      parentPort.postMessage({ type: "job-error", id: message.id, error: error && error.message ? error.message : String(error) });
    }
  });
})().catch((error) => {
  parentPort.postMessage({ type: "init-error", error: error && error.message ? error.message : String(error) });
});
`;

function pumpQueue() {
  for (const slot of workerPool) {
    if (slot.busy || queuedJobs.length === 0) continue;
    const job = queuedJobs.shift();
    if (!job) return;
    slot.busy = true;
    slot.currentJobId = job.id;
    activeJobs.set(job.id, job);
    slot.worker.postMessage({ type: "recognize", id: job.id, input: job.input });
  }
}

function handleWorkerFailure(slot: OcrWorkerSlot, reason: unknown) {
  if (!workerPool.includes(slot) && slot.currentJobId === null) return;
  const error = reason instanceof Error ? reason : new Error(String(reason));
  runtimeError = error.message;
  if (slot.currentJobId !== null) {
    const job = activeJobs.get(slot.currentJobId);
    if (job) job.reject(error);
    activeJobs.delete(slot.currentJobId);
  }
  workerPool = workerPool.filter((candidate) => candidate !== slot);
  slot.busy = false;
  slot.currentJobId = null;
  if (workerPool.length === 0) runtimeState = "error";
  pumpQueue();
}

function createWorkerSlot(
  assets: Record<string, string>,
  provider: "cpu" | "dml",
  threadsPerJob: number,
): Promise<OcrWorkerSlot> {
  const worker = new Worker(OCR_WORKER_SOURCE, {
    eval: true,
    workerData: {
      assets,
      threadsPerJob,
      executionProviders: provider === "dml" ? ["dml", "cpu"] : ["cpu"],
      enableMemPattern: provider !== "dml",
      verbose: process.env.PADDLE_OCR_VERBOSE === "1",
    },
  });
  const slot: OcrWorkerSlot = { worker, busy: false, currentJobId: null };
  return new Promise((resolve, reject) => {
    const onMessage = (message: any) => {
      if (message?.type === "ready") {
        resolve(slot);
        return;
      }
      if (message?.type === "init-error") {
        void worker.terminate();
        reject(new Error(message.error || "Không thể khởi tạo OCR worker."));
        return;
      }
      if (message?.type !== "result" && message?.type !== "job-error") return;
      const job = activeJobs.get(Number(message.id));
      activeJobs.delete(Number(message.id));
      slot.busy = false;
      slot.currentJobId = null;
      if (job) {
        if (message.type === "result") job.resolve(message.frame as OcrFrameResult);
        else job.reject(new Error(message.error || "OCR worker xử lý thất bại."));
      }
      pumpQueue();
    };
    worker.on("message", onMessage);
    worker.on("error", (error) => {
      reject(error);
      handleWorkerFailure(slot, error);
    });
    worker.on("exit", (code) => {
      if (code !== 0) handleWorkerFailure(slot, new Error(`OCR worker đã dừng với mã ${code}.`));
    });
  });
}

export function getPaddleOcrHealth() {
  const resolved = resolveModelAssets();
  return {
    connected: runtimeState === "ready" && workerPool.length > 0,
    state: runtimeState,
    error: runtimeError || undefined,
    initializedAt: initializedAt || undefined,
    model: {
      name: MODEL_NAME,
      detection: MODEL_FILES.detection,
      recognition: MODEL_FILES.recognition,
      dictionary: MODEL_FILES.charactersDictionary,
      backend: `onnxruntime-node/${activeProvider}`,
      workerMode: "worker_threads",
      logicalCpus: LOGICAL_CPUS,
      concurrency: workerPool.length || activeConcurrency,
      threadsPerJob: activeThreadsPerJob,
      source: resolved.source,
      modelDirectory: resolved.modelDirectory || undefined,
    },
  };
}

export async function initializePaddleOcr(): Promise<void> {
  if (workerPool.length > 0 && runtimeState === "ready") return;
  if (initializePromise) return initializePromise;

  initializePromise = (async () => {
    runtimeState = "initializing";
    runtimeError = "";
    const resolved = resolveModelAssets();
    const createPool = async (provider: "cpu" | "dml", concurrency: number, threadsPerJob: number) => {
      console.log(`[PaddleOCR] Khởi tạo ${concurrency} worker; model=${MODEL_NAME}; backend=onnxruntime-node/${provider}; cpus=${LOGICAL_CPUS}; threads/worker=${threadsPerJob}; source=${resolved.source}.`);
      const settledWorkers = await Promise.allSettled(
        Array.from({ length: concurrency }, () => createWorkerSlot(resolved.assets, provider, threadsPerJob)),
      );
      const failedWorker = settledWorkers.find((result): result is PromiseRejectedResult => result.status === "rejected");
      const readyWorkers = settledWorkers
        .filter((result): result is PromiseFulfilledResult<OcrWorkerSlot> => result.status === "fulfilled")
        .map((result) => result.value);
      if (failedWorker) {
        await Promise.all(readyWorkers.map((slot) => slot.worker.terminate().catch(() => undefined)));
        throw failedWorker.reason;
      }
      return readyWorkers;
    };

    try {
      activeProvider = PREFERRED_PROVIDER;
      activeConcurrency = activeProvider === "dml" ? 1 : configuredCpuConcurrency;
      activeThreadsPerJob = activeProvider === "dml" ? 1 : Math.max(1, Math.floor(LOGICAL_CPUS / activeConcurrency));
      try {
        workerPool = await createPool(activeProvider, activeConcurrency, activeThreadsPerJob);
      } catch (preferredError: any) {
        if (activeProvider !== "dml") throw preferredError;
        console.warn(`[PaddleOCR] DirectML không khởi tạo được (${preferredError?.message || preferredError}); tự chuyển sang CPU.`);
        activeProvider = "cpu";
        activeConcurrency = configuredCpuConcurrency;
        activeThreadsPerJob = Math.max(1, Math.floor(LOGICAL_CPUS / activeConcurrency));
        workerPool = await createPool(activeProvider, activeConcurrency, activeThreadsPerJob);
      }
      runtimeState = "ready";
      runtimeError = "";
      initializedAt = new Date().toISOString();
      console.log(`[PaddleOCR] Sẵn sàng ${workerPool.length} worker; backend=onnxruntime-node/${activeProvider}.`);
      pumpQueue();
    } catch (error: any) {
      runtimeState = "error";
      runtimeError = error?.message || String(error);
      await Promise.all(workerPool.map((slot) => slot.worker.terminate().catch(() => undefined)));
      workerPool = [];
      console.error(`[PaddleOCR] Khởi tạo thất bại: ${runtimeError}`);
      throw error;
    } finally {
      initializePromise = null;
    }
  })();

  return initializePromise;
}

function enqueueOcrFrame(input: OcrFrameInput): Promise<OcrFrameResult> {
  return new Promise((resolve, reject) => {
    queuedJobs.push({ id: nextJobId++, input, resolve, reject });
    pumpQueue();
  });
}

export async function recognizeOcrFrame(input: OcrFrameInput): Promise<OcrFrameResult> {
  const [frame] = await recognizeOcrBatch([input]);
  return frame;
}

export async function recognizeOcrBatch(inputs: OcrFrameInput[]): Promise<OcrFrameResult[]> {
  if (!inputs.length) return [];
  await initializePaddleOcr();
  return Promise.all(inputs.map((input) => enqueueOcrFrame(input)));
}
