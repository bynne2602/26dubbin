import {
  Crown,
  ChevronDown,
  Download,
  FileText,
  FolderOpen,
  LogOut,
  Megaphone,
  ScanText,
  Settings,
  SlidersHorizontal,
  SquareDashedMousePointer,
  Terminal,
  Trash2,
  Video,
  WandSparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { StudioRoute } from "../../app/routes";

type AppSidebarProps = {
  activeRoute: StudioRoute;
  onNavigate: (route: StudioRoute) => void;
  onDonate: () => void;
  onSignOut: () => void;
  activityLogs: string[];
  onClearLogs: () => void;
};

const DUBBIN_ITEMS = [
  { route: "dubbin", label: "Auto Dubbing", icon: Video },
  { route: "editor", label: "Trình chỉnh sửa", icon: SquareDashedMousePointer },
  { route: "extract", label: "Trích xuất phụ đề", icon: ScanText },
  { route: "tracks", label: "Bản dịch", icon: FileText },
  { route: "style", label: "Cá nhân hóa", icon: SlidersHorizontal },
  { route: "tts", label: "Lồng tiếng", icon: Megaphone },
  { route: "export", label: "Xuất bản", icon: Download },
] satisfies Array<{ route: StudioRoute; label: string; icon: typeof Video }>;

const navButtonClass = (active: boolean, nested = false) =>
  `flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-bold transition-all ${nested ? "pl-5" : ""} ${active
    ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20"
    : "text-slate-600 hover:bg-indigo-50 hover:text-indigo-700"}`;

export default function AppSidebar({ activeRoute, onNavigate, onDonate, onSignOut, activityLogs, onClearLogs }: AppSidebarProps) {
  const isElectron = typeof window !== "undefined" && navigator.userAgent.toLowerCase().includes("electron");
  const [isDubbinOpen, setIsDubbinOpen] = useState(activeRoute !== "script-shorts");

  useEffect(() => {
    setIsDubbinOpen(activeRoute !== "script-shorts");
  }, [activeRoute]);

  return (
    <aside className={`fixed inset-y-0 left-0 z-[60] hidden w-64 flex-col border-r border-slate-200 bg-white px-3 pb-4 shadow-[8px_0_30px_rgba(15,23,42,0.04)] lg:flex ${isElectron ? "pt-[46px]" : "pt-4"}`}>
      <div className="flex items-center gap-3 border-b border-slate-100 px-2 pb-5">
        <div className="h-10 w-10 overflow-hidden rounded-xl border border-indigo-100 bg-slate-900 shadow-lg shadow-indigo-500/15">
          <img src="/logo.png" alt="26Dubbin" className="h-full w-full object-cover" />
        </div>
        <div>
          <p className="text-base font-extrabold tracking-tight text-slate-900">26Dubbin</p>
          <p className="text-[10px] font-semibold text-slate-400">AI DUBBING STUDIO</p>
        </div>
      </div>

      <nav className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto pr-1" aria-label="Điều hướng chính">
        <button type="button" onClick={() => onNavigate("projects")} className={navButtonClass(activeRoute === "projects")}>
          <FolderOpen className="h-4 w-4" />
          Thư viện
        </button>

        <div className="my-2">
          <button
            type="button"
            onClick={() => setIsDubbinOpen((open) => !open)}
            aria-expanded={isDubbinOpen}
            className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[10px] font-black uppercase tracking-[0.16em] transition-colors ${isDubbinOpen ? "text-slate-500" : "text-slate-500 hover:bg-indigo-50 hover:text-indigo-700"}`}
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-indigo-50 text-indigo-600">
              <Video className="h-3 w-3" />
            </span>
            <span className="flex-1">Dubbin Tool</span>
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isDubbinOpen ? "rotate-180" : ""}`} />
          </button>
          {isDubbinOpen && <div className="ml-2 mt-1 space-y-0.5 border-l border-indigo-100 pl-1.5">
            {DUBBIN_ITEMS.map(({ route, label, icon: Icon }) => (
              <button key={route} type="button" onClick={() => onNavigate(route)} className={navButtonClass(activeRoute === route, true)}>
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>}
        </div>

        <div className={`space-y-1 ${isDubbinOpen ? "border-t border-slate-100 pt-3" : ""}`}>
          <button type="button" onClick={() => onNavigate("script-shorts")} className={navButtonClass(activeRoute === "script-shorts")}>
            <WandSparkles className="h-4 w-4" />
            AI Script Generate
          </button>
          <button type="button" onClick={() => onNavigate("settings")} className={navButtonClass(activeRoute === "settings")}>
            <Settings className="h-4 w-4" />
            Cài đặt
          </button>
        </div>
      </nav>

      <div className="mt-3 shrink-0 space-y-3">
        <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-inner">
          <div className="flex items-center justify-between border-b border-slate-800 px-2.5 py-1.5">
            <span className="flex min-w-0 items-center gap-1.5 text-[9px] font-extrabold uppercase text-emerald-400"><Terminal className="h-3 w-3" /> Nhật ký ({activityLogs.length})</span>
            <button type="button" onClick={onClearLogs} disabled={activityLogs.length === 0} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-rose-400 disabled:opacity-30" title="Xóa nhật ký"><Trash2 className="h-3 w-3" /></button>
          </div>
          <div className="h-24 overflow-y-auto px-2.5 py-2 font-mono text-[9px] leading-relaxed">
            {activityLogs.length === 0
              ? <span className="italic text-slate-600">Chưa có hoạt động...</span>
              : activityLogs.slice(-8).map((log, index) => <div key={`${index}-${log}`} className={`border-b border-slate-900 py-0.5 last:border-0 ${/lỗi|error|failed/i.test(log) ? "text-rose-400" : "text-emerald-400"}`}>{log}</div>)}
          </div>
        </div>
        <button type="button" onClick={onDonate} className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-2.5 text-sm font-extrabold text-white shadow-md shadow-indigo-500/20 transition-colors hover:bg-indigo-700">
          <Crown className="h-4 w-4" /> Nâng cấp gói
        </button>
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-xs font-extrabold text-indigo-700">U</span>
          <span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-700">Tài khoản hiện tại</span>
          <button type="button" onClick={onSignOut} className="text-slate-400 transition-colors hover:text-rose-600" title="Đăng xuất">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
