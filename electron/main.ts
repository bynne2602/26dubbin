import { app, BrowserWindow, shell, Menu, ipcMain, dialog } from "electron";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { autoUpdater } from "electron-updater";
import { prepareFfmpegRuntime } from "./ffmpegRuntime";

/** Tạo Hardware ID từ thông tin máy (CPU + hostname + platform) */
function getHardwareId(): string {
  const raw = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model ?? "unknown",
    os.totalmem().toString(),
  ].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

// Tắt GPU acceleration để tránh crash GPU cache trên một số máy Windows
app.disableHardwareAcceleration();

// ── Tìm đúng đường dẫn dist khi đóng gói ─────────────────────────────────
function getDistPath(): string {
  // Khi chạy trong electron-builder package, resourcesPath trỏ vào thư mục resources/
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app", "dist");
  }
  // __dirname = dist/electron/ => cần lên 2 cấp để về project root rồi vào dist/
  return path.join(__dirname, "..", "..", "dist");
}

function getServerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app", "dist", "server.cjs");
  }
  return path.join(__dirname, "..", "..", "dist", "server.cjs");
}

// ── Khởi động Express server ──────────────────────────────────────────────
// Origin phải cố định: IndexedDB và localStorage được tách theo origin (gồm port).
// Port ngẫu nhiên khiến checkpoint không thể khôi phục sau khi khởi động lại Electron.
const serverPort = 3000;
// PP-OCRv5/Paddle 3 is ABI-incompatible with the previous PP-OCRv4 runtime.
// Keep it in a versioned directory so an update never mixes native DLLs.
const runtimeVersion = "runtime-v2";

function getPersistentRuntimePath(): string {
  const localAppData = process.env.LOCALAPPDATA || path.dirname(app.getPath("userData"));
  return path.join(localAppData, "DubbinTool", "runtime", runtimeVersion);
}

function isUsableRuntime(root: string): boolean {
  return fs.existsSync(path.join(root, "ocr-engine", "ocr_engine.exe"));
}

function resolveOcrEnginePath(): string {
  const candidates = [
    process.env.PYTHON_PATH,
    path.join(getPersistentRuntimePath(), "ocr-engine", "ocr_engine.exe"),
    path.join(process.resourcesPath, "ocr-engine", "ocr_engine.exe"),
    path.join(process.cwd(), "resources", "ocr-engine", "ocr_engine.exe"),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate))) || "";
}

function preparePersistentRuntime(): string {
  if (!app.isPackaged) return process.resourcesPath;
  const persistentRoot = getPersistentRuntimePath();
  if (isUsableRuntime(persistentRoot)) return persistentRoot;

  // 1.0.6 is the transition release: move the large OCR/CUDA runtime outside
  // the installation folder once. Future lightweight updates can replace the
  // app without extracting or deleting these files again.
  fs.mkdirSync(persistentRoot, { recursive: true });
  for (const directory of ["ocr-engine", "cuda-libs"]) {
    const source = path.join(process.resourcesPath, directory);
    const destination = path.join(persistentRoot, directory);
    if (!fs.existsSync(source)) continue;
    try {
      if (!fs.existsSync(destination)) {
        fs.renameSync(source, destination);
      } else {
        // Recover an interrupted migration that left only a partial directory.
        fs.cpSync(source, destination, { recursive: true, force: true });
      }
    } catch (error) {
      console.warn(`[Runtime] Không thể di chuyển ${directory}; tiếp tục dùng runtime trong bộ cài.`, error);
    }
  }
  return isUsableRuntime(persistentRoot) ? persistentRoot : process.resourcesPath;
}

function serverAlreadyRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const http = require("http") as typeof import("http");
    const request = http.get(`http://localhost:${serverPort}/`, (res: any) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 500));
    });
    request.setTimeout(1000, () => { request.destroy(); resolve(false); });
    request.once("error", () => resolve(false));
  });
}

