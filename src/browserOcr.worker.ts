import type { FlattenedPaddleOcrResult, PaddleOcrService as PaddleOcrWebService } from "ppu-paddle-ocr/web";

type OcrRegion = { id: string; x: number; y: number; width: number; height: number };
type OcrFrameInput = { frameId: number; timestamp: number; image: ArrayBuffer };
type OcrModel = { name: string; detection: string; recognition: string; dictionary: string };
type WorkerRequest =
  | { type: "init"; id: number }
  | { type: "recognize-batch"; id: number; frames: OcrFrameInput[]; regions: OcrRegion[]; minConfidence: number };

const WEBGPU_MODEL: OcrModel = {
  name: "PP-OCRv5-mobile",
  detection: "PP-OCRv5_mobile_det_infer.onnx",
  recognition: "PP-OCRv5_mobile_rec_infer.onnx",
  dictionary: "ppocrv5_dict.txt",
};
const WASM_MODEL: OcrModel = {
  name: "PP-OCRv6-small",
  detection: "PP-OCRv6_small_det.ort",
  recognition: "PP-OCRv6_small_rec.ort",
  dictionary: "ppocrv6_dict.txt",
};

const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null };
let service: PaddleOcrWebService | null = null;
let initializePromise: Promise<{ backend: "webgpu" | "wasm"; model: OcrModel }> | null = null;
let activeBackend: "webgpu" | "wasm" = "wasm";
let activeModel = WASM_MODEL;

function post(type: string, id: number, payload: Record<string, unknown> = {}) {
  scope.postMessage({ type, id, ...payload });
}

function installCanvasShim() {
  const globals = globalThis as any;
  if (!globals.document) {
    globals.document = {
      createElement: (tag: string) => {
        if (tag !== "canvas") throw new Error(`Unsupported worker element: ${tag}`);
        return new OffscreenCanvas(1, 1);
      },
    };
  }
  if (!globals.HTMLCanvasElement) globals.HTMLCanvasElement = class {};
}

function normalizeRegion(region: OcrRegion, index: number): OcrRegion | null {
  const x = Math.max(0, Math.min(100, Number(region?.x)));
  const y = Math.max(0, Math.min(100, Number(region?.y)));
  const width = Math.max(0, Math.min(100 - x, Number(region?.width)));
  const height = Math.max(0, Math.min(100 - y, Number(region?.height)));
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return null;
  return { id: String(region?.id || `region-${index + 1}`), x, y, width, height };
}

