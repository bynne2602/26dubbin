import { motion } from "motion/react";
import { Megaphone, RefreshCw, Layers, Download, FileText, Play, CheckCircle2, Clock3 } from "lucide-react";
import NarrationLayout from "../layouts/NarrationLayout";
import type { Subtitle } from "../types";

type Props = {
  subtitles: Subtitle[];
  ttsEnabled: boolean;
  setTtsEnabled: (v: boolean) => void;
  ttsEngine: "vieneu" | "browser" | "tiktok";
  setTtsEngine: (v: "vieneu" | "browser" | "tiktok") => void;
  tiktokVoice: string;
  setTiktokVoice: (v: string) => void;
  tiktokSessionId: string;
  setTiktokSessionId: (v: string) => void;
  vieneuVoice: string;
  setVieneuVoice: (v: string) => void;
  ttsVoiceName: string;
  setTtsVoiceName: (v: string) => void;
  voices: SpeechSynthesisVoice[];
  originalAudioMixVolume: number;
  setOriginalAudioMixVolume: (v: number) => void;
  isPreGenerating: boolean;
  preGenerateProgress: number;
  isMergingAudio: boolean;
  fullTtsText: string;
  setFullTtsText: (v: string) => void;
  preGenerateAllTts: () => Promise<boolean>;
  downloadMergedVoiceover: () => void;
  voiceAudioUrls: Record<string, string>;
  regeneratingTtsId: string | null;
  onRegenerateTts: (subtitle: Subtitle) => void;
  onUpdateSubtitleText: (id: string, text: string) => void;
};

