import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Clipboard, Download, Film, Link2, LoaderCircle, Music2, Play, RotateCcw, Settings2, Sparkles, Square, WandSparkles } from "lucide-react";
import { BEEKNOEE_GOOGLE_VOICES, DEFAULT_AI_SHORTS_VOICE, encodeBeeknoeeVoice } from "../lib/beeknoeeTts";
import { projectDbPut, type StoredAiShortsProject } from "../lib/projectDb";

export type ScriptShortsResult = {
  source?: { platform?: string; title?: string; durationSeconds?: number };
  summary?: string;
  script: {
    hook: string;
    body: string;
    ending: string;
    fullText: string;
    estimatedDurationSeconds: number;
  };
  metadata?: {
    title?: string;
    description?: string;
    hashtags?: string[];
    thumbnailTitle?: string;
    thumbnailPrompt?: string;
    keywords?: string[];
  };
};

type Props = {
  geminiApiKey: string;
  tiktokSessionId?: string;
  onActivity?: (message: string) => void;
};

const STAGES = ["Đang nhận diện video...", "AI đang phân tích video...", "Đang xây dựng mạch nội dung...", "Đang viết kịch bản Shorts..."];

export default function AiScriptShortsTab({ geminiApiKey, tiktokSessionId = "", onActivity }: Props) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScriptShortsResult | null>(null);
  const [renderedVideo, setRenderedVideo] = useState<{ downloadUrl: string; durationSeconds: number; voiceDurationSeconds?: number; musicVolume?: number; voice?: string; music?: { title?: string; artist?: string; license?: string; licenseUrl?: string } } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showConfig, setShowConfig] = useState(true);
  const [musicVolume, setMusicVolume] = useState(0.12);
  const [musicStyle, setMusicStyle] = useState("funny");
  const [voiceRate, setVoiceRate] = useState(1.13);
  const [voicePitch, setVoicePitch] = useState(3);
  const [titleOverlay, setTitleOverlay] = useState(true);
  const [voice, setVoice] = useState(() => encodeBeeknoeeVoice(DEFAULT_AI_SHORTS_VOICE));
  const [previewingVoice, setPreviewingVoice] = useState(false);
  const activeRequestRef = useRef<AbortController | null>(null);
  const voicePreviewRef = useRef<HTMLAudioElement | null>(null);
  const canGenerate = useMemo(() => /^https?:\/\//i.test(url.trim()) && !busy, [url, busy]);

  useEffect(() => () => {
    activeRequestRef.current?.abort();
    if (voicePreviewRef.current) {
      voicePreviewRef.current.pause();
      URL.revokeObjectURL(voicePreviewRef.current.src);
    }
  }, []);

  const getTtsCredentials = async () => {
    const licenseKey = localStorage.getItem("license_key") || "";
    const hwidResponse = await fetch("/api/license/hwid");
    const hwidPayload = await hwidResponse.json().catch(() => ({}));
    const hwid = String(hwidPayload?.hwid || "");
    if (!licenseKey || !hwid) throw new Error("Vui lòng kích hoạt license DubbinTool trước khi dùng Google TTS.");
    return { licenseKey, hwid, tiktokSessionId: tiktokSessionId.trim() || localStorage.getItem("tiktok_session_id") || "" };
  };

  const previewVoice = async () => {
    if (voicePreviewRef.current && !voicePreviewRef.current.paused) {
      voicePreviewRef.current.pause();
      setPreviewingVoice(false);
      return;
    }
    setPreviewingVoice(true);
    setError("");
    try {
      const credentials = await getTtsCredentials();
      const response = await fetch("/api/beeknoee-tts/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice, text: "Xin chào, đây là giọng đọc mẫu dành cho video ngắn của DubbinTool.", ...credentials }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Không thể nghe thử giọng (HTTP ${response.status}).`);
      }
      const blob = await response.blob();
      if (voicePreviewRef.current) URL.revokeObjectURL(voicePreviewRef.current.src);
      const audio = new Audio(URL.createObjectURL(blob));
      voicePreviewRef.current = audio;
      audio.onended = () => setPreviewingVoice(false);
      audio.onerror = () => setPreviewingVoice(false);
      await audio.play();
    } catch (cause: any) {
      setPreviewingVoice(false);
      setError(cause?.message || "Không thể nghe thử giọng đọc.");
    }
  };

  const generate = async () => {
    if (!canGenerate) return;
    setBusy(true); setError(""); setResult(null); setRenderedVideo(null); setProgress(3); setMessage(STAGES[0]);
    const controller = new AbortController();
    activeRequestRef.current?.abort();
    activeRequestRef.current = controller;
    onActivity?.("AI Script Shorts: bắt đầu phân tích URL video.");
    try {
      const credentials = await getTtsCredentials();
      const keys = geminiApiKey.split(/[\r\n,;]+/).map((item) => item.trim()).filter(Boolean);
      const response = await fetch("/api/ai-script-shorts", {
        signal: controller.signal,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(keys.length ? { "x-gemini-api-keys": JSON.stringify(keys) } : {}),
        },
        body: JSON.stringify({
          url: url.trim(),
          voice,
          musicVolume,
          musicStyle,
          voiceRate,
          voicePitch,
          titleOverlay,
          aspectRatio: "9:16",
          ...credentials,
        }),
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Không thể phân tích video (HTTP ${response.status}).`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let generatedResult: ScriptShortsResult | null = null;
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n"); buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "progress") { setProgress(event.percent); setMessage(event.message); }
          if (event.type === "result") { generatedResult = event.result; setResult(event.result); setProgress(event.percent || 88); setMessage("Đã viết xong script, đang dựng video..."); }
          if (event.type === "video") {
            setRenderedVideo(event);
            setProgress(100);
            setMessage("Video Shorts đã render xong · đang lưu vào Thư viện...");
            const videoResponse = await fetch(event.downloadUrl);
            if (!videoResponse.ok) throw new Error("Video render xong nhưng không thể lưu vào Thư viện.");
            const videoBlob = await videoResponse.blob();
            const stored: StoredAiShortsProject = {
              id: `ai-shorts:${crypto.randomUUID()}`,
              updatedAt: Date.now(),
              title: generatedResult?.metadata?.title || "AI Script Shorts",
              sourceUrl: url.trim(),
              script: generatedResult?.script?.fullText || "",
              metadata: generatedResult?.metadata as Record<string, unknown> | undefined,
              videoBlob,
              durationSeconds: Number(event.durationSeconds || 0),
              voice: String(event.voice || ""),
              musicTitle: String(event.music?.title || ""),
            };
            await projectDbPut("aiShorts", stored);
            window.dispatchEvent(new CustomEvent("dubbin:ai-shorts-saved"));
            setMessage("Video Shorts đã render xong và lưu vào Thư viện");
          }
          if (event.type === "error") throw new Error(event.error);
        }
        if (done) break;
      }
      onActivity?.("AI Script Shorts: đã tạo xong video tối đa 90 giây.");
    } catch (cause: any) {
      if (controller.signal.aborted) {
        setMessage("Đã hủy tác vụ. Các tiến trình tải và render nền đã dừng.");
        onActivity?.("AI Script Shorts: đã hủy tác vụ.");
        return;
      }
      setError(cause?.message || "Không thể tạo kịch bản.");
      onActivity?.(`AI Script Shorts lỗi: ${cause?.message || "không xác định"}`);
    } finally {
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
      setBusy(false);
    }
  };

  const copyScript = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.script.fullText);
    setCopied(true); window.setTimeout(() => setCopied(false), 1600);
  };

  const downloadScript = () => {
    if (!result) return;
    const blob = new Blob([result.script.fullText], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = href; anchor.download = `${result.metadata?.title || "ai-script-shorts"}.txt`.replace(/[\\/:*?"<>|]/g, "-");
    anchor.click(); URL.revokeObjectURL(href);
  };

  return (
    <section className="col-span-12 min-h-[calc(100vh-130px)] overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 bg-gradient-to-br from-indigo-50 via-white to-violet-50 px-6 py-7 sm:px-10">
        <div className="mx-auto max-w-4xl text-center">
          <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-200"><WandSparkles className="h-7 w-7" /></span>
          <h1 className="text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">AI Script Shorts</h1>
          <p className="mt-2 text-sm text-slate-500">Dán link video, AI tự xem và viết lại thành một kịch bản Shorts hoàn chỉnh.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2 text-xs font-bold">
            <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-slate-600"><Film className="mr-1 inline h-3.5 w-3.5" />Video nguồn tối đa 60 giây</span>
            <span className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-indigo-700"><Sparkles className="mr-1 inline h-3.5 w-3.5" />Voice + fade đen 1 giây · tối đa 90 giây</span>
          </div>
          <div className="mx-auto mt-7 flex max-w-3xl flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-2 shadow-xl shadow-slate-200/50 sm:flex-row">
            <label className="flex min-w-0 flex-1 items-center gap-3 px-3"><Link2 className="h-5 w-5 shrink-0 text-slate-400" /><input value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void generate(); }} disabled={busy} placeholder="Dán URL YouTube, TikTok, Bilibili, Facebook..." className="h-12 min-w-0 flex-1 bg-transparent text-sm font-semibold text-slate-800 outline-none placeholder:font-normal placeholder:text-slate-400" /></label>
            {busy
              ? <button type="button" onClick={() => activeRequestRef.current?.abort()} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-rose-600 px-6 text-sm font-extrabold text-white shadow-md shadow-rose-200 transition hover:bg-rose-700"><LoaderCircle className="h-4 w-4 animate-spin" />Hủy tác vụ</button>
              : <button type="button" disabled={!canGenerate} onClick={() => void generate()} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 text-sm font-extrabold text-white shadow-md shadow-indigo-200 transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-45"><Sparkles className="h-4 w-4" />Generate Video</button>}
          </div>
          <p className="mt-3 text-[11px] font-medium text-slate-400">Hỗ trợ YouTube · TikTok · Bilibili · Facebook · Instagram · X · MP4 trực tiếp</p>
          <button type="button" onClick={() => setShowConfig((value) => !value)} className="mx-auto mt-4 flex w-full max-w-4xl items-center justify-between rounded-2xl border border-indigo-100 bg-white px-4 py-3 text-left shadow-sm transition hover:border-indigo-200 hover:shadow-md"><span className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700"><Settings2 className="h-4 w-4" /></span><span><span className="block text-xs font-black text-slate-800">Cấu hình video</span><span className="mt-0.5 block text-[10px] font-semibold text-slate-400">Giọng đọc, nhạc nền, tốc độ, cao độ và tag tiêu đề</span></span></span><span className="rounded-lg bg-indigo-50 px-2.5 py-1 text-[10px] font-extrabold text-indigo-700">{showConfig ? "Thu gọn" : "Mở cấu hình"}</span></button>
          {showConfig && <div className="mx-auto mt-4 grid max-w-4xl gap-3 rounded-2xl border border-indigo-100 bg-white/90 p-4 text-left shadow-sm sm:grid-cols-2 lg:grid-cols-3"><div className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500"><span>Giọng đọc</span><div className="mt-1.5 flex gap-2"><select value={voice} onChange={(event) => { setVoice(event.target.value); if (voicePreviewRef.current) voicePreviewRef.current.pause(); setPreviewingVoice(false); }} disabled={busy} className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold normal-case text-slate-700">{Array.from(new Set(BEEKNOEE_GOOGLE_VOICES.map((item) => item.group))).map((group) => <optgroup key={group} label={group}>{BEEKNOEE_GOOGLE_VOICES.filter((item) => item.group === group).map((item) => <option key={encodeBeeknoeeVoice(item)} value={encodeBeeknoeeVoice(item)}>{item.label}</option>)}</optgroup>)}</select><button type="button" onClick={() => void previewVoice()} disabled={busy} title={previewingVoice ? "Dừng nghe thử" : "Nghe thử giọng"} className="flex h-9 w-10 shrink-0 items-center justify-center rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50">{previewingVoice ? <Square className="h-3.5 w-3.5 fill-current" /> : <Play className="h-4 w-4 fill-current" />}</button></div><p className="mt-1 normal-case font-medium text-slate-400">Chỉ đọc nguyên văn kịch bản.</p></div><label className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500">Style nhạc nền<select value={musicStyle} onChange={(event) => setMusicStyle(event.target.value)} className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold normal-case text-slate-700"><option value="funny">Funny / hài hước</option><option value="upbeat">Vui tươi / năng lượng</option><option value="chill">Nhẹ nhàng</option><option value="auto">Tự động theo nội dung</option></select></label><label className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500">Nhạc nền: {Math.round(musicVolume * 100)}%<input type="range" min="0" max="0.25" step="0.01" value={musicVolume} onChange={(event) => setMusicVolume(Number(event.target.value))} className="mt-3 w-full accent-indigo-600" /></label><label className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500">Tốc độ đọc: {voiceRate.toFixed(2)}x<input type="range" min="1" max="1.2" step="0.01" value={voiceRate} onChange={(event) => setVoiceRate(Number(event.target.value))} className="mt-3 w-full accent-indigo-600" /></label><label className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500">Độ cao giọng: +{voicePitch}%<input type="range" min="0" max="5" step="1" value={voicePitch} onChange={(event) => setVoicePitch(Number(event.target.value))} className="mt-3 w-full accent-indigo-600" /></label><label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-700">Tag tiêu đề 3 giây<input type="checkbox" checked={titleOverlay} onChange={(event) => setTitleOverlay(event.target.checked)} className="h-4 w-4 accent-indigo-600" /></label></div>}
        </div>
      </div>

      <div className="mx-auto max-w-5xl space-y-6 px-5 py-7 sm:px-8">
        {(busy || message) && <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-5"><div className="flex items-center justify-between gap-4"><div><p className="text-sm font-extrabold text-slate-800">{message}</p><p className="mt-1 text-xs text-slate-500">Mọi bước phân tích và tối ưu được xử lý tự động.</p></div><span className="text-sm font-black text-indigo-600">{progress}%</span></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-white"><div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-500" style={{ width: `${progress}%` }} /></div></div>}
        {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">{error}</div>}
        {renderedVideo && <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 shadow-lg"><div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><div><p className="text-sm font-extrabold text-white">Xem trước video hoàn chỉnh</p><p className="mt-0.5 text-[11px] font-medium text-slate-400">Kiểm tra voice, burnsub, tag tiêu đề và nhạc nền trước khi tải.</p></div><span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-[10px] font-extrabold text-emerald-300">Đã render</span></div><div className="flex max-h-[680px] justify-center bg-black p-3"><video key={renderedVideo.downloadUrl} src={renderedVideo.downloadUrl} controls playsInline preload="metadata" className="max-h-[650px] w-auto max-w-full rounded-xl bg-black shadow-2xl" /></div></div>}
        {result && <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-extrabold uppercase tracking-widest text-indigo-600">Kịch bản hoàn chỉnh</p><h2 className="mt-1 text-xl font-black text-slate-900">{result.metadata?.title || "AI Script Shorts"}</h2></div><span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-extrabold text-emerald-700">≈ {result.script.estimatedDurationSeconds || 82} giây</span></div><div className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-5 text-[15px] font-medium leading-7 text-slate-700">{result.script.fullText}</div>{renderedVideo && <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="flex items-center gap-2 text-sm font-extrabold text-emerald-800"><Check className="h-4 w-4" />Video Shorts đã sẵn sàng</p><p className="mt-1 text-xs text-emerald-700">9:16 · video {renderedVideo.durationSeconds}s · voice {renderedVideo.voiceDurationSeconds ?? renderedVideo.durationSeconds}s · outro fade đen 1s · tắt tiếng gốc · nhạc nền {Math.round((renderedVideo.musicVolume ?? musicVolume) * 100)}%</p><p className="mt-1 text-[11px] font-bold text-emerald-700">{renderedVideo.voice || "Ngọc Huyền · Tin tức (Fine-tune)"} · karaoke trắng/vàng</p></div><a href={renderedVideo.downloadUrl} className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-extrabold text-white hover:bg-emerald-700"><Download className="h-4 w-4" />Tải video MP4</a></div>{renderedVideo.music?.title && <p className="mt-3 flex items-center gap-1.5 border-t border-emerald-200 pt-3 text-[11px] font-semibold text-emerald-800"><Music2 className="h-3.5 w-3.5" />Nhạc: {renderedVideo.music.title}{renderedVideo.music.artist ? ` — ${renderedVideo.music.artist}` : ""}{renderedVideo.music.license ? ` · ${renderedVideo.music.license}` : ""}</p>}</div>}<div className="mt-4 flex gap-2"><button type="button" onClick={() => void copyScript()} className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-xs font-extrabold text-slate-700 hover:bg-slate-50">{copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Clipboard className="h-4 w-4" />}{copied ? "Đã sao chép" : "Sao chép"}</button><button type="button" onClick={downloadScript} className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-xs font-extrabold text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" />Tải TXT</button><button type="button" onClick={() => { setResult(null); setRenderedVideo(null); setMessage(""); setProgress(0); }} className="ml-auto rounded-xl p-2 text-slate-400 hover:bg-slate-100"><RotateCcw className="h-4 w-4" /></button></div></article>
          <aside className="space-y-4"><div className="rounded-2xl border border-slate-200 p-5"><p className="text-xs font-black uppercase tracking-wider text-slate-500">Gợi ý đăng bài</p><p className="mt-3 text-sm font-bold leading-6 text-slate-800">{result.metadata?.description}</p><div className="mt-3 flex flex-wrap gap-1.5">{result.metadata?.hashtags?.map((tag) => <span key={tag} className="rounded-md bg-indigo-50 px-2 py-1 text-[11px] font-bold text-indigo-700">{tag.startsWith("#") ? tag : `#${tag}`}</span>)}</div></div><div className="rounded-2xl border border-slate-200 p-5"><p className="text-xs font-black uppercase tracking-wider text-slate-500">Thumbnail</p><p className="mt-3 text-base font-black text-slate-900">{result.metadata?.thumbnailTitle}</p><p className="mt-2 text-xs leading-5 text-slate-500">{result.metadata?.thumbnailPrompt}</p></div></aside>
        </div>}
        {!busy && !result && !error && <div className="py-10 text-center text-sm text-slate-400">Kịch bản được tạo mới dựa trên nội dung cốt lõi, không sao chép từng câu từ video nguồn.</div>}
      </div>
    </section>
  );
}
