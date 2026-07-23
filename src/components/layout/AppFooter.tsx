import type { StudioRoute } from "../../app/routes";

export default function AppFooter({ activeRoute }: { activeRoute: StudioRoute }) {
  const hidden = activeRoute === "translate" || activeRoute === "projects" || activeRoute === "settings";
  return (
    <footer className={`mt-20 border-t border-slate-200/80 bg-white lg:ml-64 ${hidden ? "hidden" : ""}`} id="footer">
      <div className="mx-auto max-w-7xl px-6 py-12">
        <div className="grid grid-cols-1 gap-8 border-b border-slate-100 pb-8 md:grid-cols-12">
          <div className="flex flex-col gap-3 md:col-span-6">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-100 bg-slate-900 shadow-sm" id="footer-logo"><img src="/logo.png" alt="Logo" className="h-full w-full object-cover" /></div>
              <span className="text-base font-extrabold tracking-tight text-slate-950">26Dubbin</span>
            </div>
            <p className="max-w-md text-xs font-medium leading-relaxed text-slate-500">Nền tảng biên tập, dịch thuật phụ đề AI và làm mờ phụ đề gốc. Tích hợp các engine AI để xử lý video chính xác và nhanh chóng.</p>
          </div>
          <div className="flex flex-col gap-2 md:col-span-3">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-900">Tính năng cốt lõi</span>
            <ul className="space-y-1.5 text-xs font-semibold text-slate-500">
              {['Dịch thuật tự động AI', 'Kiểm duyệt & làm mờ phụ đề gốc', 'Xuất SRT, VTT và JSON'].map((label) => <li key={label} className="flex items-center gap-1.5"><span className="h-1 w-1 rounded-full bg-[#4f46e5]" />{label}</li>)}
            </ul>
          </div>
          <div className="flex flex-col gap-2 md:col-span-3">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-900">Công nghệ tích hợp</span>
            <div className="mt-1 flex flex-wrap gap-2">{['Gemini AI', 'React', 'Tailwind CSS'].map((label) => <span key={label} className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">{label}</span>)}</div>
          </div>
        </div>
        <div className="flex flex-col items-center justify-between gap-4 pt-8 sm:flex-row">
          <p className="text-xs font-medium text-slate-400">© 2026 26Dubbin. All rights reserved.</p>
          <p className="max-w-sm text-[11px] font-medium leading-relaxed text-slate-400 sm:text-right">Xử lý video, phụ đề và giọng đọc trong một workflow thống nhất.</p>
        </div>
      </div>
    </footer>
  );
}
