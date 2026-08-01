import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  /** Mở dialog chọn folder, trả về đường dẫn hoặc null nếu hủy */
  selectOutputFolder: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:selectOutputFolder"),

  /** Lưu file vào folder đã chọn, trả về đường dẫn file đã lưu hoặc null nếu lỗi */
  saveFileToFolder: (
    folder: string,
    filename: string,
    base64Data: string,
  ): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke("dialog:saveFileToFolder", folder, filename, base64Data),

  /** Lưu file với hộp thoại Save As */
  saveFileDialog: (
    defaultFilename: string,
    base64Data: string,
  ): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke("dialog:saveFileDialog", defaultFilename, base64Data),

  /** Stream a completed render directly to disk without copying it through renderer memory. */
  saveRenderedVideo: (
    downloadUrl: string,
    folder: string,
    filename: string,
  ): Promise<{ success: boolean; filePath?: string; error?: string; canceled?: boolean }> =>
    ipcRenderer.invoke("dialog:saveRenderedVideo", downloadUrl, folder, filename),
  onRenderSaveProgress: (callback: (progress: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: any) => callback(progress);
    ipcRenderer.on("render:save-progress", listener);
    return () => ipcRenderer.removeListener("render:save-progress", listener);
  },
  onAppRecovered: (callback: (status: { crashes: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: { crashes: number }) => callback(status);
    ipcRenderer.on("app:recovered", listener);
    return () => ipcRenderer.removeListener("app:recovered", listener);
  },
  runSystemDiagnostics: (folder?: string) => ipcRenderer.invoke("system:diagnostics", folder),
  openPath: (target: string) => ipcRenderer.invoke("system:openPath", target),
  showItemInFolder: (target: string) => ipcRenderer.invoke("system:showItemInFolder", target),
  clearTemp: () => ipcRenderer.invoke("system:clearTemp"),
  appendLog: (message: string) => ipcRenderer.invoke("log:append", message),
  openLog: () => ipcRenderer.invoke("log:open"),

  onUpdateStatus: (callback: (status: { state: string; percent?: number; version?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: { state: string; percent?: number; version?: string }) => callback(status);
    ipcRenderer.on("update:status", listener);
    return () => ipcRenderer.removeListener("update:status", listener);
  },

  installUpdate: (): Promise<void> => ipcRenderer.invoke("update:install"),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:getVersion"),
});
