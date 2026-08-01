import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Link2,
  Magnet,
  Pause,
  Play,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  Video,
  WandSparkles,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { BlurBox, Subtitle, SubtitleSettings } from "../types";
import { getSubtitleVisualScale } from "../lib/subtitleSizing";

type Snapshot = { subtitles: Subtitle[]; blurBoxes: BlurBox[] };
type SelectedClip = { kind: "subtitle" | "voice" | "blur"; id: string } | null;

type Props = {
  videoSrc: string;
  videoName: string;
  duration: number;
  subtitles: Subtitle[];
  blurBoxes: BlurBox[];
  subSettings: SubtitleSettings;
  ttsEnabled: boolean;
  voiceAudioUrls: Record<string, string>;
  ttsPlaybackRate: number;
  ttsVolume: number;
  sourceAudioVolume: number;
  isRendering: boolean;
  onChangeSubtitles: (items: Subtitle[]) => void;
  onChangeBlurBoxes: (items: BlurBox[]) => void;
  onRender: () => void;
  onBack: () => void;
};

const cloneSnapshot = (subtitles: Subtitle[], blurBoxes: BlurBox[]): Snapshot => ({
  subtitles: subtitles.map((item) => ({ ...item })),
  blurBoxes: blurBoxes.map((item) => ({ ...item })),
});

