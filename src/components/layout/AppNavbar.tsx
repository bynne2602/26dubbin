import { Cpu } from "lucide-react";

type AppNavbarProps = {
  engineStatus: string;
  isDownloading: boolean;
  downloadProgress: number;
  onDownloadEngines: () => void;
};

export default function AppNavbar({ engineStatus, isDownloading, downloadProgress, onDownloadEngines }: AppNavbarProps) {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-slate-200/80 bg-white/90 backdrop-blur-md lg:pl-64" id="header">
      <div className="mx-auto flex w-full flex-col items-center justify-end gap-4 px-4 py-3.5 sm:px-6 md:flex-row">
        <div className="flex w-full items-center gap-3 md:w-auto lg:hidden">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-900 shadow-lg shadow-[#4f46e5]/15" id="logo-icon">
            <img src="/logo.png" alt="Logo" className="h-full w-full object-cover" />
          </div>
          <div>
            <h1 className="bg-gradient-to-r from-slate-950 via-[#4f46e5] to-slate-900 bg-clip-text text-xl font-extrabold tracking-tight text-transparent">26Dubbin</h1>
            <p className="text-xs font-semibold text-slate-500">Thuyết Minh & Dịch Phụ Đề AI</p>
          </div>
        </div>

        <div className="flex w-full items-center justify-end gap-3.5 border-t border-slate-100 pt-3 md:w-auto md:border-0 md:pt-0">
          <button
            type="button"
            onClick={onDownloadEngines}
            disabled={isDownloading}
            className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold shadow-sm transition-all ${engineStatus === "installed" ? "border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : isDownloading ? "cursor-not-allowed border border-indigo-200 bg-indigo-50 text-indigo-600" : "border border-indigo-600 bg-[#4f46e5] text-white hover:bg-[#4338ca]"}`}
          >
            <Cpu className={`h-3.5 w-3.5 ${isDownloading ? "animate-spin" : ""}`} />
            <span>{engineStatus === "installed" ? "Engine Sẵn Sàng" : isDownloading ? `Đang Tải ${downloadProgress}%` : "Tải Engine"}</span>
          </button>
          <a href="https://zalo.me/0373491922" target="_blank" rel="noreferrer" className="flex max-w-[200px] items-center gap-2 truncate rounded-full border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600 transition-colors hover:border-indigo-300 hover:text-indigo-600 sm:max-w-none">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[#6366f1]" />
            <span className="truncate"><span className="hidden sm:inline">Zalo: </span>0373491922</span>
          </a>
        </div>
      </div>
    </header>
  );
}
