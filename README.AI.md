# 26Dubbin — AI-Readable README

> This file is written for AI coding agents (Copilot, Cursor, Claude Code, etc.), not for marketing.
> It contains dense, unambiguous facts about the repository: what each file does, how data flows,
> which commands are safe, and which invariants must never be broken.
> Human-facing docs: [`README.md`](README.md). Agent behavior rules (Vietnamese): [`AGENTS.md`](AGENTS.md).
> Accumulated bug lessons: [`ASSISTANT_LESSONS.md`](ASSISTANT_LESSONS.md).

## 1. Identity

- Product name: `26Dubbin` (codebase name: `DubbinTool`, npm package `dubbintool`).
- Type: proprietary Windows desktop app (Electron) for AI video dubbing + auto-subtitles in Vietnamese.
- Current version: read from `package.json` → `version` (1.2.5 at time of writing). Do not hardcode elsewhere.
- Website: `https://dubbintool.io.vn`. Auth/license/PayOS backend: Cloudflare Worker `dubbintool-auth`.
- Language of UI strings: Vietnamese. Language of code identifiers/comments: English (some legacy Vietnamese comments).

## 2. Process model (what talks to what)

```
Electron main (electron/main.ts)
 ├─ spawns local Express server (dist/server.cjs from server.ts) as child process
 ├─ provisions native runtimes on first run: ffmpeg, OCR engine, separation model, llama.cpp TTS
 └─ exposes IPC: getHWID, getPathForFile, update/runtime status (electron/preload.ts → window.electronAPI)

React renderer (src/)
 ├─ HTTP → local Express server (http://localhost:<port>/api/...)  [all heavy work]
 └─ HTTPS → Cloudflare auth worker via server proxy /api/auth/*    [accounts, license, payment]

Express server (server.ts, single file, ~5k lines)
 ├─ spawns Python workers from scripts/ (OCR, render, TTS, alignment, separation)
 ├─ spawns native ffmpeg.exe (from bundled ocr-engine resources or imageio-ffmpeg)
 ├─ proxies /api/auth/* to https://dubbintool.io.vn/api/auth/* (any method + query, verbatim)
 └─ proxies paid TTS to https://dubbintool.io.vn/api/tts with { licenseKey, hwid } (server-side verified)
```

- The browser/Electron renderer NEVER talks to the auth worker directly; always through the local server proxy.
- Access gating fact: `hasActiveAccess` comes from worker `/api/auth/me` (D1 subscription row). The UI blocks on it (`authedNoAccess` state in `StudioWorkspace.tsx` → pricing screen). Open-sourcing this repo does not bypass payment because the subscription lives server-side.

## 3. Key files and their roles

