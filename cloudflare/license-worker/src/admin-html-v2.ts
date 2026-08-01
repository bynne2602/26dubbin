import { RESTORED_ADMIN_HTML } from "./admin-html";

const ADMIN_THEME = `<style>
:root{color-scheme:light;--bg:#f6f7fb;--card:#fff;--line:#e1e5ee;--muted:#737d91;--primary:#654cf0;--green:#15956e;--red:#d94b62}
html{min-width:320px;background:var(--bg)}
body{min-width:320px;background:radial-gradient(circle at 50% -130px,#eae7ff 0,transparent 440px),var(--bg);color:#151829;font-family:"Be Vietnam Pro",system-ui,-apple-system,"Segoe UI",sans-serif}
.shell{width:calc(100% - 32px);max-width:1160px;margin-left:auto;margin-right:auto;padding:30px 0 60px}
.logo{display:block;width:46px;height:46px;border-radius:14px;object-fit:cover;background:none;box-shadow:0 10px 28px rgba(101,76,240,.25)}
.eyebrow{color:#654cf0}.top h1{color:#151829}.state{color:#737d91;background:#fff;border-color:#e1e5ee}.state.ok{color:#15825f;background:#eefaf6;border-color:#bee8da}
.auth,.card{background:rgba(255,255,255,.97);border-color:#e1e5ee;box-shadow:0 14px 40px rgba(27,35,58,.06)}
.grid{grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr)}.card{min-width:0}.head{border-color:#edf0f5}.head h2{color:#151829}.head p,.muted,.empty{color:#737d91}
.fields{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}label{color:#4f596c}input,select,textarea{min-width:0;background:#fafbfe;border-color:#d9deea;color:#151829}input:focus,select:focus,textarea:focus{border-color:#735dff;box-shadow:0 0 0 3px rgba(115,93,255,.1)}
.count,.stat{background:#f1efff;border-color:#e3dfff;color:#5d49d7}.stat b{color:#151829}.trial{background:#fafbfe;border-color:#e2e6ef}.table{color:#252a38}th,td{border-color:#edf0f5}th{color:#7b8598}.mini{background:#f7f8fb;border-color:#dfe3ec;color:#303747}.mini.red{background:#fff5f6;color:#c7465b;border-color:#f1cbd2}.secondary{background:#f3f1ff;color:#5b47dc;border-color:#ded8ff}.result{background:#effaf6;border-color:#bfe5d8}.toast{box-shadow:0 16px 42px rgba(23,29,48,.18)}
@media(max-width:780px){.shell{width:calc(100% - 24px);margin-left:auto;margin-right:auto}.grid{grid-template-columns:minmax(0,1fr)}.fields{grid-template-columns:minmax(0,1fr)}.top{padding-inline:2px}.brand{min-width:0}.top h1{font-size:20px}.keyrow{flex-direction:column}.keyrow .btn{width:100%}.toast{left:12px;right:12px;bottom:12px;text-align:center}}
</style>`;

export const ADMIN_HTML_V2 = RESTORED_ADMIN_HTML
  .replace("</head>", `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700;800&display=swap" rel="stylesheet">${ADMIN_THEME}</head>`)
  .replace('<div class="logo">D</div>', '<img class="logo" src="/assets/logo.png" alt="DubbinTool">');
