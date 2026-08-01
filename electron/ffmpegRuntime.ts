import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { createGunzip } from "zlib";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const MANIFEST_URL = "https://download.dubbintool.io.vn/runtime/ffmpeg/manifest.json";
const RUNTIME_VERSION = "ffmpeg-v1";
const ENCODERS = ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"] as const;

type RuntimeManifest = {
  version: string;
  url: string;
  size: number;
  sha256: string;
  executableSha256: string;
};

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", () => resolve(hash.digest("hex")));
  });
}

async function probeEncoder(executable: string, encoder: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(executable, [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=s=256x256:d=0.08",
      "-frames:v", "1", "-c:v", encoder, "-f", "null", "-",
    ], { windowsHide: true, stdio: "ignore" });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { try { child.kill(); } catch {}; finish(false); }, 8000);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

async function selectEncoder(executable: string): Promise<string | null> {
  if (!fs.existsSync(executable)) return null;
  for (const encoder of ENCODERS) {
    if (await probeEncoder(executable, encoder)) return encoder;
  }
  return null;
}

async function installFromManifest(target: string): Promise<void> {
  const manifestResponse = await fetch(MANIFEST_URL, { cache: "no-store" });
  if (!manifestResponse.ok) throw new Error(`FFmpeg manifest HTTP ${manifestResponse.status}`);
  const manifest = await manifestResponse.json() as RuntimeManifest;
  if (manifest.version !== RUNTIME_VERSION || !manifest.url || !manifest.sha256 || !manifest.executableSha256) {
    throw new Error("FFmpeg runtime manifest không hợp lệ.");
  }
  const archiveResponse = await fetch(manifest.url, { cache: "no-store" });
  if (!archiveResponse.ok || !archiveResponse.body) throw new Error(`FFmpeg runtime HTTP ${archiveResponse.status}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const archivePath = `${target}.gz.part`;
  const executablePath = `${target}.part`;
  try {
    await pipeline(Readable.fromWeb(archiveResponse.body as any), fs.createWriteStream(archivePath));
    if (fs.statSync(archivePath).size !== Number(manifest.size)) throw new Error("Kích thước FFmpeg runtime không khớp manifest.");
    if ((await sha256File(archivePath)).toLowerCase() !== manifest.sha256.toLowerCase()) throw new Error("SHA-256 gói FFmpeg không hợp lệ.");
    await pipeline(fs.createReadStream(archivePath), createGunzip(), fs.createWriteStream(executablePath));
    if ((await sha256File(executablePath)).toLowerCase() !== manifest.executableSha256.toLowerCase()) throw new Error("SHA-256 FFmpeg sau giải nén không hợp lệ.");
    fs.renameSync(executablePath, target);
  } finally {
    try { fs.unlinkSync(archivePath); } catch {}
    try { fs.unlinkSync(executablePath); } catch {}
  }
}

export async function prepareFfmpegRuntime(options: {
  localAppData: string;
  resourcesPath: string;
}): Promise<{ executable: string; encoder: string }> {
  const persistentExe = path.join(options.localAppData, "DubbinTool", "runtime", RUNTIME_VERSION, "ffmpeg.exe");
  const packagedExe = path.join(options.resourcesPath, "ffmpeg", "ffmpeg.exe");
  const candidates = [persistentExe, packagedExe];
  for (const executable of candidates) {
    const encoder = await selectEncoder(executable);
    if (encoder) {
      if (executable === packagedExe && !fs.existsSync(persistentExe)) {
        fs.mkdirSync(path.dirname(persistentExe), { recursive: true });
        fs.copyFileSync(packagedExe, persistentExe);
        return { executable: persistentExe, encoder };
      }
      return { executable, encoder };
    }
  }
  await installFromManifest(persistentExe);
  const encoder = await selectEncoder(persistentExe);
  if (!encoder) throw new Error("FFmpeg runtime đã tải nhưng không có encoder hoạt động.");
  return { executable: persistentExe, encoder };
}
