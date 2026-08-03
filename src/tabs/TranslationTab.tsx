import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { FileText, Sparkles, Plus, Download, Edit3, Trash2, Check, RefreshCw, Replace, AlertCircle, LocateFixed } from "lucide-react";
import TranslationLayout from "../layouts/TranslationLayout";
import TranslationConfigPanel from "../components/TranslationConfigPanel";
import type { Subtitle } from "../types";
import { isSubtitleTranslationMissing } from "../lib/subtitle";

type Props = {
  subtitles: Subtitle[];
  filteredSubtitles: Subtitle[];
  currentTime: number;
  duration: number;
  translationGlossary: string;
  setTranslationGlossary: (value: string) => void;
  translationStyle: string;
  setTranslationStyle: (value: string) => void;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  editingSubId: string | null;
  setEditingSubId: (id: string | null) => void;
  editStart: number;
  setEditStart: (v: number) => void;
  editEnd: number;
  setEditEnd: (v: number) => void;
  editOriginal: string;
  setEditOriginal: (v: string) => void;
  editTranslated: string;
  setEditTranslated: (v: string) => void;
  setSubtitles: React.Dispatch<React.SetStateAction<Subtitle[]>>;
  onTranslate: () => void;
  onRetryTranslation: () => void;
  onRetranslateOne: (id: string) => void;
  isTranslating: boolean;
  onAddSub: () => void;
  onSaveEdit: (id: string) => void;
  onDeleteSub: (id: string) => void;
  onSeekTo: (t: number) => void;
  onStartEdit: (sub: Subtitle) => void;
  exportSRT: () => void;
  exportVTT: () => void;
  exportJSON: () => void;
  formatSecondsToVTT: (s: number) => string;
};