async function decodeCanvas(image: ArrayBuffer) {
  const bitmap = await createImageBitmap(new Blob([image]));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Không tạo được canvas OCR nền.");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

function cropRegion(source: OffscreenCanvas, region: OcrRegion) {
  const sx = Math.max(0, Math.round((region.x / 100) * source.width));
  const sy = Math.max(0, Math.round((region.y / 100) * source.height));
  const sw = Math.max(1, Math.min(source.width - sx, Math.round((region.width / 100) * source.width)));
  const sh = Math.max(1, Math.min(source.height - sy, Math.round((region.height / 100) * source.height)));
  const crop = new OffscreenCanvas(sw, sh);
  const context = crop.getContext("2d", { alpha: false });
  if (!context) throw new Error("Không tạo được vùng OCR nền.");
  context.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return { crop, offsetX: sx, offsetY: sy };
}

async function createService(backend: "webgpu" | "wasm", requestId: number) {
  post("status", requestId, { message: "Đang nạp bộ máy ONNX trong nền..." });
  const [{ PaddleOcrService, DetectionService, RecognitionService }, ort] = await Promise.all([
    import("ppu-paddle-ocr/web"),
    import("onnxruntime-web/webgpu"),
  ]);
  ort.env.wasm.wasmPaths = "/ort/";
  ort.env.wasm.numThreads = backend === "wasm" && globalThis.crossOriginIsolated
    ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)))
    : 1;
  ort.env.wasm.proxy = false;
  if (backend === "webgpu") ort.env.webgpu.powerPreference = "high-performance";
  const model = backend === "webgpu" ? WEBGPU_MODEL : WASM_MODEL;
  post("status", requestId, { message: `Đang tải ${model.name} (${backend.toUpperCase()})...` });
  const [detectionModel, recognitionModel, dictionaryText] = await Promise.all([
    fetch(`/models/paddle-ocr/${model.detection}`).then((response) => response.ok ? response.arrayBuffer() : Promise.reject(new Error(`HTTP ${response.status}: detection model`))),
    fetch(`/models/paddle-ocr/${model.recognition}`).then((response) => response.ok ? response.arrayBuffer() : Promise.reject(new Error(`HTTP ${response.status}: recognition model`))),
    fetch(`/models/paddle-ocr/${model.dictionary}`).then((response) => response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}: OCR dictionary`))),
  ]);
  const sessionOptions = {
    executionProviders: backend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"],
    graphOptimizationLevel: "all" as const,
    executionMode: "sequential" as const,
  };
  post("status", requestId, { message: "Đang khởi tạo model phát hiện chữ..." });
  const detectionSession = await ort.InferenceSession.create(new Uint8Array(detectionModel), sessionOptions);
  post("status", requestId, { message: "Đang khởi tạo model nhận dạng chữ..." });
  const recognitionSession = await ort.InferenceSession.create(new Uint8Array(recognitionModel), sessionOptions);
  installCanvasShim();
  const charactersDictionary = dictionaryText.split(/\r?\n/);
  const detectionOptions = { maxSideLength: 960, minimumAreaThreshold: 30 };
  const recognitionOptions = { strategy: "per-line" as const, charactersDictionary };
  const debuggingOptions = { verbose: false, debug: false };
  const nextService = new PaddleOcrService({
    processing: { engine: "canvas-native" },
    detection: detectionOptions,
    recognition: recognitionOptions,
    session: sessionOptions,
    debugging: debuggingOptions,
  });
  const internal = nextService as any;
  internal.detectionSession = detectionSession;
  internal.recognitionSession = recognitionSession;
  internal.detector = new DetectionService(detectionSession, detectionOptions, debuggingOptions);
  internal.recognitor = new RecognitionService(recognitionSession, recognitionOptions, debuggingOptions);
  return nextService;
}

async function validateService(candidate: PaddleOcrWebService, requestId: number) {
  post("status", requestId, { message: "Đang kiểm tra model bằng ảnh mẫu..." });
  const canvas = new OffscreenCanvas(360, 104);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Không tạo được ảnh kiểm tra OCR.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, 360, 104);
  context.fillStyle = "#000";
  context.font = "bold 38px sans-serif";
  context.fillText("OCR 123", 24, 68);
  const result = await candidate.recognize(canvas, { flatten: true, noCache: true, strategy: "per-line" });
  if (!(result as FlattenedPaddleOcrResult).results?.length || !String(result.text || "").trim()) {
    throw new Error("Model OCR không vượt qua kiểm tra nhận dạng.");
  }
}

async function initialize(requestId: number) {
  if (service) return { backend: activeBackend, model: activeModel };
  if (initializePromise) return initializePromise;
  initializePromise = (async () => {
    const gpu = (navigator as any).gpu;
    const supportsWebGpu = Boolean(gpu && await gpu.requestAdapter().catch(() => null));
    if (supportsWebGpu) {
      try {
        const gpuService = await createService("webgpu", requestId);
        await validateService(gpuService, requestId);
        service = gpuService;
        activeBackend = "webgpu";
        activeModel = WEBGPU_MODEL;
        return { backend: activeBackend, model: activeModel };
      } catch (error) {
        post("status", requestId, { message: `WebGPU không dùng được (${error instanceof Error ? error.message : String(error)}). Đang chuyển WASM...` });
      }
    }
    const wasmService = await createService("wasm", requestId);
    await validateService(wasmService, requestId);
    service = wasmService;
    activeBackend = "wasm";
    activeModel = WASM_MODEL;
    return { backend: activeBackend, model: activeModel };
  })().catch((error) => {
    initializePromise = null;
    throw error;
  });
  return initializePromise;
}

async function recognizeBatch(message: Extract<WorkerRequest, { type: "recognize-batch" }>) {
  const initialized = await initialize(message.id);
  if (!service) throw new Error("PaddleOCR nền chưa sẵn sàng.");
  const regions = (message.regions || []).map(normalizeRegion).filter((region): region is OcrRegion => Boolean(region));
  if (!regions.length) regions.push({ id: "full-frame", x: 0, y: 0, width: 100, height: 100 });
  type CropTask = { frameIndex: number; region: OcrRegion; image: OffscreenCanvas; offsetX: number; offsetY: number };
  const tasks: CropTask[] = [];
  for (let frameIndex = 0; frameIndex < message.frames.length; frameIndex++) {
    const source = await decodeCanvas(message.frames[frameIndex].image);
    for (const region of regions) {
      const { crop, offsetX, offsetY } = cropRegion(source, region);
      tasks.push({ frameIndex, region, image: crop, offsetX, offsetY });
    }
  }

  // Keep every timestamp as an independent detector input. Stacking temporal
  // frames into one tall image was faster but could shrink text and map a box
  // into the neighbouring frame, which is unacceptable for subtitle timing.
  const results = await service.batchRecognize(tasks.map((task) => task.image), {
    flatten: true,
    noCache: true,
    strategy: "per-line",
    concurrency: 1,
    settle: true,
    onProgress: (done, total) => post("batch-progress", message.id, { done, total: total || tasks.length }),
  });
  const output = message.frames.map((frame) => ({ timestamp: Number(frame.timestamp.toFixed(3)), detections: [] as Array<Record<string, unknown>> }));
  results.forEach((settled, taskIndex) => {
    if (settled.status === "rejected") throw settled.reason;
    const task = tasks[taskIndex];
    const result = settled.value as FlattenedPaddleOcrResult;
    for (const item of result.results || []) {
      const text = String(item.text || "").replace(/\s+/g, " ").trim();
      const confidence = Number(item.confidence || 0);
      if (!text || confidence < Math.max(0, Math.min(1, Number(message.minConfidence ?? 0.35)))) continue;
      const rawBox = item.box || { x: 0, y: 0, width: 0, height: 0 };
      const box = {
        x: Math.round(rawBox.x + task.offsetX),
        y: Math.round(rawBox.y + task.offsetY),
        width: Math.round(rawBox.width),
        height: Math.round(rawBox.height),
      };
      output[task.frameIndex].detections.push({
        text, confidence, region_id: task.region.id, box,
        bbox: [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]],
      });
    }
  });
  return { frames: output, ...initialized };
}

scope.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      post("ready", message.id, await initialize(message.id));
    } else if (message.type === "recognize-batch") {
      post("batch-result", message.id, await recognizeBatch(message));
    }
  } catch (error) {
    post("error", message.id, { error: error instanceof Error ? error.message : String(error) });
  }
};
