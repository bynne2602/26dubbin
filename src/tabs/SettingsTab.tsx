import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { Settings, RefreshCw, Activity, Trash2, Sparkles, Layers, Plus, Cpu, HardDrive, FolderOpen } from "lucide-react";
import SettingsLayout from "../layouts/SettingsLayout";

type ApiQuotaEntry = {
  provider: "gemini" | "custom";
  label: string;
  model: string;
  status: "unused" | "available" | "limited" | "error";
  requests: number;
  successes: number;
  failures: number;
  quotaErrors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastOperation: string;
  lastUsedAt: string | null;
  lastError: string;
  quotaVisibility: string;
  rateLimit: {
    requestLimit: string | null;
    requestRemaining: string | null;
    requestReset: string | null;
    tokenLimit: string | null;
    tokenRemaining: string | null;
    tokenReset: string | null;
  };
};

type Props = {
  apiQuotaEntries: ApiQuotaEntry[];
  quotaUpdatedAt: string;
  quotaLoadError: string;
  isLoadingQuota: boolean;
  onRefreshQuota: () => void;
  removeGeminiApiKey: (index: number) => void;

  tiktokSessionId: string;
  setTiktokSessionId: (v: string) => void;

  geminiApiKey: string;
  geminiApiKeyDraft: string;
  setGeminiApiKeyDraft: (v: string) => void;
  submitGeminiApiKeys: () => void;
  parseGeminiApiKeys: (v: string) => string[];

  apiPlatform: "gemini" | "custom";
  setApiPlatform: (v: "gemini" | "custom") => void;
  extractionMethod: string;

  customApiUrl: string;
  setCustomApiUrl: (v: string) => void;
  customApiKey: string;
  setCustomApiKey: (v: string) => void;
  customModel: string;
  setCustomModel: (v: string) => void;
  sanitizeCustomApiBaseUrl: (v: string) => string;

  allowGeminiFallback: boolean;
  setAllowGeminiFallback: (v: boolean) => void;

  isTestingConnection: boolean;
  testResult: { success: boolean; msg: string } | null;
  testCustomApiConnection: () => void;

  smartTtsEnabled: boolean;
  setSmartTtsEnabled: (v: boolean) => void;

};