| Path | Role |
|---|---|
| `server.ts` | Local Express server: all `/api/*` routes, Python job spawning, ffmpeg resolution (`resolveNativeFfmpeg`), auth proxy, PayOS proxying. |
| `electron/main.ts` | App lifecycle, spawns server, single-instance lock, auto-update, runtime install orchestration. |
| `electron/preload.ts` | `window.electronAPI` bridge (HWID, file paths, update events). |
| `electron/ocrRuntime.ts`, `ffmpegRuntime.ts`, `separationRuntime.ts`, `cloakBrowserRuntime.ts` | Download/verify/extract runtime archives (`tar.exe -xf`). See §7 non-ASCII trap. |
| `src/flows/studio/StudioWorkspace.tsx` | Main component (~9.6k lines). Holds most app state, pricing/login screens (`authedNoAccess` block), `handleBuyNow`, render orchestration, and `createXxx` memoized helper factories whose dependency arrays must include every ref/state used. |
| `src/flows/studio/dubshorts/DubShortsRender.ts` | Dub Shorts pipeline (`createHandleDubShorts`). Batch callers MUST pass `awaitCompletion: true` or it returns `undefined` URL. |
| `src/tabs/*.tsx` | Feature tabs: Auto Dubbing lives inside StudioWorkspace; `AiScriptShortsTab.tsx`, `TranslationTab.tsx`, `SubtitleExtractionTab.tsx`, `TimelineEditorTab.tsx`, `CopyrightCheckerTab.tsx`, `NarrationTab.tsx`, `NewsShortTab.tsx`, `StickFigureTab.tsx`, `ProjectLibraryTab.tsx`, `SettingsTab.tsx`, `AdminPanel.tsx`. |
| `src/lib/licenseAuth.ts` | Auth client: register/login/refresh/me, `PLAN_LABELS`, `getPlanLabel`, `getRemainingLabel`, checkout order creation, admin endpoints (`authAdminUsers/Orders/Stats/Grant/Revoke`), types `MeResult`, `AdminUserRow`, `PaymentPlan`. |
| `cloudflare/auth-worker/src/index.ts` | THE license/payment/auth truth: JWT (HS256, `JWT_SECRET`), PBKDF2-SHA256 100k passwords (`salt$hash`), D1 queries, PayOS order create/verify, `PAYOS_PLANS`, `requireAuth`/`requireAdmin`, `hasActiveAccess` computation, admin grant/revoke. |
| `cloudflare/auth-worker/migrations/*.sql` | D1 schema migrations. `0003_add_role.sql` added `users.role` (`'user'`/`'admin'`). Apply with `wrangler d1 execute ... --remote`. |
| `scripts/ocr_video_stream.py` | Streaming OCR extraction over a video (used by OCR pipeline `src/flows/studio/ocrPipeline.ts`). |
| `scripts/ocr_frame.py` | Single-frame/batch OCR. `OCR_TEXT_MODE=chinese` default: keep CJK/mixed, reject Latin-only artifacts. |
| `scripts/render_video.py` | Final MP4 export via native ffmpeg subprocess (libx264 + aac). Readiness: `GET /api/render/verify`. |
| `scripts/vieneu_tts.py` | VieNeu neural TTS worker (local model, batch generation). |
| `scripts/align_voice_words.py` | Word-level alignment for subtitle sync. |
| `scripts/video_similarity.py` | Copyright checker (chromaprint/fpcalc based). |
| `src/server/licenseDb.ts` | Local legacy license-key store (`verifyLicense(key, hwid)`) — separate from the account system; do not remove, old users depend on `/api/license/*`. |
| `build/electron-builder.update.cjs` / `.full.cjs` | Packager configs: update channel (no runtime inside) vs full channel (embeds runtimes). |
| `release-runtime-v5/`, `release-runtime-v6/` | Split runtime archives + manifests published for download by the app. Source changes are NOT released until a new archive + manifest exists here. |

## 4. Data flow: the core dubbing pipeline

1. User picks video file(s) → OCR: `ocrPipeline.ts` → `POST /api/ocr/stream` → `scripts/ocr_video_stream.py` → cues list (multi-frame identical text = ONE cue).
2. Cues → translation: `POST` to server → Gemini API (user key from Settings, or server custom API) with glossary + style per tab/mode (separate localStorage keys, e.g. `26dubbin_dub_translation_glossary`).
3. Translated text → TTS: engine `vieneu` (local, via `synthesizeVieNeu` in server.ts) | `tiktok` | `google` (paid, proxied through `dubbintool.io.vn/api/tts` with licenseKey+hwid).
4. Audio clips → timeline placement → `scripts/render_video.py` → final MP4 (subtitle overlay + blur/ROI boxes, same coordinate system as preview).
5. Checkpoints are written per stage; resume MUST produce byte-equivalent results to a fresh run for unchanged content. Timestamp-only edits reuse WAV; only text changes trigger re-TTS.

## 5. Commands (allowed without asking)

```bash
npm run dev                # local dev server (tsx) — does not touch production
npm run build              # vite bundle + esbuild server bundle → dist/
npm run build:electron     # build + electron main/preload bundles
npm run lint               # tsc --noEmit (see §8 known pre-existing errors)
npm run test:ocr-dedupe    # + test:subtitle-optimizer, test:subtitle-sizing, test:video-hub
```

Destructive / gated commands (ONLY on explicit user instruction):
```bash
npm run electron:pack:update   # "build"/"đóng gói": current version, no bump
npm run electron:pack:full     # full installer with runtimes
npx wrangler deploy            # auth worker → production
npx wrangler d1 execute dubbintool-auth-db --remote ...   # PRODUCTION DB
```
Versioning rule: `pack`/`push` ⇒ bump patch in `package.json` + `package-lock.json` first, then `electron:pack:update`. Never pack unprompted.

## 6. Environment variables (names only — values are secrets, never commit)

