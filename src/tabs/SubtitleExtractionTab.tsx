import { motion } from "motion/react";
import { CheckCircle2, Download, FileText, Maximize, Pause, Play, ScanText, Sparkles, Upload, Volume2 } from "lucide-react";
import { useRef, useState } from "react";
import type { OcrRegion, Subtitle } from "../types";
import type { OcrDetection, OcrServiceHealth } from "../lib/ocr";
import { optimizeExtractedSubtitles, type SubtitleOptimizationStats } from "../lib/subtitle";

type Props = {
  videoSrc: string;
  videoName: string;
  subtitles: Subtitle[];
  ocrRegions: OcrRegion[];
  ocrFps: number;
  extractionMethod: "ocr" | "localocr";
  ocrHealth: OcrServiceHealth | null;
  isLoading: boolean;
  loadingProgress: number;
  loadingStep: string;
  errorMsg: string;
  watermarkRegions: OcrRegion[];
  watermarkScanDetections: OcrDetection[];
  isScanningWatermark: boolean;
  activeWatermarkRegionId: string | null;
  onSelectVideo: () => void;
  onExtract: () => void;
  onScanMissing: () => void;
  onMethodChange: (method: "localocr") => void;
  onFpsChange: (fps: number) => void;
  onUpdateRegion: (id: string, patch: Partial<OcrRegion>) => void;
  onSetActiveRegion: (id: string) => void;
  onExportSrt: () => void;
  onExportVtt: () => void;
  onExportJson: () => void;
  onOpenTracks: () => void;
  onOptimizeSubtitles: (items: Subtitle[], stats: SubtitleOptimizationStats) => void;
  onScanWatermarks: () => void;
  onAddWatermarkDetection: (detection: OcrDetection) => void;
  onSetActiveWatermarkRegion: (id: string) => void;
  onRemoveWatermarkRegion: (id: string) => void;
};

