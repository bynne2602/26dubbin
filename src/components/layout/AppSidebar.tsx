import {
  Coffee,
  FileText,
  FolderOpen,
  LogOut,
  Megaphone,
  Settings,
  SlidersHorizontal,
  Video,
} from "lucide-react";
import type { StudioRoute } from "../../app/routes";

type AppSidebarProps = {
  activeRoute: StudioRoute;
  onNavigate: (route: StudioRoute) => void;
  onDonate: () => void;
  onSignOut: () => void;
};

const NAV_ITEMS = [
  { route: "translate", label: "Tool Auto Dubbing", icon: Video },
  { route: "projects", label: "Thư viện dự án", icon: FolderOpen },
  { route: "style", label: "Cá nhân hóa", icon: SlidersHorizontal },
  { route: "tracks", label: "Bản dịch", icon: FileText },
  { route: "tts", label: "Thuyết minh", icon: Megaphone },
  { route: "settings", label: "Cài đặt", icon: Settings },
] satisfies Array<{ route: StudioRoute; label: string; icon: typeof Video }>;

export default function AppSidebar({ activeRoute, onNavigate, onDonate, onSignOut }: AppSidebarProps) {
  return (
    <aside className="fixed inset-y-0 left-0 z-[60] hidden w-64 flex-col border-r border-slate-200 bg-white px-3 py-4 shadow-[8px_0_30px_rgba(15,23,42,0.04)] lg:flex">
      <div className="flex items-center gap-3 border-b border-slate-100 px-2 pb-5">
        <div className="h-10 w-10 overflow-hidden rounded-xl border border-indigo-100 bg-slate-900 shadow-lg shadow-indigo-500/15">
          <img src="/logo.png" alt="26Dubbin" className="h-full w-full object-cover" />
        </div>
        <div>
          <p className="text-base font-extrabold tracking-tight text-slate-900">26Dubbin</p>
          <p className="text-[10px] font-semibold text-slate-400">AI DUBBING STUDIO</p>
        </div>
      </div>

      <nav className="mt-6 flex flex-col gap-1.5" aria-label="Điều hướng chính">
        {NAV_ITEMS.map(({ route, label, icon: Icon }) => (
          <button
            key={route}
            type="button"
            onClick={() => onNavigate(route)}
            className={`flex items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-bold transition-all ${activeRoute === route ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" : "text-slate-600 hover:bg-indigo-50 hover:text-indigo-700"}`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </nav>

      <div className="mt-auto space-y-3">
        <button type="button" onClick={onDonate} className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-3 py-2.5 text-sm font-extrabold text-white shadow-md shadow-amber-500/20 transition-colors hover:bg-amber-600">
          <Coffee className="h-4 w-4" /> Donate
        </button>
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-2">
          <img src="/donate-qr.png" alt="Mã QR Donate" className="aspect-square w-full rounded-xl object-contain" />
        </div>
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