export default function TranslationTab({
  subtitles,
  filteredSubtitles,
  currentTime,
  duration,
  translationGlossary,
  setTranslationGlossary,
  translationStyle,
  setTranslationStyle,
  searchQuery,
  setSearchQuery,
  editingSubId,
  setEditingSubId,
  editStart,
  setEditStart,
  editEnd,
  setEditEnd,
  editOriginal,
  setEditOriginal,
  editTranslated,
  setEditTranslated,
  setSubtitles,
  onTranslate,
  onRetryTranslation,
  onRetranslateOne,
  isTranslating,
  onAddSub,
  onSaveEdit,
  onDeleteSub,
  onSeekTo,
  onStartEdit,
  exportSRT,
  exportVTT,
  exportJSON,
  formatSecondsToVTT,
}: Props) {
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [replaceScope, setReplaceScope] = useState<"translated" | "original" | "both">("translated");
  const [showTranslationIssues, setShowTranslationIssues] = useState(false);
  const retryTranslationCount = useMemo(
    () => subtitles.filter(isSubtitleTranslationMissing).length,
    [subtitles],
  );
  const translationIssues = useMemo(
    () => subtitles
      .map((subtitle, index) => ({ subtitle, lineNumber: index + 1 }))
      .filter(({ subtitle }) => isSubtitleTranslationMissing(subtitle)),
    [subtitles],
  );

  const focusTranslationIssue = (subtitle: Subtitle) => {
    onSeekTo(subtitle.start);
    window.requestAnimationFrame(() => {
      document.getElementById(`sub-item-${subtitle.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const replaceMatchCount = useMemo(() => {
    if (!findText) return 0;
    const needle = findText.toLocaleLowerCase();
    return subtitles.reduce((count, subtitle) => {
      const fields = replaceScope === "both" ? [subtitle.original, subtitle.translated] : [subtitle[replaceScope]];
      return count + fields.reduce((fieldCount, value) => {
        let matches = 0;
        let from = 0;
        const haystack = String(value || "").toLocaleLowerCase();
        while ((from = haystack.indexOf(needle, from)) >= 0) {
          matches += 1;
          from += Math.max(1, needle.length);
        }
        return fieldCount + matches;
      }, 0);
    }, 0);
  }, [findText, replaceScope, subtitles]);

  const timelineSubtitles = useMemo(() => {
    const maxTimelineClips = 600;
    if (subtitles.length <= maxTimelineClips) return subtitles;
    const groupSize = Math.ceil(subtitles.length / maxTimelineClips);
    const grouped: Subtitle[] = [];
    for (let index = 0; index < subtitles.length; index += groupSize) {
      const group = subtitles.slice(index, index + groupSize);
      const first = group[0];
      const last = group[group.length - 1];
      grouped.push({
        ...first,
        id: `timeline-${first.id}-${last.id}`,
        end: last.end,
        translated: `${group.length} đoạn phụ đề`,
      });
    }
    return grouped;
  }, [subtitles]);

  const replaceAll = () => {
    if (!findText || replaceMatchCount === 0) return;
    const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "gi");
    setSubtitles((previous) => previous.map((subtitle) => ({
      ...subtitle,
      original: replaceScope === "translated" ? subtitle.original : subtitle.original.replace(pattern, replaceText),
      translated: replaceScope === "original" ? subtitle.translated : subtitle.translated.replace(pattern, replaceText),
    })));
  };

  return (
    <TranslationLayout>
      <motion.div
        key="tracks"
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -15 }}
        transition={{ duration: 0.2, ease: "easeInOut" }}
        className="flex h-[calc(100vh-138px)] min-h-[560px] max-h-[820px] flex-col gap-3 overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-4 text-left shadow-md transition-[border-color,box-shadow] duration-300 hover:border-slate-300/80 hover:shadow-lg"
      >
        {/* Header */}
        <div className="flex flex-col gap-1 shrink-0">
          <div className="flex flex-col gap-3">
            <h3 className="font-bold text-slate-800 flex items-center gap-2 text-base">
              <FileText className="w-4.5 h-4.5 text-[#4f46e5]" />
              Quản Lý Bản Dịch Video
            </h3>
            <div className="grid w-full grid-cols-2 gap-2">
              {subtitles.length > 0 && (
                <button
                  onClick={() => setReplaceOpen((open) => !open)}
                  className="flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-amber-500/20 bg-amber-500/10 px-2 py-2 text-[10px] font-bold text-amber-600 shadow-sm transition-all hover:bg-amber-500 hover:text-white"
                >
                  <Replace className="w-3 h-3" />
                  Tìm & thay
                </button>
              )}
              {subtitles.length > 0 && (
                <button
                  onClick={onTranslate}
                  disabled={isTranslating}
                  className="flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-2 py-2 text-[10px] font-bold text-indigo-500 shadow-sm transition-all hover:bg-indigo-500 hover:text-white"
                >
                  <Sparkles className={`w-3 h-3 ${isTranslating ? "animate-pulse" : ""}`} />
                  {isTranslating ? "Đang dịch..." : "Dịch tất cả"}
                </button>
              )}
              {subtitles.length > 0 && (
                <button
                  onClick={() => {
                    if (retryTranslationCount === 1) focusTranslationIssue(translationIssues[0].subtitle);
                    else setShowTranslationIssues((open) => !open);
                  }}
                  disabled={isTranslating || retryTranslationCount === 0}
                  title="Xem các dòng chưa dịch hoặc còn giữ nguyên văn, sau đó dịch lại riêng hoặc hàng loạt"
                  className="flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-rose-500/20 bg-rose-500/10 px-2 py-2 text-[10px] font-bold text-rose-600 shadow-sm transition-all hover:bg-rose-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RefreshCw className={`h-3 w-3 ${isTranslating ? "animate-spin" : ""}`} />
                  {retryTranslationCount === 1 ? "Xem dòng cần dịch lại (1)" : `Xem ${retryTranslationCount} dòng cần dịch lại`}
                </button>
              )}
              {subtitles.length > 0 && (
                <button
                  onClick={onAddSub}
                  className="flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#4f46e5]/20 bg-[#4f46e5]/10 px-2 py-2 text-[10px] font-bold text-[#4f46e5] shadow-sm transition-all hover:bg-[#4f46e5] hover:text-white"
                >
                  <Plus className="w-3 h-3" />
                  Thêm đoạn
                </button>
              )}
            </div>
          </div>
          <p className="text-[11px] text-slate-500 font-medium">
            Nhấp vào dòng bất kỳ để chuyển video đến đoạn đó. Bạn có thể <strong className="text-[#4f46e5]">chỉnh sửa trực tiếp bản dịch nhanh</strong> trong ô chữ phía dưới, hoặc nhấn bút chì để tùy chỉnh thời gian.
          </p>
        </div>

        {retryTranslationCount > 0 && showTranslationIssues && (
          <div className="shrink-0 rounded-xl border border-rose-200 bg-rose-50 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="flex items-center gap-1.5 text-xs font-bold text-rose-700"><AlertCircle className="h-3.5 w-3.5" />{retryTranslationCount} dòng chưa dịch hoặc còn giữ nguyên văn</p>
              <button onClick={onRetryTranslation} disabled={isTranslating} className="rounded-lg bg-rose-600 px-2.5 py-1.5 text-[10px] font-bold text-white hover:bg-rose-700 disabled:opacity-40">Dịch lại tất cả</button>
            </div>
            <div className="max-h-32 space-y-1.5 overflow-y-auto pr-1">
              {translationIssues.map(({ subtitle, lineNumber }) => (
                <button key={subtitle.id} onClick={() => focusTranslationIssue(subtitle)} className="flex w-full items-center gap-2 rounded-lg border border-rose-100 bg-white px-2.5 py-2 text-left transition hover:border-rose-300 hover:bg-rose-50">
                  <span className="shrink-0 rounded bg-rose-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-rose-700">Dòng {lineNumber}</span>
                  <span className="shrink-0 font-mono text-[10px] text-slate-500">{formatSecondsToVTT(subtitle.start).substring(3, 11)}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-700">{subtitle.original || "(không có nội dung gốc)"}</span>
                  <LocateFixed className="h-3.5 w-3.5 shrink-0 text-rose-500" />
                </button>
              ))}
            </div>
          </div>
        )}

        <TranslationConfigPanel compact glossary={translationGlossary} setGlossary={setTranslationGlossary} style={translationStyle} setStyle={setTranslationStyle} />

        {/* Export Bar */}
        {subtitles.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 p-2 bg-slate-50 rounded-xl border border-slate-200/60 shrink-0 shadow-sm">
            <span className="text-[10px] text-slate-500 font-bold uppercase mr-1 pl-1">Xuất file:</span>
            <button onClick={exportSRT} className="flex-1 py-1 px-2 bg-white border border-slate-200 hover:border-[#4f46e5] text-slate-700 hover:text-[#4f46e5] text-[11px] font-bold rounded-md transition-all flex items-center justify-center gap-1 shadow-sm">
              <Download className="w-3 h-3" />SRT (Chuẩn)
            </button>
            <button onClick={exportVTT} className="flex-1 py-1 px-2 bg-white border border-slate-200 hover:border-[#4f46e5] text-slate-700 hover:text-[#4f46e5] text-[11px] font-bold rounded-md transition-all flex items-center justify-center gap-1 shadow-sm">
              <Download className="w-3 h-3" />VTT (Web)
            </button>
            <button onClick={exportJSON} className="flex-1 py-1 px-2 bg-white border border-slate-200 hover:border-[#4f46e5] text-slate-700 hover:text-[#4f46e5] text-[11px] font-bold rounded-md transition-all flex items-center justify-center gap-1 shadow-sm">
              <Download className="w-3 h-3" />JSON
            </button>
          </div>
        )}

        {/* Subtitle timeline */}
        {subtitles.length > 0 && duration > 0 && (
          <div className="shrink-0 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
            <div className="mb-2 flex items-center justify-between font-mono text-[10px] font-bold text-slate-500">
              <span>{formatSecondsToVTT(currentTime).substring(3, 11)}</span>
              <span>{formatSecondsToVTT(duration).substring(3, 11)}</span>
            </div>
            <div className="relative mb-2 h-7 overflow-hidden rounded-lg bg-slate-200" onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onSeekTo(Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration)));
            }}>
              {timelineSubtitles.map((subtitle) => (
                <button
                  key={subtitle.id}
                  title={`${formatSecondsToVTT(subtitle.start).substring(3, 11)} · ${subtitle.translated || subtitle.original}`}
                  onClick={(event) => { event.stopPropagation(); onSeekTo(subtitle.start); }}
                  className={`absolute top-1 h-5 min-w-px rounded-sm ${currentTime >= subtitle.start && currentTime <= subtitle.end ? "bg-indigo-600" : "bg-sky-400 hover:bg-sky-500"}`}
                  style={{ left: `${(subtitle.start / duration) * 100}%`, width: `${Math.max(0.12, ((subtitle.end - subtitle.start) / duration) * 100)}%` }}
                />
              ))}
              <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-rose-500" style={{ left: `${(currentTime / duration) * 100}%` }} />
            </div>
            <input type="range" min={0} max={duration} step={0.01} value={Math.min(currentTime, duration)} onChange={(event) => onSeekTo(Number(event.target.value))} className="h-1.5 w-full cursor-pointer accent-indigo-600" />
          </div>
        )}

        {/* Find and replace */}
        {replaceOpen && subtitles.length > 0 && (
          <div className="shrink-0 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_140px_auto]">
              <input value={findText} onChange={(event) => setFindText(event.target.value)} placeholder="Tìm từ hoặc cụm từ..." className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-amber-500" />
              <input value={replaceText} onChange={(event) => setReplaceText(event.target.value)} placeholder="Thay bằng..." className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-amber-500" />
              <select value={replaceScope} onChange={(event) => setReplaceScope(event.target.value as typeof replaceScope)} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs font-semibold outline-none focus:border-amber-500">
                <option value="translated">Bản dịch</option>
                <option value="original">Bản gốc</option>
                <option value="both">Cả hai</option>
              </select>
              <button onClick={replaceAll} disabled={!findText || replaceMatchCount === 0} className="rounded-lg bg-amber-500 px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">
                Thay tất cả ({replaceMatchCount})
              </button>
            </div>
            <p className="mt-1.5 text-[10px] font-medium text-slate-500">Không phân biệt chữ hoa/thường · thay đổi được tự động lưu vào checkpoint dự án.</p>
          </div>
        )}

        {/* Search */}
        {subtitles.length > 0 && (
          <div className="relative shrink-0">
            <input
              type="text"
              placeholder="Tìm kiếm từ khóa trong phụ đề gốc/dịch..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-white border border-slate-200 pl-3 pr-8 py-2 text-xs rounded-xl text-slate-800 placeholder-slate-400 focus:outline-none focus:border-[#4f46e5] w-full font-medium"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs font-bold">×</button>
            )}
          </div>
        )}

        {/* Subtitle List */}
        <div className="flex-1 overflow-y-auto space-y-3 pr-1" id="subtitles-list">
          {subtitles.length === 0 ? (
            <div className="py-12 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50/50 px-4">
              <FileText className="w-8 h-8 text-slate-400 mx-auto mb-2.5" />
              <p className="text-sm font-bold text-slate-700">Chưa Có Phụ Đề Nào</p>
              <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto font-medium">Hãy bấm dịch video ở Tab "Dịch Thuật AI" để tạo bản dịch ngay lập tức!</p>
            </div>
          ) : filteredSubtitles.length === 0 ? (
            <p className="text-xs text-slate-500 py-6 text-center font-medium">Không tìm thấy phân đoạn phù hợp với từ khóa.</p>
          ) : (
            filteredSubtitles.map((sub) => {
              const isEditing = editingSubId === sub.id;
              const isActive = currentTime >= sub.start && currentTime <= sub.end;
              return (
                <div
                  key={sub.id}
                  style={{ contentVisibility: "auto", containIntrinsicSize: "160px" }}
                  className={`p-3.5 rounded-xl border text-left transition-all relative shadow-sm ${isActive ? "bg-[#4f46e5]/10 border-[#4f46e5]/30" : "bg-white border-slate-200 hover:border-slate-300"}`}
                  id={`sub-item-${sub.id}`}
                >
                  {isEditing ? (
                    <div className="flex flex-col gap-3">
                      <div className="grid grid-cols-2 gap-2 shrink-0">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase">Bắt đầu (Giây)</label>
                          <input type="number" step="0.1" value={editStart} onChange={(e) => setEditStart(parseFloat(e.target.value) || 0)} className="bg-white border border-slate-200 px-2 py-1 text-xs rounded text-slate-800 focus:outline-none focus:border-[#4f46e5] font-mono font-bold" />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase">Kết thúc (Giây)</label>
                          <input type="number" step="0.1" value={editEnd} onChange={(e) => setEditEnd(parseFloat(e.target.value) || 0)} className="bg-white border border-slate-200 px-2 py-1 text-xs rounded text-slate-800 focus:outline-none focus:border-[#4f46e5] font-mono font-bold" />
                        </div>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Chữ Gốc (Original Text)</label>
                        <textarea value={editOriginal} onChange={(e) => setEditOriginal(e.target.value)} className="bg-white border border-slate-200 p-2 text-xs rounded text-slate-800 h-14 resize-none focus:outline-none focus:border-[#4f46e5] font-medium" />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Chữ Đã Dịch (Translated Text)</label>
                        <textarea value={editTranslated} onChange={(e) => setEditTranslated(e.target.value)} className="bg-[#4f46e5]/5 border border-[#4f46e5]/20 p-2 text-xs rounded text-[#4f46e5] h-14 resize-none font-bold focus:outline-none focus:border-[#4f46e5]" />
                      </div>
                      <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-100">
                        <button onClick={() => setEditingSubId(null)} className="px-2 py-1 text-[11px] text-slate-500 hover:text-slate-800 font-bold transition-all">Hủy bỏ</button>
                        <button onClick={() => onSaveEdit(sub.id)} className="px-3 py-1 bg-gradient-to-r from-[#4f46e5] to-[#6366f1] text-white text-[11px] font-bold rounded-md shadow hover:opacity-95 transition-all flex items-center gap-1">
                          <Check className="w-3 h-3" />Lưu lại
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="cursor-pointer" onClick={() => onSeekTo(sub.start)}>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="text-[10px] font-mono font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded border border-slate-200">
                          {formatSecondsToVTT(sub.start).substring(3, 11)} ➔ {formatSecondsToVTT(sub.end).substring(3, 11)}
                        </span>
                        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <button disabled={isTranslating} onClick={() => onRetranslateOne(sub.id)} className="p-1 hover:bg-indigo-50 text-slate-400 hover:text-[#4f46e5] rounded transition-all disabled:opacity-40" title="Dịch lại riêng dòng này"><RefreshCw className={`w-3 h-3 ${isTranslating ? "animate-spin" : ""}`} /></button>
                          <button onClick={() => onStartEdit(sub)} className="p-1 hover:bg-slate-100 text-slate-400 hover:text-[#4f46e5] rounded transition-all" title="Chỉnh sửa phân đoạn"><Edit3 className="w-3 h-3" /></button>
                          <button onClick={() => onDeleteSub(sub.id)} className="p-1 hover:bg-red-50 text-slate-400 hover:text-red-500 rounded transition-all" title="Xóa phân đoạn"><Trash2 className="w-3 h-3" /></button>
                        </div>
                      </div>
                      <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed mb-1.5 italic font-medium">{sub.original}</p>
                      <div className="relative group/inline mt-1" onClick={(e) => e.stopPropagation()}>
                        <textarea
                          value={sub.translated}
                          onChange={(e) => {
                            const newVal = e.target.value;
                            setSubtitles(prev => prev.map(s => s.id === sub.id ? { ...s, translated: newVal } : s));
                          }}
                          rows={Math.max(1, Math.ceil(sub.translated.length / 42))}
                          className="w-full text-xs text-slate-800 font-bold leading-relaxed bg-slate-50/50 hover:bg-slate-100/60 focus:bg-white border border-slate-200/50 focus:border-[#4f46e5] rounded-xl px-3 py-2 focus:outline-none transition-all resize-none min-h-[38px] shadow-sm font-sans"
                          placeholder="Nhập bản dịch tại đây..."
                        />
                        <div className="absolute right-2.5 bottom-2 opacity-0 group-hover/inline:opacity-100 focus-within:!opacity-0 transition-opacity pointer-events-none flex items-center gap-1 text-[9px] text-slate-400 font-bold">
                          <Edit3 className="w-3 h-3 text-[#4f46e5]/70" />
                          <span className="text-[#4f46e5]/70">Sửa nhanh</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </motion.div>
    </TranslationLayout>
  );
}