export default function SettingsTab({
  apiQuotaEntries, quotaUpdatedAt, quotaLoadError, isLoadingQuota, onRefreshQuota, removeGeminiApiKey,
  tiktokSessionId, setTiktokSessionId,
  geminiApiKey, geminiApiKeyDraft, setGeminiApiKeyDraft, submitGeminiApiKeys, parseGeminiApiKeys,
  apiPlatform, setApiPlatform, extractionMethod,
  customApiUrl, setCustomApiUrl, customApiKey, setCustomApiKey, customModel, setCustomModel, sanitizeCustomApiBaseUrl,
  allowGeminiFallback, setAllowGeminiFallback,
  isTestingConnection, testResult, testCustomApiConnection,
  smartTtsEnabled, setSmartTtsEnabled,
}: Props) {
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [checkingSystem, setCheckingSystem] = useState(false);
  const refreshDiagnostics = async () => {
    if (!window.electronAPI?.runSystemDiagnostics) return;
    setCheckingSystem(true);
    try { setDiagnostics(await window.electronAPI.runSystemDiagnostics()); }
    finally { setCheckingSystem(false); }
  };
  useEffect(() => { void refreshDiagnostics(); }, []);
  const formatBytes = (value = 0) => value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(1)} GB`
    : `${(value / 1024 ** 2).toFixed(1)} MB`;
  return (
    <SettingsLayout>
      <section className="min-h-[calc(100vh-73px)] bg-slate-50 px-4 py-6 sm:px-6 lg:ml-64 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mx-auto w-full max-w-6xl rounded-3xl border border-slate-200 bg-white shadow-sm"
        >
          <div className="flex flex-col p-6 sm:p-8 lg:p-10">
            {/* Header */}
            <div className="order-1 mb-7 flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-100 rounded-xl">
                  <Settings className="w-6 h-6 text-indigo-600" />
                </div>
                <div>
                  <h1 className="text-xl font-black text-slate-900">Cài đặt hệ thống</h1>
                  <p className="text-xs text-slate-500 font-medium">Quản lý API, theo dõi quota và đồng bộ thông số.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onRefreshQuota}
                disabled={isLoadingQuota}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-extrabold text-slate-600 transition-colors hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${isLoadingQuota ? "animate-spin" : ""}`} />
                Làm mới quota
              </button>
            </div>

            <section className="order-2 mb-5 rounded-2xl border border-indigo-100 bg-indigo-50/40 p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-black text-slate-800"><Cpu className="h-4 w-4 text-indigo-600" /> Chẩn đoán hệ thống</h2>
                  <p className="mt-1 text-[11px] font-medium text-slate-500">Kiểm tra runtime, bộ mã hóa, RAM và ổ đĩa trước khi chạy dự án dài.</p>
                </div>
                <button type="button" onClick={() => void refreshDiagnostics()} disabled={checkingSystem || !window.electronAPI} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white disabled:opacity-50">
                  <RefreshCw className={`h-4 w-4 ${checkingSystem ? "animate-spin" : ""}`} /> Kiểm tra lại
                </button>
              </div>
              {!window.electronAPI ? (
                <p className="mt-4 rounded-xl bg-white p-3 text-xs font-semibold text-slate-500">Chẩn đoán đầy đủ chỉ có trong ứng dụng desktop.</p>
              ) : diagnostics && (
                <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-slate-200 bg-white p-3"><div className="text-[10px] font-black uppercase text-slate-400">FFmpeg</div><div className={`mt-1 text-xs font-black ${diagnostics.ffmpeg.exists ? "text-emerald-600" : "text-rose-600"}`}>{diagnostics.ffmpeg.exists ? "Sẵn sàng" : "Thiếu runtime"}</div><div className="mt-1 truncate text-[10px] text-slate-500">{diagnostics.ffmpeg.encoder} · {formatBytes(diagnostics.ffmpeg.size)}</div></div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3"><div className="text-[10px] font-black uppercase text-slate-400">OCR Engine</div><div className={`mt-1 text-xs font-black ${diagnostics.ocr.exists ? "text-emerald-600" : "text-amber-600"}`}>{diagnostics.ocr.exists ? "Sẵn sàng" : "Chưa tìm thấy"}</div><div className="mt-1 truncate text-[10px] text-slate-500" title={diagnostics.ocr.path}>{diagnostics.ocr.path || "Không có đường dẫn"}</div></div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3"><div className="flex items-center gap-1 text-[10px] font-black uppercase text-slate-400"><HardDrive className="h-3 w-3" /> Ổ đĩa</div><div className={`mt-1 text-xs font-black ${diagnostics.disk.writable ? "text-emerald-600" : "text-rose-600"}`}>{diagnostics.disk.writable ? "Có thể ghi" : "Không thể ghi"}</div><div className="mt-1 text-[10px] text-slate-500">Còn trống {formatBytes(diagnostics.disk.free)}</div></div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3"><div className="text-[10px] font-black uppercase text-slate-400">Bộ nhớ</div><div className="mt-1 text-xs font-black text-slate-700">Trống {formatBytes(diagnostics.memory.free)}</div><div className="mt-1 text-[10px] text-slate-500">Tổng {formatBytes(diagnostics.memory.total)}</div></div>
                </div>
              )}
              {diagnostics && <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void window.electronAPI?.showItemInFolder(diagnostics.ffmpeg.path)} disabled={!diagnostics.ffmpeg.exists} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[10px] font-bold text-slate-600 disabled:opacity-40"><FolderOpen className="h-3.5 w-3.5" /> Mở thư mục FFmpeg</button><button type="button" onClick={() => void window.electronAPI?.openLog()} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[10px] font-bold text-slate-600"><Activity className="h-3.5 w-3.5" /> Mở log đầy đủ</button><button type="button" onClick={async () => { await window.electronAPI?.clearTemp(); await refreshDiagnostics(); }} className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-3 py-2 text-[10px] font-bold text-rose-600"><Trash2 className="h-3.5 w-3.5" /> Dọn file tạm DubbinTool</button></div>}
            </section>

            {/* Quota Section */}
            <section className="order-4 mb-5 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 sm:p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-black text-slate-800">
                    <Activity className="h-4 w-4 text-indigo-600" /> Quản lý API & quota
                  </h2>
                  <p className="mt-1 text-[11px] font-medium text-slate-500">
                    Tự cập nhật mỗi 5 giây · Thống kê chính xác các lượt gọi phát sinh từ app trong phiên server hiện tại.
                  </p>
                </div>
                <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[10px] font-bold text-slate-500">
                  {quotaUpdatedAt ? `Cập nhật ${new Date(quotaUpdatedAt).toLocaleTimeString("vi-VN")}` : "Chưa có dữ liệu"}
                </span>
              </div>

              {quotaLoadError && (
                <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-700">{quotaLoadError}</div>
              )}

              {apiQuotaEntries.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-xs font-semibold text-slate-400">
                  Chưa có API key được cấu hình để theo dõi.
                </div>
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {apiQuotaEntries.map((entry, entryIndex) => {
                    const statusStyle = entry.status === "available"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : entry.status === "limited"
                        ? "border-amber-200 bg-amber-50 text-amber-700"
                        : entry.status === "error"
                          ? "border-rose-200 bg-rose-50 text-rose-700"
                          : "border-slate-200 bg-slate-100 text-slate-500";
                    const statusLabel = entry.status === "available" ? "Hoạt động"
                      : entry.status === "limited" ? "Hết quota / 429"
                      : entry.status === "error" ? "Có lỗi" : "Chưa sử dụng";
                    const geminiKeyIndex = apiQuotaEntries.slice(0, entryIndex).filter((item) => item.provider === "gemini").length;
                    return (
                      <article key={`${entry.provider}-${entry.label}-${entryIndex}`} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={`h-2.5 w-2.5 rounded-full ${entry.status === "available" ? "bg-emerald-500" : entry.status === "limited" ? "bg-amber-500" : entry.status === "error" ? "bg-rose-500" : "bg-slate-300"}`} />
                              <h3 className="truncate text-sm font-black text-slate-800">{entry.label}</h3>
                            </div>
                            <p className="mt-1 truncate text-[10px] font-semibold text-slate-400">{entry.model || "Chưa xác định model"}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className={`rounded-full border px-2.5 py-1 text-[9px] font-black ${statusStyle}`}>{statusLabel}</span>
                            {entry.provider === "gemini" && (
                              <button type="button" onClick={() => removeGeminiApiKey(geminiKeyIndex)} className="rounded-lg border border-rose-100 bg-rose-50 p-1.5 text-rose-500 transition-colors hover:border-rose-300 hover:bg-rose-100" title="Xóa API key">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="mt-4 grid grid-cols-4 gap-2">
                          {[["Request", entry.requests], ["Thành công", entry.successes], ["Lỗi", entry.failures], ["Lỗi 429", entry.quotaErrors]].map(([label, value]) => (
                            <div key={String(label)} className="rounded-xl bg-slate-50 px-2 py-2 text-center">
                              <div className="text-sm font-black text-slate-800">{value}</div>
                              <div className="mt-0.5 text-[8px] font-bold uppercase text-slate-400">{label}</div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          <div className="rounded-xl border border-slate-100 px-3 py-2">
                            <div className="text-[9px] font-bold uppercase text-slate-400">Token đã dùng</div>
                            <div className="mt-1 text-xs font-black text-slate-700">{entry.totalTokens.toLocaleString("vi-VN")}</div>
                            <div className="text-[9px] text-slate-400">Vào {entry.inputTokens.toLocaleString("vi-VN")} · Ra {entry.outputTokens.toLocaleString("vi-VN")}</div>
                          </div>
                          <div className="rounded-xl border border-slate-100 px-3 py-2">
                            <div className="text-[9px] font-bold uppercase text-slate-400">Request còn lại</div>
                            <div className="mt-1 text-xs font-black text-slate-700">
                              {entry.rateLimit.requestRemaining ?? "Không được cung cấp"}
                              {entry.rateLimit.requestLimit ? ` / ${entry.rateLimit.requestLimit}` : ""}
                            </div>
                            <div className="text-[9px] text-slate-400">Reset: {entry.rateLimit.requestReset ?? "Không có dữ liệu"}</div>
                          </div>
                        </div>
                        <p className="mt-3 rounded-lg bg-indigo-50/70 px-3 py-2 text-[9px] font-medium leading-relaxed text-indigo-700">{entry.quotaVisibility}</p>
                        {entry.lastError && <p className="mt-2 line-clamp-2 text-[9px] font-semibold text-rose-600">Lỗi gần nhất: {entry.lastError}</p>}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            <div className="contents">
              {/* TikTok Session ID */}
              <div className="order-2 mb-5 flex flex-col gap-1.5">
                <label className="text-xs font-bold text-slate-700 flex items-center justify-between">
                  <span>TikTok Session ID</span>
                  <span className="text-[10px] text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">Lưu trình duyệt</span>
                </label>
                <input
                  type="text"
                  placeholder="sessionid_xxxxxxxxxxxxxxxxxxxxxxxx"
                  value={tiktokSessionId}
                  onChange={(e) => setTiktokSessionId(e.target.value)}
                  className="bg-white border border-slate-200 px-3.5 py-2.5 rounded-xl text-sm focus:outline-none focus:border-indigo-500 text-slate-800 w-full font-mono"
                />
                <p className="text-[11px] text-slate-400 leading-relaxed font-medium">
                  Bắt buộc để sử dụng giọng đọc Tiếng Việt cực mượt của TikTok. Lấy cookie <code className="bg-slate-100 px-1 py-0.5 rounded text-rose-500 font-mono">sessionid</code> từ TikTok Web.
                </p>
              </div>

              {/* Gemini API Key pool */}
              <div className="order-3 mb-5 flex flex-col gap-1.5">
                <label className="text-xs font-bold text-slate-700 flex items-center justify-between">
                  <span>Thêm Google Gemini API Key</span>
                  <span className="text-[10px] text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                    Đang quản lý {parseGeminiApiKeys(geminiApiKey).length} key
                  </span>
                </label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="password"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="Dán một hoặc nhiều API key rồi nhấn Enter"
                    value={geminiApiKeyDraft}
                    onChange={(e) => setGeminiApiKeyDraft(e.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        submitGeminiApiKeys();
                      }
                    }}
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 font-mono text-sm text-slate-800 focus:border-indigo-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={submitGeminiApiKeys}
                    disabled={parseGeminiApiKeys(geminiApiKeyDraft).length === 0}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-black text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus className="h-4 w-4" /> Thêm API
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed font-medium">
                  Nhấn Enter hoặc nút Thêm API. Key sẽ chuyển xuống khu quản lý bên dưới và ô nhập tự xóa trắng.
                </p>
              </div>

              {/* API Platform Selection */}
              <div className="order-5 mb-5 flex flex-col gap-2">
                <label className="text-xs font-extrabold text-slate-700 flex items-center justify-between">
                  <span>Nguồn dịch thuật (API Translation Platform)</span>
                  <span className="text-[10px] text-[#4f46e5] bg-indigo-50 px-2 py-0.5 rounded font-black">LỰA CHỌN</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { key: "gemini" as const, label: "Google Gemini", desc: "Dịch bằng Gemini 3.5. Ổn định, mượt mà và miễn phí mặc định.", Icon: Sparkles },
                    { key: "custom" as const, label: "Custom API", desc: "Cắm key platform.beeknoee.com hoặc OpenAI tương thích.", Icon: Layers },
                  ]).map(({ key, label, desc, Icon }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setApiPlatform(key)}
                      className={`p-3 rounded-2xl border text-left transition-all flex flex-col gap-1 cursor-pointer ${apiPlatform === key ? "border-[#4f46e5] bg-indigo-50/40 shadow-sm ring-1 ring-[#4f46e5]/10" : "border-slate-200 hover:border-slate-300 bg-white"}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black text-slate-800">{label}</span>
                        <Icon className={`w-3.5 h-3.5 ${apiPlatform === key ? (key === "gemini" ? "text-amber-500 animate-pulse" : "text-[#4f46e5]") : "text-slate-400"}`} />
                      </div>
                      <span className="text-[9px] text-slate-400 font-bold leading-tight">{desc}</span>
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap gap-2">
                  {apiPlatform === "custom" ? (
                    <span className="inline-flex items-center gap-2 rounded-full bg-[#eef2ff] border border-[#c7d2fe] px-3 py-1 text-[10px] font-semibold text-[#4338ca]"><Layers className="w-3.5 h-3.5" />Custom API đang dùng</span>
                  ) : (
                    <span className="inline-flex items-center gap-2 rounded-full bg-[#eff6ff] border border-[#bfdbfe] px-3 py-1 text-[10px] font-semibold text-[#1d4ed8]"><Sparkles className="w-3.5 h-3.5" />Gemini đang dùng</span>
                  )}
                  {apiPlatform === "custom" && (
                    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[10px] font-semibold border ${allowGeminiFallback ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-slate-100 border-slate-300 text-slate-600"}`}>
                      {allowGeminiFallback ? "Gemini fallback đang bật" : "Gemini fallback đang tắt"}
                    </span>
                  )}
                </div>

                {extractionMethod === "aiocr" && apiPlatform === "custom" && (
                  <div className="rounded-2xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                    AI OCR mode sends raw video to the third-party API. This works only if your custom AI provider supports base64 video ingestion via chat endpoints.
                  </div>
                )}
              </div>

              {/* Custom API Config */}
              <div className={`order-6 mb-5 p-4 rounded-2xl border transition-all flex flex-col gap-3 ${apiPlatform === "custom" ? "bg-slate-50 border-slate-300/80" : "bg-slate-50/30 border-slate-200/50 opacity-60"}`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-extrabold text-[#4f46e5] uppercase tracking-wider">Cấu hình Custom API (Beeknoee)</span>
                  {apiPlatform !== "custom" && <span className="text-[8px] text-slate-400 font-bold bg-slate-100 px-1.5 py-0.5 rounded">TẮT</span>}
                </div>
                {[
                  { label: "Custom API Base URL", type: "text", placeholder: "https://platform.beeknoee.com/v1", value: customApiUrl, onChange: (v: string) => setCustomApiUrl(v), onBlur: () => setCustomApiUrl(sanitizeCustomApiBaseUrl(customApiUrl)) },
                  { label: "Custom API Key", type: "password", placeholder: "sk-...", value: customApiKey, onChange: (v: string) => setCustomApiKey(v) },
                  { label: "Model Name", type: "text", placeholder: "gpt-4o-mini", value: customModel, onChange: (v: string) => setCustomModel(v) },
                ].map(({ label, type, placeholder, value, onChange, onBlur }) => (
                  <div key={label} className="flex flex-col gap-1">
                    <label className="text-[11px] font-bold text-slate-600">{label}</label>
                    <input
                      type={type}
                      placeholder={placeholder}
                      disabled={apiPlatform !== "custom"}
                      value={value}
                      onChange={(e) => onChange(e.target.value)}
                      onBlur={onBlur}
                      className="bg-white border border-slate-200 px-3 py-1.5 rounded-lg text-xs focus:outline-none focus:border-indigo-500 text-slate-800 w-full font-mono disabled:opacity-60"
                    />
                  </div>
                ))}
                <p className="text-[10px] text-slate-400 leading-relaxed font-medium">
                  Chỉ cần nhập URL gốc hoặc endpoint đầy đủ; hệ thống tự bỏ tiền tố POST và tự ghép /chat/completions.
                </p>

                {apiPlatform === "custom" && (
                  <div className="pt-1 flex flex-col gap-2">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-[10px] text-slate-700">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-bold text-[11px] text-slate-800">Dự phòng Gemini</div>
                          <div className="text-[10px] text-slate-500">Nếu Custom API thất bại, sẽ thử lại bằng Gemini.</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setAllowGeminiFallback(!allowGeminiFallback)}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${allowGeminiFallback ? "bg-indigo-600" : "bg-slate-300"}`}
                        >
                          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${allowGeminiFallback ? "translate-x-6" : "translate-x-1"}`} />
                        </button>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={testCustomApiConnection}
                      disabled={isTestingConnection || !customApiUrl || !customApiKey}
                      className="w-full py-1.5 px-3 bg-white border border-slate-200 hover:border-[#4f46e5] hover:text-[#4f46e5] text-slate-700 rounded-lg text-[10px] font-extrabold transition-all flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      {isTestingConnection ? (
                        <><RefreshCw className="w-3.5 h-3.5 animate-spin text-[#4f46e5]" />Đang kiểm tra kết nối...</>
                      ) : (
                        <><Activity className="w-3.5 h-3.5" />Kiểm tra kết nối API</>
                      )}
                    </button>
                    {testResult && (
                      <div className={`p-2 rounded-lg text-[10px] leading-relaxed font-semibold border ${testResult.success ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-rose-50 border-rose-200 text-rose-700"}`}>
                        {testResult.success ? "🟢 " : "🔴 "}{testResult.msg}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Smart TTS Switch */}
              <div className="order-7 bg-slate-50 p-4 rounded-2xl border border-slate-200 flex items-center justify-between gap-4">
                <div className="flex flex-col gap-0.5 text-left">
                  <span className="text-xs font-bold text-slate-700">Tự động tăng tốc độ thuyết minh (Smart TTS)</span>
                  <span className="text-[11px] text-slate-400 font-medium leading-relaxed">
                    Tự động điều chỉnh tốc độ đọc (playbackRate) của giọng AI để vừa khít với thời lượng của phân đoạn phụ đề.
                  </span>
                </div>
                <button
                  onClick={() => setSmartTtsEnabled(!smartTtsEnabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none shrink-0 ${smartTtsEnabled ? "bg-indigo-600" : "bg-slate-300"}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${smartTtsEnabled ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </div>
            </div>

            <div className="order-8 mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-center text-xs font-bold text-emerald-700">
              Cấu hình được tự động lưu trên trình duyệt này.
            </div>
          </div>
        </motion.div>
      </section>
    </SettingsLayout>
  );
}
