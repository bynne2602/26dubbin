import { useCallback, useEffect, useState } from "react";
import { RefreshCw, FolderOpen, Video, Trash2, RotateCcw, Download, WandSparkles } from "lucide-react";
import ProjectLibraryLayout from "../layouts/ProjectLibraryLayout";
import { projectDbDelete, projectDbGetAll, type ProjectLibraryItem, type StoredAiShortsProject } from "../lib/projectDb";

type Props = {
  projectLibrary: ProjectLibraryItem[];
  currentProjectId: string | null;
  isProjectLibraryLoading: boolean;
  onRefresh: () => void;
  onCreateNew: () => void;
  onOpen: (id: string) => void;
  onReExport: (id: string) => void;
  onDelete: (id: string, name: string) => void;
};

export default function ProjectLibraryTab({
  projectLibrary,
  currentProjectId,
  isProjectLibraryLoading,
  onRefresh,
  onCreateNew,
  onOpen,
  onReExport,
  onDelete,
}: Props) {
  const [category, setCategory] = useState<"dubbin" | "aiShorts">("dubbin");
  const [aiProjects, setAiProjects] = useState<Array<StoredAiShortsProject & { previewUrl: string }>>([]);
  const loadAiProjects = useCallback(async () => {
    const stored = await projectDbGetAll<StoredAiShortsProject>("aiShorts");
    setAiProjects((previous) => {
      previous.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      return stored.sort((a, b) => b.updatedAt - a.updatedAt).map((item) => ({ ...item, previewUrl: URL.createObjectURL(item.videoBlob) }));
    });
  }, []);
  useEffect(() => {
    void loadAiProjects();
    const refresh = () => void loadAiProjects();
    window.addEventListener("dubbin:ai-shorts-saved", refresh);
    return () => window.removeEventListener("dubbin:ai-shorts-saved", refresh);
  }, [loadAiProjects]);
  const deleteAiProject = async (project: StoredAiShortsProject & { previewUrl: string }) => {
    if (!window.confirm(`Xóa video AI Shorts “${project.title}”?`)) return;
    await projectDbDelete("aiShorts", project.id);
    await loadAiProjects();
  };
  return (
    <ProjectLibraryLayout>
      <section className="lg:col-span-12 min-h-[calc(100vh-150px)] rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-extrabold text-slate-900"><FolderOpen className="h-5 w-5 text-indigo-600" /> Thư viện dự án</h1>
            <p className="mt-1 text-xs text-slate-500">Video, phụ đề, checkpoint STT/TTS và bản render được lưu ngay trên trình duyệt này.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => { onRefresh(); void loadAiProjects(); }} disabled={isProjectLibraryLoading} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${isProjectLibraryLoading ? "animate-spin" : ""}`} /> Làm mới</button>
            <button onClick={onCreateNew} className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-extrabold text-white shadow-sm hover:bg-indigo-500">+ Dự án mới</button>
          </div>
        </div>

        <div className="mt-4 inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
          <button type="button" onClick={() => setCategory("dubbin")} className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-extrabold ${category === "dubbin" ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500"}`}><Video className="h-3.5 w-3.5" />Dubbin Tool <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px]">{projectLibrary.length}</span></button>
          <button type="button" onClick={() => setCategory("aiShorts")} className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-extrabold ${category === "aiShorts" ? "bg-white text-violet-700 shadow-sm" : "text-slate-500"}`}><WandSparkles className="h-3.5 w-3.5" />AI Scripts Auto <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px]">{aiProjects.length}</span></button>
        </div>

        {category === "dubbin" && (isProjectLibraryLoading && projectLibrary.length === 0 ? (
          <div className="flex min-h-72 items-center justify-center text-sm font-semibold text-slate-400"><RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Đang tải thư viện...</div>
        ) : projectLibrary.length === 0 ? (
          <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/60 text-center">
            <FolderOpen className="mb-3 h-12 w-12 text-slate-300" />
            <h2 className="text-base font-extrabold text-slate-700">Chưa có dự án đã lưu</h2>
            <p className="mt-1 max-w-sm text-xs text-slate-500">Tải video trong Tool Auto Dubbing; dự án sẽ tự xuất hiện ở đây ngay khi checkpoint đầu tiên được lưu.</p>
            <button onClick={onCreateNew} className="mt-4 rounded-lg bg-[#b08cff] px-4 py-2 text-xs font-extrabold text-white hover:bg-[#9d72ff]">Tạo dự án đầu tiên</button>
          </div>
        ) : (
          <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {projectLibrary.map(({ project, previewUrl, hasFinalRender }) => (
              <article key={project.id} className={`overflow-hidden rounded-xl border bg-white transition-shadow hover:shadow-md ${currentProjectId === project.id ? "border-indigo-400 ring-2 ring-indigo-100" : "border-slate-200"}`}>
                <div className="aspect-video bg-slate-950">
                  {previewUrl ? <video src={previewUrl} muted preload="metadata" className="h-full w-full object-contain" /> : <div className="flex h-full items-center justify-center"><Video className="h-10 w-10 text-slate-600" /></div>}
                </div>
                <div className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="min-w-0 truncate text-sm font-extrabold text-slate-800" title={project.videoName}>{project.videoName}</h2>
                    {currentProjectId === project.id && <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[9px] font-extrabold text-indigo-600">ĐANG MỞ</span>}
                  </div>
                  <p className="mt-1 text-[10px] text-slate-400">Cập nhật {new Date(project.updatedAt).toLocaleString("vi-VN")}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] font-bold">
                    <span className="rounded bg-sky-50 px-2 py-1 text-sky-600">{project.subtitles?.length || 0} dòng phụ đề</span>
                    <span className="rounded bg-violet-50 px-2 py-1 text-violet-600">{project.ttsEngine === "tiktok" ? "TikTok TTS" : "Gemini TTS"}</span>
                    <span className="rounded bg-slate-100 px-2 py-1 text-slate-600">{project.exportResolution}p</span>
                    {hasFinalRender && <span className="rounded bg-emerald-50 px-2 py-1 text-emerald-600">Có video final</span>}
                  </div>
                  <div className={`mt-4 grid gap-2 ${hasFinalRender ? "grid-cols-[1fr_auto_auto]" : "grid-cols-[1fr_auto]"}`}>
                    <button onClick={() => onOpen(project.id)} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-extrabold text-white hover:bg-indigo-500">Mở dự án</button>
                    {hasFinalRender && <button onClick={() => onReExport(project.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-extrabold text-emerald-700 hover:bg-emerald-100" title="Mở dự án tại bước xuất video"><RotateCcw className="h-3.5 w-3.5" />Xuất lại</button>}
                    <button onClick={() => onDelete(project.id, project.videoName)} className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-bold text-rose-500 hover:bg-rose-50" title="Xóa dự án"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ))}
        {category === "aiShorts" && (aiProjects.length === 0 ? <div className="mt-5 flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-violet-200 bg-violet-50/40 text-center"><WandSparkles className="mb-3 h-12 w-12 text-violet-300" /><h2 className="text-base font-extrabold text-slate-700">Chưa có video AI Scripts Auto</h2><p className="mt-1 max-w-sm text-xs text-slate-500">Video sẽ tự động xuất hiện tại đây ngay khi AI Script Shorts render xong.</p></div> : <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{aiProjects.map((project) => <article key={project.id} className="overflow-hidden rounded-xl border border-violet-200 bg-white transition-shadow hover:shadow-md"><div className="aspect-[9/16] max-h-80 bg-black"><video src={project.previewUrl} controls preload="metadata" className="h-full w-full object-contain" /></div><div className="p-4"><h2 className="truncate text-sm font-extrabold text-slate-800" title={project.title}>{project.title}</h2><p className="mt-1 text-[10px] text-slate-400">Tạo {new Date(project.updatedAt).toLocaleString("vi-VN")}</p><div className="mt-3 flex flex-wrap gap-1.5 text-[10px] font-bold"><span className="rounded bg-violet-50 px-2 py-1 text-violet-600">{project.durationSeconds.toFixed(1)} giây</span><span className="max-w-full truncate rounded bg-indigo-50 px-2 py-1 text-indigo-600">{project.voice || "TTS"}</span>{project.musicTitle && <span className="max-w-full truncate rounded bg-amber-50 px-2 py-1 text-amber-700">{project.musicTitle}</span>}</div><p className="mt-3 line-clamp-3 text-xs leading-5 text-slate-500">{project.script}</p><div className="mt-4 grid grid-cols-[1fr_auto] gap-2"><a href={project.previewUrl} download={`${project.title.replace(/[\\/:*?\"<>|]/g, "-")}.mp4`} className="inline-flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-xs font-extrabold text-white hover:bg-violet-500"><Download className="h-3.5 w-3.5" />Tải video</a><button onClick={() => void deleteAiProject(project)} className="rounded-lg border border-rose-200 px-3 py-2 text-rose-500 hover:bg-rose-50" title="Xóa video"><Trash2 className="h-4 w-4" /></button></div></div></article>)}</div>)}
      </section>
    </ProjectLibraryLayout>
  );
}
