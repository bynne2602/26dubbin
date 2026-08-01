export interface Subtitle {
  id: string;
  start: number;
  end: number;
  original: string;
  translated: string;
}

export interface BlurBox {
  id: string;
  start?: number;    // Optional active range on the editor timeline
  end?: number;
  xPosition: number;  // Percentage from left (0 to 100)
  yPosition: number;  // Percentage from top (0 to 100)
  width: number;      // Percentage of video width (0 to 100)
  height: number;     // Percentage of video height (0 to 100)
  blurAmount: number; // Pixels of blur filter
  opacity: number;    // Opacity (0 to 1)
  bgColor: string;    // Background cover color
}

export interface OcrRegion {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BlurSettings {
  enabled: boolean;
  yPosition: number; // Percentage from top (e.g., 80%)
  height: number;    // Percentage of video height (e.g., 15%)
  width: number;     // Percentage of video width (e.g., 80%)
  blurAmount: number; // Pixels of blur filter
  opacity: number;   // Opacity of the background cover (0 to 1)
  bgColor: string;   // Background cover color (e.g., "rgba(0,0,0,0.5)")
}

export interface SubtitleSettings {
  fontSize: number;       // Kích thước chữ dạng số (px) để điều chỉnh mượt mà bằng thanh kéo
  fontFamily: string;     // Font chữ tuỳ chỉnh (Inter, Space Grotesk, v.v.)
  textColor: string;      // Màu chữ dạng HEX
  bgColor: string;        // Màu nền phụ đề dạng RGBA
  outline: boolean;       // Bật/tắt viền chữ
  outlineColor: string;   // Màu sắc viền chữ
  outlineWidth: number;   // Độ dày viền chữ (px)
  textEffect: "none" | "outline" | "glow" | "shadow"; // Hiệu ứng chữ (Không có, viền stroke, phát sáng glow, đổ bóng shadow)
  fontWeight: "normal" | "medium" | "bold" | "black";  // Độ đậm của chữ
  letterSpacing: number;  // Khoảng cách giữa các chữ (px)
  position: "top" | "bottom" | "center" | "blur-box" | "custom"; // Vị trí hiển thị phụ đề trên màn hình
  customX?: number;       // Vị trí ngang tuỳ chỉnh (%)
  customY?: number;       // Vị trí dọc tuỳ chỉnh (%)
}

// Electron IPC API exposed via preload contextBridge
declare global {
  interface Window {
    electronAPI?: {
      selectOutputFolder: () => Promise<string | null>;
      saveFileToFolder: (
        folder: string,
        filename: string,
        base64Data: string,
      ) => Promise<{ success: boolean; filePath?: string; error?: string }>;
      saveFileDialog: (
        defaultFilename: string,
        base64Data: string,
      ) => Promise<{ success: boolean; filePath?: string; error?: string }>;
      saveRenderedVideo: (
        downloadUrl: string,
        folder: string,
        filename: string,
      ) => Promise<{ success: boolean; filePath?: string; size?: number; error?: string; canceled?: boolean }>;
      onRenderSaveProgress: (callback: (progress: { transferred: number; total: number; percent?: number; bytesPerSecond: number; done?: boolean }) => void) => () => void;
      onAppRecovered: (callback: (status: { crashes: number }) => void) => () => void;
      runSystemDiagnostics: (folder?: string) => Promise<any>;
      openPath: (target: string) => Promise<string>;
      showItemInFolder: (target: string) => Promise<boolean>;
      clearTemp: () => Promise<{ removed: number }>;
      appendLog: (message: string) => Promise<void>;
      openLog: () => Promise<string>;
      onUpdateStatus: (callback: (status: { state: "checking" | "downloading" | "ready" | "idle" | "error"; percent?: number; version?: string }) => void) => () => void;
      installUpdate: () => Promise<void>;
      getAppVersion: () => Promise<string>;
    };
  }
}
