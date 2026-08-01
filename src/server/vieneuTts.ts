import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import fs from "fs";
import path from "path";

type PendingRequest = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
let worker: ChildProcessWithoutNullStreams | null = null;
let buffer = "";
let pending: PendingRequest[] = [];
let startup: Promise<void> | null = null;

function removePending(request: PendingRequest): boolean {
  const index = pending.indexOf(request);
  if (index < 0) return false;
  pending.splice(index, 1);
  return true;
}

function root(): string {
  const distPath = process.env.DIST_PATH;
  return distPath ? path.dirname(distPath) : process.cwd();
}

function scriptPath(): string {
  const script = path.join(root(), "scripts", "vieneu_tts.py");
  if (!fs.existsSync(script)) throw new Error("Thiếu scripts/vieneu_tts.py.");
  return script;
}

function isBundledEngine(executable: string): boolean {
  return path.basename(executable).toLowerCase() === "ocr_engine.exe";
}

async function findPython(): Promise<string> {
  const candidates = [
    process.env.PYTHON_PATH,
    path.join(process.cwd(), ".venv", "Scripts", "python.exe"),
    path.join(root(), ".venv", "Scripts", "python.exe"),
    "python",
    "python3",
  ].filter(Boolean) as string[];
  for (const executable of candidates) {
    if (isBundledEngine(executable) && fs.existsSync(executable)) return executable;
    const available = await new Promise<boolean>((resolve) => {
      const child = spawn(executable, ["--version"]);
      const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 3000);
      child.once("error", () => { clearTimeout(timer); resolve(false); });
      child.once("close", (code) => { clearTimeout(timer); resolve(code === 0); });
    });
    if (available) return executable;
  }
  throw new Error("Không tìm thấy Python. Hãy cài Python và gói VieNeu trước khi chạy.");
}

function stopWorker(error: Error): void {
  const active = worker;
  worker = null;
  startup = null;
  if (active) { try { active.kill(); } catch {} }
  const queued = pending;
  pending = [];
  queued.forEach(({ reject, timer }) => { clearTimeout(timer); reject(error); });
}

async function ensureWorker(): Promise<void> {
  if (worker?.exitCode === null && worker.stdin.writable) return;
  if (startup) return startup;
  startup = (async () => {
    const python = await findPython();
    const child = spawn(python, isBundledEngine(python) ? ["vieneu_tts"] : [scriptPath()], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdio: "pipe",
    });
    worker = child;
    buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const result = JSON.parse(line);
          const request = pending.shift();
          if (!request) continue;
          clearTimeout(request.timer);
          if (result.ok === false || result.error) request.reject(new Error(result.error || "VieNeu TTS lỗi."));
          else request.resolve(result);
        } catch { /* Ignore SDK logs; bridge emits JSON on its own lines. */ }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => console.warn(`[VieNeu] ${chunk.toString().trim()}`));
    child.once("error", (error) => stopWorker(error));
    child.once("close", (code) => stopWorker(new Error(`VieNeu TTS worker dừng (${code ?? "unknown"}).`)));
  })().finally(() => { startup = null; });
  return startup;
}

export async function synthesizeVieNeu(text: string, voice = "Phạm Tuyên", style = "tu_nhien"): Promise<{ audio: string; format: "wav"; sampleRate: number }> {
  await ensureWorker();
  return new Promise((resolve, reject) => {
    if (!worker?.stdin.writable) return reject(new Error("VieNeu TTS worker chưa sẵn sàng."));
    const request = {} as PendingRequest;
    request.resolve = resolve;
    request.reject = reject;
    request.timer = setTimeout(() => {
      if (removePending(request)) reject(new Error("VieNeu TTS quá thời gian (10 phút). Lần đầu có thể đang tải model."));
    }, 600_000);
    pending.push(request);
    worker.stdin.write(`${JSON.stringify({ action: "synthesize", text, voice, style })}\n`, (error) => {
      if (!error) return;
      if (removePending(request)) { clearTimeout(request.timer); request.reject(error); }
    });
  });
}

export async function getVieNeuVoices(): Promise<unknown[]> {
  await ensureWorker();
  return new Promise((resolve, reject) => {
    if (!worker?.stdin.writable) return reject(new Error("VieNeu TTS worker chưa sẵn sàng."));
    const request = {} as PendingRequest;
    request.resolve = (result) => resolve(result.voices || []);
    request.reject = reject;
    request.timer = setTimeout(() => {
      if (removePending(request)) reject(new Error("VieNeu TTS khởi tạo quá thời gian."));
    }, 600_000);
    pending.push(request);
    worker.stdin.write(`${JSON.stringify({ action: "verify" })}\n`);
  });
}

export async function preloadNgocHuyen(): Promise<void> {
  await ensureWorker();
  return new Promise((resolve, reject) => {
    if (!worker?.stdin.writable) return reject(new Error("VieNeu TTS worker chưa sẵn sàng."));
    const request = {} as PendingRequest;
    request.resolve = () => resolve();
    request.reject = reject;
    request.timer = setTimeout(() => {
      if (removePending(request)) reject(new Error("Ngọc Huyền khởi tạo quá thời gian."));
    }, 600_000);
    pending.push(request);
    worker.stdin.write(`${JSON.stringify({ action: "preload_ngoc_huyen" })}\n`);
  });
}