async function startServer(): Promise<void> {
  const serverPath = getServerPath();

  // Set DIST_PATH env để server.cjs biết serve static files ở đâu
  process.env.DIST_PATH   = getDistPath();
  process.env.ELECTRON    = "1";

  process.env.PORT = String(serverPort);
  process.env.HWID = getHardwareId();
  if (app.isPackaged) {
    // Keep every server-side relative path anchored at resources/app. Without
    // this, the preview OCR health-check searches scripts from the install
    // launch directory while video OCR resolves a different packaged path.
    process.chdir(path.join(process.resourcesPath, "app"));
    const runtimeRoot = preparePersistentRuntime();
    const cudaLibs = path.join(runtimeRoot, "cuda-libs");
    const engine = path.join(runtimeRoot, "ocr-engine", "ocr_engine.exe");
    const packagedFfmpeg = path.join(process.resourcesPath, "ffmpeg", "ffmpeg.exe");
    const packagedYtDlp = path.join(process.resourcesPath, "media-downloader", "yt-dlp.exe");
    process.env.OCR_RESOURCES_PATH = runtimeRoot;
    if (fs.existsSync(packagedFfmpeg)) process.env.FFMPEG_BINARY = packagedFfmpeg;
    if (fs.existsSync(packagedYtDlp)) process.env.YT_DLP_BINARY = packagedYtDlp;
    process.env.PADDLE_CUDA_BIN = cudaLibs;
    process.env.PYTHON_PATH = engine;
    process.env.PATH = `${cudaLibs};${process.env.PATH || ""}`;
    try {
      const ffmpegRuntime = await prepareFfmpegRuntime({
        localAppData: process.env.LOCALAPPDATA || path.dirname(app.getPath("userData")),
        resourcesPath: process.resourcesPath,
      });
      process.env.FFMPEG_BINARY = ffmpegRuntime.executable;
      process.env.FFMPEG_VIDEO_ENCODER = ffmpegRuntime.encoder;
      console.log(`[FFmpeg Runtime] ${ffmpegRuntime.encoder}: ${ffmpegRuntime.executable}`);
    } catch (error) {
      console.warn("[FFmpeg Runtime] Không thể chuẩn bị runtime tự động; server sẽ dùng fallback.", error);
    }
  } else delete process.env.OCR_RESOURCES_PATH;

  // Reuse an existing local app server (e.g. Electron restarted during dev).
  // This avoids crashing the main process with EADDRINUSE on port 3000.
  if (await serverAlreadyRunning()) return;

  // Load server.cjs (CommonJS bundle)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(serverPath);

  // Đợi server sẵn sàng
  await waitForServer(`http://localhost:${serverPort}/`);
}

function waitForServer(url: string, maxMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const http = require("http") as typeof import("http");
    const start  = Date.now();
    const check  = () => {
      http.get(url, (res: any) => {
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      }).on("error", retry);
    };
    const retry = () => {
      if (Date.now() - start > maxMs) return reject(new Error("Server không khởi động được."));
      setTimeout(check, 300);
    };
    check();
  });
}

// ── Cửa sổ chính ──────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let rendererCrashTimes: number[] = [];

function getDiagnosticsPath(): string {
  return path.join(app.getPath("userData"), "logs", "dubbintool.log");
}

function appendAppLog(message: string): void {
  try {
    const logPath = getDiagnosticsPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {}
}

function directorySize(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    try {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(fullPath);
        else if (entry.isFile()) total += fs.statSync(fullPath).size;
      }
    } catch {}
  }
  return total;
}

function dubbinTempSize(): number {
  const tempRoot = path.resolve(app.getPath("temp"));
  let total = 0;
  try {
    for (const name of fs.readdirSync(tempRoot)) {
      if (!/^dubbin-/i.test(name)) continue;
      const target = path.resolve(tempRoot, name);
      if (path.dirname(target) !== tempRoot) continue;
      try { total += fs.statSync(target).isFile() ? fs.statSync(target).size : directorySize(target); } catch {}
    }
  } catch {}
  return total;
}
let pendingUpdateVersion: string | undefined;

function emitUpdateStatus(payload: { state: "checking" | "downloading" | "ready" | "idle" | "error"; percent?: number; version?: string }) {
  mainWindow?.webContents.send("update:status", payload);
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => emitUpdateStatus({ state: "checking" }));
  autoUpdater.on("update-not-available", () => emitUpdateStatus({ state: "idle" }));

  autoUpdater.on("update-available", (info) => {
    pendingUpdateVersion = info.version;
    emitUpdateStatus({ state: "downloading", percent: 0, version: pendingUpdateVersion });
  });

  autoUpdater.on("download-progress", (progress) => {
    emitUpdateStatus({
      state: "downloading",
      percent: Math.max(0, Math.min(100, progress.percent)),
      version: pendingUpdateVersion,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    pendingUpdateVersion = info.version;
    emitUpdateStatus({ state: "ready", percent: 100, version: info.version });
  });

  autoUpdater.on("error", (error) => {
    emitUpdateStatus({ state: "error" });
    console.error("Lỗi tự động cập nhật:", error);
  });

  // Chờ giao diện ổn định rồi mới kiểm tra để không làm chậm lúc mở ứng dụng.
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((error) => {
      console.error("Không thể kiểm tra cập nhật:", error);
    });
  }, 5000);
}

function getPreloadPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app", "dist", "electron", "preload.cjs");
  }
  return path.join(__dirname, "preload.cjs");
}

function getWindowIconPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "app", "dist", "assets", "icon.png");
  return path.join(__dirname, "..", "..", "public", "assets", "icon.png");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1400,
    height: 900,
    minWidth:  900,
    minHeight: 600,
    title: "26Dubbin Tool",
    icon: getWindowIconPath(),
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#ffffff",
      symbolColor: "#64748b",
      height: 38,
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: getPreloadPath(),
    },
    show: false,
    backgroundColor: "#ffffff",
  });

  mainWindow.loadURL(`http://localhost:${serverPort}`);

  // Hiện cửa sổ sau khi tải xong để tránh flash trắng
  mainWindow.once("ready-to-show", () => {
    mainWindow!.show();
  });

  // Mở link ngoài bằng trình duyệt mặc định
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    const now = Date.now();
    rendererCrashTimes = rendererCrashTimes.filter((time) => now - time < 60_000);
    rendererCrashTimes.push(now);
    appendAppLog(`Renderer crash: ${details.reason} (exit ${details.exitCode})`);
    if (rendererCrashTimes.length <= 2 && mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => mainWindow?.reload(), 800);
    }
  });
  mainWindow.webContents.on("did-finish-load", () => {
    if (rendererCrashTimes.length > 0) {
      mainWindow?.webContents.send("app:recovered", { crashes: rendererCrashTimes.length });
      setTimeout(() => { rendererCrashTimes = []; }, 60_000);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── IPC: File dialogs ─────────────────────────────────────────────────────
ipcMain.handle("dialog:selectOutputFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Chọn thư mục lưu video",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle(
  "dialog:saveFileToFolder",
  async (_event, folder: string, filename: string, base64Data: string) => {
    try {
      const filePath = path.join(folder, filename);
      const buffer = Buffer.from(base64Data, "base64");
      fs.writeFileSync(filePath, buffer);
      return { success: true, filePath };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
);

ipcMain.handle(
  "dialog:saveRenderedVideo",
  async (event, downloadUrl: string, folder: string, filename: string) => {
    let partialPath = "";
    try {
      let targetFolder = folder;
      let targetPath = "";
      if (!targetFolder) {
        const result = await dialog.showSaveDialog(mainWindow!, {
          title: "Lưu video",
          defaultPath: path.basename(filename || "final-video.mp4"),
          filters: [{ name: "Video MP4", extensions: ["mp4"] }],
        });
        if (result.canceled || !result.filePath) return { success: false, canceled: true };
        targetPath = result.filePath;
      } else {
        targetPath = path.join(targetFolder, path.basename(filename || "final-video.mp4"));
      }

      const safeUrl = new URL(String(downloadUrl || ""), `http://127.0.0.1:${serverPort}`);
      if (!/^https?:$/.test(safeUrl.protocol) || !["127.0.0.1", "localhost"].includes(safeUrl.hostname) || Number(safeUrl.port || 80) !== serverPort) {
        throw new Error("Đường dẫn tải video không hợp lệ.");
      }
      partialPath = `${targetPath}.partial`;
      try { fs.unlinkSync(partialPath); } catch {}
      await new Promise<void>((resolve, reject) => {
        const http = require("http") as typeof import("http");
        const request = http.get(safeUrl, (response: import("http").IncomingMessage) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`Server trả về HTTP ${response.statusCode || 0}.`));
            return;
          }
          const total = Number(response.headers["content-length"] || 0);
          const startedAt = Date.now();
          let transferred = 0;
          response.on("data", (chunk: Buffer) => {
            transferred += chunk.length;
            event.sender.send("render:save-progress", {
              transferred, total,
              percent: total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : undefined,
              bytesPerSecond: Math.round(transferred / Math.max(0.1, (Date.now() - startedAt) / 1000)),
            });
          });
          const output = fs.createWriteStream(partialPath);
          response.pipe(output);
          output.once("finish", () => output.close(() => resolve()));
          output.once("error", reject);
          response.once("error", reject);
        });
        request.once("error", reject);
      });
      const size = fs.statSync(partialPath).size;
      if (size <= 0) throw new Error("Video đã lưu có kích thước bằng 0.");
      try { fs.unlinkSync(targetPath); } catch {}
      fs.renameSync(partialPath, targetPath);
      event.sender.send("render:save-progress", { transferred: size, total: size, percent: 100, bytesPerSecond: 0, done: true });
      return { success: true, filePath: targetPath, size };
    } catch (err: any) {
      if (partialPath) { try { fs.unlinkSync(partialPath); } catch {} }
      return { success: false, error: err?.message || String(err) };
    }
  },
);

ipcMain.handle("system:diagnostics", async (_event, requestedFolder?: string) => {
  const runtimePath = process.env.FFMPEG_BINARY || "";
  const ocrEnginePath = resolveOcrEnginePath();
  const probeFolder = requestedFolder && fs.existsSync(requestedFolder) ? requestedFolder : app.getPath("temp");
  let writable = false;
  try {
    const testPath = path.join(probeFolder, `.dubbin-write-${process.pid}.tmp`);
    fs.writeFileSync(testPath, "ok"); fs.unlinkSync(testPath); writable = true;
  } catch {}
  let diskFree = 0;
  try { diskFree = Number(fs.statfsSync(probeFolder).bavail) * Number(fs.statfsSync(probeFolder).bsize); } catch {}
  return {
    appVersion: app.getVersion(),
    ffmpeg: { path: runtimePath, exists: Boolean(runtimePath && fs.existsSync(runtimePath)), size: runtimePath && fs.existsSync(runtimePath) ? fs.statSync(runtimePath).size : 0, encoder: process.env.FFMPEG_VIDEO_ENCODER || "unknown" },
    ocr: { path: ocrEnginePath || process.env.PYTHON_PATH || "", exists: Boolean(ocrEnginePath) },
    memory: { total: os.totalmem(), free: os.freemem() },
    disk: { folder: probeFolder, free: diskFree, writable },
    cache: { temp: dubbinTempSize() },
    logPath: getDiagnosticsPath(),
  };
});

ipcMain.handle("system:openPath", async (_event, target: string) => {
  if (!target) return "Đường dẫn trống.";
  return shell.openPath(target);
});
ipcMain.handle("system:showItemInFolder", (_event, target: string) => {
  if (!target || !fs.existsSync(target)) return false;
  shell.showItemInFolder(target);
  return true;
});
ipcMain.handle("system:clearTemp", () => {
  const tempRoot = path.resolve(app.getPath("temp"));
  let removed = 0;
  for (const name of fs.readdirSync(tempRoot)) {
    if (!/^dubbin-/i.test(name)) continue;
    const target = path.resolve(tempRoot, name);
    if (path.dirname(target) !== tempRoot) continue;
    try {
      const stat = fs.statSync(target);
      removed += stat.isFile() ? stat.size : directorySize(target);
      fs.rmSync(target, { recursive: true, force: true });
    } catch {}
  }
  appendAppLog(`Đã dọn ${removed} byte file tạm an toàn.`);
  return { removed };
});
ipcMain.handle("log:append", (_event, message: string) => appendAppLog(String(message || "")));
ipcMain.handle("log:open", async () => {
  appendAppLog("Mở nhật ký ứng dụng.");
  return shell.openPath(getDiagnosticsPath());
});

ipcMain.handle("update:install", () => {
  // The one-click installer has no choices, but remains visible so users can
  // follow the installation progress before the updated app reopens.
  if (app.isPackaged) autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle("app:getVersion", () => app.getVersion());

ipcMain.handle(
  "dialog:saveFileDialog",
  async (_event, defaultFilename: string, base64Data: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Lưu video",
      defaultPath: defaultFilename,
      filters: [{ name: "Video MP4", extensions: ["mp4"] }],
    });
    if (result.canceled || !result.filePath) return { success: false };
    try {
      const buffer = Buffer.from(base64Data, "base64");
      fs.writeFileSync(result.filePath, buffer);
      return { success: true, filePath: result.filePath };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
);

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    await startServer();
    createWindow();
    setupAutoUpdater();
  } catch (err) {
    console.error("Lỗi khởi động server:", err);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
