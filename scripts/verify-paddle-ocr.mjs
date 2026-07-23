import { PaddleOcrService, V6_SMALL_MODEL } from "ppu-paddle-ocr";
import { readFile } from "node:fs/promises";

const imagePath = process.argv[2];
if (!imagePath) {
  console.error("Usage: node scripts/verify-paddle-ocr.mjs <image-path>");
  process.exit(2);
}

const startedAt = Date.now();
const service = new PaddleOcrService({
  model: V6_SMALL_MODEL,
  processing: { engine: "canvas-native" },
  recognition: { strategy: "per-box" },
  session: { executionProviders: ["cpu"], graphOptimizationLevel: "all" },
  debugging: { verbose: true, debug: false },
});

try {
  console.log(JSON.stringify({
    phase: "initialize",
    model: "PP-OCRv6-small",
    backend: "onnxruntime-node/cpu",
    assets: V6_SMALL_MODEL,
  }));
  await service.initialize();
  const initializedMs = Date.now() - startedAt;
  const image = await readFile(imagePath);
  const imageBuffer = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength);
  const result = await service.recognize(imageBuffer, { flatten: true, noCache: true });
  console.log(JSON.stringify({
    phase: "complete",
    initializedMs,
    totalMs: Date.now() - startedAt,
    text: result.text,
    confidence: result.confidence,
    results: "results" in result ? result.results : result.lines.flat(),
  }, null, 2));
} finally {
  await service.destroy();
}