Local `.env` (gitignored): `GEMINI_API_KEY`, `FREEBGMUSIC_API_KEY`, `DUBBIN_TTS_PROXY_URL`, `YOUTUBE_ADMIN_CLIENT_ID`, `YOUTUBE_ADMIN_CLIENT_SECRET`, `HWID` (injected by Electron), `FFMPEG_BINARY`, `OCR_RESOURCES_PATH`, `TIKTOK_SESSIONID`, `DUBBIN_FFMPEG_EXE` (server → Python workers).
Worker secrets (Cloudflare dashboard only, referenced as `env.X` in code): `JWT_SECRET`, `LICENSE_ADMIN_SECRET`, `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
Never add secret values to any tracked file; `.env.example` holds keys with empty values only.

## 7. Hard invariants (violating any = regression)

- **OCR**: same text across consecutive frames is ONE cue; rejected-Latin fragments must not survive as new cues.
- **TTS/dubbing**: one clip trimmed exactly once; never cut audio buffers to force-fit a slot; no voice overlap; re-TTS only when sentence text changed.
- **Render == Preview**: identical coordinate systems and configuration; a checkpoint/resume run must equal a fresh run.
- **Cancellation**: must stop the real backend/native worker, not just the UI state.
- **Caching**: never delete successful caches/checkpoints during cancel/retry handling.
- **Runtime archives**: file names inside runtime zip payloads MUST be pure ASCII — Windows `tar.exe` (bsdtar) crashes creating non-ASCII zips and skips UTF-8-EFS entries on extract. Build payloads with `scripts/zip_runtime.py` (python zipfile), never `tar -cf`.
- **Release honesty**: a source change to runtime code is NOT released until a new archive + manifest exists in `release-runtime-v*/` and the app can download it.

## 8. Known traps and repo quirks

- `src/flows/studio/StudioWorkspace-backup.tsx` and `StudioWorkspace1.tsx` and `backups/**` contain pre-existing `tsc` errors (`apiPlatform`). Do NOT fix or touch them; filter them out of lint output.
- New JSX icons must be added to the `lucide-react` import list in the same edit — a missing import causes a blank white screen at runtime that Vite build does NOT catch. Two historical incidents (Settings2, Film).
- `createXxx(...)` memoized factories in StudioWorkspace: any new ref/state used inside must be added to that factory's dependency array, or the pipeline uses stale closures.
- Python trap: `locals()[name] = value` does not write local variables — assign directly or return new arrays from helpers.
- Batch async pipelines with `awaitCompletion` flags: batch callers must await, or UI reports false success with empty output paths.
- The repo root currently has NO `.git` directory (working copy, not initialized). Before any GitHub push: remove/ignore `.env.api` (contains a real API key), `data/youtube-admin-studio-profile/`, `data/youtube-admin-chrome/` (logged-in session cookies), `**/.wrangler/`, model weights (`build/*.gguf`, `training/**/merged-hf`, `models/`, `public/models/`, `resources/ocr-engine/`), and `release-runtime-v*` archives.
- D1/PowerShell: escape single quotes as `''` inside SQL strings; wrangler `--json` output has non-JSON preamble — slice from first `[`. Terminal mojibake of Vietnamese is display-only; verify with `length()` vs `length(CAST(x AS BLOB))`.

## 9. Admin & licensing system (production facts)

- `users.role` column gates admin. Worker endpoints: `GET /admin/users|orders|stats`, `POST /admin/grant`, `POST /admin/revoke` — all behind `requireAdmin()` (403 `{code:"forbidden"}` for non-admins).
- Admin UI: `src/tabs/AdminPanel.tsx`, rendered in Settings only when `account.me.isAdmin` and a `getAdminToken` prop is supplied.
- Admin accounts hold a real `forever` subscription (`expires_at NULL`) so gating code paths stay uniform.
- Passwords: PBKDF2-SHA256, 100k iterations, stored as `salt$hash` hex — reproducible offline with `crypto.pbkdf2Sync`.
- PayOS plans defined once in worker `PAYOS_PLANS`: `1m=99000`, `6m=499000`, `1y=999000`, `forever=1999000` (VND). The app pricing table (`StudioWorkspace.tsx`, `licensePlans`) must stay in sync with these ids/prices.

## 10. Definition of done for any change

1. Reproduce or find evidence (log/code/checkpoint) — no blind fixes.
2. Minimal-scope edit; state which invariants (§7) the change preserves.
3. Static check: `npm run lint` (filtered per §8) + `npm run build`.
4. Behavior test on real data/fixture when the change touches OCR/TTS/render/payments.
5. Report completion at the correct level only: code changed / statically checked / behavior tested / packaged / runtime released.