export default function NarrationTab({
  subtitles,
  ttsEnabled,
  setTtsEnabled,
  ttsEngine,
  setTtsEngine,
  tiktokVoice,
  setTiktokVoice,
  tiktokSessionId,
  setTiktokSessionId,
  vieneuVoice,
  setVieneuVoice,
  ttsVoiceName,
  setTtsVoiceName,
  voices,
  originalAudioMixVolume,
  setOriginalAudioMixVolume,
  isPreGenerating,
  preGenerateProgress,
  isMergingAudio,
  fullTtsText,
  setFullTtsText,
  preGenerateAllTts,
  downloadMergedVoiceover,
  voiceAudioUrls,
  regeneratingTtsId,
  onRegenerateTts,
  onUpdateSubtitleText,
}: Props) {
  return (
    <NarrationLayout>
      <motion.div
        key="tts"
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -15 }}
        transition={{ duration: 0.2, ease: "easeInOut" }}
        className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-md flex flex-col gap-4 max-h-[620px] overflow-hidden hover:border-slate-300/80 hover:shadow-lg transition-all duration-300 text-left"
      >
        {/* Header */}
        <div className="flex flex-col gap-1 shrink-0">
          <h3 className="font-bold text-slate-800 flex items-center gap-2 text-base">
            <Megaphone className="w-5 h-5 text-[#4f46e5]" />
            Cấu Hình Thuyết Minh VieNeu & TikTok TTS
          </h3>
          <p className="text-xs text-slate-500">Phát âm thanh thuyết minh tự động khi xem video hoặc kết xuất bản thuyết minh đồng bộ hoàn chỉnh.</p>
        </div>

        <div className="flex-1 overflow-y-auto flex flex-col gap-4 pr-1 min-h-0 text-left">

          {/* Toggle Live Reader */}
          <div className="flex items-center justify-between bg-slate-50 border border-slate-200/60 p-3 rounded-xl shadow-sm shrink-0">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-bold text-slate-700">Đọc phụ đề theo video (Live)</span>
              <span className="text-[10px] text-slate-400">Tự động phát giọng đọc khi chạy video player</span>
            </div>
            <button
              onClick={() => setTtsEnabled(!ttsEnabled)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${ttsEnabled ? "bg-[#4f46e5]" : "bg-slate-200"}`}
            >
              <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${ttsEnabled ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>

          {/* Volume Mix */}
          <div className="flex flex-col gap-1.5 bg-slate-50 border border-slate-200/60 p-3 rounded-xl shadow-sm shrink-0">
            <div className="flex justify-between text-xs font-bold">
              <span className="text-slate-600">Âm lượng audio gốc khi ghép TTS</span>
              <span className="text-[#4f46e5] font-mono">{Math.round(originalAudioMixVolume * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={originalAudioMixVolume}
              onChange={(e) => setOriginalAudioMixVolume(parseFloat(e.target.value))}
              className="accent-[#6366f1] bg-slate-200 h-1.5 rounded-lg appearance-none cursor-pointer mt-1"
            />
            <p className="text-[10px] text-slate-400 leading-relaxed">
              0% = tắt hẳn audio gốc khi có giọng đọc AI. 100% = giữ nguyên âm lượng gốc. Áp dụng cho cả nghe thử và khi xuất video/audio.
            </p>
          </div>

          {/* Engine Selector */}
          <div className="flex flex-col gap-2.5 bg-slate-50 border border-slate-200/60 p-3 rounded-xl shadow-sm shrink-0">
            <span className="text-xs font-bold text-slate-700">Chọn công nghệ giọng đọc (Engine)</span>
            <div className="grid grid-cols-3 gap-2">
              {([
                { key: "tiktok" as const, label: "TikTok TTS", sub: "(Tiếng Việt)" },
                { key: "vieneu" as const, label: "VieNeu TTS", sub: "(Chạy cục bộ)" },
                { key: "browser" as const, label: "Trình Duyệt", sub: "(Phát Offline)" },
              ]).map((eng) => (
                <button
                  key={eng.key}
                  onClick={() => setTtsEngine(eng.key)}
                  className={`py-2 px-1 text-center rounded-lg border text-xs font-bold flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${ttsEngine === eng.key ? "bg-[#4f46e5] text-white border-[#4f46e5] shadow" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}
                >
                  <span>{eng.label}</span>
                  <span className="text-[9px] font-medium opacity-80">{eng.sub}</span>
                </button>
              ))}
            </div>

            <div className="mt-2 border-t border-slate-200/60 pt-2 text-left">
              {ttsEngine === "tiktok" && (
                <div className="flex flex-col gap-2.5 animate-fadeIn">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold text-slate-500">Giọng đọc TikTok</label>
                    <select value={tiktokVoice} onChange={(e) => setTiktokVoice(e.target.value)} className="bg-white border border-slate-200 text-xs font-bold rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-[#4f46e5] w-full">
                      <option value="BV074_streaming">BV074_streaming (Nữ hoạt ngôn, ấm áp)</option>
                      <option value="BV075_streaming">BV075_streaming (Nam tự tin, thanh niên)</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <div className="flex justify-between items-center">
                      <label className="text-[10px] font-bold text-slate-500">TikTok Session ID (Mắt xích)</label>
                      <span className="text-[9px] text-[#4f46e5] font-semibold">Tự động lưu trữ</span>
                    </div>
                    <input
                      type="text"
                      value={tiktokSessionId}
                      onChange={(e) => setTiktokSessionId(e.target.value)}
                      placeholder="Nhập sessionid cookie của tiktok.com..."
                      className="bg-white border border-slate-200 text-xs font-medium rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-[#4f46e5] w-full font-mono placeholder:text-slate-400"
                    />
                    <p className="text-[9px] text-slate-400 leading-normal">
                      Đăng nhập TikTok trên máy tính, mở DevTools (F12) → Application → Cookies → Sao chép cột <strong>sessionid</strong> rồi dán vào đây.
                    </p>
                  </div>
                </div>
              )}

              {ttsEngine === "vieneu" && (
                <div className="flex flex-col gap-2 animate-fadeIn">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold text-slate-500">Giọng đọc VieNeu</label>
                    <select value={vieneuVoice} onChange={(e) => setVieneuVoice(e.target.value)} className="bg-white border border-slate-200 text-xs font-bold rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-[#4f46e5] w-full">
                      <option value="Phạm Tuyên">Phạm Tuyên</option>
                      <option value="Minh Đức">Minh Đức</option>
                      <option value="Trúc Ly">Trúc Ly</option>
                      <option value="Quang Sơn">Quang Sơn</option>
                      <option value="Ngọc Trân">Ngọc Trân</option>
                      <option value="Ngọc Huyền · Tin tức (Fine-tune)">Ngọc Huyền · Tin tức (Fine-tune)</option>
                    </select>
                  </div>
                </div>
              )}

              {ttsEngine === "browser" && (
                <div className="flex flex-col gap-2 animate-fadeIn">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold text-slate-500">Giọng đọc Trình duyệt (Web Speech)</label>
                    <select value={ttsVoiceName} onChange={(e) => setTtsVoiceName(e.target.value)} className="bg-white border border-slate-200 text-xs font-bold rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-[#4f46e5] w-full">
                      {voices.length === 0 ? (
                        <option value="">Giọng đọc trình duyệt mặc định</option>
                      ) : (
                        voices.map((voice) => <option key={voice.name} value={voice.name}>{voice.name} ({voice.lang})</option>)
                      )}
                    </select>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Bulk Export */}
          {subtitles.length > 0 && (
            <div className="bg-[#4f46e5]/5 border border-[#4f46e5]/15 p-3 rounded-xl shadow-sm flex flex-col gap-3 shrink-0">
              <span className="text-xs font-bold text-slate-700 flex items-center gap-1">
                <Layers className="w-3.5 h-3.5 text-[#4f46e5]" />
                Xuất bản nhạc thuyết minh đồng bộ
              </span>
              {isPreGenerating ? (
                <div className="flex flex-col gap-2 p-2 bg-white rounded-lg border border-slate-100 shadow-sm">
                  <div className="flex justify-between items-center text-xs font-bold text-slate-600">
                    <span className="flex items-center gap-1.5 animate-pulse text-[#4f46e5]"><RefreshCw className="w-3.5 h-3.5 animate-spin" />Đang tạo thuyết minh: {preGenerateProgress}%</span>
                    <span className="font-mono text-[10px]">Đang tạo...</span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div className="bg-[#4f46e5] h-full rounded-full transition-all duration-300 ease-out" style={{ width: `${preGenerateProgress}%` }} />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={async () => {
                      const success = await preGenerateAllTts();
                      if (success) alert("Đã tổng hợp thành công tất cả phân đoạn thuyết minh vào bộ nhớ tạm! Bạn có thể bật video để nghe thử trực tiếp.");
                    }}
                    className="py-2 px-3 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 hover:border-[#4f46e5] rounded-lg text-xs font-bold transition-all shadow-sm flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />Tổng Hợp Thử
                  </button>
                  <button
                    onClick={downloadMergedVoiceover}
                    disabled={isMergingAudio}
                    className="py-2 px-3 bg-[#4f46e5] hover:bg-[#34533e] text-white rounded-lg text-xs font-bold transition-all shadow flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />Tải File .WAV
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Sentence-level TTS editor */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-500 font-bold uppercase flex items-center gap-1">
                <FileText className="w-3 h-3 text-slate-400" />
                Danh sách TTS theo từng câu ({subtitles.length})
              </span>
              <button
                type="button"
                onClick={() => {
                  const combined = subtitles.map(sub => sub.translated).join(" ");
                  setFullTtsText(combined);
                }}
                className="text-[10px] text-[#4f46e5] hover:text-[#34533e] font-bold flex items-center gap-1 cursor-pointer bg-slate-100 hover:bg-slate-200/80 px-2 py-0.5 rounded transition-all"
              >
                <RefreshCw className="w-2.5 h-2.5" />Khôi phục gốc
              </button>
            </div>
            {subtitles.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400 border border-dashed border-slate-200 rounded-xl bg-slate-50/40">
                Chưa có dữ liệu phụ đề dịch. Vui lòng hoàn tất dịch video trước.
              </div>
            ) : (
              <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
                {subtitles.map((subtitle, index) => {
                  const audioUrl = voiceAudioUrls[subtitle.id];
                  const regenerating = regeneratingTtsId === subtitle.id;
                  return (
                    <div key={subtitle.id} className="rounded-xl border border-slate-200 bg-slate-50/70 p-2.5 text-left">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-[10px] font-bold text-slate-500"><span className="rounded border border-slate-200 bg-white px-1.5 py-0.5">#{index + 1}</span><Clock3 className="h-3 w-3" /><span className="font-mono">{subtitle.start.toFixed(2)}s → {subtitle.end.toFixed(2)}s</span></div>
                        <span className={`flex items-center gap-1 text-[9px] font-bold ${audioUrl ? "text-emerald-600" : "text-amber-600"}`}>{audioUrl ? <CheckCircle2 className="h-3 w-3" /> : <Clock3 className="h-3 w-3" />}{audioUrl ? "Đã có voice" : "Chưa tạo"}</span>
                      </div>
                      <textarea value={subtitle.translated} onChange={(event) => onUpdateSubtitleText(subtitle.id, event.target.value)} rows={2} className="w-full resize-none rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-semibold text-slate-700 outline-none focus:border-[#4f46e5]" />
                      <div className="mt-2 flex justify-end gap-1.5">
                        <button type="button" disabled={!audioUrl} onClick={() => { if (audioUrl) void new Audio(audioUrl).play(); }} className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-600 disabled:opacity-40"><Play className="h-3 w-3" /> Nghe</button>
                        <button type="button" disabled={isPreGenerating || regenerating} onClick={() => onRegenerateTts(subtitle)} className="flex items-center gap-1 rounded-lg bg-[#4f46e5] px-2 py-1 text-[10px] font-bold text-white disabled:opacity-50"><RefreshCw className={`h-3 w-3 ${regenerating ? "animate-spin" : ""}`} /> {audioUrl ? "Tạo lại" : "Tạo voice"}</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        </div>
      </motion.div>
    </NarrationLayout>
  );
}