export default function TimelineEditorTab({
  videoSrc,
  videoName,
  duration,
  subtitles,
  blurBoxes,
  subSettings,
  ttsEnabled,
  voiceAudioUrls,
  ttsPlaybackRate,
  ttsVolume,
  sourceAudioVolume,
  isRendering,
  onChangeSubtitles,
  onChangeBlurBoxes,
  onRender,
  onBack,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewFrameRef = useRef<HTMLDivElement>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeVoiceIdRef = useRef("");
  const timelineRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<Snapshot[]>([]);
  const redoRef = useRef<Snapshot[]>([]);
  const editSnapshotRef = useRef<Snapshot | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [selected, setSelected] = useState<SelectedClip>(null);
  const [viewport, setViewport] = useState({ left: 0, width: 1200 });
  const [previewHeight, setPreviewHeight] = useState(360);
  const [isOptimizingTimestamps, setIsOptimizingTimestamps] = useState(false);
  const [, setHistoryVersion] = useState(0);
  const refreshHistoryControls = () => setHistoryVersion((value) => value + 1);
  const beginPropertyEdit = () => {
    if (!editSnapshotRef.current) editSnapshotRef.current = cloneSnapshot(subtitles, blurBoxes);
  };
  const finishPropertyEdit = () => {
    if (!editSnapshotRef.current) return;
    undoRef.current.push(editSnapshotRef.current);
    if (undoRef.current.length > 100) undoRef.current.shift();
    redoRef.current = [];
    editSnapshotRef.current = null;
    refreshHistoryControls();
  };

  const timelineDuration = Math.max(0.1, duration, ...subtitles.map((item) => item.end));
  const timelineWidth = Math.max(1200, timelineDuration * 12 * zoom);
  const pixelsPerSecond = timelineWidth / timelineDuration;
  const visibleStart = Math.max(0, viewport.left / pixelsPerSecond - 2);
  const visibleEnd = Math.min(timelineDuration, (viewport.left + viewport.width) / pixelsPerSecond + 2);

  const overlapIds = useMemo(() => {
    const ids = new Set<string>();
    const sorted = [...subtitles].sort((a, b) => a.start - b.start);
    for (let index = 1; index < sorted.length; index++) {
      if (sorted[index].start < sorted[index - 1].end - 0.001) {
        ids.add(sorted[index - 1].id);
        ids.add(sorted[index].id);
      }
    }
    return ids;
  }, [subtitles]);

  const activeSubtitle = useMemo(
    () => subtitles.find((item) => currentTime >= item.start && currentTime < item.end),
    [subtitles, currentTime],
  );
  const selectedSubtitle = selected?.kind === "subtitle" || selected?.kind === "voice"
    ? subtitles.find((item) => item.id === selected.id)
    : undefined;
  const selectedBlur = selected?.kind === "blur"
    ? blurBoxes.find((item) => item.id === selected.id)
    : undefined;

  useEffect(() => {
    const frame = previewFrameRef.current;
    if (!frame) return;
    const update = () => setPreviewHeight(Math.max(1, frame.clientHeight));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [videoSrc]);

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.volume = Math.max(0, Math.min(1, sourceAudioVolume));
  }, [sourceAudioVolume, videoSrc]);

  useEffect(() => {
    const stopVoice = () => {
      voiceAudioRef.current?.pause();
      voiceAudioRef.current = null;
      activeVoiceIdRef.current = "";
    };
    if (!ttsEnabled) {
      stopVoice();
      return;
    }
    const cue = subtitles.find((item) => currentTime >= item.start && currentTime < item.end);
    const url = cue ? voiceAudioUrls[cue.id] : "";
    if (!cue || !url) {
      stopVoice();
      return;
    }
    if (activeVoiceIdRef.current !== cue.id || !voiceAudioRef.current) {
      stopVoice();
      const audio = new Audio(url);
      audio.preservesPitch = true;
      audio.playbackRate = Math.max(0.5, Math.min(2, ttsPlaybackRate || 1));
      audio.volume = Math.max(0, Math.min(1, ttsVolume));
      voiceAudioRef.current = audio;
      activeVoiceIdRef.current = cue.id;
    }
    const audio = voiceAudioRef.current;
    const expectedAudioTime = Math.max(0, (currentTime - cue.start) * audio.playbackRate);
    if (Number.isFinite(audio.duration)) {
      const safeTime = Math.min(Math.max(0, audio.duration - 0.02), expectedAudioTime);
      if (Math.abs(audio.currentTime - safeTime) > 0.18) audio.currentTime = safeTime;
    } else if (Math.abs(audio.currentTime - expectedAudioTime) > 0.18) {
      audio.currentTime = expectedAudioTime;
    }
    if (playing) void audio.play().catch(() => {});
    else audio.pause();
  }, [currentTime, playing, subtitles, ttsEnabled, ttsPlaybackRate, ttsVolume, voiceAudioUrls]);

  useEffect(() => () => {
    voiceAudioRef.current?.pause();
    voiceAudioRef.current = null;
  }, []);

  const commit = (next: Snapshot) => {
    undoRef.current.push(cloneSnapshot(subtitles, blurBoxes));
    if (undoRef.current.length > 100) undoRef.current.shift();
    redoRef.current = [];
    refreshHistoryControls();
    onChangeSubtitles(next.subtitles);
    onChangeBlurBoxes(next.blurBoxes);
  };
  const restore = (snapshot: Snapshot, target: React.MutableRefObject<Snapshot[]>) => {
    target.current.push(cloneSnapshot(subtitles, blurBoxes));
    refreshHistoryControls();
    onChangeSubtitles(snapshot.subtitles);
    onChangeBlurBoxes(snapshot.blurBoxes);
  };
  const undo = () => {
    const snapshot = undoRef.current.pop();
    if (snapshot) restore(snapshot, redoRef);
  };
  const redo = () => {
    const snapshot = redoRef.current.pop();
    if (snapshot) restore(snapshot, undoRef);
  };

  const seek = (time: number) => {
    const next = Math.max(0, Math.min(timelineDuration, time));
    setCurrentTime(next);
    if (videoRef.current) videoRef.current.currentTime = next;
  };
  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) await video.play();
    else video.pause();
  };

  const getSnapTime = (value: number, ignoredId: string) => {
    if (!snapEnabled) return value;
    const points = [0, timelineDuration, currentTime];
    for (const item of subtitles) if (item.id !== ignoredId) points.push(item.start, item.end);
    for (const box of blurBoxes) if (box.id !== ignoredId) points.push(box.start ?? 0, box.end ?? timelineDuration);
    const nearest = points.reduce((best, point) => Math.abs(point - value) < Math.abs(best - value) ? point : best, points[0]);
    return Math.abs(nearest - value) <= 0.12 ? nearest : value;
  };

  const beginDrag = (
    event: React.PointerEvent,
    kind: "subtitle" | "voice" | "blur",
    id: string,
    mode: "move" | "start" | "end",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setSelected({ kind, id });
    const sourceSubtitle = subtitles.find((item) => item.id === id);
    const sourceBlur = blurBoxes.find((item) => item.id === id);
    const initialStart = sourceSubtitle?.start ?? sourceBlur?.start ?? 0;
    const initialEnd = sourceSubtitle?.end ?? sourceBlur?.end ?? timelineDuration;
    const pointerStart = event.clientX;
    const initial = cloneSnapshot(subtitles, blurBoxes);
    let changed = false;

    const onMove = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientX - pointerStart) / pixelsPerSecond;
      let start = initialStart;
      let end = initialEnd;
      if (mode === "move") {
        const length = initialEnd - initialStart;
        start = getSnapTime(Math.max(0, Math.min(timelineDuration - length, initialStart + delta)), id);
        end = start + length;
      } else if (mode === "start") {
        start = getSnapTime(Math.max(0, Math.min(initialEnd - 0.08, initialStart + delta)), id);
      } else {
        end = getSnapTime(Math.max(initialStart + 0.08, Math.min(timelineDuration, initialEnd + delta)), id);
      }
      changed = true;
      if (sourceSubtitle) {
        onChangeSubtitles(subtitles.map((item) => item.id === id ? { ...item, start, end } : item));
      } else if (sourceBlur) {
        onChangeBlurBoxes(blurBoxes.map((item) => item.id === id ? { ...item, start, end } : item));
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (changed) {
        undoRef.current.push(initial);
        if (undoRef.current.length > 100) undoRef.current.shift();
        redoRef.current = [];
        refreshHistoryControls();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const splitSelected = () => {
    if (!selectedSubtitle || currentTime <= selectedSubtitle.start + 0.08 || currentTime >= selectedSubtitle.end - 0.08) return;
    const splitText = (value: string) => {
      const words = String(value || "").trim().split(/\s+/).filter(Boolean);
      if (words.length <= 1) {
        const characters = Array.from(String(value || "").trim());
        if (characters.length <= 1) return [value, value] as const;
        const middle = Math.max(1, Math.floor(characters.length / 2));
        return [characters.slice(0, middle).join(""), characters.slice(middle).join("")] as const;
      }
      const middle = Math.max(1, Math.floor(words.length / 2));
      return [words.slice(0, middle).join(" "), words.slice(middle).join(" ")] as const;
    };
    const [firstOriginal, secondOriginal] = splitText(selectedSubtitle.original);
    const [firstTranslated, secondTranslated] = splitText(selectedSubtitle.translated || selectedSubtitle.original);
    const first = { ...selectedSubtitle, end: currentTime, original: firstOriginal, translated: firstTranslated };
    const second = { ...selectedSubtitle, id: `${selectedSubtitle.id}-split-${Date.now()}`, start: currentTime, original: secondOriginal, translated: secondTranslated };
    commit({ subtitles: subtitles.flatMap((item) => item.id === selectedSubtitle.id ? [first, second] : [item]), blurBoxes });
    setSelected({ kind: "subtitle", id: second.id });
  };
  const mergeSelectedWithNext = () => {
    if (!selectedSubtitle) return;
    const sorted = [...subtitles].sort((a, b) => a.start - b.start);
    const index = sorted.findIndex((item) => item.id === selectedSubtitle.id);
    const next = sorted[index + 1];
    if (!next) return;
    const merged: Subtitle = {
      ...selectedSubtitle,
      end: Math.max(selectedSubtitle.end, next.end),
      original: [selectedSubtitle.original, next.original].filter(Boolean).join(" "),
      translated: [selectedSubtitle.translated, next.translated].filter(Boolean).join(" "),
    };
    commit({
      subtitles: subtitles.filter((item) => item.id !== next.id).map((item) => item.id === selectedSubtitle.id ? merged : item),
      blurBoxes,
    });
  };
  const removeSelected = () => {
    if (!selected) return;
    commit({
      subtitles: selected.kind === "blur" ? subtitles : subtitles.filter((item) => item.id !== selected.id),
      blurBoxes: selected.kind === "blur" ? blurBoxes.filter((item) => item.id !== selected.id) : blurBoxes,
    });
    setSelected(null);
  };

  const optimizeTimestamps = async () => {
    if (!subtitles.length || isOptimizingTimestamps) return;
    setIsOptimizingTimestamps(true);
    try {
      const gap = 0.035;
      const minimumDuration = 0.08;
      const measureAudibleDuration = async (subtitle: Subtitle): Promise<number> => {
        const source = voiceAudioUrls[subtitle.id];
        if (!source) return Math.max(minimumDuration, subtitle.end - subtitle.start);
        try {
          const bytes = await fetch(source).then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.arrayBuffer();
          });
          const context = new AudioContext();
          try {
            const decoded = await context.decodeAudioData(bytes.slice(0));
            const threshold = 0.006;
            let first = decoded.length;
            let last = -1;
            for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
              const samples = decoded.getChannelData(channel);
              let channelFirst = 0;
              while (channelFirst < samples.length && Math.abs(samples[channelFirst]) < threshold) channelFirst++;
              let channelLast = samples.length - 1;
              while (channelLast >= channelFirst && Math.abs(samples[channelLast]) < threshold) channelLast--;
              first = Math.min(first, channelFirst);
              last = Math.max(last, channelLast);
            }
            const audibleSamples = last >= first ? last - first + 1 : decoded.length;
            return Math.max(minimumDuration, (audibleSamples / decoded.sampleRate) / Math.max(0.1, ttsPlaybackRate));
          } finally {
            void context.close();
          }
        } catch {
          return Math.max(minimumDuration, subtitle.end - subtitle.start);
        }
      };

      const ordered = subtitles.map((item) => ({ ...item })).sort((a, b) => a.start - b.start || a.end - b.end);
      const measured = await Promise.all(ordered.map(measureAudibleDuration));
      let cursor = 0;
      for (let index = 0; index < ordered.length; index++) {
        const item = ordered[index];
        const naturalStart = Math.max(0, item.start);
        const start = Math.max(naturalStart, index === 0 ? 0 : cursor + gap);
        const end = start + measured[index];
        item.start = start;
        item.end = Math.max(start + minimumDuration, end);
        cursor = item.end;
      }
      const byId = new Map(ordered.map((item) => [item.id, item] as const));
      commit({ subtitles: subtitles.map((item) => byId.get(item.id) || item), blurBoxes });
    } finally {
      setIsOptimizingTimestamps(false);
    }
  };

  const renderClip = (
    kind: "subtitle" | "voice" | "blur",
    id: string,
    start: number,
    end: number,
    label: string,
    color: string,
  ) => {
    if (end < visibleStart || start > visibleEnd) return null;
    const isSelected = selected?.kind === kind && selected.id === id;
    const hasOverlap = kind !== "blur" && overlapIds.has(id);
    return (
      <div
        key={`${kind}-${id}`}
        className={`absolute top-1 h-8 cursor-grab select-none overflow-hidden rounded-md border text-[10px] font-bold text-white shadow-sm ${color} ${isSelected ? "ring-2 ring-indigo-300 ring-offset-1" : ""} ${hasOverlap ? "!border-rose-600 !bg-rose-500" : "border-white/30"}`}
        style={{ left: start * pixelsPerSecond, width: Math.max(10, (end - start) * pixelsPerSecond) }}
        onPointerDown={(event) => beginDrag(event, kind, id, "move")}
        onClick={(event) => event.stopPropagation()}
        title={`${start.toFixed(2)}s → ${end.toFixed(2)}s · ${label}`}
      >
        <span className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize bg-black/15" onPointerDown={(event) => beginDrag(event, kind, id, "start")} />
        <span className="block truncate px-2 py-2">{label}</span>
        <span className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize bg-black/15" onPointerDown={(event) => beginDrag(event, kind, id, "end")} />
      </div>
    );
  };

  const tracks = [
    {
      label: "Video",
      content: [
        <div key="video-source" className="absolute top-1 h-8 overflow-hidden rounded-md border border-emerald-300 bg-emerald-500 px-2 py-2 text-[10px] font-bold text-white" style={{ left: 0, width: timelineWidth }}>
          {videoName || "Video nguồn"}
        </div>,
      ],
    },
    {
      label: "Phụ đề",
      content: subtitles.map((item) => renderClip("subtitle", item.id, item.start, item.end, item.translated || item.original, "bg-sky-500")),
    },
    {
      label: "Voice",
      content: ttsEnabled
        ? subtitles.map((item) => renderClip("voice", item.id, item.start, item.end, item.translated || item.original, "bg-violet-500"))
        : [],
    },
    {
      label: "Blur Box",
      content: blurBoxes.map((item, index) => renderClip("blur", item.id, item.start ?? 0, item.end ?? timelineDuration, `Blur #${index + 1}`, "bg-amber-500")),
    },
  ];

  return (
    <section data-testid="timeline-editor" className="col-span-12 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:h-full">
      <header data-testid="editor-toolbar" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <div className="mr-auto min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-extrabold text-slate-900"><Video className="h-4 w-4 text-indigo-600" /> Trình chỉnh sửa</h2>
          <p className="truncate text-[11px] text-slate-500">{videoName || "Dự án hiện tại"} · Tự động lưu cùng checkpoint</p>
        </div>
        <button aria-label="Hoàn tác" onClick={undo} disabled={!undoRef.current.length} className="rounded-lg border p-2 text-slate-600 disabled:opacity-30" title="Hoàn tác"><Undo2 className="h-4 w-4" /></button>
        <button aria-label="Làm lại" onClick={redo} disabled={!redoRef.current.length} className="rounded-lg border p-2 text-slate-600 disabled:opacity-30" title="Làm lại"><Redo2 className="h-4 w-4" /></button>
        <button onClick={() => setSnapEnabled((value) => !value)} className={`flex items-center gap-1 rounded-lg border px-3 py-2 text-[11px] font-bold ${snapEnabled ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "text-slate-500"}`}><Magnet className="h-3.5 w-3.5" /> Snap</button>
        <button onClick={() => void optimizeTimestamps()} disabled={!subtitles.length || isOptimizingTimestamps} className="flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] font-bold text-emerald-700 disabled:opacity-40" title="Đo thời lượng có tiếng của từng voice rồi dàn lại timeline liên tục, không chồng lấn"><WandSparkles className={`h-3.5 w-3.5 ${isOptimizingTimestamps ? "animate-pulse" : ""}`} /> {isOptimizingTimestamps ? "Đang đo voice..." : "Tối ưu timestamp"}</button>
        <button onClick={onBack} className="rounded-lg border border-slate-200 px-3 py-2 text-[11px] font-bold text-slate-600">Về Tool Auto</button>
        <button onClick={onRender} disabled={isRendering || !videoSrc} className="rounded-lg bg-indigo-600 px-4 py-2 text-[11px] font-extrabold text-white disabled:opacity-50">{isRendering ? "Đang render..." : "Render video"}</button>
      </header>

      {!videoSrc ? (
        <div className="grid min-h-[520px] place-items-center text-sm font-bold text-slate-400">Chưa có video trong dự án.</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div data-testid="editor-preview-area" className="grid min-h-[360px] shrink-0 grid-cols-1 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="flex min-h-0 flex-col bg-slate-950">
              <div className="relative flex min-h-[280px] flex-1 items-center justify-center overflow-hidden p-3 lg:min-h-0">
                <div ref={previewFrameRef} className="relative max-h-full max-w-full overflow-hidden rounded-lg bg-black shadow-2xl">
                  <video
                    ref={videoRef}
                    src={videoSrc}
                    className="max-h-[48vh] max-w-full lg:max-h-[calc(100vh-390px)]"
                    onLoadedMetadata={(event) => {
                      event.currentTarget.volume = Math.max(0, Math.min(1, sourceAudioVolume));
                    }}
                    onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                  />
                  {blurBoxes.filter((box) => currentTime >= (box.start ?? 0) && currentTime < (box.end ?? timelineDuration)).map((box) => (
                    <div key={box.id} className="pointer-events-none absolute border border-amber-400/80 bg-slate-900/20" style={{ left: `${box.xPosition}%`, top: `${box.yPosition}%`, width: `${box.width}%`, height: `${box.height}%`, backdropFilter: `blur(${box.blurAmount}px)` }} />
                  ))}
                  {activeSubtitle && (
                    <div
                      className="pointer-events-none absolute left-1/2 max-w-[88%] -translate-x-1/2 whitespace-pre-wrap text-center"
                      style={{
                        left: subSettings.position === "custom" ? `${subSettings.customX ?? 50}%` : "50%",
                        top: subSettings.position === "top" ? "8%" : subSettings.position === "center" ? "50%" : `${subSettings.customY ?? 82}%`,
                        transform: `translate(-50%, ${subSettings.position === "center" ? "-50%" : "-100%"})`,
                        color: subSettings.textColor,
                        fontFamily: `"${subSettings.fontFamily || "Arial"}", Arial, sans-serif`,
                        fontSize: `${Math.max(1, subSettings.fontSize * getSubtitleVisualScale(previewHeight))}px`,
                        lineHeight: 1.22,
                        letterSpacing: `${subSettings.letterSpacing * getSubtitleVisualScale(previewHeight)}px`,
                        fontWeight: subSettings.fontWeight === "normal" ? 400 : subSettings.fontWeight === "medium" ? 500 : subSettings.fontWeight === "black" ? 900 : 700,
                        WebkitTextStroke: subSettings.outline ? `${Math.max(0.5, subSettings.outlineWidth * getSubtitleVisualScale(previewHeight))}px ${subSettings.outlineColor}` : undefined,
                        textShadow: subSettings.textEffect === "glow"
                          ? `0 0 ${Math.max(3, subSettings.fontSize * getSubtitleVisualScale(previewHeight) * 0.35)}px ${subSettings.textColor}`
                          : subSettings.textEffect === "shadow"
                            ? "2px 2px 3px rgba(0,0,0,.9)"
                            : undefined,
                        backgroundColor: subSettings.bgColor || "transparent",
                        padding: `${Math.max(2, subSettings.fontSize * getSubtitleVisualScale(previewHeight) * 0.18)}px ${Math.max(5, subSettings.fontSize * getSubtitleVisualScale(previewHeight) * 0.4)}px`,
                        borderRadius: 6,
                      }}
                    >
                      {activeSubtitle.translated || activeSubtitle.original}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 border-t border-slate-800 px-4 py-2 text-white">
                <button aria-label={playing ? "Tạm dừng video" : "Phát video"} onClick={togglePlayback} className="rounded-lg bg-indigo-600 p-2">{playing ? <Pause className="h-4 w-4 fill-white" /> : <Play className="h-4 w-4 fill-white" />}</button>
                <span className="font-mono text-[11px]">{currentTime.toFixed(2)}s</span>
                <input type="range" min="0" max={timelineDuration} step="0.01" value={currentTime} onChange={(event) => seek(Number(event.target.value))} className="flex-1 accent-indigo-500" />
                <span className="font-mono text-[11px] text-slate-400">{timelineDuration.toFixed(2)}s</span>
              </div>
            </div>

            <aside data-testid="editor-properties" className="max-h-[420px] overflow-y-auto border-l border-slate-200 bg-slate-50 p-4 lg:max-h-none lg:min-h-0">
              <h3 className="text-xs font-extrabold text-slate-800">Thuộc tính clip</h3>
              {overlapIds.size > 0 && <div className="mt-3 flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-[10px] font-bold text-rose-700"><AlertTriangle className="h-4 w-4 shrink-0" /> Có {overlapIds.size} clip phụ đề chồng timestamp.</div>}
              {selectedSubtitle ? (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center gap-1 text-[10px] font-bold text-indigo-600"><Link2 className="h-3.5 w-3.5" /> Phụ đề và Voice đang liên kết</div>
                  <label className="block text-[10px] font-bold text-slate-600">Nội dung dịch
                    <textarea
                      value={selectedSubtitle.translated}
                      onFocus={beginPropertyEdit}
                      onChange={(event) => onChangeSubtitles(subtitles.map((item) => item.id === selectedSubtitle.id ? { ...item, translated: event.target.value } : item))}
                      onBlur={finishPropertyEdit}
                      className="mt-1 h-24 w-full resize-none rounded-lg border border-slate-200 bg-white p-2 text-xs font-medium"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[10px] font-bold text-slate-600">Bắt đầu<input type="number" step="0.01" value={selectedSubtitle.start.toFixed(2)} onFocus={beginPropertyEdit} onBlur={finishPropertyEdit} onChange={(event) => {
                      const value = Number(event.target.value);
                      if (!Number.isFinite(value)) return;
                      onChangeSubtitles(subtitles.map((item) => item.id === selectedSubtitle.id ? { ...item, start: Math.max(0, Math.min(item.end - 0.05, value)) } : item));
                    }} className="mt-1 w-full rounded border p-2" /></label>
                    <label className="text-[10px] font-bold text-slate-600">Kết thúc<input type="number" step="0.01" value={selectedSubtitle.end.toFixed(2)} onFocus={beginPropertyEdit} onBlur={finishPropertyEdit} onChange={(event) => {
                      const value = Number(event.target.value);
                      if (!Number.isFinite(value)) return;
                      onChangeSubtitles(subtitles.map((item) => item.id === selectedSubtitle.id ? { ...item, end: Math.min(timelineDuration, Math.max(item.start + 0.05, value)) } : item));
                    }} className="mt-1 w-full rounded border p-2" /></label>
                  </div>
                  <button onClick={splitSelected} className="flex w-full items-center justify-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 py-2 text-[11px] font-bold text-indigo-700"><Scissors className="h-3.5 w-3.5" /> Tách tại playhead</button>
                  <button onClick={mergeSelectedWithNext} className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white py-2 text-[11px] font-bold text-slate-700"><Link2 className="h-3.5 w-3.5" /> Gộp với câu kế tiếp</button>
                  <button onClick={removeSelected} className="flex w-full items-center justify-center gap-2 rounded-lg border border-rose-200 bg-rose-50 py-2 text-[11px] font-bold text-rose-600"><Trash2 className="h-3.5 w-3.5" /> Xóa clip</button>
                </div>
              ) : selectedBlur ? (
                <div className="mt-4 space-y-3 text-[10px] font-bold text-slate-600">
                  <p className="rounded-lg bg-amber-50 p-2 text-amber-700">Blur Box chỉ hoạt động trong khoảng clip trên timeline.</p>
                  <label className="block">Mức blur: {selectedBlur.blurAmount}px<input type="range" min="0" max="30" value={selectedBlur.blurAmount} onPointerDown={beginPropertyEdit} onPointerUp={finishPropertyEdit} onKeyDown={beginPropertyEdit} onBlur={finishPropertyEdit} onChange={(event) => onChangeBlurBoxes(blurBoxes.map((item) => item.id === selectedBlur.id ? { ...item, blurAmount: Number(event.target.value) } : item))} className="mt-1 w-full" /></label>
                  <button onClick={removeSelected} className="flex w-full items-center justify-center gap-2 rounded-lg border border-rose-200 bg-rose-50 py-2 text-[11px] font-bold text-rose-600"><Trash2 className="h-3.5 w-3.5" /> Xóa Blur Box</button>
                </div>
              ) : <p className="mt-4 text-[11px] leading-5 text-slate-500">Chọn một clip trên timeline để sửa nội dung hoặc timing.</p>}
            </aside>
          </div>

          <div data-testid="editor-timeline" className="shrink-0 border-t border-slate-200 bg-slate-100 lg:h-[clamp(205px,32vh,250px)]">
            <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
              <span className="text-[10px] font-extrabold text-slate-600">TIMELINE</span>
              <button aria-label="Thu nhỏ timeline" onClick={() => setZoom((value) => Math.max(0.5, value / 1.3))} className="ml-auto rounded border p-1.5 text-slate-500"><ZoomOut className="h-3.5 w-3.5" /></button>
              <span className="w-12 text-center text-[10px] font-bold text-slate-500">{Math.round(zoom * 100)}%</span>
              <button aria-label="Phóng to timeline" onClick={() => setZoom((value) => Math.min(10, value * 1.3))} className="rounded border p-1.5 text-slate-500"><ZoomIn className="h-3.5 w-3.5" /></button>
            </div>
            <div
              ref={timelineRef}
              className="h-[260px] overflow-auto lg:h-[calc(100%-38px)]"
              onScroll={(event) => setViewport({ left: event.currentTarget.scrollLeft, width: event.currentTarget.clientWidth })}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                seek((event.currentTarget.scrollLeft + event.clientX - rect.left - 88) / pixelsPerSecond);
              }}
            >
              <div className="relative" style={{ width: timelineWidth + 88, minHeight: 220 }}>
                <div className="sticky left-0 z-30 w-[88px] border-r border-slate-300 bg-slate-200/95">
                  <div className="h-7 border-b border-slate-300" />
                  {tracks.map((track) => <div key={track.label} className="flex h-11 items-center border-b border-slate-300 px-3 text-[10px] font-extrabold text-slate-600">{track.label}</div>)}
                </div>
                <div className="absolute left-[88px] top-0" style={{ width: timelineWidth }}>
                  <div className="relative h-7 border-b border-slate-300 bg-white">
                    {Array.from({ length: Math.ceil(timelineDuration / Math.max(1, 10 / zoom)) + 1 }, (_, index) => {
                      const step = Math.max(1, 10 / zoom);
                      const time = index * step;
                      return <span key={time} className="absolute top-1 font-mono text-[9px] text-slate-400" style={{ left: time * pixelsPerSecond }}>{time.toFixed(0)}s</span>;
                    })}
                  </div>
                  {tracks.map((track) => <div key={track.label} className="relative h-11 border-b border-slate-300 bg-white/80">{track.content}</div>)}
                  <div className="pointer-events-none absolute top-0 z-20 h-[203px] w-px bg-rose-500" style={{ left: currentTime * pixelsPerSecond }} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