export default function SubtitleExtractionTab({
  videoSrc, videoName, subtitles, ocrRegions, ocrFps, extractionMethod,
  ocrHealth, watermarkRegions, watermarkScanDetections, isScanningWatermark, activeWatermarkRegionId,
  isLoading, loadingProgress, loadingStep, errorMsg, onSelectVideo, onExtract, onScanMissing,
  onMethodChange, onFpsChange, onUpdateRegion, onExportSrt, onExportVtt,
  onExportJson, onOpenTracks, onOptimizeSubtitles, onSetActiveRegion, onScanWatermarks, onAddWatermarkDetection, onSetActiveWatermarkRegion, onRemoveWatermarkRegion,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizationStats, setOptimizationStats] = useState<SubtitleOptimizationStats | null>(null);

  const handleOptimizeSubtitles = async () => {
    if (!subtitles.length || isLoading || isOptimizing) return;
    setIsOptimizing(true);
    setOptimizationStats(null);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
    try {
      const result = optimizeExtractedSubtitles(subtitles, duration);
      onOptimizeSubtitles(result.subtitles, result.stats);
      setOptimizationStats(result.stats);
    } finally {
      setIsOptimizing(false);
    }
  };

  const togglePlayback = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      void videoRef.current.play();
    } else {
      videoRef.current.pause();
    }
  };

  const seekVideo = (value: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = value;
    setCurrentTime(value);
  };

  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds)) return "0:00";
    return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
  };

  const formatSrtTime = (seconds: number) => {
    const safe = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const secs = Math.floor(safe % 60);
    const millis = Math.floor((safe - Math.floor(safe)) * 1000);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
  };

  const handleRegionPointerDown = (event: React.PointerEvent<HTMLButtonElement>, region: OcrRegion, resize = false) => {
    event.preventDefault();
    event.stopPropagation();
    onSetActiveRegion(region.id);
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const onMove = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / bounds.width) * 100;
      const dy = ((moveEvent.clientY - startY) / bounds.height) * 100;
      onUpdateRegion(region.id, resize
        ? { width: Math.round(Math.max(2, Math.min(100 - region.x, region.width + dx)) * 10) / 10, height: Math.round(Math.max(2, Math.min(100 - region.y, region.height + dy)) * 10) / 10 }
        : { x: Math.round(Math.max(0, Math.min(100 - region.width, region.x + dx)) * 10) / 10, y: Math.round(Math.max(0, Math.min(100 - region.height, region.y + dy)) * 10) / 10 });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}
      className="flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 text-left shadow-md lg:col-span-12 lg:h-[calc(100vh-125px)] lg:min-h-[620px] lg:overflow-hidden"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-800"><ScanText className="h-5 w-5 text-indigo-600" /> Trích xuất phụ đề</h2>
          <p className="mt-1 text-xs text-slate-500">Tách phụ đề có sẵn trong video bằng OCR, không tự động dịch nội dung.</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {optimizationStats && (
            <span className="flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-[10px] font-bold text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Đã tối ưu {optimizationStats.before} → {optimizationStats.after} dòng
            </span>
          )}
          <button
            type="button"
            onClick={() => void handleOptimizeSubtitles()}
            disabled={!subtitles.length || isLoading || isOptimizing}
            className="flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-bold text-violet-700 transition hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
            title="Lọc câu OCR trùng gần nhau, làm sạch ký tự rác và sửa timestamp chồng lấn"
          >
            <Sparkles className={`h-4 w-4 ${isOptimizing ? "animate-pulse" : ""}`} />
            {isOptimizing ? "Đang tối ưu..." : "Tối ưu phụ đề"}
          </button>
          <button type="button" onClick={onOpenTracks} disabled={!subtitles.length} className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-700 disabled:opacity-50">Mở trình chỉnh sửa ({subtitles.length})</button>
        </div>
      </div>

      <div className="mt-5 grid min-h-0 flex-1 items-stretch gap-4 lg:grid-cols-[260px_minmax(360px,1fr)_290px] xl:grid-cols-[280px_minmax(420px,1fr)_300px]">
        <aside className="min-h-0 space-y-4 overflow-y-auto rounded-xl bg-slate-50 p-3 pr-2">
          <fieldset className="rounded-lg border border-slate-200 bg-white p-3">
            <legend className="px-1 text-xs font-extrabold text-slate-800">1. Video nguồn</legend>
            <button type="button" onClick={onSelectVideo} className="mt-1 flex h-20 w-full flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-xs text-slate-500 hover:border-indigo-400 hover:text-indigo-600"><Upload className="mb-1 h-4 w-4" />{videoName || "Chọn video"}</button>
            <p className="mt-2 text-[10px] text-slate-500">{videoSrc ? "Video đã sẵn sàng" : "Chưa có video"}</p>
          </fieldset>
          <fieldset className="rounded-lg border border-slate-200 bg-white p-3">
            <legend className="px-1 text-xs font-extrabold text-slate-800">6. Lọc Watermark</legend>
            <p className="mb-2 text-[10px] text-slate-400">Seek video tới frame có watermark rồi bấm quét. Chọn chữ nào là watermark để thêm vùng lọc.</p>
            <button type="button" onClick={onScanWatermarks} disabled={isScanningWatermark || !videoSrc} className="w-full rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[10px] font-bold text-amber-700 hover:bg-amber-100 disabled:opacity-50">{isScanningWatermark ? "Đang quét..." : "Quét OCR frame hiện tại"}</button>
            {watermarkScanDetections.length > 0 && <div className="mt-2 space-y-1"><p className="text-[10px] font-bold text-slate-500">Chữ phát hiện — chọn để lọc:</p>{watermarkScanDetections.map((detection, index) => <button key={`${detection.text}-${index}`} type="button" onClick={() => onAddWatermarkDetection(detection)} className="flex w-full items-center justify-between gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-left text-[10px] text-amber-800"><span className="truncate font-mono">{detection.text}</span><span className="shrink-0">{Math.round((detection.confidence || 0) * 100)}% +</span></button>)}</div>}
            {watermarkRegions.length > 0 ? <div className="mt-2 space-y-1"><p className="text-[10px] font-bold text-slate-500">Vùng đang lọc:</p>{watermarkRegions.map((region, index) => <div key={region.id} className={`flex items-center justify-between rounded border px-2 py-1 text-[10px] ${activeWatermarkRegionId === region.id ? "border-rose-400 bg-rose-50 text-rose-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}><button type="button" onClick={() => onSetActiveWatermarkRegion(region.id)} className="min-w-0 truncate text-left font-bold">WM {index + 1}: {region.label}</button><button type="button" onClick={() => onRemoveWatermarkRegion(region.id)} className="ml-2 shrink-0 font-bold text-rose-400">✕</button></div>)}</div> : <p className="mt-2 text-[10px] italic text-slate-400">Chưa có vùng watermark nào.</p>}
          </fieldset>
          <fieldset className="rounded-lg border border-slate-200 bg-white p-3">
            <legend className="px-1 text-xs font-extrabold text-slate-800">2. Engine OCR</legend>
            <label className="flex items-center gap-2 text-xs"><input type="radio" checked={extractionMethod === "localocr"} onChange={() => onMethodChange("localocr")} /> PaddleOCR Python ({ocrHealth?.model?.backend?.includes("gpu") ? "GPU" : "CPU"})</label>
            <label className="mt-3 block text-xs font-bold text-slate-600">Tần suất quét: {ocrFps} FPS<input type="range" min="1" max="20" step="1" value={ocrFps} onChange={(event) => onFpsChange(Number(event.target.value))} className="mt-1 w-full accent-indigo-600" /><span className="mt-1 block text-[10px] font-normal text-slate-400">Có thể quét tối đa 20 FPS để bắt các phụ đề xuất hiện ngắn.</span></label>
          </fieldset>
          <button type="button" onClick={onExtract} disabled={!videoSrc || isLoading} className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2.5 text-xs font-extrabold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"><Play className="h-4 w-4 fill-current" />{isLoading ? "Đang trích xuất..." : "Bắt đầu trích xuất"}</button>
          <button type="button" onClick={onScanMissing} disabled={!videoSrc || !subtitles.length || isLoading} className="flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-xs font-extrabold text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50" title="Bỏ qua timeline đã có phụ đề và chỉ OCR các khoảng còn trống"><ScanText className="h-4 w-4" />Quét phần phụ đề còn thiếu</button>
          <p className="-mt-2 px-1 text-[9px] leading-relaxed text-slate-400">Các đoạn đã có timestamp OCR sẽ được giữ nguyên và không quét lại.</p>
          {isLoading && <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-2 text-[10px] text-indigo-700"><div className="mb-1 flex justify-between font-bold"><span>{loadingStep || "Đang xử lý..."}</span><span>{Math.round(loadingProgress)}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-indigo-100"><div className="h-full bg-indigo-600 transition-all" style={{ width: `${Math.min(100, Math.max(0, loadingProgress))}%` }} /></div></div>}
          {errorMsg && <p className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-[10px] text-rose-700">{errorMsg}</p>}
        </aside>

        <div className="flex h-[420px] min-h-0 items-center justify-center overflow-hidden rounded-xl bg-slate-950 p-3 lg:h-full">
          {videoSrc ? <div className="w-full max-w-4xl overflow-hidden rounded-xl border border-slate-800 bg-black shadow-2xl">
            <div className="relative aspect-video max-h-[500px]">
              <video
                ref={videoRef}
                src={videoSrc}
                onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                className="h-full w-full object-contain"
              />
              <div className="pointer-events-none absolute inset-0">
              {ocrRegions.map((region, index) => <button
                key={region.id}
                type="button"
                onPointerDown={(event) => handleRegionPointerDown(event, region)}
                className="pointer-events-auto absolute cursor-move border-2 border-emerald-400 bg-emerald-400/10 text-left shadow-[0_0_0_1px_rgba(16,185,129,0.25)]"
                style={{ left: `${region.x}%`, top: `${region.y}%`, width: `${region.width}%`, height: `${region.height}%` }}
              >
                <span className="absolute left-0 top-0 rounded-br bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-white">OCR {index + 1}</span>
                <span onPointerDown={(event) => handleRegionPointerDown(event as unknown as React.PointerEvent<HTMLButtonElement>, region, true)} className="absolute -bottom-1 -right-1 h-3 w-3 cursor-nwse-resize rounded-sm bg-emerald-400" />
              </button>)}
              </div>
            </div>
            <div className="border-t border-slate-800 bg-slate-950 px-3 py-2.5">
              <input type="range" min="0" max={duration || 0} step="0.01" value={currentTime} onChange={(event) => seekVideo(Number(event.target.value))} className="mb-2 h-1.5 w-full cursor-pointer accent-indigo-500" />
              <div className="flex items-center gap-3 text-xs text-slate-300">
                <button type="button" onClick={togglePlayback} className="rounded-lg bg-indigo-600 p-2 text-white transition hover:bg-indigo-500" title={isPlaying ? "Tạm dừng" : "Phát"}>
                  {isPlaying ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
                </button>
                <span className="min-w-[78px] font-mono text-[11px]">{formatTime(currentTime)} / {formatTime(duration)}</span>
                <div className="ml-auto flex items-center gap-2">
                  <Volume2 className="h-4 w-4 text-slate-400" />
                  <input type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => { const next = Number(event.target.value); setVolume(next); if (videoRef.current) videoRef.current.volume = next; }} className="w-20 accent-indigo-500" />
                  <button type="button" onClick={() => void videoRef.current?.requestFullscreen?.()} className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white" title="Toàn màn hình"><Maximize className="h-4 w-4" /></button>
                </div>
              </div>
            </div>
          </div> : <div className="text-center text-slate-500"><FileText className="mx-auto mb-2 h-10 w-10" /><p className="text-sm">Chọn video để xem trước</p></div>}
        </div>

        <aside className="flex h-[680px] min-h-0 flex-col gap-3 overflow-hidden lg:h-auto">
          <div className="max-h-44 shrink-0 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
            <h3 className="font-extrabold text-slate-800">Vùng OCR</h3>
            <p className="mt-1 text-[10px] text-slate-500">Giới hạn vùng quét để tăng độ chính xác và tốc độ.</p>
            <div className="mt-3 space-y-2">{ocrRegions.map((region, index) => <div key={region.id} className="rounded-lg border border-slate-200 bg-white p-2"><p className="mb-1 text-[10px] font-bold text-slate-600">Vùng #{index + 1}</p><div className="grid grid-cols-2 gap-1">{(["x", "y", "width", "height"] as const).map((key) => <label key={key} className="text-[9px] text-slate-500">{key.toUpperCase()}<input type="number" min="0" max="100" step="0.1" value={region[key]} onChange={(event) => onUpdateRegion(region.id, { [key]: Number(event.target.value) })} className="mt-0.5 w-full rounded border border-slate-200 px-1.5 py-1 text-[10px]" /></label>)}</div></div>)}</div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-sm">
            <div className="flex shrink-0 items-center justify-between border-b border-slate-100 pb-2">
              <div><h3 className="font-extrabold text-slate-800">Phụ đề đã nhận diện</h3><p className="mt-0.5 text-[10px] font-medium text-slate-500">OCR tới đâu, danh sách cập nhật tới đó.</p></div>
              <span className="rounded-md bg-indigo-500/10 px-2 py-1 text-[10px] font-bold text-indigo-600">{subtitles.length} dòng</span>
            </div>
            {optimizationStats && (
              <div className="mt-2 grid shrink-0 grid-cols-3 gap-1 rounded-lg border border-emerald-100 bg-emerald-50 p-2 text-center text-[9px] font-bold text-emerald-700">
                <span>Lọc trùng<br />{optimizationStats.duplicatesRemoved}</span>
                <span>Làm sạch<br />{optimizationStats.textCleaned + optimizationStats.emptyRemoved}</span>
                <span>Sửa timing<br />{optimizationStats.overlapsFixed}</span>
              </div>
            )}
            <div className="mt-2 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1" id="extracted-subtitles-list">
              {subtitles.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-4 py-12 text-center">
                  <FileText className="mx-auto mb-2.5 h-8 w-8 text-slate-400" />
                  <p className="text-sm font-bold text-slate-700">Chưa có phụ đề</p>
                  <p className="mt-1 text-xs font-medium text-slate-500">Bấm bắt đầu trích xuất để xem kết quả trực tiếp.</p>
                </div>
              ) : subtitles.map((subtitle, index) => {
                const isActive = currentTime >= subtitle.start && currentTime <= subtitle.end;
                return (
                  <div
                    key={subtitle.id || `${subtitle.start}-${index}`}
                    onClick={() => seekVideo(subtitle.start)}
                    className={`cursor-pointer rounded-xl border p-3.5 text-left shadow-sm transition-all ${isActive ? "border-indigo-500/30 bg-indigo-500/10" : "border-slate-200 bg-white hover:border-slate-300"}`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="rounded border border-slate-200 bg-slate-100 px-2 py-0.5 font-mono text-[10px] font-bold text-slate-600">
                        {formatSrtTime(subtitle.start).substring(3, 11)} ➔ {formatSrtTime(subtitle.end).substring(3, 11)}
                      </span>
                      <span className="text-[10px] font-bold text-slate-400">#{index + 1}</span>
                    </div>
                    <p className="line-clamp-3 text-xs font-bold leading-relaxed text-slate-800">{subtitle.original || subtitle.translated}</p>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="shrink-0 rounded-xl border border-emerald-200 bg-emerald-50 p-3"><div className="flex items-center justify-between gap-2"><div><p className="text-xs font-bold text-emerald-800">Đã nhận diện: {subtitles.length} dòng</p><p className="mt-0.5 text-[9px] text-emerald-600">{ocrHealth?.connected ? "PaddleOCR sẵn sàng" : "Engine khởi tạo khi chạy"}</p></div><button type="button" onClick={onOpenTracks} disabled={!subtitles.length} className="rounded-md bg-emerald-600 px-2 py-1.5 text-[9px] font-extrabold text-white disabled:opacity-40">Chỉnh sửa</button></div><div className="mt-2 grid grid-cols-3 gap-1"><button type="button" onClick={onExportSrt} disabled={!subtitles.length} className="rounded bg-white px-1 py-1.5 text-[10px] font-bold text-slate-600 disabled:opacity-40"><Download className="mx-auto h-3 w-3" />SRT</button><button type="button" onClick={onExportVtt} disabled={!subtitles.length} className="rounded bg-white px-1 py-1.5 text-[10px] font-bold text-slate-600 disabled:opacity-40"><Download className="mx-auto h-3 w-3" />VTT</button><button type="button" onClick={onExportJson} disabled={!subtitles.length} className="rounded bg-white px-1 py-1.5 text-[10px] font-bold text-slate-600 disabled:opacity-40"><Download className="mx-auto h-3 w-3" />JSON</button></div></div>
        </aside>
      </div>
    </motion.section>
  );
}
