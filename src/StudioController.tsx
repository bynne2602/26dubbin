import React, { useState, useRef, useEffect, useMemo } from "react";
import { 
  Upload, Play, Pause, Download, Languages, Sliders, Type, Edit3, 
  Check, Trash2, Plus, Volume2, Video, FileText, SlidersHorizontal, Info, Eye, EyeOff,
  Megaphone, VolumeX, RefreshCw, Sparkles, Music, Crown, X, Layers, Settings, Activity, Cpu, LogOut, Lock,
  Key, FolderOpen, Calendar, Infinity, ChevronDown, Copy
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Subtitle, BlurSettings, SubtitleSettings, BlurBox, OcrRegion } from "./types";
import { verifyLicenseKey, saveLicense, clearLicense, checkSavedLicense, getHwid, getRemainingLabel, getPlanLabel, type LicenseEntry } from "./lib/licenseAuth";
import AppSidebar from "./components/layout/AppSidebar";
import AppNavbar from "./components/layout/AppNavbar";
import AppFooter from "./components/layout/AppFooter";
import TranslationConfigPanel from "./components/TranslationConfigPanel";
import type { StudioRoute } from "./app/routes";
import AutoDubbingLayout from "./layouts/AutoDubbingLayout";
import ProjectLibraryLayout from "./layouts/ProjectLibraryLayout";
import PersonalizationLayout from "./layouts/PersonalizationLayout";
import TranslationLayout from "./layouts/TranslationLayout";
import NarrationLayout from "./layouts/NarrationLayout";
import SettingsLayout from "./layouts/SettingsLayout";
import { bufferToWavAsync, pcmToWav, sliceAudioBuffer, getAudioChunkBase64, trimAudioBufferSilence, countSpeechCharacters, median, concatenateAudioBlobs, extractAudioTrack } from "./lib/audio";
import { type ChunkSubtitle, isSubtitleTranslationMissing, normalizeSubtitleText, mergeDuplicateSubtitles, normalizeChunkSubtitleTimestamps, validateSubtitleTimeline, formatTtsTime, formatEstimatedTime, SMART_TTS_MIN_RATE, SMART_TTS_MAX_RATE, SMART_TTS_VOICE_GAP_SECONDS, getSubtitleGapAfter, computeSmartTtsRate, splitTtsTextIntoClauses } from "./lib/subtitle";
import { projectDbPut, projectDbGet, projectDbGetAll, projectDbDelete, makeProjectId, stableHash, PROJECT_POINTER_KEY, type StoredProject, type StoredProjectMedia, type StoredPreparedVoiceover, type StoredChunk, type StoredOcrCheckpoint, type StoredTtsClip, type ProjectLibraryItem, type OcrRegionPreset } from "./lib/projectDb";
import { type OcrDetection, type OcrFrameResult, type OcrServiceHealth, type OcrRuntimeProfile, DEFAULT_OCR_REGIONS, getOcrRuntimeProfile, cleanOcrText, isLikelyOcrWatermark, normalizedOcrText, ocrSimilarity, mergeOcrFramesToSubtitles, readJsonResponse } from "./lib/ocr";
import { extractVideoFrames, captureVideoFrame, canvasToPngBlob } from "./lib/videoCapture";
import { type BurnedSubtitleAsset, type VoiceTiming, BLUR_COVER_PRESETS, parseBlurCoverColor, getBlurCoverPresetKey, getBlurCoverCssColor, getBlurCoverFfmpegColor, createBurnedSubtitleAsset, createTransparentSubtitleFrame, verifyBurnedSubtitlePixels } from "./lib/burnSub";
import { getFittedSubtitleFrame, getSubtitleExportFrame, getSubtitleVisualScale } from "./lib/subtitleSizing";
import { DEFAULT_SUBTITLE_SETTINGS, DEFAULT_BLUR_SETTINGS, SAMPLE_SUBTITLES } from "./lib/constants";
import SettingsTab from "./tabs/SettingsTab";

const ProjectLibraryTab = React.lazy(() => import("./tabs/ProjectLibraryTab"));
const PersonalizationTab = React.lazy(() => import("./tabs/PersonalizationTab"));
const TranslationTab = React.lazy(() => import("./tabs/TranslationTab"));
const NarrationTab = React.lazy(() => import("./tabs/NarrationTab"));
const SubtitleExtractionTab = React.lazy(() => import("./tabs/SubtitleExtractionTab"));
const TimelineEditorTab = React.lazy(() => import("./tabs/TimelineEditorTab"));
const AiScriptShortsTab = React.lazy(() => import("./tabs/AiScriptShortsTab"));

function parseGeminiApiKeys(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\r\n,;]+/)
      .map((key) => key.trim())
      .filter(Boolean),
  ));
}

function getGeminiRequestHeaders(value: string): Record<string, string> {
  const keys = parseGeminiApiKeys(value);
  if (keys.length === 0) return {};
  return {
    "x-gemini-api-keys": JSON.stringify(keys),
    "x-gemini-api-key": keys[0],
  };
}

function sanitizeCustomApiBaseUrl(value: string): string {
  return value
    .trim()
    .replace(/^(?:POST|GET|PUT|PATCH|DELETE)\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

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

type StudioControllerProps = {
  activeRoute: StudioRoute;
  onNavigate: (route: StudioRoute) => void;
};

type PipelineStage = "ocr-translation" | "tts" | "smart-tts" | "render";
type PipelineJob = {
  id: string;
  stage: PipelineStage;
  label: string;
  status: "running" | "paused" | "cancelling";
  startedAt: number;
  lastHeartbeatAt: number;
};

const RELEASE_NOTES: Record<string, string[]> = {
  "1.1.4": [
    "Khôi phục OCR Engine tự động cho các máy bị mất runtime sau khi cập nhật nhẹ.",
    "Sửa lỗi di chuyển OCR khi thư mục cài đặt và LOCALAPPDATA nằm trên hai ổ đĩa khác nhau.",
    "OCR được lưu bền vững trong runtime-v2 để các bản cập nhật nhẹ sau không xóa nhầm.",
  ],
  "1.1.3": [
    "AI Script Shorts mặc định giọng đọc 1.13x, cao độ +3% và nhạc nền 12%.",
    "Tách subtitle karaoke lên vùng Y=1220 để không chồng lên tag tiêu đề trong 3 giây đầu.",
    "Làm mới tag tiêu đề gọn, nền đen mờ và có đường nhấn trắng rõ ràng hơn.",
    "Thêm outro 1 giây: hình ảnh và nhạc nền mờ dần sang đen sau khi voice kết thúc.",
  ],
  "1.1.2": [
    "AI Script Shorts không còn ép kịch bản hoặc video đạt tối thiểu 60 giây.",
    "Video kết thúc chính xác theo voice và chỉ giới hạn tối đa 90 giây.",
    "Phụ đề hiển thị từng từ tại vùng an toàn Y=1400 của khung dọc 1080×1920.",
    "Giữ chữ trắng viền đen và tô karaoke vàng đúng theo timestamp giọng đọc.",
  ],
  "1.1.1": [
    "AI Script Shorts: phụ đề karaoke trắng, viền đen và tô vàng theo đúng voice.",
    "Đưa phụ đề lên vùng an toàn giữa-thấp để dễ đọc trên video dọc.",
    "Video ngắn hơn voice sẽ tự loop; video dài hơn voice tự cắt đúng điểm kết thúc.",
    "Loại bỏ nền đen, frame đứng và nhạc nền chạy dư sau khi voice kết thúc.",
  ],
  "1.1.0": [
    "Ra mắt AI Script Generate: dán link video, AI phân tích nội dung, viết kịch bản mới, tạo TTS, nhạc nền, phụ đề động và render Shorts 9:16.",
    "Bổ sung trình chỉnh sửa timeline nhẹ, tối ưu timestamp voice/phụ đề, preview video và lưu sản phẩm AI Shorts vào thư viện riêng.",
    "Nâng cấp PP-OCRv5, lọc trùng phụ đề, checkpoint dịch/TTS và quy trình render tự phục hồi khi encoder gặp lỗi.",
    "Đồng bộ giao diện, sidebar, bảng giá, updater và bộ cài Full/Update cho phiên bản 1.1.0.",
  ],
  "1.0.29": [
    "Thêm mã QR và nút tham gia nhóm Zalo ngay trên màn hình kích hoạt để người dùng nhận key thuận tiện hơn.",
    "Giữ link Zalo dự phòng hoạt động ngay cả khi ảnh QR chưa tải được.",
  ],
  "1.0.28": [
    "OCR giữ mốc xuất hiện đầu tiên của hardsub sau bước xác nhận chống nhiễu, giảm tình trạng phụ đề bị vào chậm.",
    "Thêm Quét phần phụ đề còn thiếu: bỏ qua các timestamp đã OCR và chỉ xử lý những khoảng timeline còn trống.",
    "Tab Lồng tiếng hiển thị TTS theo từng câu, có trạng thái, nghe thử và tạo lại riêng từng dòng.",
    "Tab Bản dịch bổ sung nút dịch lại riêng cho từng dòng phụ đề.",
    "Nâng cấp đăng ký trial theo HWID: mỗi thiết bị chỉ gửi một lần, admin duyệt thủ công và chỉ cấp đúng 1 ngày.",
  ],
  "1.0.27": [
    "Cập nhật one-click có cửa sổ tiến trình rõ ràng; không còn tình trạng app đóng rồi cài âm thầm mà không báo trạng thái.",
    "Bỏ toàn bộ bước chọn phạm vi và Next/Back: tải xong, hiển thị tiến trình cài, sau đó tự mở lại DubbinTool.",
    "Phát hành song song gói cập nhật và Full Setup đầy đủ cho người cài mới từ website.",
  ],
  "1.0.26": [
    "Đồng bộ âm lượng video gốc trong Trình chỉnh sửa với đúng thiết lập của Tool Auto.",
    "Thay đổi âm lượng ở Tool Auto được áp dụng ngay khi mở hoặc quay lại Trình chỉnh sửa.",
    "Tiếp tục dùng bộ cập nhật one-click và giữ kèm PP-OCRv5 cho máy nâng cấp trực tiếp từ bản cũ.",
  ],
  "1.0.25": [
    "Cập nhật one-click: bỏ hoàn toàn bước chọn Only me/All users và màn hình Next khi nâng cấp.",
    "Sau khi tải xong, ứng dụng tự đóng, cài bản mới vào đúng phạm vi người dùng hiện tại và tự mở lại.",
    "Tiếp tục mang runtime PP-OCRv5 trong gói để người dùng đi thẳng từ 1.0.23 không bị thiếu OCR.",
  ],
  "1.0.24": [
    "Nâng OCR video lên PP-OCRv5 Mobile, PaddleOCR 3.5 và PaddlePaddle GPU 3.1.1 tương thích CUDA 11.8.",
    "Runtime OCR v2 tách biệt hoàn toàn với PP-OCRv4 cũ, tự chạy GPU và fallback CPU khi thiết bị không tương thích.",
    "Thêm debounce hai lần đọc liên tiếp trước khi chốt câu mới, loại lỗi một frame mờ làm tách phụ đề.",
    "Sắp xếp box theo vị trí, khử detection chồng nhau và khóa chuỗi OCR ổn định để không dao động dấu/ký tự.",
    "Dùng fuzzy thích ứng theo độ dài và bỏ dấu tiếng Việt; giảm trùng nhưng không gộp nhầm các câu ngắn.",
    "Giảm refresh OCR thừa xuống 1,8 giây; benchmark vùng phụ đề GPU đạt khoảng 0,03–0,06 giây mỗi lần inference sau warm-up.",
    "Import video hiển thị preview ngay, lưu checkpoint nền và chỉ trích audio khi workflow STT thực sự cần.",
    "Trình chỉnh sửa phát Voice TTS theo playhead, đồng bộ style phụ đề và có nút Tối ưu timestamp chống chồng clip.",
    "Cập nhật trong app cài im lặng, giữ nguyên phạm vi người dùng và thư mục cài đặt hiện tại.",
  ],
  "1.0.23": [
    "Thêm Trình chỉnh sửa timeline nhẹ dành riêng cho phụ đề, Voice TTS và Blur Box.",
    "Tool Auto dừng trước render và cho chọn Render ngay, Tinh chỉnh timeline hoặc Để sau.",
    "Cho phép kéo, đổi độ dài, tách, gộp và xóa clip; subtitle và voice được liên kết để không lệch nội dung.",
    "Thêm zoom timeline, snap timestamp, playhead, cảnh báo overlap và Undo/Redo tối đa 100 thao tác.",
    "Blur Box có thời gian bắt đầu/kết thúc riêng và renderer chỉ áp dụng đúng khoảng đã đặt.",
    "Editor dùng metadata và checkpoint hiện có, không bổ sung engine dựng phim nặng.",
    "Thêm Tối ưu phụ đề sau OCR: lọc trùng, làm sạch ký tự rác, gộp dòng đồng thời và sửa timestamp chồng lấn.",
    "Thêm Retry bản dịch chỉ gửi lại câu trống hoặc còn giống nguyên văn; giữ nguyên mọi batch đã dịch thành công.",
    "Custom API thiếu cấu hình tự chuyển sang Gemini; AI trả thiếu dòng không còn được ghi nhận giả là dịch thành công.",
    "Sửa Hủy tác vụ dịch, Undo timestamp/Blur trong Editor và tách đúng cả nội dung gốc lẫn bản dịch.",
  ],
  "1.0.22": [
    "Render tự phân tích lỗi FFmpeg và thử lại tối đa 3 chiến lược mà không chạy lại OCR, dịch hoặc TTS.",
    "Tự chuyển từ GPU sang CPU libx264 nếu encoder phần cứng gặp lỗi giữa chừng.",
    "Thêm chế độ tương thích ít luồng, sửa timestamp, bỏ frame hỏng và tăng muxing queue khi nguồn video không ổn định.",
    "Nếu audio gốc bị lỗi, hệ thống tự bỏ riêng audio gốc nhưng vẫn giữ đầy đủ voice thuyết minh.",
    "Nhật ký hiển thị từng lần tự phục hồi và popup cuối liệt kê nguyên nhân của mọi chiến lược đã thử.",
  ],
  "1.0.21": [
    "Sửa Smart TTS nhận diện phần tràn cộng dồn toàn track thay vì chỉ kiểm tra từng câu riêng lẻ.",
    "Tự chọn và rút gọn các câu phù hợp, kể cả câu ngắn, đồng thời bỏ qua câu rỗng hoặc chỉ có dấu ba chấm.",
    "Thêm time-stretch giữ nguyên cao độ làm lớp bảo vệ cuối, tránh dừng render vì phần timing dư rất nhỏ.",
    "Nếu voice cuối dài hơn video không quá 2 giây, video final tự nối nền đen để phát hết lời đọc.",
    "Phần voice dư trên 2 giây bắt buộc quay lại Smart TTS để cân timing, không kéo dài video mất kiểm soát.",
  ],
  "1.0.20": [
    "Đồng bộ tuyệt đối tỷ lệ phụ đề giữa preview và video final theo cùng một khung tham chiếu.",
    "Font, viền, bóng, nền, padding, bo góc, xuống dòng và vị trí cùng co giãn theo kích thước khung hình.",
    "Sửa preview lấy nhầm kích thước vùng chứa khiến subtitle không co giãn đúng khi thay đổi cửa sổ.",
    "Thay popup cập nhật Windows bằng thông báo DubbinTool có tiến độ tải và nút khởi động lại để cài.",
  ],
  "1.0.19": [
    "Chuẩn hóa Font size theo pixel của video xuất: đặt 18px sẽ render đúng 18px ở file final.",
    "Không còn tự thu nhỏ cỡ chữ khi video nguồn là 2K hoặc 4K.",
    "Đồng bộ cả hai khu vực preview với kích thước subtitle thực tế.",
  ],
  "1.0.18": [
    "Sửa lỗi cỡ phụ đề render bị sai hoặc quá nhỏ so với font size đã đặt.",
    "Preview và video xuất dùng cùng quy tắc scale theo kích thước khung hình.",
    "Log render hiển thị cỡ chữ thực tế sau khi scale để dễ kiểm tra.",
  ],
  "1.0.17": [
    "Thêm chẩn đoán FFmpeg, encoder GPU/CPU, OCR, RAM và dung lượng ổ đĩa trong Cài đặt.",
    "Render kiểm tra quyền ghi và dung lượng trống trước khi chạy, giảm lỗi ở phút cuối.",
    "Lưu video theo file .partial, hiển thị tiến độ và chỉ đổi sang MP4 sau khi xác minh thành công.",
    "Tự khôi phục giao diện khi renderer gặp sự cố; checkpoint dự án vẫn được giữ nguyên.",
    "Nhật ký đầy đủ được lưu ra file để mở và gửi khi cần hỗ trợ kỹ thuật.",
  ],
  "1.0.16": [
    "Thêm FFmpeg Runtime Manager: tự tải, xác minh SHA-256, giải nén và cache runtime phù hợp khi máy chưa có.",
    "Tự kiểm tra encode thật và chọn NVIDIA NVENC, Intel Quick Sync, AMD AMF hoặc CPU libx264 theo thiết bị.",
    "Runtime FFmpeg universal chỉ tải một lần khoảng 31 MB; các bản cập nhật nhẹ sau không đóng gói lại binary này.",
    "Nhật ký render hiển thị chính xác encoder đang hoạt động thay vì chỉ báo GPU/CPU chung chung.",
  ],
  "1.0.15": [
    "Sửa renderer trắng toàn bộ sau khi render 100% do video lớn bị nhân bản qua Blob, ArrayBuffer, chuỗi nhị phân và Base64.",
    "Electron main process stream video hoàn chỉnh trực tiếp từ server xuống file đích, giảm mạnh RAM và không còn giới hạn chuỗi V8.",
    "Không lưu thêm toàn bộ MP4 lớn vào IndexedDB sau render; checkpoint dự án và dữ liệu TTS/phụ đề vẫn được giữ nguyên.",
  ],
  "1.0.14": [
    "Đóng gói FFmpeg 7.1 tương thích riêng trong mọi bản cập nhật để render NVIDIA NVENC không phụ thuộc FFmpeg cài trên Windows.",
    "Ưu tiên encode video bằng GPU NVIDIA; chỉ fallback sang CPU libx264 khi phép kiểm tra NVENC thực tế thất bại.",
    "Nhật ký render hiển thị rõ encoder phần cứng hoặc CPU đang được sử dụng.",
  ],
  "1.0.13": [
    "Render video lớn được tải theo luồng nhị phân, không còn lỗi vượt giới hạn chuỗi 0x1fffffe8 khi đóng gói MP4 thành Base64.",
    "Tự kiểm tra và sử dụng NVIDIA NVENC để encode bằng GPU; tự chuyển về libx264 khi máy không hỗ trợ và ghi rõ engine trong nhật ký.",
    "Tối ưu giao diện tab Bản dịch: nhóm thao tác gọn hơn, cấu hình dịch thuật cuộn riêng và không che danh sách phụ đề.",
    "Thanh điều hướng đổi liên hệ sang nút Tham gia group Zalo.",
  ],
  "1.0.12": [
    "Sửa render dự án hàng nghìn phụ đề: gộp PNG thành một track concat, không còn vượt giới hạn command line Windows và thoát Python exit 1.",
    "Render giữ lại stderr/NDJSON cuối cùng để popup hiển thị nguyên nhân FFmpeg thật; hỗ trợ video gốc không có audio khi ghép voiceover.",
    "Smart TTS dừng ngay toàn bộ hàng đợi khi Session ID hoặc cấu hình sai, không retry ba lần trên hàng nghìn câu.",
    "TikTok TTS thêm cooldown chung, retry lệch nhịp và tự giảm luồng theo mức lỗi để tránh bão request; chỉ tăng lại khi kết nối ổn định.",
    "Câu rỗng hoặc chỉ có ký hiệu luôn được lưu checkpoint im lặng; nhánh tạo lại câu rút gọn có timeout, retry và báo lỗi thật.",
    "Sửa cache URL dùng chung cho câu trùng lặp và tăng timeout rút gọn theo batch lên 120 giây.",
  ],
  "1.0.11": [
    "Phụ đề chỉ có dấu câu như ... được chuyển thành checkpoint im lặng, không gọi TikTok TTS và không chặn Smart TTS finalize.",
    "Sửa TikTok báo nhầm Session ID hết hạn khi nội dung thực tế không có ký tự để đọc.",
    "Giữ bản sửa worker TTS thoát đúng khi hàng đợi kết thúc và chỉ hiển thị 100% sau khi finalize hoàn tất.",
  ],
  "1.0.10": [
    "Thông báo TTS lỗi giờ hiển thị nguyên nhân thật từ API, HTTP status hoặc timeout thay vì chỉ báo số thứ tự câu.",
    "Hiển thị nội dung câu lỗi, subtitle ID, TTS engine và voice để có thể sửa hoặc thử lại chính xác.",
    "Nhật ký lưu chi tiết từng câu thất bại; các câu thành công và checkpoint vẫn được giữ nguyên.",
  ],
  "1.0.9": [
    "Khôi phục tốc độ OCR video dài: chỉ nhận diện trong vùng OCR đã chọn thay vì quét toàn bộ khung hình.",
    "Giới hạn inference OCR thích ứng tối đa 5 lần/giây nhưng vẫn giữ timeline ở FPS người dùng chọn bằng kết quả cache liên tục.",
    "Sửa cảnh báo sai thiếu ocr_frame.py và tự kiểm tra lại OCR runtime sau trạng thái lỗi cũ.",
    "Giữ nguyên logic chống phụ đề trùng, checkpoint và khả năng hủy tác vụ an toàn.",
  ],
  "1.0.8": [
    "Thêm bộ điều khiển pipeline chung với nút Tạm dừng/Tiếp tục và Hủy tác vụ; hủy thật request đang chạy nhưng vẫn giữ toàn bộ checkpoint đã hoàn thành.",
    "Smart TTS finalize dùng hàng đợi giải mã giới hạn, timeout từng clip và hiển thị đúng tiến độ thay vì treo ở 100%.",
    "Tách rõ giai đoạn chuẩn bị và xuất bản: render final chỉ nạp track đã finalize rồi mux/encode, không gọi lại AI hoặc TTS.",
    "Thêm watchdog phát hiện tác vụ không có tiến triển để người dùng có thể hủy an toàn và chạy tiếp từ checkpoint.",
    "Cải thiện độ ổn định cho dự án dài: giảm tải đồng thời, checkpoint theo từng câu/batch và thông báo trạng thái rõ ràng hơn.",
  ],
  "1.0.7": [
    "Tách Smart TTS finalize khỏi bước render: track WAV, timing và câu rút gọn được lưu checkpoint; render chỉ mux/encode và không gọi lại AI/TTS.",
    "Smart TTS 4-pass: đo giọng tự nhiên, chia nhóm cue và mượn GAP an toàn, rút gọn theo ngữ cảnh rồi time-stretch giữ nguyên cao độ.",
    "TikTok TTS dùng hàng đợi thích ứng: khởi đầu 5 luồng, tự tăng tối đa 8 và tự giảm khi bị giới hạn hoặc timeout.",
    "Giữ checkpoint audio theo từng câu và retry có thời gian chờ tăng dần để tránh gọi dồn API.",
    "Danh sách và timeline phụ đề được tối ưu cho dự án hàng nghìn dòng, giảm mạnh số phần tử phải render.",
    "Batch dịch hoặc câu TTS lỗi không còn dừng toàn bộ hàng đợi; phần thành công vẫn tiếp tục và được lưu.",
    "Mã hóa WAV chạy trong Web Worker, thu hồi cache audio cũ và giảm tần suất cập nhật progress để giao diện ít bị đơ.",
    "Các tab lớn được tải theo nhu cầu để app mở nhanh và dùng ít RAM ban đầu hơn.",
    "Sử dụng gói cập nhật nhẹ, tái sử dụng OCR/CUDA Runtime đã cài bởi phiên bản 1.0.6.",
  ],
  "1.0.6": [
    "Tách OCR/CUDA sang Runtime cố định để các bản cập nhật tiếp theo cài nhanh hơn đáng kể.",
    "Dịch phụ đề theo batch 40 dòng, timeout 120 giây, tự thử lại và lưu checkpoint sau từng batch.",
    "TikTok TTS chạy tối đa 3 luồng đồng thời và vẫn lưu audio riêng cho từng câu.",
    "Thêm timeline cùng công cụ Tìm & thay thế trong danh sách bản dịch.",
  ],
  "1.0.5": [
    "Tối ưu workflow Tool Auto với chế độ Tự động và Chỉnh sửa nâng cao.",
    "Làm mới Trung tâm xuất video, log xử lý và responsive toàn bộ workspace.",
    "Giảm lag, đơ khi OCR video dài và tối ưu cập nhật phụ đề trực tiếp.",
    "Cải thiện trang Trích xuất phụ đề và thêm Xuất lại trong Thư viện dự án.",
    "Cập nhật bảng giá, liên hệ Zalo và giao diện Nâng cấp gói.",
  ],
};

export default function StudioController({ activeRoute, onNavigate }: StudioControllerProps) {
  // Login States
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(() => (import.meta as any).env?.VITE_PREVIEW_MODE === "true");
  const [tokenInput, setTokenInput] = useState<string>("");
  const [loginError, setLoginError] = useState<string>("");
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);
  const [licenseEntry, setLicenseEntry] = useState<LicenseEntry | null>(null);
  const [hwid, setHwid] = useState<string>("");

  // Lấy HWID và kiểm tra license đã lưu khi khởi động
  useEffect(() => {
    if ((import.meta as any).env?.VITE_PREVIEW_MODE === "true") return;
    getHwid().then(h => setHwid(h));
    checkSavedLicense().then((result) => {
      if (result.valid && result.entry) {
        setIsLoggedIn(true);
        setLicenseEntry(result.entry);
      } else {
        setIsLoggedIn(false);
        clearLicense();
      }
    });
  }, []);

  // App States
  const [showDonatePopup, setShowDonatePopup] = useState<boolean>(false);
  const [updateStatus, setUpdateStatus] = useState<{ state: "checking" | "downloading" | "ready" | "idle" | "error"; percent?: number; version?: string }>({ state: "idle" });
  const [dismissedUpdateState, setDismissedUpdateState] = useState<string | null>(null);
  const [whatsNewVersion, setWhatsNewVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!window.electronAPI?.onUpdateStatus) return;
    return window.electronAPI.onUpdateStatus(setUpdateStatus);
  }, []);

  useEffect(() => {
    if (updateStatus.state === "ready") setDismissedUpdateState(null);
  }, [updateStatus.state, updateStatus.version]);

  useEffect(() => {
    if (!window.electronAPI?.getAppVersion) return;
    void window.electronAPI.getAppVersion().then((version) => {
      if (!RELEASE_NOTES[version]) return;
      if (localStorage.getItem("26dubbin_seen_release_notes") !== version) setWhatsNewVersion(version);
    }).catch(() => undefined);
  }, []);
  const [videoSrc, setVideoSrc] = useState<string>("");
  const [videoName, setVideoName] = useState<string>("");
  const [outputVideoName, setOutputVideoName] = useState<string>("final-video");
  const [videoMimeType, setVideoMimeType] = useState<string>("video/mp4");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string>("");
  const [isRestoringProject, setIsRestoringProject] = useState<boolean>(true);
  const [extractedAudio, setExtractedAudio] = useState<{ base64: string; mimeType: string; audioBuffer?: AudioBuffer } | null>(null);
  const [isExtractingAudio, setIsExtractingAudio] = useState<boolean>(false);
  const [extractingProgressStep, setExtractingProgressStep] = useState<string>("");
  
  const [sourceLang, setSourceLang] = useState<string>("auto");
  const [targetLang, setTargetLang] = useState<string>("Vietnamese");
  const [translationGlossary, setTranslationGlossary] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("26dubbin_translation_glossary") || "";
    }
    return "";
  });
  const [translationStyle, setTranslationStyle] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("26dubbin_translation_style") || "Mặc định";
    }
    return "Mặc định";
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("26dubbin_translation_glossary", translationGlossary);
    }
  }, [translationGlossary]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("26dubbin_translation_style", translationStyle);
    }
  }, [translationStyle]);

  const [outputFolder, setOutputFolder] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("26dubbin_output_folder") || "";
    }
    return "";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("26dubbin_output_folder", outputFolder);
    }
  }, [outputFolder]);

  const [extractionMethod, setExtractionMethod] = useState<"audio" | "ocr" | "aiocr" | "localocr">("audio");
  const [watermarkRegions, setWatermarkRegions] = useState<OcrRegion[]>([]);
  const watermarkRegionsRef = useRef<OcrRegion[]>([]);
  useEffect(() => { watermarkRegionsRef.current = watermarkRegions; }, [watermarkRegions]);
  const [activeWatermarkRegionId, setActiveWatermarkRegionId] = useState<string | null>(null);
  const [watermarkScanDetections, setWatermarkScanDetections] = useState<OcrDetection[]>([]);
  const [isScanningWatermark, setIsScanningWatermark] = useState(false);
  
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const activeTab = activeRoute;
  const setActiveTab = onNavigate;
  const [projectLibrary, setProjectLibrary] = useState<ProjectLibraryItem[]>([]);
  const [isProjectLibraryLoading, setIsProjectLibraryLoading] = useState<boolean>(false);
  const projectPreviewUrlsRef = useRef<string[]>([]);

  // Text-to-Speech (TTS) Synthesis States
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(false);
  const [ttsEngine, setTtsEngine] = useState<"vieneu" | "browser" | "tiktok">("vieneu");
  const [vieneuVoice, setVieneuVoice] = useState<string>("Phạm Tuyên");
  const [tiktokVoice, setTiktokVoice] = useState<string>("BV074_streaming");
  const [tiktokSessionId, setTiktokSessionId] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("tiktok_session_id") || "";
    }
    return "";
  });
  const [smartTtsEnabled, setSmartTtsEnabled] = useState<boolean>(true);
  const [geminiApiKey, setGeminiApiKey] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const storedKeys = localStorage.getItem("gemini_api_keys");
      if (storedKeys) {
        try {
          const parsed = JSON.parse(storedKeys);
          if (Array.isArray(parsed)) return parsed.filter((key) => typeof key === "string").join("\n");
        } catch {
          return storedKeys;
        }
      }
      return localStorage.getItem("gemini_api_key") || "";
    }
    return "";
  });
  const [geminiApiKeyDraft, setGeminiApiKeyDraft] = useState<string>("");
  
  // Auto-save tiktok session ID in local storage when updated
  useEffect(() => {
    if (typeof window !== "undefined") {
      if (tiktokSessionId) {
        localStorage.setItem("tiktok_session_id", tiktokSessionId);
      } else {
        localStorage.removeItem("tiktok_session_id");
      }
    }
  }, [tiktokSessionId]);

  // Auto-save Gemini API Key in local storage when updated
  useEffect(() => {
    if (typeof window !== "undefined") {
      const keys = parseGeminiApiKeys(geminiApiKey);
      if (keys.length > 0) {
        localStorage.setItem("gemini_api_keys", JSON.stringify(keys));
        localStorage.setItem("gemini_api_key", keys[0]);
      } else {
        localStorage.removeItem("gemini_api_keys");
        localStorage.removeItem("gemini_api_key");
      }
    }
  }, [geminiApiKey]);

  const [activityLogs, setActivityLogs] = useState<string[]>([]);
  const [isAutoLogExpanded, setIsAutoLogExpanded] = useState(false);
  const [isAutoAdvancedOpen, setIsAutoAdvancedOpen] = useState(false);
  const [isAutoExpertMode, setIsAutoExpertMode] = useState(false);
  const [customApiUrl, setCustomApiUrl] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("custom_api_url") || "";
    }
    return "";
  });
  const [customApiKey, setCustomApiKey] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("custom_api_key") || "";
    }
    return "";
  });
  const [customModel, setCustomModel] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("custom_model") || "";
    }
    return "";
  });

  const addLog = (msg: string) => {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    setActivityLogs(prev => [...prev.slice(-99), line]);
    void window.electronAPI?.appendLog(line);
  };

  useEffect(() => window.electronAPI?.onRenderSaveProgress?.((progress) => {
    const percent = progress.percent ?? 0;
    setRecordingProgress(Math.min(100, 99 + percent / 100));
    if (progress.done) addLog(`Đã xác minh file xuất: ${(progress.transferred / 1024 / 1024).toFixed(1)} MB.`);
  }), []);

  useEffect(() => window.electronAPI?.onAppRecovered?.(() => {
    addLog("Giao diện vừa được tự khôi phục sau sự cố. Dữ liệu checkpoint vẫn được giữ nguyên.");
  }), []);

  const handleLoginSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setLoginError("");

    const trimmed = tokenInput.trim();
    if (!trimmed) {
      setLoginError("Vui lòng nhập mã kích hoạt!");
      return;
    }

    setIsLoggingIn(true);

    try {
      addLog("Đang xác thực license key...");
      const result = await verifyLicenseKey(trimmed);

      if (!result.valid || !result.entry) {
        setLoginError(result.reason ?? "License key không hợp lệ.");
        return;
      }

      saveLicense(trimmed, result.entry);
      setLicenseEntry(result.entry);
      setIsLoggedIn(true);
      addLog(`Kích hoạt thành công! UID: ${result.entry.uid} — Gói: ${getPlanLabel(result.entry.plan)}`);
    } catch (err: any) {
      setLoginError(`Lỗi xác thực: ${err?.message ?? String(err)}`);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSignOut = () => {
    setIsLoggedIn(false);
    setTokenInput("");
    setLicenseEntry(null);
    clearLicense();
    addLog("Đã đăng xuất khỏi hệ thống.");
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      if (customApiUrl) {
        localStorage.setItem("custom_api_url", customApiUrl);
      } else {
        localStorage.removeItem("custom_api_url");
      }
    }
  }, [customApiUrl]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      if (customApiKey) {
        localStorage.setItem("custom_api_key", customApiKey);
      } else {
        localStorage.removeItem("custom_api_key");
      }
    }
  }, [customApiKey]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      if (customModel) {
        localStorage.setItem("custom_model", customModel);
      } else {
        localStorage.removeItem("custom_model");
      }
    }
  }, [customModel]);

  const [apiPlatform, setApiPlatform] = useState<"gemini" | "custom">(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("api_platform") as "gemini" | "custom" | null;
      if (stored === "custom") {
        const hasCustomConfig = Boolean(
          localStorage.getItem("custom_api_url")?.trim()
          && localStorage.getItem("custom_api_key")?.trim(),
        );
        return hasCustomConfig ? "custom" : "gemini";
      }
      return stored || "gemini";
    }
    return "gemini";
  });

  const [allowGeminiFallback, setAllowGeminiFallback] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("allow_gemini_fallback") === "true";
    }
    return false;
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("api_platform", apiPlatform);
    }
  }, [apiPlatform]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("allow_gemini_fallback", allowGeminiFallback ? "true" : "false");
    }
  }, [allowGeminiFallback]);

  const [showEngineModal, setShowEngineModal] = useState<boolean>(false);
  const [engineDownloadProgress, setEngineDownloadProgress] = useState<number>(0);
  const [engineCurrentStep, setEngineCurrentStep] = useState<string>("");
  const [engineInstallLogs, setEngineInstallLogs] = useState<string[]>([]);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const appendEngineLog = (msg: string) => {
    setEngineInstallLogs(prev => {
      const next = [...prev.slice(-999), `[${new Date().toLocaleTimeString()}] ${msg}`];
      return next;
    });
  };

  useEffect(() => {
    // Auto-scroll to bottom when logs update
    try {
      if (logContainerRef.current) {
        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      }
    } catch (e) {
      // ignore
    }
  }, [engineInstallLogs]);
  const [isDownloadingEngine, setIsDownloadingEngine] = useState<boolean>(false);
  const [engineStatus, setEngineStatus] = useState<"not_installed" | "downloading" | "installed" | "error" | "ready">(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("engine_installed_status") as any) || "not_installed";
    }
    return "not_installed";
  });

 const handleCheckResources = async () => {
  if (isDownloadingEngine) return;
  setIsDownloadingEngine(true);
  setShowEngineModal(true);
  setEngineDownloadProgress(2);
  setEngineCurrentStep("Đang kiểm tra tài nguyên OCR đã đóng gói...");
  setEngineInstallLogs(["[Hệ thống] Bắt đầu kiểm tra tài nguyên cục bộ..."]);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    await sleep(500);
    setEngineDownloadProgress(20);
    setEngineCurrentStep("Đang kiểm tra engine OCR...");
    appendEngineLog("[Hệ thống] Đang kiểm tra file trong resources/ocr-engine...");

    // ── Kiểm tra Python/PaddleOCR đã bundle sẵn ─────────────────────
    setEngineCurrentStep("Đang kiểm tra môi trường Python OCR...");
    appendEngineLog("[Python OCR] Kiểm tra Python + PaddleOCR...");
    setEngineDownloadProgress(50);

    const pythonCheckRes = await fetch("/api/python/verify").catch(() => null);
    const pythonCheck = pythonCheckRes ? await pythonCheckRes.json().catch(() => null) : null;

    if (pythonCheck?.ok) {
      appendEngineLog(`[Python OCR] ✅ Đã sẵn sàng (${pythonCheck.python})`);
    } else {
      appendEngineLog(`[Python OCR] ❌ Không tìm thấy — ${pythonCheck?.detail || "không kết nối được server"}`);
    }
    setEngineDownloadProgress(75);

    // ── Self-Diagnostic cuối cùng ─────────────────────────────────
    setEngineCurrentStep("Đang chạy kiểm tra tự động toàn bộ tài nguyên...");
    appendEngineLog("[Kiểm tra] Bắt đầu Self-Diagnostic...");
    setEngineDownloadProgress(85);

    const finalPyCheck = await fetch("/api/python/verify").catch(() => null);
    const finalPy = finalPyCheck ? await finalPyCheck.json().catch(() => null) : null;
    appendEngineLog(
      `[Kiểm tra] Python OCR (import + predict): ${
        finalPy?.ok ? "✅ ĐẠT" : "❌ THIẾU — " + (finalPy?.detail || "Không kết nối được server")
      }`
    );
    setEngineDownloadProgress(95);

    if (!finalPy?.ok) {
      appendEngineLog("[Kiểm tra] ⚠️ Python OCR chưa sẵn sàng — tính năng OCR sẽ không hoạt động.");
    }

    setEngineCurrentStep("Hoàn tất kiểm tra tài nguyên.");
    setEngineInstallLogs(prev => [
      ...prev,
      "[Hệ thống] Trạng thái: HOÀN THÀNH",
      `[Hệ thống] Python OCR: ${finalPy?.ok ? "✅" : "❌ (không hoạt động)"}`,
    ]);
    setEngineDownloadProgress(100);
    await sleep(500);

    setEngineCurrentStep("Tất cả tài nguyên đã được kiểm tra.");
    setEngineStatus(finalPy?.ok ? "installed" : "error");
    if (typeof window !== "undefined") {
      localStorage.setItem("engine_installed_status", finalPy?.ok ? "installed" : "error");
    }
    addLog(finalPy?.ok ? "Kiểm tra hoàn tất: Python OCR sẵn sàng." : "Kiểm tra hoàn tất: Python OCR lỗi.");
  } catch (err: any) {
    console.error("Lỗi kiểm tra tài nguyên:", err);
    setErrorMsg(`Không thể kiểm tra tài nguyên: ${err.message || String(err)}`);
    setEngineStatus("error");
    setEngineCurrentStep("Lỗi trong quá trình kiểm tra tài nguyên!");
    setEngineInstallLogs(prev => [
      ...prev,
      `[LỖI] Đã xảy ra lỗi khi kiểm tra: ${err.message || String(err)}`,
      "[LÝ DO] Không kết nối được tới server nội bộ, hoặc thiếu file trong resources/ocr-engine.",
      "[GỢI Ý] Thử khởi động lại ứng dụng. Nếu vẫn lỗi, có thể cần cài lại từ installer.",
    ]);
  } finally {
    setIsDownloadingEngine(false);
  }
};
  const [exportedVideoUrl, setExportedVideoUrl] = useState<string>("");
  const [isTestingConnection, setIsTestingConnection] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{ success: boolean; msg: string } | null>(null);
  const [apiQuotaEntries, setApiQuotaEntries] = useState<ApiQuotaEntry[]>([]);
  const [isLoadingQuota, setIsLoadingQuota] = useState<boolean>(false);
  const [quotaUpdatedAt, setQuotaUpdatedAt] = useState<string>("");
  const [quotaLoadError, setQuotaLoadError] = useState<string>("");

  const submitGeminiApiKeys = () => {
    const incomingKeys = parseGeminiApiKeys(geminiApiKeyDraft);
    if (incomingKeys.length === 0) return;
    const mergedKeys = Array.from(new Set([...parseGeminiApiKeys(geminiApiKey), ...incomingKeys]));
    setGeminiApiKey(mergedKeys.join("\n"));
    setGeminiApiKeyDraft("");
  };

  const removeGeminiApiKey = (keyIndex: number) => {
    const keys = parseGeminiApiKeys(geminiApiKey);
    setGeminiApiKey(keys.filter((_, index) => index !== keyIndex).join("\n"));
  };

  const refreshApiQuota = async (silent = false) => {
    if (!silent) setIsLoadingQuota(true);
    try {
      const response = await fetch("/api/quota-status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getGeminiRequestHeaders(geminiApiKey),
        },
        body: JSON.stringify({ customApiKey, customModel }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setApiQuotaEntries(Array.isArray(data.entries) ? data.entries : []);
      setQuotaUpdatedAt(data.updatedAt || new Date().toISOString());
      setQuotaLoadError("");
    } catch (error: any) {
      setQuotaLoadError(error?.message || "Không thể tải trạng thái API.");
    } finally {
      if (!silent) setIsLoadingQuota(false);
    }
  };

  useEffect(() => {
    if (activeTab !== "settings") return;
    void refreshApiQuota();
    const timer = window.setInterval(() => void refreshApiQuota(true), 5000);
    return () => window.clearInterval(timer);
  }, [activeTab, geminiApiKey, customApiKey, customModel]);

  const testCustomApiConnection = async () => {
    if (!customApiUrl || !customApiKey) {
      setTestResult({ success: false, msg: "Vui lòng điền đầy đủ URL và API Key." });
      setErrorMsg("Không thể kiểm tra Custom API: Vui lòng điền đầy đủ URL và API Key.");
      return;
    }
    setIsTestingConnection(true);
    setTestResult(null);
    try {
      const cleanedUrl = sanitizeCustomApiBaseUrl(customApiUrl);
      if (cleanedUrl !== customApiUrl) setCustomApiUrl(cleanedUrl);
      const response = await fetch("/api/test-custom-api", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customApiUrl: cleanedUrl,
          customApiKey,
          customModel: customModel || "gpt-4o-mini",
        })
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        setTestResult({ success: true, msg: `${data.message || "Kết nối thành công! API hoạt động tốt."}${data.endpoint ? ` Endpoint: ${data.endpoint}` : ""}` });
        addLog("Thử nghiệm kết nối Custom API: THÀNH CÔNG");
      } else {
        const message = data.error || `Custom API trả về lỗi HTTP ${response.status}.`;
        setTestResult({ success: false, msg: message });
        setErrorMsg(`Kiểm tra Custom API thất bại: ${message}`);
        addLog(`Thử nghiệm kết nối Custom API thất bại: ${response.status}`);
      }
      await refreshApiQuota(true);
    } catch (err: any) {
      const message = `Lỗi kết nối: ${err.message || String(err)}`;
      setTestResult({ success: false, msg: message });
      setErrorMsg(`Kiểm tra Custom API thất bại: ${message}`);
      addLog(`Lỗi kiểm tra kết nối Custom API: ${err.message || String(err)}`);
    } finally {
      setIsTestingConnection(false);
    }
  };

  const [ttsVoiceName, setTtsVoiceName] = useState<string>("");
  const [ttsRate, setTtsRate] = useState<number>(SMART_TTS_MIN_RATE);
  const [ttsPitch, setTtsPitch] = useState<number>(1.0);
  const [ttsVolume, setTtsVolume] = useState<number>(0.8);
  const [originalAudioMixVolume, setOriginalAudioMixVolume] = useState<number>(0.3);
// 0.0 (tắt hẳn audio gốc) -> 1.0 (giữ nguyên 100%). Mặc định 0.3 = 30%, dùng cho cả
// live preview (auto-mute khi TTS đang đọc) và bước ghép audio cuối cùng khi export.
  const [autoMuteVideo, setAutoMuteVideo] = useState<boolean>(true);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [generatingTtsId, setGeneratingTtsId] = useState<string | null>(null);
  const [preGeneratingAll, setPreGeneratingAll] = useState<boolean>(false);
  const [ttsMode, setTtsMode] = useState<"full" | "sync">("full");
  const [fullTtsText, setFullTtsText] = useState<string>("");
  const [isGeneratingFullTts, setIsGeneratingFullTts] = useState<boolean>(false);
  const [fullTtsAudioUrl, setFullTtsAudioUrl] = useState<string | null>(null);
  const [fullTtsPlaying, setFullTtsPlaying] = useState<boolean>(false);
  const [fullTtsCurrentTime, setFullTtsCurrentTime] = useState<number>(0);
  const [fullTtsDuration, setFullTtsDuration] = useState<number>(0);
  const [isMergingAudio, setIsMergingAudio] = useState<boolean>(false);
  const [isFinalizingVoiceover, setIsFinalizingVoiceover] = useState<boolean>(false);
  const [isRecordingVideo, setIsRecordingVideo] = useState<boolean>(false);
  const [recordingProgress, setRecordingProgress] = useState<number>(0);
  const [recordingEtaSeconds, setRecordingEtaSeconds] = useState<number | null>(null);
  const [pipelineJob, setPipelineJob] = useState<PipelineJob | null>(null);
  const pipelineAbortRef = useRef<AbortController | null>(null);
  const pipelinePausedRef = useRef(false);

  const beginPipelineJob = (stage: PipelineStage, label: string): AbortSignal => {
    const controller = new AbortController();
    pipelineAbortRef.current = controller;
    pipelinePausedRef.current = false;
    const now = Date.now();
    setPipelineJob({ id: `${stage}-${now}`, stage, label, status: "running", startedAt: now, lastHeartbeatAt: now });
    return controller.signal;
  };

  const heartbeatPipeline = () => {
    setPipelineJob((job) => job ? { ...job, lastHeartbeatAt: Date.now() } : job);
  };

  const finishPipelineJob = (signal?: AbortSignal) => {
    if (signal && pipelineAbortRef.current?.signal !== signal) return;
    pipelineAbortRef.current = null;
    pipelinePausedRef.current = false;
    setPipelineJob(null);
  };

  const waitForPipeline = async (signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException("Tác vụ đã được hủy.", "AbortError");
    while (pipelinePausedRef.current) {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      if (signal.aborted) throw new DOMException("Tác vụ đã được hủy.", "AbortError");
    }
    heartbeatPipeline();
  };

  const togglePipelinePause = () => {
    if (!pipelineJob || pipelineJob.stage === "render" || pipelineJob.status === "cancelling") return;
    pipelinePausedRef.current = !pipelinePausedRef.current;
    setPipelineJob((job) => job ? { ...job, status: pipelinePausedRef.current ? "paused" : "running", lastHeartbeatAt: Date.now() } : job);
    addLog(pipelinePausedRef.current ? "Đã tạm dừng cấp thêm công việc mới; request đang chạy sẽ hoàn tất và checkpoint được giữ lại." : "Đã tiếp tục tác vụ từ checkpoint.");
  };

  const cancelActivePipeline = () => {
    if (!pipelineAbortRef.current || !pipelineJob) return;
    const question = pipelineJob.stage === "render"
      ? "Hủy render video hiện tại? Track TTS đã chuẩn bị vẫn được giữ lại."
      : "Hủy tác vụ hiện tại? Các batch/câu đã hoàn thành vẫn được lưu để lần sau tiếp tục.";
    if (!window.confirm(question)) return;
    setPipelineJob((job) => job ? { ...job, status: "cancelling" } : job);
    pipelineAbortRef.current.abort();
    pipelinePausedRef.current = false;
    setAutoRenderRequested(false);
    setAutoPrepareRequested(false);
    setIsLoading(false);
    setIsPreGenerating(false);
    setIsFinalizingVoiceover(false);
    setIsMergingAudio(false);
    setIsRecordingVideo(false);
    setLoadingEtaSeconds(null);
    setPreGenerateEtaSeconds(null);
    setRecordingEtaSeconds(null);
    addLog("Đã gửi lệnh hủy. Checkpoint hoàn thành vẫn được giữ nguyên.");
  };

  useEffect(() => {
    if (!pipelineJob || pipelineJob.status !== "running") return;
    const timer = window.setInterval(() => {
      setPipelineJob((job) => {
        if (!job || job.status !== "running") return job;
        if (Date.now() - job.lastHeartbeatAt > 120_000) {
          addLog(`[Watchdog] ${job.label} không cập nhật hơn 2 phút. Có thể hủy an toàn và chạy tiếp từ checkpoint.`);
          return { ...job, lastHeartbeatAt: Date.now() };
        }
        return job;
      });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [pipelineJob?.id, pipelineJob?.status]);
  const [exportResolution, setExportResolution] = useState<"720" | "1080" | "1440">(() => {
    const profile = getOcrRuntimeProfile();
    return profile.isMobile && profile.id !== "mobile-high" ? "720" : "1080";
  });
  const [exportAspectRatio, setExportAspectRatio] = useState<"original" | "16:9" | "9:16" | "1:1" | "4:3" | "3:4">("original");
  const [autoRenderRequested, setAutoRenderRequested] = useState<boolean>(false);
  const [autoPrepareRequested, setAutoPrepareRequested] = useState<boolean>(false);
  const [showPreRenderChoice, setShowPreRenderChoice] = useState<boolean>(false);
  const [subtitlePipelineVersion, setSubtitlePipelineVersion] = useState<number>(0);
  const [isProgressMinimized, setIsProgressMinimized] = useState<boolean>(false);
  const [timelineHeight, setTimelineHeight] = useState<number>(150);
  const [workspacePropertyTarget, setWorkspacePropertyTarget] = useState<"subtitle" | "blur" | "ocr">("subtitle");
  const [ocrRegions, setOcrRegions] = useState<OcrRegion[]>(DEFAULT_OCR_REGIONS);
  const [activeOcrRegionId, setActiveOcrRegionId] = useState<string>(DEFAULT_OCR_REGIONS[0].id);
  const [ocrFps, setOcrFps] = useState<number>(5);
  const [ocrHealth, setOcrHealth] = useState<OcrServiceHealth | null>(null);
  const [isCheckingOcr, setIsCheckingOcr] = useState<boolean>(false);
  const [isPreviewingOcr, setIsPreviewingOcr] = useState<boolean>(false);
  const [ocrPreviewText, setOcrPreviewText] = useState<string>("");
  const [isDrawingOcrRegion, setIsDrawingOcrRegion] = useState<boolean>(false);
  const [ocrPresetName, setOcrPresetName] = useState<string>("");
  const [ocrPresets, setOcrPresets] = useState<OcrRegionPreset[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const parsed = JSON.parse(localStorage.getItem("26dubbin_ocr_region_presets") || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [workspaceVideoDimensions, setWorkspaceVideoDimensions] = useState({ width: 16, height: 9 });
  const workspacePreviewHostRef = useRef<HTMLDivElement>(null);
  const secondaryPreviewHostRef = useRef<HTMLDivElement>(null);
  const [workspacePreviewSize, setWorkspacePreviewSize] = useState({ width: 0, height: 0 });
  const [secondaryPreviewSize, setSecondaryPreviewSize] = useState({ width: 0, height: 0 });
  const exportPreviewRatio = exportAspectRatio === "original"
    ? workspaceVideoDimensions.width / Math.max(1, workspaceVideoDimensions.height)
    : ({ "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4 } as const)[exportAspectRatio];
  const exportPreviewAspectRatio = `${exportPreviewRatio} / 1`;
  useEffect(() => {
    const observe = (element: HTMLDivElement | null, setter: React.Dispatch<React.SetStateAction<{ width: number; height: number }>>) => {
      if (!element) return undefined;
      const observer = new ResizeObserver(([entry]) => setter({ width: entry.contentRect.width, height: entry.contentRect.height }));
      observer.observe(element);
      return observer;
    };
    const workspaceObserver = observe(workspacePreviewHostRef.current, setWorkspacePreviewSize);
    const secondaryObserver = observe(secondaryPreviewHostRef.current, setSecondaryPreviewSize);
    return () => { workspaceObserver?.disconnect(); secondaryObserver?.disconnect(); };
  }, []);
  const getFittedCanvasStyle = (size: { width: number; height: number }): React.CSSProperties => {
    if (!size.width || !size.height) return { aspectRatio: exportPreviewAspectRatio, maxWidth: "100%", maxHeight: "100%" };
    const frame = getFittedSubtitleFrame(size.width, size.height, exportPreviewRatio);
    return { aspectRatio: exportPreviewAspectRatio, width: `${frame.width}px`, height: `${frame.height}px` };
  };
  
  // Customization States
  const [showSubtitles, setShowSubtitles] = useState<boolean>(true);
  const [blurSettings, setBlurSettings] = useState<BlurSettings>(DEFAULT_BLUR_SETTINGS);
  const [blurBoxes, setBlurBoxes] = useState<BlurBox[]>([]);
  const [activeBlurBoxId, setActiveBlurBoxId] = useState<string | null>("blur-1");
  const [subSettings, setSubSettings] = useState<SubtitleSettings>(DEFAULT_SUBTITLE_SETTINGS);
  const [isAdjustingCensor, setIsAdjustingCensor] = useState<boolean>(false);
  const [flipHorizontal, setFlipHorizontal] = useState<boolean>(false);
  const [flipVertical, setFlipVertical] = useState<boolean>(false);

  // Playback state
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [volume, setVolume] = useState<number>(0.8);
  
  // API Call Status
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingStep, setLoadingStep] = useState<string>("");
  const [loadingProgress, setLoadingProgress] = useState<number>(0);
  const [loadingEtaSeconds, setLoadingEtaSeconds] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [errorPopupQueue, setErrorPopupQueue] = useState<string[]>([]);

  useEffect(() => {
    const message = errorMsg.trim();
    if (!message) return;
    setIsAutoLogExpanded(true);
    setErrorPopupQueue((current) =>
      current[current.length - 1] === message ? current : [...current, message],
    );
  }, [errorMsg]);

  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      const message = event.error?.message || event.message || "Ứng dụng gặp lỗi không xác định.";
      setErrorPopupQueue((current) => current[current.length - 1] === message ? current : [...current, message]);
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error
        ? reason.message
        : typeof reason === "string" ? reason : "Một tác vụ nền đã thất bại.";
      setErrorPopupQueue((current) => current[current.length - 1] === message ? current : [...current, message]);
    };
    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  const dismissErrorPopup = () => {
    setErrorPopupQueue((current) => current.slice(1));
    setErrorMsg("");
  };

  // Subtitle Edit State
  const [editingSubId, setEditingSubId] = useState<string | null>(null);
  const [editOriginal, setEditOriginal] = useState<string>("");
  const [editTranslated, setEditTranslated] = useState<string>("");
  const [editStart, setEditStart] = useState<number>(0);
  const [editEnd, setEditEnd] = useState<number>(0);

  // Search filter for subtitle list
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const workspaceVideoRef = useRef<HTMLVideoElement>(null);
  const autoDubbingFileInputRef = useRef<HTMLInputElement>(null);
  const extractedAudioRef = useRef<{ base64: string; mimeType: string; audioBuffer?: AudioBuffer } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const restoreProject = async () => {
      const projectId = localStorage.getItem(PROJECT_POINTER_KEY);
      if (!projectId) {
        setIsRestoringProject(false);
        return;
      }

      try {
        const [project, media, lastRender] = await Promise.all([
          projectDbGet<StoredProject>("projects", projectId),
          projectDbGet<StoredProjectMedia>("media", projectId),
          projectDbGet<StoredProjectMedia>("media", `${projectId}|latest-render`),
        ]);
        if (cancelled || !media) return;

        const restoredFile = new File([media.blob], media.name, {
          type: media.type || "video/mp4",
          lastModified: media.lastModified,
        });
        setCurrentProjectId(projectId);
        setVideoFile(restoredFile);
        setVideoName(media.name);
        setOutputVideoName(`final-${media.name.replace(/\.[^.]+$/, "")}`);
        setVideoMimeType(media.type || "video/mp4");
        setVideoSrc(URL.createObjectURL(restoredFile));
        if (lastRender?.blob) setExportedVideoUrl(URL.createObjectURL(lastRender.blob));
        setActiveTab("dubbin");

        if (project) {
          setSubtitles(project.subtitles || []);
          setSubtitlePipelineVersion(project.subtitlePipelineVersion ?? 0);
          setSourceLang(project.sourceLang || "auto");
          setTargetLang(project.targetLang || "Vietnamese");
          setExtractionMethod(project.extractionMethod === "ocr" ? "localocr" : (project.extractionMethod || "audio"));
          setOcrRegions(project.ocrRegions?.length ? project.ocrRegions : DEFAULT_OCR_REGIONS);
          setActiveOcrRegionId(project.ocrRegions?.[0]?.id || DEFAULT_OCR_REGIONS[0].id);
          setOcrFps(project.ocrFps || 5);
          setTtsEnabled(project.ttsEnabled ?? false);
          setTtsEngine(project.ttsEngine === "tiktok" || project.ttsEngine === "browser" ? project.ttsEngine : "vieneu");
          setVieneuVoice(project.vieneuVoice || project.geminiVoice || "Phạm Tuyên");
          setTiktokVoice(project.tiktokVoice || "BV074_streaming");
          setSmartTtsEnabled(project.smartTtsEnabled ?? true);
          setTtsRate(Math.max(SMART_TTS_MIN_RATE, Math.min(SMART_TTS_MAX_RATE, project.ttsRate || SMART_TTS_MIN_RATE)));
          setOriginalAudioMixVolume(project.originalAudioMixVolume ?? 0.3);
          setExportResolution(project.exportResolution || "1080");
          setExportAspectRatio(project.exportAspectRatio || "original");
          setBlurBoxes(project.blurBoxes || []);
          setBlurSettings(project.blurSettings || DEFAULT_BLUR_SETTINGS);
          setSubSettings(project.subSettings || DEFAULT_SUBTITLE_SETTINGS);
          setFlipHorizontal(project.flipHorizontal ?? false);
          setFlipVertical(project.flipVertical ?? false);
        }

        addLog(`Đã khôi phục dự án "${media.name}"${project?.subtitles?.length ? ` với ${project.subtitles.length} dòng phụ đề` : ""}.`);
        if (sessionStorage.getItem("26dubbin_reexport_project") === projectId) {
          sessionStorage.removeItem("26dubbin_reexport_project");
          window.setTimeout(() => {
            document.getElementById("auto-export-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }, 500);
        }
        setIsExtractingAudio(true);
        setExtractingProgressStep("Đang khôi phục audio từ dự án...");
        extractAudioTrack(restoredFile, setExtractingProgressStep)
          .then((extracted) => {
            if (cancelled) return;
            setExtractedAudio(extracted);
            extractedAudioRef.current = extracted;
          })
          .catch((error) => {
            console.warn("Could not restore extracted audio:", error);
            if (!cancelled) setErrorMsg(`Đã khôi phục dự án nhưng chưa đọc được audio: ${error?.message || error}`);
          })
          .finally(() => {
            if (!cancelled) {
              setIsExtractingAudio(false);
              setExtractingProgressStep("");
            }
          });
      } catch (error) {
        console.warn("Could not restore active project:", error);
      } finally {
        if (!cancelled) setIsRestoringProject(false);
      }
    };
    restoreProject();
    return () => {
      cancelled = true;
    };
  }, []);

  // Tự sửa các dự án cũ từng lưu timestamp tương đối của từng chunk. Dữ liệu
  // gốc trong store `chunks` vẫn còn nguyên nên không cần gọi Gemini lại.
  useEffect(() => {
    if (!currentProjectId || !Number.isFinite(duration) || duration <= 0) return;
    let cancelled = false;

    const repairTimelineFromCheckpoints = async () => {
      const allChunks = await projectDbGetAll<StoredChunk>("chunks").catch(() => []);
      if (cancelled) return;
      const projectChunks = allChunks.filter((chunk) => chunk.projectId === currentProjectId);
      if (projectChunks.length === 0) return;

      const chunkStatsByJob = new Map<string, { latest: number; maxEnd: number; count: number }>();
      projectChunks.forEach((chunk) => {
        const current = chunkStatsByJob.get(chunk.jobKey) || { latest: 0, maxEnd: 0, count: 0 };
        chunkStatsByJob.set(chunk.jobKey, {
          latest: Math.max(current.latest, chunk.updatedAt),
          maxEnd: Math.max(current.maxEnd, chunk.end),
          count: current.count + 1,
        });
      });
      const latestJobKey = [...chunkStatsByJob.entries()].sort((a, b) =>
        b[1].maxEnd - a[1].maxEnd || b[1].count - a[1].count || b[1].latest - a[1].latest
      )[0]?.[0];
      if (!latestJobKey) return;

      const selectedChunks = projectChunks
        .filter((chunk) => chunk.jobKey === latestJobKey)
        .sort((a, b) => a.start - b.start);
      const restoredChunkSubtitles = selectedChunks.flatMap((chunk) =>
        normalizeChunkSubtitleTimestamps(chunk.subtitles, chunk.start, chunk.end, duration)
      );
      const repairedSubtitles = validateSubtitleTimeline(
        mergeDuplicateSubtitles(restoredChunkSubtitles),
        duration,
      );
      if (cancelled || repairedSubtitles.length === 0) return;

      const currentLastEnd = Math.max(...subtitles.map((sub) => sub.end), 0);
      const repairedLastEnd = Math.max(...repairedSubtitles.map((sub) => sub.end), 0);
      const currentLooksCollapsed =
        selectedChunks.length > 1 &&
        repairedLastEnd > currentLastEnd + 0.75;
      if (!currentLooksCollapsed && subtitles.length > 0) return;

      setSubtitles(repairedSubtitles);
      addLog(
        `Đã tự sửa timeline checkpoint: ${subtitles.length} → ${repairedSubtitles.length} dòng, ` +
        `mốc cuối ${currentLastEnd.toFixed(2)}s → ${repairedLastEnd.toFixed(2)}s. Không gọi lại Gemini.`,
      );
    };

    void repairTimelineFromCheckpoints();
    return () => {
      cancelled = true;
    };
  }, [currentProjectId, duration]);

  useEffect(() => {
    if (!currentProjectId || isRestoringProject || !videoName) return;
    const saveTimer = window.setTimeout(() => {
      projectDbPut("projects", {
        id: currentProjectId,
        updatedAt: Date.now(),
        videoName,
        videoMimeType,
        subtitles,
        sourceLang,
        targetLang,
        extractionMethod,
        ocrRegions,
        ocrFps,
        ttsEnabled,
        ttsEngine,
        vieneuVoice,
        tiktokVoice,
        smartTtsEnabled,
        ttsRate,
        originalAudioMixVolume,
        exportResolution,
        exportAspectRatio,
        blurBoxes,
        blurSettings,
        subSettings,
        flipHorizontal,
        flipVertical,
        subtitlePipelineVersion,
      } satisfies StoredProject).catch((error) => console.warn("Could not save project checkpoint:", error));
    }, 400);
    return () => window.clearTimeout(saveTimer);
  }, [
    currentProjectId, isRestoringProject, videoName, videoMimeType, subtitles, sourceLang, targetLang,
    extractionMethod, ocrRegions, ocrFps, ttsEnabled, ttsEngine, vieneuVoice, tiktokVoice, smartTtsEnabled, ttsRate,
    originalAudioMixVolume, exportResolution, exportAspectRatio, blurBoxes, blurSettings, subSettings, flipHorizontal, flipVertical,
    subtitlePipelineVersion,
  ]);

  const refreshProjectLibrary = async () => {
    setIsProjectLibraryLoading(true);
    try {
      projectPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      projectPreviewUrlsRef.current = [];
      const projects = (await projectDbGetAll<StoredProject>("projects"))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const items = await Promise.all(projects.map(async (project) => {
        const [media, finalRender] = await Promise.all([
          projectDbGet<StoredProjectMedia>("media", project.id),
          projectDbGet<StoredProjectMedia>("media", `${project.id}|latest-render`),
        ]);
        const previewUrl = media?.blob ? URL.createObjectURL(media.blob) : undefined;
        if (previewUrl) projectPreviewUrlsRef.current.push(previewUrl);
        return { project, media, previewUrl, hasFinalRender: Boolean(finalRender?.blob) } satisfies ProjectLibraryItem;
      }));
      setProjectLibrary(items);
    } catch (error: any) {
      console.error("Could not load project library:", error);
      setErrorMsg(`Không thể mở thư viện dự án: ${error?.message || error}`);
    } finally {
      setIsProjectLibraryLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "projects") refreshProjectLibrary();
  }, [activeTab]);

  useEffect(() => () => {
    projectPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const handleOpenLibraryProject = (projectId: string) => {
    localStorage.setItem(PROJECT_POINTER_KEY, projectId);
    window.location.reload();
  };

  const handleReExportLibraryProject = (projectId: string) => {
    localStorage.setItem(PROJECT_POINTER_KEY, projectId);
    sessionStorage.setItem("26dubbin_reexport_project", projectId);
    window.location.reload();
  };

  const handleCreateNewProject = () => {
    if (videoSrc?.startsWith("blob:")) URL.revokeObjectURL(videoSrc);
    if (exportedVideoUrl?.startsWith("blob:")) URL.revokeObjectURL(exportedVideoUrl);
    localStorage.removeItem(PROJECT_POINTER_KEY);
    setCurrentProjectId("");
    setVideoFile(null);
    setVideoName("");
    setOutputVideoName("final-video");
    setVideoSrc("");
    setVideoMimeType("video/mp4");
    setExtractedAudio(null);
    extractedAudioRef.current = null;
    setSubtitles([]);
    setSubtitlePipelineVersion(0);
    setBlurBoxes([]);
    setActiveBlurBoxId(null);
    setFlipHorizontal(false);
    setFlipVertical(false);
    setExportedVideoUrl("");
    setErrorMsg("");
    setActiveTab("dubbin");
  };

  const handleDeleteLibraryProject = async (projectId: string, projectName: string) => {
    if (!window.confirm(`Xóa dự án "${projectName}" và toàn bộ checkpoint STT/TTS?`)) return;
    setIsProjectLibraryLoading(true);
    try {
      const [chunks, ttsClips, ocrCheckpoints] = await Promise.all([
        projectDbGetAll<StoredChunk>("chunks"),
        projectDbGetAll<StoredTtsClip>("tts"),
        projectDbGetAll<StoredOcrCheckpoint>("ocr"),
      ]);
      await Promise.all([
        projectDbDelete("projects", projectId),
        projectDbDelete("media", projectId),
        projectDbDelete("media", `${projectId}|latest-render`),
        projectDbDelete("media", `${projectId}|prepared-voiceover`),
        ...chunks.filter((chunk) => chunk.projectId === projectId).map((chunk) => projectDbDelete("chunks", chunk.id)),
        ...ttsClips.filter((clip) => clip.projectId === projectId).map((clip) => projectDbDelete("tts", clip.id)),
        ...ocrCheckpoints.filter((item) => item.projectId === projectId).map((item) => projectDbDelete("ocr", item.id)),
      ]);

      if (localStorage.getItem(PROJECT_POINTER_KEY) === projectId) {
        localStorage.removeItem(PROJECT_POINTER_KEY);
        setCurrentProjectId("");
        setVideoFile(null);
        setVideoName("");
        setOutputVideoName("final-video");
        setVideoSrc("");
        setSubtitles([]);
        setSubtitlePipelineVersion(0);
        setExportedVideoUrl("");
      }
      addLog(`Đã xóa dự án "${projectName}" khỏi thư viện.`);
      await refreshProjectLibrary();
    } catch (error: any) {
      setErrorMsg(`Không thể xóa dự án: ${error?.message || error}`);
    } finally {
      setIsProjectLibraryLoading(false);
    }
  };

  // Handle load demo video

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset ngay để Electron vẫn bắn change khi người dùng chọn lại chính video đó.
    e.target.value = "";
    if (file) void handleFile(file);
  };

  const handleFile = async (file: File) => {
    const supportedVideoExtension = /\.(mp4|m4v|mov|webm|avi|mkv|mpeg|mpg|3gp|ts)$/i.test(file.name);
    if (!file.type.startsWith("video/") && !supportedVideoExtension) {
      setErrorMsg("Vui lòng chọn một tập tin video hợp lệ (MP4, WebM, v.v.)");
      return;
    }

    const projectId = makeProjectId(file);
    setCurrentProjectId(projectId);
    setIsRestoringProject(false);
    localStorage.setItem(PROJECT_POINTER_KEY, projectId);

    // Keep large imports responsive: display the local file immediately while
    // the independent project checkpoint is copied in the background.
    void (async () => {
      try {
        if (navigator.storage?.persist) await navigator.storage.persist();
        await projectDbPut("media", {
          id: projectId,
          blob: file,
          name: file.name,
          type: file.type,
          lastModified: file.lastModified,
        } satisfies StoredProjectMedia);
        addLog("Đã tạo checkpoint và lưu video gốc vào bộ nhớ dự án Electron.");
      } catch (storageError: any) {
        console.warn("Could not persist project media:", storageError);
        addLog(`CẢNH BÁO: Không thể lưu video dự án (${storageError?.message || storageError}).`);
      }
    })();

    setVideoFile(file);
    setVideoName(file.name);
    setOutputVideoName(`final-${file.name.replace(/\.[^.]+$/, "")}`);
    setVideoMimeType(file.type);
    setSubtitles([]);
    setSubtitlePipelineVersion(0);
    setBlurBoxes([]);
    setActiveBlurBoxId(null);
    setErrorMsg("");
    setExtractedAudio(null);
    extractedAudioRef.current = null;
    
    // Revoke previous object URL if it exists to prevent memory leak
    if (videoSrc && videoSrc.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(videoSrc);
      } catch (err) {
        console.error("Error revoking object URL:", err);
      }
    }

    const objectUrl = URL.createObjectURL(file);
    setVideoSrc(objectUrl);
    // Keep the current route when loading from the standalone extraction tab.
    if (activeTab !== "extract") setActiveTab("dubbin");

    // Decoding the entire audio track is expensive for long videos. The STT
    // workflow already extracts it lazily; OCR imports do not need this work.
    setIsExtractingAudio(false);
    setExtractingProgressStep("");
  };

  // Convert File to Base64 safely for API
  const getFileBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (error) => reject(error);
    });
  };
  async function checkOcrService(showFailurePopup = true): Promise<OcrServiceHealth> {
    setIsCheckingOcr(true);
    try {
      const response = await fetch("/api/ocr/health?retry=1", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      const status: OcrServiceHealth = { ...payload, connected: response.ok && payload.connected === true };
      setOcrHealth(status);
      if (showFailurePopup && status.state === "error") setErrorMsg(status.error || "CPU OCR dự phòng chưa sẵn sàng.");
      return status;
    } catch (error: any) {
      const status: OcrServiceHealth = { connected: false, state: "error", error: error?.message || String(error) };
      setOcrHealth(status);
      if (showFailurePopup) setErrorMsg(`Không kiểm tra được CPU OCR dự phòng: ${status.error}`);
      return status;
    } finally {
      setIsCheckingOcr(false);
    }
  }

  useEffect(() => {
    if (extractionMethod === "ocr" || extractionMethod === "localocr") void checkOcrService(false);
  }, [extractionMethod]);

  useEffect(() => {
    videoRef.current?.pause();
    workspaceVideoRef.current?.pause();
    setIsPlaying(false);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem("26dubbin_ocr_region_presets", JSON.stringify(ocrPresets));
  }, [ocrPresets]);

  const TRANSLATION_BATCH_SIZE = 40;
  const TRANSLATION_BATCH_TIMEOUT_MS = 120_000;
  const TRANSLATION_MAX_ATTEMPTS = 3;

  const requestTranslationBatch = async (batch: Subtitle[], label: string, parentSignal?: AbortSignal) => {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= TRANSLATION_MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const abortFromPipeline = () => controller.abort();
      parentSignal?.addEventListener("abort", abortFromPipeline, { once: true });
      const timeout = window.setTimeout(() => controller.abort(), TRANSLATION_BATCH_TIMEOUT_MS);
      try {
        if (parentSignal) await waitForPipeline(parentSignal);
        const response = await fetch("/api/translate-subtitles", {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json", ...getGeminiRequestHeaders(geminiApiKey) },
          body: JSON.stringify({
            subtitles: batch,
            sourceLanguage: sourceLang,
            targetLanguage: targetLang,
            apiPlatform,
            customApiUrl: apiPlatform === "custom" ? customApiUrl : "",
            customApiKey: apiPlatform === "custom" ? customApiKey : "",
            customModel: apiPlatform === "custom" ? customModel : "",
            allowGeminiFallback,
            translationGlossary: translationGlossary.trim() || undefined,
            translationStyle: translationStyle.trim() || undefined,
          }),
        });
        return await readJsonResponse(response);
      } catch (error) {
        if (parentSignal?.aborted) throw new DOMException("Translation cancelled.", "AbortError");
        lastError = error;
        if (attempt >= TRANSLATION_MAX_ATTEMPTS) break;
        const reason = error instanceof DOMException && error.name === "AbortError"
          ? "quá thời gian 120 giây"
          : error instanceof Error ? error.message : String(error);
        addLog(`[${label}] Batch lỗi (${reason}); thử lại ${attempt + 1}/${TRANSLATION_MAX_ATTEMPTS}...`);
        await new Promise<void>((resolve) => window.setTimeout(resolve, attempt * 1_500));
      } finally {
        window.clearTimeout(timeout);
        parentSignal?.removeEventListener("abort", abortFromPipeline);
      }
    }
    if (lastError instanceof DOMException && lastError.name === "AbortError") {
      throw new Error("Batch dịch vượt quá thời gian 120 giây sau 3 lần thử.");
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || "Dịch batch thất bại."));
  };

  const handleTranslateExistingSubtitles = async (retryOnly = false, onlyIds?: string[]) => {
    if (subtitles.length === 0) return;

    const selectedIds = onlyIds?.length ? new Set(onlyIds) : null;
    const originalSubtitles = selectedIds
      ? subtitles.filter((subtitle) => selectedIds.has(subtitle.id))
      : retryOnly ? subtitles.filter(isSubtitleTranslationMissing) : subtitles;
    if (originalSubtitles.length === 0) {
      addLog("[Retry bản dịch] Không còn dòng lỗi hoặc chưa dịch.");
      return;
    }
    const actionLabel = retryOnly ? "Retry bản dịch" : "Dịch lại";
    const pipelineSignal = beginPipelineJob(
      "ocr-translation",
      retryOnly ? `Đang retry ${originalSubtitles.length} dòng bản dịch` : "Đang dịch phụ đề",
    );
    setIsLoading(true);
    setErrorMsg("");
    setLoadingProgress(0);
    setLoadingStep(`Đang dịch ${originalSubtitles.length} dòng phụ đề có sẵn...`);
    addLog(`[${actionLabel}] Gửi ${originalSubtitles.length} dòng text; giữ nguyên mốc thời gian, câu đã dịch và phụ đề gốc.`);
    try {
      // Retry mode must never replace the full track with only the failed subset.
      let checkpoint = [...subtitles];
      const batchCount = Math.ceil(originalSubtitles.length / TRANSLATION_BATCH_SIZE);
      const failedBatches: number[] = [];
      for (let offset = 0; offset < originalSubtitles.length; offset += TRANSLATION_BATCH_SIZE) {
        const batch = originalSubtitles.slice(offset, offset + TRANSLATION_BATCH_SIZE);
        const batchNumber = Math.floor(offset / TRANSLATION_BATCH_SIZE) + 1;
        try {
          const payload = await requestTranslationBatch(batch, actionLabel, pipelineSignal);
          const returned = Array.isArray(payload.subtitles) ? payload.subtitles : [];
          if (returned.length !== batch.length) throw new Error(`AI trả thiếu dòng (${returned.length}/${batch.length}).`);
          const translatedById = new Map<string, string>(returned.map((item: Partial<Subtitle>) => [String(item.id || ""), String(item.translated || "").trim()]));
          const missingId = batch.find((subtitle) => !translatedById.has(subtitle.id));
          if (missingId) throw new Error(`AI thiếu dòng ${missingId.id}.`);
          checkpoint = checkpoint.map((subtitle) => translatedById.has(subtitle.id)
            ? { ...subtitle, translated: String(translatedById.get(subtitle.id) || subtitle.original) }
            : subtitle);
          setSubtitles(checkpoint);
          addLog(`[${actionLabel}] Đã lưu checkpoint batch ${batchNumber}/${batchCount}.`);
        } catch (error) {
          if (pipelineSignal.aborted) throw error;
          failedBatches.push(batchNumber);
          const reason = error instanceof Error ? error.message : String(error);
          addLog(`[${actionLabel}] Batch ${batchNumber}/${batchCount} lỗi sau 3 lần thử: ${reason} Giữ nguyên các dòng này và tiếp tục.`);
        }
        const completed = Math.min(originalSubtitles.length, offset + batch.length);
        setLoadingProgress(Math.round((completed / originalSubtitles.length) * 100));
        setLoadingStep(`Đang dịch batch ${batchNumber}/${batchCount} · ${completed}/${originalSubtitles.length} dòng...`);
      }
      setLoadingProgress(100);
      if (failedBatches.length > 0) {
        setErrorMsg(`Đã chạy hết ${batchCount} batch nhưng còn ${failedBatches.length} batch lỗi (${failedBatches.join(", ")}). Kết quả thành công đã lưu; bấm Retry bản dịch để chỉ thử lại các dòng còn thiếu.`);
      } else {
        addLog(`[${actionLabel}] Hoàn tất ${originalSubtitles.length} dòng, không trích xuất lại video.`);
      }
    } catch (err: any) {
      setErrorMsg(`${err?.message || "Dịch phụ đề thất bại."} Phụ đề hiện tại đã được giữ nguyên.`);
      addLog(`[${actionLabel}] Lỗi, giữ nguyên phụ đề: ${err?.message || String(err)}`);
    } finally {
      setIsLoading(false);
      setLoadingStep("");
      setLoadingEtaSeconds(null);
      finishPipelineJob(pipelineSignal);
    }
  };

  // Extract and translate a new subtitle track from the video.
  const handleTranslateVideo = async () => {
    const pipelineSignal = beginPipelineJob("ocr-translation", "Đang OCR và dịch phụ đề");
    if (!videoSrc) {
      setErrorMsg("Vui lòng tải lên video trước.");
      finishPipelineJob(pipelineSignal);
      return;
    }

    setIsLoading(true);
    setErrorMsg("");
    setLoadingProgress(0);
    setLoadingEtaSeconds(null);
    setLoadingStep("Chuẩn bị dữ liệu video...");
    addLog("Bắt đầu xử lý dịch và trích xuất phụ đề video...");

    try {
      /* Legacy browser ONNX OCR workflow removed. Python stream below is active.
        if (!videoFile) throw new Error("PaddleOCR cần tệp video gốc, không thể chạy trên video demo.");
        const sourceVideoFile = videoFile as File;
        await checkOcrService(false);
        setLoadingStep("Đang quét toàn bộ video bằng PaddleOCR Python...");
        const ocrProjectId = currentProjectId || makeProjectId(sourceVideoFile);
        const ocrJobKey = stableHash(JSON.stringify({
          pipeline: "python-stream-v2-dense",
          file: {
            name: sourceVideoFile.name,
            size: sourceVideoFile.size,
            lastModified: sourceVideoFile.lastModified,
          },
          fps: ocrFps,
          regions: ocrRegions.map((region) => ({
            id: region.id,
            x: Number(region.x.toFixed(3)),
            y: Number(region.y.toFixed(3)),
            width: Number(region.width.toFixed(3)),
            height: Number(region.height.toFixed(3)),
          })),
          confidence: 0.25,
        }));
        const liveTranslationCache = new Map<string, string>();
        const scheduledTranslationKeys = new Set<string>();
        let latestOcrSubtitles: Subtitle[] = [];
        let translatedLineCount = 0;
        let translationFailure: Error | null = null;
        let translationQueue: Promise<void> = Promise.resolve();
        const translationBatchSize = TRANSLATION_BATCH_SIZE;
        const getTranslationKey = (subtitle: Subtitle) => normalizedOcrText(subtitle.original);

        for (const subtitle of subtitles) {
          const key = getTranslationKey(subtitle);
          const translated = cleanOcrText(subtitle.translated || "");
          if (key && translated && translated !== cleanOcrText(subtitle.original)) {
            liveTranslationCache.set(key, translated);
            scheduledTranslationKeys.add(key);
          }
        }
        translatedLineCount = liveTranslationCache.size;

        const applyLiveTranslations = (items: Subtitle[]) => items.map((subtitle) => {
          const translated = liveTranslationCache.get(getTranslationKey(subtitle));
          return translated ? { ...subtitle, translated } : subtitle;
        });

        const translateOcrBatch = async (batch: Subtitle[]) => {
          const payload = await requestTranslationBatch(batch, "OCR + Dịch", pipelineSignal);
          const translatedItems: Array<Partial<Subtitle> & { id?: string | number }> = Array.isArray(payload.subtitles)
            ? payload.subtitles
            : [];
          if (translatedItems.length !== batch.length) {
            throw new Error(`Bản dịch trả thiếu dòng (${translatedItems.length}/${batch.length}); OCR vẫn được giữ trong checkpoint.`);
          }
          const translatedById = new Map<string, Partial<Subtitle>>(
            translatedItems.map((item) => [String(item.id || ""), item]),
          );
          return batch.map((original) => {
            const translated = translatedById.get(original.id);
            if (!translated) throw new Error(`Bản dịch thiếu ID ${original.id}; OCR vẫn được giữ trong checkpoint.`);
            const returnedStart = Number(translated.start);
            const returnedEnd = Number(translated.end);
            if (Math.abs(returnedStart - original.start) > 0.001 || Math.abs(returnedEnd - original.end) > 0.001) {
              addLog(`[Dịch] Giữ timestamp OCR ${original.start.toFixed(2)}-${original.end.toFixed(2)}s cho ${original.id}.`);
            }
            return {
              ...original,
              translated: cleanOcrText(String(translated.translated || original.original)),
            };
          });
        };

        const scheduleLiveTranslations = (items: Subtitle[], flushAll = false) => {
          latestOcrSubtitles = items;
          const stableItems = flushAll ? items : items.slice(0, -1);
          const uniquePending = new Map<string, Subtitle>();
          for (const subtitle of stableItems) {
            const key = getTranslationKey(subtitle);
            if (key && !scheduledTranslationKeys.has(key)) uniquePending.set(key, subtitle);
          }
          const pending = [...uniquePending.values()];
          const scheduledCount = flushAll
            ? pending.length
            : Math.floor(pending.length / translationBatchSize) * translationBatchSize;
          if (scheduledCount === 0) return;

          for (let offset = 0; offset < scheduledCount; offset += translationBatchSize) {
            const batch = pending.slice(offset, Math.min(scheduledCount, offset + translationBatchSize));
            for (const subtitle of batch) scheduledTranslationKeys.add(getTranslationKey(subtitle));
            translationQueue = translationQueue.then(async () => {
              try {
                const translatedBatch = await translateOcrBatch(batch);
                for (const subtitle of translatedBatch) {
                  const key = getTranslationKey(subtitle);
                  if (key) liveTranslationCache.set(key, subtitle.translated);
                }
                translatedLineCount = liveTranslationCache.size;
                setSubtitles(applyLiveTranslations(latestOcrSubtitles));
                setLoadingStep(`Đang OCR và dịch song song: đã dịch ${translatedLineCount} dòng...`);
                addLog(`[OCR + Dịch] Đã dịch thêm ${translatedBatch.length} dòng; tổng ${translatedLineCount} dòng.`);
              } catch (error) {
                translationFailure = error instanceof Error ? error : new Error(String(error));
                const message = `Một batch dịch gặp lỗi: ${translationFailure.message} Các batch khác vẫn tiếp tục và kết quả đã nhận vẫn được lưu.`;
                setErrorMsg(message);
                addLog(`[OCR + Dịch] ${message}`);
              }
            });
          }
        };

        const ocrResult = await runPaddleOcrOnVideo(sourceVideoFile, ocrFps, ocrRegions, (message, percent, etaSeconds) => {
          setLoadingStep(`${message} Đã dịch ${translatedLineCount} dòng.`);
          setLoadingProgress(Math.min(95, percent));
          setLoadingEtaSeconds(etaSeconds);
          addLog(message);
        }, (partialFrames, frameInterval, videoDuration) => {
          const partialSubtitles = mergeOcrFramesToSubtitles(partialFrames, frameInterval, videoDuration, 0.86, watermarkRegionsRef.current);
          latestOcrSubtitles = partialSubtitles;
          setSubtitles(applyLiveTranslations(partialSubtitles));
          setSubtitlePipelineVersion(0);
          if (partialSubtitles.length > 0) scheduleLiveTranslations(partialSubtitles);
        }, undefined, true);
        const originalSubtitles = mergeOcrFramesToSubtitles(ocrResult.frames, ocrResult.frameInterval, ocrResult.duration, 0.86, watermarkRegionsRef.current);
        if (!originalSubtitles.length) {
          throw new Error("PaddleOCR không thấy phụ đề trong vùng đã chọn. Hãy seek tới frame có chữ, chỉnh ROI và bấm Preview OCR trước.");
        }
        latestOcrSubtitles = originalSubtitles;
        setSubtitles(applyLiveTranslations(originalSubtitles));
        addLog(`[PaddleOCR frontend] Gộp ${ocrResult.frames.length} frame thành ${originalSubtitles.length} dòng bằng fuzzy temporal merge; timestamp lấy trực tiếp từ frame.`);

        scheduleLiveTranslations(originalSubtitles, true);
        setLoadingStep(`OCR hoàn tất; đang chờ dịch nốt các dòng còn lại...`);
        setLoadingProgress(96);
        const translationEstimate = Math.max(8, Math.ceil(6 + originalSubtitles.length * 0.18));
        setLoadingEtaSeconds(translationEstimate);
        await translationQueue;
        if (translationFailure) throw translationFailure;
        const finalSubtitles = applyLiveTranslations(originalSubtitles);
        setSubtitles(finalSubtitles);
        setSubtitlePipelineVersion(5);
        setActiveTab("tracks");
        setLoadingProgress(100);
        addLog(`[PaddleOCR frontend] Hoàn tất ${finalSubtitles.length} dòng; AI chỉ nhận text để dịch, không nhận ảnh.`);
        return;
      */

      if (extractionMethod === "ocr" || extractionMethod === "localocr") {
        if (!videoFile) throw new Error("Paddle Local (Python) cần tệp video gốc.");
        const ocrRuntimeProfile = getOcrRuntimeProfile();
        const liveTranslationCacheL = new Map<string, string>();
        const scheduledTranslationKeysL = new Set<string>();
        let latestOcrSubtitlesL: Subtitle[] = [];
        let translatedLineCountL = 0;
        let translationFailureL: Error | null = null;
        let translationQueueL: Promise<void> = Promise.resolve();
        const translationBatchSizeL = TRANSLATION_BATCH_SIZE;
        const getTranslationKeyL = (subtitle: Subtitle) => normalizedOcrText(subtitle.original);

        for (const subtitle of subtitles) {
          const key = getTranslationKeyL(subtitle);
          const translated = cleanOcrText(subtitle.translated || "");
          if (key && translated && translated !== cleanOcrText(subtitle.original)) {
            liveTranslationCacheL.set(key, translated);
            scheduledTranslationKeysL.add(key);
          }
        }
        translatedLineCountL = liveTranslationCacheL.size;

        const applyLiveTranslationsL = (items: Subtitle[]) => items.map((subtitle) => {
          const translated = liveTranslationCacheL.get(getTranslationKeyL(subtitle));
          return translated ? { ...subtitle, translated } : subtitle;
        });

        const translateOcrBatchL = async (batch: Subtitle[]) => {
          const payload = await requestTranslationBatch(batch, "Python OCR + Dịch", pipelineSignal);
          const translatedItems: Array<Partial<Subtitle> & { id?: string | number }> = Array.isArray(payload.subtitles) ? payload.subtitles : [];
          if (translatedItems.length !== batch.length) throw new Error(`Bản dịch trả thiếu dòng (${translatedItems.length}/${batch.length}).`);
          const translatedById = new Map<string, Partial<Subtitle>>(translatedItems.map((item) => [String(item.id || ""), item]));
          return batch.map((original) => {
            const translated = translatedById.get(original.id);
            if (!translated) throw new Error(`Bản dịch thiếu ID ${original.id}.`);
            return { ...original, translated: cleanOcrText(String(translated.translated || original.original)) };
          });
        };

        const scheduleLiveTranslationsL = (items: Subtitle[], flushAll = false) => {
          latestOcrSubtitlesL = items;
          const stableItems = flushAll ? items : items.slice(0, -1);
          const uniquePending = new Map<string, Subtitle>();
          for (const subtitle of stableItems) {
            const key = getTranslationKeyL(subtitle);
            if (key && !scheduledTranslationKeysL.has(key)) uniquePending.set(key, subtitle);
          }
          const pending = [...uniquePending.values()];
          const scheduledCount = flushAll ? pending.length : Math.floor(pending.length / translationBatchSizeL) * translationBatchSizeL;
          if (scheduledCount === 0) return;
          for (let offset = 0; offset < scheduledCount; offset += translationBatchSizeL) {
            const batch = pending.slice(offset, Math.min(scheduledCount, offset + translationBatchSizeL));
            for (const subtitle of batch) scheduledTranslationKeysL.add(getTranslationKeyL(subtitle));
            translationQueueL = translationQueueL.then(async () => {
              try {
                const translatedBatch = await translateOcrBatchL(batch);
                for (const subtitle of translatedBatch) { const key = getTranslationKeyL(subtitle); if (key) liveTranslationCacheL.set(key, subtitle.translated); }
                translatedLineCountL = liveTranslationCacheL.size;
                setSubtitles(applyLiveTranslationsL(latestOcrSubtitlesL));
                setLoadingStep(`Đang dịch phụ đề: đã hoàn tất ${translatedLineCountL} dòng...`);
              } catch (error) {
                translationFailureL = error instanceof Error ? error : new Error(String(error));
                setErrorMsg(`Dịch lỗi: ${translationFailureL.message}`);
              }
            });
          }
        };

        const accumulatedFrames: OcrFrameResult[] = [];
        let ocrVideoDuration = 0;
        const ocrFrameInterval = 1 / ocrFps;
        let nextLiveMergeFrameCount = 10;
        let lastProgressUiAt = 0;
        let framesSinceMainThreadYield = 0;
        setLoadingStep("Đang upload video lên server OCR...");
        const ocrFormData = new FormData();
        ocrFormData.append("video", videoFile);
        ocrFormData.append("fps", String(ocrFps));
        ocrFormData.append("minConfidence", "0.25");
        ocrFormData.append("startTime", "0");
        ocrFormData.append("regions", JSON.stringify(ocrRegions.map((r) => ({ id: r.id, x: r.x, y: r.y, width: r.width, height: r.height }))));
        const ocrVideoResp = await fetch("/api/ocr/video", { method: "POST", body: ocrFormData, signal: pipelineSignal });
        if (!ocrVideoResp.ok || !ocrVideoResp.body) throw new Error(`OCR video thất bại: ${ocrVideoResp.status}`);

        const reader = ocrVideoResp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        outer: while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const ln of lines) {
              if (!ln.trim()) continue;
              let msg: any;
              try {
                msg = JSON.parse(ln);
              } catch {
                addLog(`[Python OCR] Bỏ qua 1 dòng NDJSON lỗi format: ${ln.slice(0, 200)}`);
                continue;
              }
              if (msg.type === "error") throw new Error(msg.error || "OCR server error");
              if (msg.type === "ocr_error") {
                addLog(`[Python OCR] Lỗi vùng ${msg.region_id || "unknown"} tại ${Number(msg.timestamp || 0).toFixed(2)}s: ${msg.error || "không rõ lỗi"}`);
                continue;
              }
              if (msg.type === "frame") {
                const frame: OcrFrameResult = {
                  timestamp: Number(msg.timestamp || 0),
                  detections: Array.isArray(msg.detections) ? msg.detections : [],
                };
                accumulatedFrames.push(frame);
                ocrVideoDuration = msg.duration || ocrVideoDuration;
                const now = performance.now();
                if (now - lastProgressUiAt >= 250 || Number(msg.percent || 0) >= 99) {
                  lastProgressUiAt = now;
                  setLoadingProgress(Math.min(94, msg.percent || 0));
                  const etaStr = msg.eta != null
                    ? msg.eta >= 60
                      ? `còn ~${Math.floor(msg.eta / 60)}p${Math.round(msg.eta % 60)}s`
                      : `còn ~${msg.eta}s`
                    : "";
                  const speedStr = msg.speed != null ? ` · ${msg.speed}x realtime` : "";
                  const ocrStr = msg.ocr_count != null ? ` · OCR: ${msg.ocr_count}` : "";
                  setLoadingStep(`[Python OCR] ${msg.percent || 0}% · ${etaStr}${speedStr}${ocrStr}`);
                }

                // Re-merging every accumulated frame on every message is O(n²)
                // and eventually freezes long OCR jobs. Refresh live subtitles
                // less often as the track grows; the final pass still merges all frames.
                if (accumulatedFrames.length >= nextLiveMergeFrameCount) {
                  const framesWithSpan = accumulatedFrames.map((frame, index) => ({
                    ...frame,
                    spanEnd: accumulatedFrames[index + 1]?.timestamp
                      ?? Math.min(ocrVideoDuration, frame.timestamp + ocrFrameInterval),
                  }));
                  const livePartial = mergeOcrFramesToSubtitles(
                    framesWithSpan, ocrFrameInterval, ocrVideoDuration, 0.86, watermarkRegionsRef.current,
                  );
                  latestOcrSubtitlesL = livePartial;
                  // Chỉ cập nhật kết quả OCR để xem trước. Dịch thuật phải chờ
                  // worker OCR hoàn tất toàn bộ video, tránh chạy song song với OCR.
                  setSubtitles(livePartial);
                  nextLiveMergeFrameCount = accumulatedFrames.length
                    + Math.max(10, Math.floor(accumulatedFrames.length * 0.08));
                }

                framesSinceMainThreadYield += 1;
                if (framesSinceMainThreadYield >= 100) {
                  framesSinceMainThreadYield = 0;
                  await new Promise<void>((resolve) => setTimeout(resolve, 0));
                }
              }
              if (msg.type === "done") { ocrVideoDuration = msg.duration || ocrVideoDuration; break outer; }
            }
          }

        const sortedAccumulatedFrames = [...accumulatedFrames].sort((a, b) => a.timestamp - b.timestamp);
        const gaps: Array<{ from: number; to: number; gap: number }> = [];
        for (let i = 1; i < sortedAccumulatedFrames.length; i++) {
          const gap = sortedAccumulatedFrames[i].timestamp - sortedAccumulatedFrames[i - 1].timestamp;
          if (gap > ocrFrameInterval * 1.5) gaps.push({ from: sortedAccumulatedFrames[i - 1].timestamp, to: sortedAccumulatedFrames[i].timestamp, gap });
        }
        if (gaps.length > 0) {
          addLog(`[CẢNH BÁO OCR] Phát hiện ${gaps.length} khoảng trống frame: ${gaps.map((gap) => `${gap.from.toFixed(1)}s→${gap.to.toFixed(1)}s`).join(", ")}`);
        }
        const originalSubtitlesL = mergeOcrFramesToSubtitles(
          sortedAccumulatedFrames.map((f, i) => ({ ...f, spanEnd: Math.min(ocrVideoDuration, f.timestamp + ocrFrameInterval) })),
          ocrFrameInterval, ocrVideoDuration, 0.86, watermarkRegionsRef.current,
        );
        if (!originalSubtitlesL.length) throw new Error("Python OCR không thấy phụ đề trong vùng đã chọn.");
        latestOcrSubtitlesL = originalSubtitlesL;
        setSubtitles(originalSubtitlesL);
        addLog(`[Python OCR] Gộp ${accumulatedFrames.length} frame thành ${originalSubtitlesL.length} dòng.`);
        addLog(`[Dịch thuật] OCR đã hoàn tất. Bắt đầu dịch toàn bộ ${originalSubtitlesL.length} dòng trước khi tạo TTS.`);
        scheduleLiveTranslationsL(originalSubtitlesL, true);
        setLoadingStep(`OCR Python hoàn tất; đang dịch toàn bộ phụ đề...`);
        setLoadingProgress(96);
        setLoadingEtaSeconds(Math.max(8, Math.ceil(6 + originalSubtitlesL.length * 0.18)));
        await translationQueueL;
        if (translationFailureL) throw translationFailureL;
        const finalSubtitlesL = applyLiveTranslationsL(originalSubtitlesL);
        setSubtitles(finalSubtitlesL);
        setSubtitlePipelineVersion(5);
        setActiveTab("tracks");
        setLoadingProgress(100);
        addLog(`[Python OCR] Hoàn tất ${finalSubtitlesL.length} dòng.`);
        return;
      }

      let base64Payload = "";
      let payloadMimeType = videoMimeType;
      let frames: { timestamp: number; base64: string }[] = [];
      
      if (videoFile) {
        if (extractionMethod === "aiocr") {
          setLoadingStep("Đang trích xuất khung hình từ video...");
          addLog("Bắt đầu trích xuất khung hình từ video...");
          const frameInterval = apiPlatform === "custom" ? 0.5 : 2.0;
          addLog(`Lấy khung hình OCR mỗi ${frameInterval}s${apiPlatform === "custom" ? " cho Custom API" : ""}.`);
          frames = await extractVideoFrames(videoFile, frameInterval, (step) => {
            setLoadingStep(step);
            addLog(step);
          });
          if (extractedAudioRef.current) {
            const cur = extractedAudioRef.current as { base64: string; mimeType: string; audioBuffer?: AudioBuffer };
            base64Payload = cur.base64;
            payloadMimeType = cur.mimeType;
          }
        } else {
          if (extractedAudioRef.current) {
            const cur = extractedAudioRef.current as { base64: string; mimeType: string; audioBuffer?: AudioBuffer };
            base64Payload = cur.base64;
            payloadMimeType = cur.mimeType;
          } else if (isExtractingAudio) {
            setLoadingStep("Vui lòng đợi giây lát, đang hoàn tất trích xuất âm thanh nền...");
            addLog("Đang đợi hoàn tất quá trình trích xuất âm thanh từ tệp video...");
            let waitTime = 0;
            while (!extractedAudioRef.current && waitTime < 60000) {
              await new Promise((r) => setTimeout(r, 500));
              waitTime += 500;
            }
            if (extractedAudioRef.current) {
              const cur = extractedAudioRef.current as { base64: string; mimeType: string; audioBuffer?: AudioBuffer };
              base64Payload = cur.base64;
              payloadMimeType = cur.mimeType;
            } else {
              throw new Error("Trích xuất âm thanh nền quá lâu hoặc gặp lỗi. Vui lòng thử lại.");
            }
          } else {
            setLoadingStep("Đang trích xuất âm thanh từ video...");
            addLog("Đang khởi chạy tiến trình trích xuất âm thanh: " + videoName);
            const extracted: { base64: string; mimeType: string; audioBuffer: AudioBuffer } =
              await extractAudioTrack(videoFile, (step) => {
                setLoadingStep(step);
                addLog(`Trích xuất: ${step}`);
              });
            base64Payload = extracted.base64;
            payloadMimeType = extracted.mimeType;
            extractedAudioRef.current = extracted;
            setExtractedAudio(extracted);
            addLog("Trích xuất âm thanh gốc thành công!");
          }
        }
      } else {
        // If it's the demo video, we fetch its content or mock the translation process 
        // to save API tokens and give an instantaneous premium experience.
        setLoadingStep("Gửi yêu cầu dịch thuật bằng Gemini 3.5 AI...");
        addLog("Sử dụng bản thử nghiệm tối ưu cho video demo...");
        await new Promise((r) => setTimeout(r, 2000));
        setSubtitles([...SAMPLE_SUBTITLES]);
        setLoadingStep("Đang cấu trúc kết quả phụ đề...");
        await new Promise((r) => setTimeout(r, 800));
        setIsLoading(false);
        setActiveTab("tracks");
        addLog("Nạp dữ liệu mẫu thành công.");
        return;
      }

      const audioBuffer = extractedAudioRef.current?.audioBuffer;
      const totalDuration = duration || (audioBuffer ? audioBuffer.duration : 0);
      const activeProjectId = currentProjectId || (videoFile ? makeProjectId(videoFile) : "temporary-project");
      const translationJobKey = `stt-v4-${stableHash(JSON.stringify({
        projectId: activeProjectId,
        sourceLang,
        targetLang,
        extractionMethod,
        apiPlatform,
        customModel: apiPlatform === "custom" ? customModel : "gemini",
      }))}`;
      const CHUNK_DURATION = 12;
      const CHUNK_OVERLAP = 2;
      const CHUNK_STEP = CHUNK_DURATION - CHUNK_OVERLAP;
      
      const shouldChunk = extractionMethod === "audio" && audioBuffer && totalDuration > CHUNK_DURATION;

      if (shouldChunk && audioBuffer) {
        const chunkRanges: Array<{ start: number; end: number }> = [];
        for (let start = 0; start < totalDuration; start += CHUNK_STEP) {
          chunkRanges.push({ start, end: Math.min(start + CHUNK_DURATION, totalDuration) });
          if (start + CHUNK_DURATION >= totalDuration) break;
        }
        const numChunks = chunkRanges.length;
        addLog(`Thời lượng video ${totalDuration.toFixed(1)}s. Chia thành ${numChunks} phân đoạn 12s, chồng lấn 2s để không mất lời ở biên.`);
        const allSubtitles: ChunkSubtitle[] = [];
        const chunkStageStartedAt = performance.now();
        setLoadingEtaSeconds(numChunks * (apiPlatform === "custom" ? 7 : 19));
        const updateChunkEstimate = (completed: number) => {
          const elapsedSeconds = Math.max(0.25, (performance.now() - chunkStageStartedAt) / 1000);
          const remaining = Math.max(0, numChunks - completed);
          const averageSeconds = elapsedSeconds / Math.max(1, completed);
          setLoadingProgress(Math.min(99, Math.round((completed / Math.max(1, numChunks)) * 99)));
          setLoadingEtaSeconds(remaining > 0 ? Math.max(1, Math.ceil(averageSeconds * remaining)) : 0);
        };

        for (let i = 0; i < numChunks; i++) {
          const { start: startSec, end: endSec } = chunkRanges[i];
          const currentChunkDuration = endSec - startSec;
          const chunkCacheId = `${activeProjectId}|${translationJobKey}|${startSec.toFixed(2)}-${endSec.toFixed(2)}`;
          const cachedChunk = await projectDbGet<StoredChunk>("chunks", chunkCacheId).catch(() => undefined);
          if (cachedChunk) {
            const normalizedCachedSubtitles = normalizeChunkSubtitleTimestamps(
              cachedChunk.subtitles,
              startSec,
              endSec,
              totalDuration,
            );
            allSubtitles.push(...normalizedCachedSubtitles);
            const partial = validateSubtitleTimeline(mergeDuplicateSubtitles(allSubtitles), totalDuration);
            setSubtitles(partial);
            addLog(`[Phân đoạn ${i + 1}/${numChunks}] Đã khôi phục và chuẩn hóa timestamp từ checkpoint (${normalizedCachedSubtitles.length} dòng), không gọi Gemini.`);
            updateChunkEstimate(i + 1);
            continue;
          }
          
          // Custom API does not use Gemini's free-tier request cooldown.
          if (i > 0 && apiPlatform !== "custom") {
            const cooldownSecs = 12;
            for (let sec = cooldownSecs; sec > 0; sec--) {
              setLoadingStep(`[Phân đoạn ${i + 1}/${numChunks}] Đang nghỉ ${sec}s để tránh quá tải giới hạn API miễn phí (Rate Limit)...`);
              setLoadingEtaSeconds((current) => current === null ? null : Math.max(1, current - 1));
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }

          setLoadingStep(`[Phân đoạn ${i + 1}/${numChunks}] Trích xuất âm thanh (${Math.floor(startSec)}s - ${Math.floor(endSec)}s)...`);
          const chunkBase64 = await getAudioChunkBase64(audioBuffer, startSec, endSec);

          setLoadingStep(`[Phân đoạn ${i + 1}/${numChunks}] Đang dịch thuật bằng AI...`);
          addLog(`[Phân đoạn ${i + 1}/${numChunks}] Đang dịch thuật và tạo phụ đề (${Math.floor(startSec)}s - ${Math.floor(endSec)}s)...`);
          
          let response: Response | null = null;
          let responseText = "";
          let attempt = 0;
          const maxAttempts = 3;
          
          while (attempt < maxAttempts) {
            try {
              response = await fetch("/api/translate-video", {
                signal: pipelineSignal,
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...getGeminiRequestHeaders(geminiApiKey),
                },
                body: JSON.stringify({
                  videoBase64: chunkBase64,
                  mimeType: payloadMimeType,
                  sourceLanguage: sourceLang,
                  targetLanguage: targetLang,
                  duration: currentChunkDuration,
                  videoDuration: totalDuration,
                  chunkIndex: i,
                  chunkStart: startSec,
                  chunkEnd: endSec,
                  timestampMode: "absolute",
                  apiPlatform: apiPlatform,
                  customApiUrl: apiPlatform === "custom" ? customApiUrl : "",
                  customApiKey: apiPlatform === "custom" ? customApiKey : "",
                  customModel: apiPlatform === "custom" ? customModel : "",
                  extractionMethod: extractionMethod,
                  allowGeminiFallback,
                  translationGlossary: translationGlossary.trim() || undefined,
                  translationStyle: translationStyle.trim() || undefined,
                }),
              });

              responseText = await response.text();
              
              if (response.status === 429) {
                attempt++;
                if (attempt < maxAttempts) {
                  // Wait longer and retry
                  const retryDelay = 20 * attempt;
                  for (let sec = retryDelay; sec > 0; sec--) {
                    setLoadingStep(`[Phân đoạn ${i + 1}/${numChunks}] API đạt giới hạn (429). Đang chờ thử lại sau ${sec}s (Lần thử ${attempt}/${maxAttempts - 1})...`);
                    setLoadingEtaSeconds((current) => current === null ? null : Math.max(1, current - 1));
                    await new Promise(resolve => setTimeout(resolve, 1000));
                  }
                  continue;
                }
              }
              break;
            } catch (fetchErr: any) {
              attempt++;
              if (attempt >= maxAttempts) {
                throw fetchErr;
              }
              await new Promise(resolve => setTimeout(resolve, 3000));
            }
          }

          if (!response || !response.ok) {
            let errMsg = `Dịch phân đoạn ${i + 1}/${numChunks} thất bại.`;
            try {
              const errData = JSON.parse(responseText);
              errMsg = errData.error || errMsg;
            } catch (jsonErr) {
              if (responseText.trim().startsWith("<")) {
                const titleMatch = responseText.match(/<title>([\s\S]*?)<\/title>/i);
                const title = titleMatch ? titleMatch[1].trim() : "";
                errMsg = `Lỗi hệ thống (HTML ${response ? response.status : "unknown"}) ở phân đoạn ${i + 1}: ${title || (response ? response.statusText : "")}`;
              } else {
                errMsg = `${response ? response.status : "unknown"} ${response ? response.statusText : ""}: ${responseText.substring(0, 150)}`;
              }
            }
            throw new Error(errMsg);
          }

          let data;
          try {
            data = JSON.parse(responseText);
          } catch (jsonErr) {
            console.error("Non-JSON response received:", responseText);
            if (responseText.trim().startsWith("<")) {
              const titleMatch = responseText.match(/<title>([\s\S]*?)<\/title>/i);
              const title = titleMatch ? titleMatch[1].trim() : "";
              throw new Error(`Lỗi phản hồi hệ thống (HTML format): ${title || "Phản hồi không mong đợi"}`);
            }
            throw new Error(`Phản hồi phân đoạn ${i + 1} từ server không đúng định dạng JSON.`);
          }

          if (data.subtitles && Array.isArray(data.subtitles)) {
            const rawChunkSubtitles: ChunkSubtitle[] = data.subtitles.map((sub: any, idx: number) => {
              const start = typeof sub.start === "number" ? sub.start : parseFloat(sub.start || 0);
              const end = typeof sub.end === "number" ? sub.end : parseFloat(sub.end || 0);
              const realStart = parseFloat(start.toFixed(2));
              const realEnd = parseFloat(Math.max(start + 0.1, end).toFixed(2));

              return {
                id: `sub-gen-${i}-${idx}-${Date.now()}`,
                start: realStart,
                end: realEnd,
                original: sub.original || "",
                translated: sub.translated || "",
                chunkIndex: i,
                chunkStart: startSec,
                chunkEnd: endSec,
                boundaryDistance: Math.max(0, Math.min(realStart - startSec, endSec - realEnd)),
              };
            });
            const formattedChunkSubtitles = normalizeChunkSubtitleTimestamps(
              rawChunkSubtitles,
              startSec,
              endSec,
              totalDuration,
            );
            
            allSubtitles.push(...formattedChunkSubtitles);
            const checkpointSaved = await projectDbPut("chunks", {
              id: chunkCacheId,
              projectId: activeProjectId,
              jobKey: translationJobKey,
              start: startSec,
              end: endSec,
              subtitles: formattedChunkSubtitles,
              updatedAt: Date.now(),
            } satisfies StoredChunk).then(() => true).catch((error) => {
              console.warn("Could not persist STT chunk:", error);
              addLog(`[Phân đoạn ${i + 1}/${numChunks}] Không lưu được checkpoint: ${error?.message || error}`);
              return false;
            });
            setSubtitles(validateSubtitleTimeline(mergeDuplicateSubtitles(allSubtitles), totalDuration));
            addLog(`[Phân đoạn ${i + 1}/${numChunks}] Hoàn tất! Nhận được ${formattedChunkSubtitles.length} dòng phụ đề.`);
            if (checkpointSaved) addLog(`[Phân đoạn ${i + 1}/${numChunks}] Đã lưu checkpoint; nếu hết quota có thể bấm chạy lại để tiếp tục.`);
          }
          updateChunkEstimate(i + 1);
        }

        // Sort entire merged array chronologically
        const sortedSubtitles = allSubtitles.sort((a, b) => a.start - b.start);
        const dedupedSubtitles = mergeDuplicateSubtitles(sortedSubtitles);
        const validatedSubtitles = validateSubtitleTimeline(dedupedSubtitles, totalDuration);
        if (validatedSubtitles.length === 0) {
          throw new Error("AI không trả về phụ đề hợp lệ; đã giữ nguyên phụ đề hiện tại.");
        }
        setSubtitles(validatedSubtitles);
        setSubtitlePipelineVersion(4);
        addLog(`Đã gộp trùng lặp: ${sortedSubtitles.length} → ${dedupedSubtitles.length} phân đoạn.`);
      } else {
        // Fallback for short files or when audioBuffer is not present (single request)
        setLoadingStep("Đang dịch thuật và trích xuất phụ đề bằng AI...");
        addLog("Đang dịch thuật và trích xuất phụ đề toàn bộ video bằng AI...");
        const singleRequestEstimate = Math.max(10, Math.ceil(8 + totalDuration * 0.08));
        const singleRequestStartedAt = performance.now();
        setLoadingEtaSeconds(singleRequestEstimate);
        const singleRequestTicker = window.setInterval(() => {
          const elapsed = Math.floor((performance.now() - singleRequestStartedAt) / 1000);
          setLoadingEtaSeconds(Math.max(1, singleRequestEstimate - elapsed));
          setLoadingProgress(Math.min(98, Math.max(1, Math.round((elapsed / singleRequestEstimate) * 90))));
        }, 1000);
        let response: Response;
        try {
          response = await fetch("/api/translate-video", {
            signal: pipelineSignal,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...getGeminiRequestHeaders(geminiApiKey),
            },
            body: JSON.stringify({
              videoBase64: base64Payload,
              mimeType: payloadMimeType,
              frames: frames,
              sourceLanguage: sourceLang,
              targetLanguage: targetLang,
              duration: totalDuration,
              videoDuration: totalDuration,
              chunkIndex: 0,
              chunkStart: 0,
              chunkEnd: totalDuration,
              timestampMode: "absolute",
              apiPlatform: apiPlatform,
              customApiUrl: apiPlatform === "custom" ? customApiUrl : "",
              customApiKey: apiPlatform === "custom" ? customApiKey : "",
              customModel: apiPlatform === "custom" ? customModel : "",
              extractionMethod: extractionMethod,
              allowGeminiFallback,
              translationGlossary: translationGlossary.trim() || undefined,
              translationStyle: translationStyle.trim() || undefined,
            }),
          });
        } finally {
          window.clearInterval(singleRequestTicker);
        }

        let responseText = "";
        try {
          responseText = await response.text();
        } catch (readErr) {
          throw new Error(`Không thể đọc luồng phản hồi từ server: ${response.status} ${response.statusText}`);
        }

        if (!response.ok) {
          let errMsg = "Gửi yêu cầu dịch video thất bại.";
          try {
            const errData = JSON.parse(responseText);
            errMsg = errData.error || errMsg;
          } catch (jsonErr) {
            if (responseText.trim().startsWith("<")) {
              const titleMatch = responseText.match(/<title>([\s\S]*?)<\/title>/i);
              const title = titleMatch ? titleMatch[1].trim() : "";
              errMsg = `Lỗi hệ thống (HTML ${response.status}): ${title || response.statusText}. Vui lòng thử lại với video ngắn hơn hoặc dung lượng nhỏ hơn.`;
            } else {
              errMsg = `${response.status} ${response.statusText}: ${responseText.substring(0, 150)}`;
            }
          }
          throw new Error(errMsg);
        }

        let data;
        try {
          data = JSON.parse(responseText);
        } catch (jsonErr) {
          console.error("Non-JSON response received:", responseText);
          if (responseText.trim().startsWith("<")) {
            const titleMatch = responseText.match(/<title>([\s\S]*?)<\/title>/i);
            const title = titleMatch ? titleMatch[1].trim() : "";
            throw new Error(`Lỗi phản hồi hệ thống (HTML format): ${title || "Phản hồi không mong đợi"}. Vui lòng thử lại với video ngắn hơn hoặc dung lượng nhỏ hơn.`);
          }
          throw new Error(`Phản hồi từ server không đúng định dạng JSON hợp lệ. Nội dung nhận được: ${responseText.substring(0, 150)}...`);
        }
        
        if (data.subtitles && Array.isArray(data.subtitles)) {
          // Map backend response into frontend model
          const formattedSubtitles: Subtitle[] = data.subtitles.map((sub: any, idx: number) => {
            const start = typeof sub.start === "number" ? sub.start : parseFloat(sub.start || 0);
            const end = typeof sub.end === "number" ? sub.end : parseFloat(sub.end || 0);
            
            return {
              id: `sub-gen-${idx}-${Date.now()}`,
              start: parseFloat(start.toFixed(2)),
              end: parseFloat(Math.max(start + 0.1, end).toFixed(2)),
              original: sub.original || "",
              translated: sub.translated || "",
            };
          });
          
          const dedupedSubtitles = mergeDuplicateSubtitles(formattedSubtitles);
          const validatedSubtitles = validateSubtitleTimeline(dedupedSubtitles, totalDuration);
          if (validatedSubtitles.length === 0) {
            throw new Error("AI không trả về phụ đề hợp lệ; đã giữ nguyên phụ đề hiện tại.");
          }
          setSubtitles(validatedSubtitles);
          setSubtitlePipelineVersion(4);
          setActiveTab("tracks");
          addLog(`Hoàn tất biên dịch! Nhận ${formattedSubtitles.length} đoạn, sau khi gộp trùng lặp còn ${dedupedSubtitles.length} phân đoạn.`);
        } else {
          throw new Error("Dữ liệu phụ đề phản hồi không đúng định dạng mong đợi.");
        }
      }

    } catch (err: any) {
      if (err?.name === "AbortError" || pipelineSignal.aborted) {
        addLog("Đã hủy OCR/dịch. Các batch hoàn thành vẫn được lưu trong checkpoint.");
        return;
      }
      console.error(err);
      setErrorMsg(`${err.message || "Đã xảy ra lỗi trong quá trình dịch thuật video."} Tiến độ đã hoàn thành được lưu; hãy bấm chạy lại khi quota khả dụng để tiếp tục.`);
      addLog("LỖI hệ thống: " + (err.message || String(err)));
      addLog("Checkpoint vẫn được giữ nguyên. Lần chạy sau sẽ bỏ qua các phân đoạn đã hoàn thành.");
    } finally {
      setIsLoading(false);
      setLoadingStep("");
      setLoadingEtaSeconds(null);
      finishPipelineJob(pipelineSignal);
    }
  };

  const handleExtractSubtitles = async (missingOnly = false) => {
    if (!videoFile) {
      setErrorMsg("Vui lòng tải lên video trước.");
      return;
    }
    setIsLoading(true);
    setErrorMsg("");
    setLoadingProgress(0);
    setLoadingStep("Chuẩn bị OCR...");
    try {
      const existingSubtitles = missingOnly ? [...subtitles] : [];
      const knownDuration = Math.max(0, duration || 0);
      const covered = [...existingSubtitles]
        .sort((left, right) => left.start - right.start)
        .reduce<Array<{ start: number; end: number }>>((ranges, subtitle) => {
          const start = Math.max(0, subtitle.start - 0.04);
          const end = Math.min(knownDuration || subtitle.end, subtitle.end + 0.04);
          const previous = ranges[ranges.length - 1];
          if (previous && start <= previous.end + 0.02) previous.end = Math.max(previous.end, end);
          else ranges.push({ start, end });
          return ranges;
        }, []);
      const scanRanges: Array<{ start: number; end: number }> = [];
      if (missingOnly && knownDuration > 0) {
        let cursor = 0;
        for (const range of covered) {
          if (range.start - cursor >= Math.max(0.12, 1 / ocrFps)) scanRanges.push({ start: cursor, end: range.start });
          cursor = Math.max(cursor, range.end);
        }
        if (knownDuration - cursor >= Math.max(0.12, 1 / ocrFps)) scanRanges.push({ start: cursor, end: knownDuration });
        if (!scanRanges.length) {
          setLoadingProgress(100);
          setLoadingStep("Timeline đã được OCR đầy đủ.");
          addLog("[OCR phần còn thiếu] Không có khoảng timeline nào cần quét thêm.");
          return;
        }
        addLog(`[OCR phần còn thiếu] Bỏ qua ${covered.length} vùng đã có phụ đề; chỉ quét ${scanRanges.length} khoảng trống.`);
      }
      const accumulatedFrames: OcrFrameResult[] = [];
      let ocrVideoDuration = 0;
      const frameInterval = 1 / ocrFps;
      const mergeScannedFrames = () => {
        if (!accumulatedFrames.length) return;
        const ranges = missingOnly ? scanRanges : [{ start: 0, end: ocrVideoDuration }];
        return ranges.flatMap((range) => {
          const rangeFrames = accumulatedFrames.filter((frame) => frame.timestamp >= range.start - 0.001 && frame.timestamp <= range.end + 0.001);
          return mergeOcrFramesToSubtitles(rangeFrames.map((frame, index) => ({ ...frame, spanEnd: rangeFrames[index + 1]?.timestamp ?? Math.min(range.end, frame.timestamp + frameInterval) })), frameInterval, range.end, 0.86, watermarkRegionsRef.current);
        });
      };
      const mergeWithExisting = (detected: Subtitle[]) => {
        const additions = detected.filter((candidate) => !existingSubtitles.some((current) => {
          const overlap = Math.min(candidate.end, current.end) - Math.max(candidate.start, current.start);
          const near = Math.abs(candidate.start - current.start) <= frameInterval * 1.5;
          return overlap > 0.02 || (near && ocrSimilarity(candidate.original, current.original) >= 0.82);
        })).map((candidate, index) => ({ ...candidate, id: `paddle-ocr-missing-${Date.now()}-${index + 1}` }));
        return [...existingSubtitles, ...additions].sort((left, right) => left.start - right.start);
      };
      const refreshPreview = () => {
        const partial = mergeScannedFrames();
        if (!partial) return;
        setSubtitles(missingOnly ? mergeWithExisting(partial) : partial);
      };

      setLoadingStep("Đang upload video lên server OCR...");
      const formData = new FormData();
      formData.append("video", videoFile);
      formData.append("fps", String(ocrFps));
      formData.append("minConfidence", "0.25");
      formData.append("startTime", "0");
      if (missingOnly) formData.append("scanRanges", JSON.stringify(scanRanges));
      formData.append("regions", JSON.stringify(ocrRegions.map((region) => ({
        id: region.id,
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
      }))));
      const response = await fetch("/api/ocr/video", { method: "POST", body: formData });
      if (!response.ok || !response.body) throw new Error(`OCR video thất bại: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        const message = JSON.parse(line);
        if (message.type === "error") throw new Error(message.error || "OCR server error");
        if (message.type === "ocr_error") {
          addLog(`[Python OCR] Lỗi vùng ${message.region_id || "unknown"} tại ${Number(message.timestamp || 0).toFixed(2)}s: ${message.error || "không rõ lỗi"}`);
          return;
        }
        if (message.type === "frame") {
          accumulatedFrames.push({
            timestamp: Number(message.timestamp || 0),
            detections: Array.isArray(message.detections) ? message.detections : [],
          });
          ocrVideoDuration = Number(message.duration || ocrVideoDuration);
          setLoadingProgress(Math.min(96, Number(message.percent || 0)));
          const eta = message.eta == null ? "" : message.eta >= 60 ? ` · còn ~${Math.floor(message.eta / 60)}p${Math.round(message.eta % 60)}s` : ` · còn ~${message.eta}s`;
          const speed = message.speed == null ? "" : ` · ${message.speed}x realtime`;
          setLoadingStep(`[Python OCR] ${message.percent || 0}%${eta}${speed} · OCR: ${message.ocr_count || accumulatedFrames.length}`);
          if (accumulatedFrames.length % 5 === 0) refreshPreview();
        }
        if (message.type === "done") ocrVideoDuration = Number(message.duration || ocrVideoDuration);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) consumeLine(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeLine(buffer);
      refreshPreview();

      const detected = mergeScannedFrames() || [];
      const extracted = missingOnly ? mergeWithExisting(detected) : detected;
      if (!extracted.length) throw new Error("Không tìm thấy phụ đề trong vùng OCR đã chọn.");
      setSubtitles(extracted);
      setSubtitlePipelineVersion(5);
      setLoadingProgress(100);
      setLoadingStep("Đã trích xuất phụ đề.");
      addLog(missingOnly ? `[OCR phần còn thiếu] Phát hiện thêm ${Math.max(0, extracted.length - existingSubtitles.length)} dòng; tổng ${extracted.length} dòng.` : `[Trích xuất phụ đề] Hoàn tất ${extracted.length} dòng.`);
    } catch (error: any) {
      const message = error?.message || String(error);
      setErrorMsg(`Trích xuất phụ đề thất bại: ${message}`);
      addLog(`[Trích xuất phụ đề] LỖI: ${message}`);
    } finally {
      setIsLoading(false);
      setLoadingEtaSeconds(null);
    }
  };

  // Video playback update handler
  const handleTimeUpdate = () => {
    const activeVideo = activeTab === "dubbin" ? workspaceVideoRef.current : videoRef.current;
    if (activeVideo) {
      setCurrentTime(activeVideo.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    const activeVideo = activeTab === "dubbin" ? workspaceVideoRef.current : videoRef.current;
    if (activeVideo) {
      setDuration(activeVideo.duration);
      setWorkspaceVideoDimensions({
        width: activeVideo.videoWidth || 16,
        height: activeVideo.videoHeight || 9
      });
    }
  };

  // Interactive controls
  const togglePlay = () => {
    const activeVideo = activeTab === "dubbin" ? workspaceVideoRef.current : videoRef.current;
    if (activeVideo) {
      if (isPlaying) {
        activeVideo.pause();
        setIsPlaying(false);
      } else {
        activeVideo.play().catch(console.error);
        setIsPlaying(true);
      }
    }
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const activeVideo = activeTab === "dubbin" ? workspaceVideoRef.current : videoRef.current;
    if (activeVideo) {
      activeVideo.currentTime = val;
      setCurrentTime(val);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    const activeVideo = activeTab === "dubbin" ? workspaceVideoRef.current : videoRef.current;
    if (activeVideo) {
      activeVideo.volume = val * originalAudioMixVolume;
    }
  };

  // Sync preview video volume whenever originalAudioMixVolume or volume changes
  useEffect(() => {
    const vid = activeTab === "dubbin" ? workspaceVideoRef.current : videoRef.current;
    if (vid) vid.volume = Math.min(1, volume * originalAudioMixVolume);
  }, [originalAudioMixVolume, volume, activeTab]);

  const handlePlaybackRateChange = (rate: number) => {
    setPlaybackRate(rate);
    const activeVideo = activeTab === "dubbin" ? workspaceVideoRef.current : videoRef.current;
    if (activeVideo) {
      activeVideo.playbackRate = rate;
    }
  };

  // Sync seek to subtitle start time
  const handleSeekTo = (time: number) => {
    const activeVideo = activeTab === "dubbin" ? workspaceVideoRef.current : videoRef.current;
    if (activeVideo) {
      activeVideo.currentTime = time;
      setCurrentTime(time);
      if (!isPlaying) {
        activeVideo.play().catch(console.error);
        setIsPlaying(true);
      }
    }
  };

  // Find active subtitle segment based on currentTime
  const currentSubtitle = useMemo(() => {
    let low = 0;
    let high = subtitles.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const subtitle = subtitles[middle];
      if (currentTime < subtitle.start) high = middle - 1;
      else if (currentTime > subtitle.end) low = middle + 1;
      else return subtitle;
    }
    return undefined;
  }, [subtitles, currentTime]);

  const currentSubtitleRef = useRef<Subtitle | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const vieneuAudioCacheRef = useRef<Record<string, string>>({});
  const tiktokAudioCacheRef = useRef<Record<string, string>>({});
  const ttsCacheSignatureRef = useRef<Record<string, string>>({});
  const fullTtsAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceTimingRef = useRef<Record<string, VoiceTiming>>({});
  const fittedTtsTextRef = useRef<Record<string, string>>({});
  const preparedVoiceoverRef = useRef<{ signature: string; blob: Blob } | null>(null);
  const preparingVoiceoverPromiseRef = useRef<Promise<Blob> | null>(null);

  // Clear Gemini voice cache when the selected voice changes
  useEffect(() => {
    Object.values(vieneuAudioCacheRef.current).forEach((url) => URL.revokeObjectURL(url));
    vieneuAudioCacheRef.current = {};
    ttsCacheSignatureRef.current = {};
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }
  }, [vieneuVoice]);

  // Clear TikTok voice cache when selected voice or session changes
  useEffect(() => {
    Object.values(tiktokAudioCacheRef.current).forEach((url) => URL.revokeObjectURL(url));
    tiktokAudioCacheRef.current = {};
    ttsCacheSignatureRef.current = {};
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }
  }, [tiktokVoice, tiktokSessionId]);

  // Sync fullTtsText when subtitles are loaded or updated
  useEffect(() => {
    voiceTimingRef.current = {};
    preparedVoiceoverRef.current = null;
    if (subtitles.length > 0) {
      const combined = subtitles.map(sub => sub.translated).join(" ");
      setFullTtsText(combined);
    } else {
      setFullTtsText("");
    }
    // Clean up previous generated full audio url when subtitles change
    if (fullTtsAudioUrl) {
      URL.revokeObjectURL(fullTtsAudioUrl);
      setFullTtsAudioUrl(null);
    }
    if (fullTtsAudioRef.current) {
      fullTtsAudioRef.current.pause();
      fullTtsAudioRef.current = null;
      setFullTtsPlaying(false);
    }
  }, [subtitles]);

  // Sync speed and volume to active full audio
  useEffect(() => {
    if (fullTtsAudioRef.current) {
      fullTtsAudioRef.current.volume = ttsVolume;
    }
  }, [ttsVolume]);

  useEffect(() => {
    if (fullTtsAudioRef.current) {
      fullTtsAudioRef.current.preservesPitch = true;
      fullTtsAudioRef.current.playbackRate = ttsRate;
    }
  }, [ttsRate]);

  // Clean up full TTS audio on unmount or engine/voice change
  useEffect(() => {
    return () => {
      if (fullTtsAudioRef.current) {
        fullTtsAudioRef.current.pause();
        fullTtsAudioRef.current = null;
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, [ttsEngine, vieneuVoice]);

  // Generate full narrative TTS audio using local VieNeu.
  const generateFullTtsVieNeu = async () => {
    if (!fullTtsText) return;
    setIsGeneratingFullTts(true);
    setErrorMsg("");

    // Stop existing playback
    if (fullTtsAudioRef.current) {
      fullTtsAudioRef.current.pause();
      fullTtsAudioRef.current = null;
      setFullTtsPlaying(false);
    }

    try {
      const res = await fetch("/api/synthesize-tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: fullTtsText, voiceName: vieneuVoice, engine: "vieneu" })
      });

      if (!res.ok) {
        throw new Error("Không thể kết nối đến máy chủ.");
      }

      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }

      if (data.audio) {
        const binary = atob(data.audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const wavBlob = data.format === "wav" ? new Blob([bytes], { type: "audio/wav" }) : pcmToWav(bytes, 24000);
        const audioUrl = URL.createObjectURL(wavBlob);
        
        setFullTtsAudioUrl(audioUrl);
        
        // Initialize HTML Audio Object
        const audio = new Audio(audioUrl);
        audio.volume = ttsVolume;
        audio.preservesPitch = true;
        audio.playbackRate = ttsRate;
        
        audio.oncanplaythrough = () => {
          setFullTtsDuration(audio.duration || 0);
        };
        
        audio.ontimeupdate = () => {
          setFullTtsCurrentTime(audio.currentTime);
        };
        
        audio.onended = () => {
          setFullTtsPlaying(false);
          setFullTtsCurrentTime(0);
        };
        
        audio.onerror = () => {
          setFullTtsPlaying(false);
        };

        fullTtsAudioRef.current = audio;
        
        // Play audio
        audio.play().then(() => {
          setFullTtsPlaying(true);
        }).catch(err => {
          console.error("Auto-play blocked or failed:", err);
          // Set duration manually even if blocked
          setFullTtsDuration(audio.duration || 0);
        });

      } else {
        throw new Error("Không nhận được dữ liệu âm thanh từ máy chủ.");
      }
    } catch (err: any) {
      console.error("Error generating full TTS:", err);
      setErrorMsg("Lỗi tạo thuyết minh toàn bài: " + (err.message || err));
    } finally {
      setIsGeneratingFullTts(false);
    }
  };

  // Play full text via browser speechSynthesis
  const playFullTtsBrowser = () => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    
    window.speechSynthesis.cancel();
    if (!fullTtsText) return;

    if (fullTtsPlaying) {
      window.speechSynthesis.cancel();
      setFullTtsPlaying(false);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(fullTtsText);
    if (voices.length > 0 && ttsVoiceName) {
      const selected = voices.find(v => v.name === ttsVoiceName);
      if (selected) utterance.voice = selected;
    }
    utterance.rate = ttsRate;
    utterance.pitch = ttsPitch;
    utterance.volume = ttsVolume;

    // Lower video sound during speech if autoMuteVideo is active
    if (autoMuteVideo && videoRef.current) {
      videoRef.current.volume = volume * originalAudioMixVolume;
    }

    utterance.onstart = () => {
      setFullTtsPlaying(true);
    };

    utterance.onend = () => {
      setFullTtsPlaying(false);
      if (videoRef.current) {
        videoRef.current.volume = volume * originalAudioMixVolume;
      }
    };

    utterance.onerror = () => {
      setFullTtsPlaying(false);
      if (videoRef.current) {
        videoRef.current.volume = volume * originalAudioMixVolume;
      }
    };

    window.speechSynthesis.speak(utterance);
  };

  const handleToggleFullTtsPlay = () => {
    if (ttsEngine === "browser") {
      playFullTtsBrowser();
      return;
    }

    if (!fullTtsAudioRef.current) return;

    if (fullTtsPlaying) {
      fullTtsAudioRef.current.pause();
      setFullTtsPlaying(false);
    } else {
      // Pause video if playing to avoid overlapping sound
      if (videoRef.current && isPlaying) {
        videoRef.current.pause();
        setIsPlaying(false);
      }
      fullTtsAudioRef.current.volume = ttsVolume;
      fullTtsAudioRef.current.preservesPitch = true;
      fullTtsAudioRef.current.playbackRate = ttsRate;
      fullTtsAudioRef.current.play().catch(console.error);
      setFullTtsPlaying(true);
    }
  };

  const handleFullTtsSeek = (time: number) => {
    if (fullTtsAudioRef.current) {
      fullTtsAudioRef.current.currentTime = time;
      setFullTtsCurrentTime(time);
    }
  };

  useEffect(() => {
    currentSubtitleRef.current = currentSubtitle || null;
  }, [currentSubtitle]);

  // Load and monitor system speech synthesis voices
  useEffect(() => {
    const loadVoices = () => {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        const allVoices = window.speechSynthesis.getVoices();
        setVoices(allVoices);
        // Prioritize Vietnamese voices
        const viVoice = allVoices.find(v => v.lang.toLowerCase().includes("vi"));
        if (viVoice) {
          setTtsVoiceName(viVoice.name);
        } else if (allVoices.length > 0) {
          const defaultVoice = allVoices.find(v => v.default) || allVoices[0];
          setTtsVoiceName(defaultVoice.name);
        }
      }
    };

    loadVoices();
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);

  // Utility to speak text using browser speech synthesis
  const speakText = (text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    
    // Stop any active audio
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }
    window.speechSynthesis.cancel();
    
    if (!text) return;
    
    const utterance = new SpeechSynthesisUtterance(text);
    if (voices.length > 0 && ttsVoiceName) {
      const selected = voices.find(v => v.name === ttsVoiceName);
      if (selected) utterance.voice = selected;
    }
    
    utterance.rate = ttsRate;
    utterance.pitch = ttsPitch;
    utterance.volume = ttsVolume;
    
    if (autoMuteVideo && videoRef.current) {
      videoRef.current.volume = volume * originalAudioMixVolume;
    }
    
    utterance.onend = () => {
      if (videoRef.current) {
        videoRef.current.volume = volume * originalAudioMixVolume;
      }
    };
    
    utterance.onerror = () => {
      if (videoRef.current) {
        videoRef.current.volume = volume * originalAudioMixVolume;
      }
    };
    
    window.speechSynthesis.speak(utterance);
  };

  // Utility to speak text using local VieNeu TTS.
  const speakTextVieNeu = async (text: string, subtitleId: string) => {
    if (typeof window === "undefined") return;

    // Stop browser SpeechSynthesis
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    
    // Stop any active VieNeu audio playing
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }

    if (!text) return;

    // Lower volume if requested
    if (autoMuteVideo && videoRef.current) {
      videoRef.current.volume = volume * originalAudioMixVolume;
    }

    // Check cache
    const cachedUrl = vieneuAudioCacheRef.current[subtitleId];
    const targetSub = subtitles.find(s => s.id === subtitleId);
    const subDuration = targetSub ? targetSub.end - targetSub.start : 0;

    if (cachedUrl) {
      const audio = new Audio(cachedUrl);
      audio.volume = ttsVolume;
      audio.preservesPitch = true;
      audio.playbackRate = ttsRate;
      
      // Smart TTS - auto speed up to fit within target subtitle duration
      audio.onloadedmetadata = () => {
        if (smartTtsEnabled && targetSub) {
          const gapAfter = getSubtitleGapAfter(targetSub, subtitles);
          audio.playbackRate = computeSmartTtsRate(audio.duration, subDuration, gapAfter, ttsRate);
        }
      };

      audio.onended = () => {
        if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
      };
      audio.onerror = () => {
        if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
      };
      ttsAudioRef.current = audio;
      audio.play().catch(err => {
        console.error("Error playing cached audio:", err);
        if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
      });
      return;
    }

    // Fetch from backend
    setGeneratingTtsId(subtitleId);
    try {
      const res = await fetch("/api/synthesize-tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voiceName: vieneuVoice, engine: "vieneu" })
      });
      if (!res.ok) {
        throw new Error("Không thể kết nối đến máy chủ.");
      }
      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }

      if (data.audio) {
        const binary = atob(data.audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const wavBlob = data.format === "wav" ? new Blob([bytes], { type: "audio/wav" }) : pcmToWav(bytes, 24000);
        const audioUrl = URL.createObjectURL(wavBlob);
        
        vieneuAudioCacheRef.current[subtitleId] = audioUrl;

        // Verify we are still on this segment
        if (currentSubtitleRef.current?.id === subtitleId) {
          const audio = new Audio(audioUrl);
          audio.volume = ttsVolume;
          audio.preservesPitch = true;
          audio.playbackRate = ttsRate;

          // Smart TTS - auto speed up to fit within target subtitle duration
          audio.onloadedmetadata = () => {
            if (smartTtsEnabled && targetSub) {
              const gapAfter = getSubtitleGapAfter(targetSub, subtitles);
              audio.playbackRate = computeSmartTtsRate(audio.duration, subDuration, gapAfter, ttsRate);
            }
          };
          audio.onended = () => {
            if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
          };
          audio.onerror = () => {
            if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
          };
          ttsAudioRef.current = audio;
          audio.play().catch(err => {
            console.error("Error playing VieNeu audio:", err);
            if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
          });
        } else {
          // Restore volume if we already passed it
          if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
        }
      } else {
        if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
      }
    } catch (err: any) {
      console.error("TTS generation error:", err);
      // Fallback to browser SpeechSynthesis so the user still hears it!
      speakText(text);
    } finally {
      setGeneratingTtsId(null);
    }
  };

  // Utility to speak text using TikTok TTS API
  const speakTextTikTok = async (text: string, subtitleId: string) => {
    if (typeof window === "undefined") return;

    // Stop browser SpeechSynthesis
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    
    // Stop any active audio playing
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }

    if (!text) return;

    // Lower volume if requested
    if (autoMuteVideo && videoRef.current) {
      videoRef.current.volume = volume * originalAudioMixVolume;
    }

    // Check cache
    const cachedUrl = tiktokAudioCacheRef.current[subtitleId];
    const targetSub = subtitles.find(s => s.id === subtitleId);
    const subDuration = targetSub ? targetSub.end - targetSub.start : 0;

    if (cachedUrl) {
      const audio = new Audio(cachedUrl);
      audio.volume = ttsVolume;
      audio.preservesPitch = true;
      audio.playbackRate = ttsRate;

      // Smart TTS - auto speed up to fit within target subtitle duration
      audio.onloadedmetadata = () => {
        if (smartTtsEnabled && targetSub) {
          const gapAfter = getSubtitleGapAfter(targetSub, subtitles);
          audio.playbackRate = computeSmartTtsRate(audio.duration, subDuration, gapAfter, ttsRate);
        }
      };

      audio.onended = () => {
        if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
      };
      audio.onerror = () => {
        if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
      };
      ttsAudioRef.current = audio;
      audio.play().catch(err => {
        console.error("Error playing cached TikTok audio:", err);
        if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
      });
      return;
    }

    // Fetch from backend
    setGeneratingTtsId(subtitleId);
    try {
      const res = await fetch("/api/synthesize-tts", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...getGeminiRequestHeaders(geminiApiKey),
        },
        body: JSON.stringify({
          text,
          voiceName: tiktokVoice,
          engine: "tiktok",
          sessionId: tiktokSessionId
        })
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Không thể kết nối đến máy chủ.");
      }
      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }

      if (data.audio) {
        const binary = atob(data.audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const mp3Blob = new Blob([bytes], { type: "audio/mp3" });
        const audioUrl = URL.createObjectURL(mp3Blob);
        
        tiktokAudioCacheRef.current[subtitleId] = audioUrl;

        // Verify we are still on this segment
        if (currentSubtitleRef.current?.id === subtitleId) {
          const audio = new Audio(audioUrl);
          audio.volume = ttsVolume;
          audio.preservesPitch = true;
          audio.playbackRate = ttsRate;

          // Smart TTS - auto speed up to fit within target subtitle duration
          audio.onloadedmetadata = () => {
            if (smartTtsEnabled && targetSub) {
              const gapAfter = getSubtitleGapAfter(targetSub, subtitles);
              audio.playbackRate = computeSmartTtsRate(audio.duration, subDuration, gapAfter, ttsRate);
            }
          };

          audio.onended = () => {
            if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
          };
          audio.onerror = () => {
            if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
          };
          ttsAudioRef.current = audio;
          audio.play().catch(err => {
            console.error("Error playing TikTok audio:", err);
            if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
          });
        } else {
          // Restore volume if we already passed it
          if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
        }
      } else {
        if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
      }
    } catch (err: any) {
      console.error("TikTok TTS generation error:", err);
      setErrorMsg("Không thể phát âm thanh TikTok TTS: " + err.message);
      if (videoRef.current) videoRef.current.volume = volume * originalAudioMixVolume;
    } finally {
      setGeneratingTtsId(null);
    }
  };

  // Sync play-along TTS reader
  const lastSpokenSubIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ttsEnabled) {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
        ttsAudioRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.volume = volume * originalAudioMixVolume;
      }
      return;
    }

    if (currentSubtitle) {
      if (currentSubtitle.id !== lastSpokenSubIdRef.current) {
        lastSpokenSubIdRef.current = currentSubtitle.id;
        if (ttsEngine === "vieneu") {
          speakTextVieNeu(currentSubtitle.translated, currentSubtitle.id);
        } else if (ttsEngine === "tiktok") {
          speakTextTikTok(currentSubtitle.translated, currentSubtitle.id);
        } else {
          speakText(currentSubtitle.translated);
        }
      }
    } else {
      // Reset spoken tracker when transition to blank video ranges
      lastSpokenSubIdRef.current = null;
    }
  }, [currentSubtitle, ttsEnabled, ttsEngine, vieneuVoice, tiktokVoice, tiktokSessionId, voices, ttsVoiceName, ttsRate, ttsPitch, ttsVolume, autoMuteVideo, volume]);

  // Cancel reading if video is paused
  useEffect(() => {
    if (!isPlaying) {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
      }
      if (videoRef.current) {
        videoRef.current.volume = volume * originalAudioMixVolume;
      }
    }
  }, [isPlaying]);

  // Edit action
  const handleStartEdit = (sub: Subtitle) => {
    setEditingSubId(sub.id);
    setEditOriginal(sub.original);
    setEditTranslated(sub.translated);
    setEditStart(sub.start);
    setEditEnd(sub.end);
  };

  const handleSaveEdit = (id: string) => {
    setSubtitles(prev => prev.map(sub => {
      if (sub.id === id) {
        return {
          ...sub,
          original: editOriginal,
          translated: editTranslated,
          start: Number(editStart),
          end: Number(editEnd),
        };
      }
      return sub;
    }));
    setEditingSubId(null);
  };

  const handleDeleteSub = (id: string) => {
    setSubtitles(prev => prev.filter(sub => sub.id !== id));
    if (editingSubId === id) {
      setEditingSubId(null);
    }
  };

  const handleAddSub = () => {
    const newSub: Subtitle = {
      id: `sub-manual-${Date.now()}`,
      start: parseFloat(currentTime.toFixed(1)),
      end: parseFloat((currentTime + 3).toFixed(1)),
      original: "New text segment...",
      translated: "Phân đoạn dịch mới...",
    };
    setSubtitles(prev => {
      const updated = [...prev, newSub];
      // Sort by start time
      return updated.sort((a, b) => a.start - b.start);
    });
    handleStartEdit(newSub);
  };

  // Export functions
  const formatSecondsToSRT = (seconds: number): string => {
    const totalMs = Math.round(Math.max(0, seconds) * 1000);
    const hrs = Math.floor(totalMs / 3600000);
    const mins = Math.floor((totalMs % 3600000) / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;

    const pad = (n: number, z: number = 2) => String(n).padStart(z, "0");
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
  };

  const formatSecondsToVTT = (seconds: number): string => {
    const totalMs = Math.round(Math.max(0, seconds) * 1000);
    const hrs = Math.floor(totalMs / 3600000);
    const mins = Math.floor((totalMs % 3600000) / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;

    const pad = (n: number, z: number = 2) => String(n).padStart(z, "0");
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`;
  };

  const triggerDownload = (filename: string, content: string) => {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const getOutputVideoFilename = () => {
    const withoutExtension = outputVideoName.trim().replace(/\.mp4$/i, "");
    const safeName = withoutExtension
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
      .replace(/[. ]+$/g, "")
      .trim();
    return `${safeName || "final-video"}.mp4`;
  };

  const saveVideoBlob = async (blob: Blob, filename: string) => {
    const isElectronCtx = typeof window !== "undefined" && navigator.userAgent.toLowerCase().includes("electron");
    if (isElectronCtx && window.electronAPI) {
      const arrayBuffer = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
      const base64 = btoa(binary);
      if (outputFolder) {
        const result = await window.electronAPI.saveFileToFolder(outputFolder, filename, base64);
        if (result.success) {
          addLog(`Đã lưu video vào: ${result.filePath}`);
        } else {
          addLog(`Lỗi lưu file: ${result.error}`);
        }
      } else {
        const result = await window.electronAPI.saveFileDialog(filename, base64);
        if (result.success) {
          addLog(`Đã lưu video vào: ${result.filePath}`);
        } else if (result.error) {
          addLog(`Lỗi lưu file: ${result.error}`);
        }
      }
    } else {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const exportSRT = () => {
    if (subtitles.length === 0) return;
    
    const sortedSubs = [...subtitles].sort((a, b) => a.start - b.start);
    let content = "";
    
    sortedSubs.forEach((sub, index) => {
      let endTime = sub.end;
      // Prevent overlapping timestamps (CapCut drops overlapping segments)
      if (index < sortedSubs.length - 1 && endTime > sortedSubs[index + 1].start) {
        endTime = sortedSubs[index + 1].start - 0.001;
      }
      
      const cleanText = (sub.translated || "").replace(/\r?\n/g, " ").trim();
      
      content += `${index + 1}\r\n`;
      content += `${formatSecondsToSRT(sub.start)} --> ${formatSecondsToSRT(endTime)}\r\n`;
      content += `${cleanText}\r\n\r\n`;
    });
    triggerDownload(`tool-dubbing-video.srt`, content);
  };

  const exportVTT = () => {
    if (subtitles.length === 0) return;
    let content = "WEBVTT\n\n";
    subtitles.forEach((sub, index) => {
      content += `${index + 1}\n`;
      content += `${formatSecondsToVTT(sub.start)} --> ${formatSecondsToVTT(sub.end)}\n`;
      content += `${sub.translated}\n\n`;
    });
    triggerDownload(`tool-dubbing-video.vtt`, content);
  };

  const exportJSON = () => {
    if (subtitles.length === 0) return;
    const content = JSON.stringify(subtitles, null, 2);
    triggerDownload(`tool-dubbing-video.json`, content);
  };

  const downloadOriginalVideo = () => {
    if (videoSrc) {
      const link = document.createElement("a");
      link.href = videoSrc;
      const extension = videoMimeType ? `.${videoMimeType.split("/")[1]}` : ".mp4";
      link.download = `tool-original-video${extension}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const [isPreGenerating, setIsPreGenerating] = useState<boolean>(false);
  const [regeneratingTtsId, setRegeneratingTtsId] = useState<string | null>(null);
  const [preGenerateProgress, setPreGenerateProgress] = useState<number>(0);
  const [preGenerateEtaSeconds, setPreGenerateEtaSeconds] = useState<number | null>(null);
  const ttsGenerationErrorRef = useRef("");

  const preGenerateAllTts = async (parentSignal?: AbortSignal): Promise<boolean> => {
    const pipelineSignal = parentSignal || beginPipelineJob("tts", "Đang tạo giọng thuyết minh");
    ttsGenerationErrorRef.current = "";
    if (isLoading) {
      const message = "Chưa thể tạo TTS vì bước OCR/dịch thuật vẫn đang chạy. Hãy chờ dịch hoàn tất toàn bộ phụ đề.";
      ttsGenerationErrorRef.current = message;
      setErrorMsg(message);
      return false;
    }
    if (subtitles.length === 0) {
      const message = "Không có phụ đề nào để tạo thuyết minh.";
      ttsGenerationErrorRef.current = message;
      setErrorMsg(message);
      return false;
    }
    const untranslatedCount = subtitles.filter((subtitle) => !cleanOcrText(String(subtitle.translated || ""))).length;
    if (untranslatedCount > 0) {
      const message = `Chưa thể tạo TTS: còn ${untranslatedCount} câu chưa dịch xong. Hãy hoàn tất bước dịch thuật trước.`;
      ttsGenerationErrorRef.current = message;
      setErrorMsg(message);
      addLog(`[TTS] Đã chặn tạo giọng đọc vì còn ${untranslatedCount} câu chưa dịch.`);
      return false;
    }
    if (ttsEngine === "browser") {
      const message = "Edge TTS chỉ dùng để nghe thử. Khi xuất video, hãy chọn VieNeu TTS hoặc TikTok TTS để tạo file âm thanh.";
      ttsGenerationErrorRef.current = message;
      setErrorMsg(message);
      return false;
    }

    setIsPreGenerating(true);
    setPreGenerateProgress(0);
    setPreGenerateEtaSeconds(Math.max(5, subtitles.length * 4));
    setErrorMsg("");
    addLog(`[TTS] Dịch thuật đã hoàn tất ${subtitles.length}/${subtitles.length} câu. Bắt đầu tạo giọng đọc.`);
    const ttsStageStartedAt = performance.now();
    let lastTtsProgressUiAt = 0;
    const updateTtsEstimate = (completed: number) => {
      const now = performance.now();
      if (completed < subtitles.length && now - lastTtsProgressUiAt < 250) return;
      lastTtsProgressUiAt = now;
      const safeCompleted = Math.max(1, completed);
      const elapsedSeconds = Math.max(0.25, (performance.now() - ttsStageStartedAt) / 1000);
      const averageSeconds = elapsedSeconds / safeCompleted;
      const remaining = Math.max(0, subtitles.length - completed);
      setPreGenerateProgress(Math.min(99, Math.round((completed / Math.max(1, subtitles.length)) * 100)));
      setPreGenerateEtaSeconds(remaining > 0 ? Math.max(1, Math.ceil(averageSeconds * remaining)) : 0);
    };

    const activeTtsEngine = ttsEngine;
    const cacheRef = activeTtsEngine === "tiktok" ? tiktokAudioCacheRef : vieneuAudioCacheRef;
    const voice = activeTtsEngine === "tiktok" ? tiktokVoice : vieneuVoice;
    let adaptiveTikTokConcurrency = activeTtsEngine === "tiktok" ? Math.min(4, subtitles.length) : 1;
    let stableTikTokRequests = 0;
    let tiktokCooldownUntil = 0;
    let fatalTtsError: Error | null = null;

    const reduceTikTokConcurrency = (reason: string) => {
      if (activeTtsEngine !== "tiktok") return;
      const previous = adaptiveTikTokConcurrency;
      adaptiveTikTokConcurrency = Math.max(2, Math.min(3, Math.floor(previous / 2)));
      stableTikTokRequests = 0;
      if (previous !== adaptiveTikTokConcurrency) {
        addLog(`[TikTok TTS] ${reason}; tự giảm ${previous} → ${adaptiveTikTokConcurrency} luồng.`);
      }
    };

    const recordStableTikTokRequest = () => {
      if (activeTtsEngine !== "tiktok" || adaptiveTikTokConcurrency >= 8) return;
      stableTikTokRequests += 1;
      if (stableTikTokRequests >= 24) {
        adaptiveTikTokConcurrency += 1;
        stableTikTokRequests = 0;
        addLog(`[TikTok TTS] Kết nối ổn định; tăng lên ${adaptiveTikTokConcurrency}/8 luồng.`);
      }
    };

    const synthesizeBlob = async (text: string, subtitleNumber: number): Promise<Blob> => {
      let lastError = "Không thể kết nối đến máy chủ.";
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (fatalTtsError) throw fatalTtsError;
        const controller = new AbortController();
        const abortFromPipeline = () => controller.abort();
        pipelineSignal.addEventListener("abort", abortFromPipeline, { once: true });
        const timeout = window.setTimeout(() => controller.abort(), 90_000);
        try {
          await waitForPipeline(pipelineSignal);
          const cooldownMs = tiktokCooldownUntil - Date.now();
          if (activeTtsEngine === "tiktok" && cooldownMs > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, cooldownMs));
            await waitForPipeline(pipelineSignal);
          }
          const res = await fetch("/api/synthesize-tts", {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, voiceName: voice, engine: activeTtsEngine, sessionId: activeTtsEngine === "tiktok" ? tiktokSessionId : undefined }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error || !data.audio) {
            const apiError = typeof data.error === "string"
              ? data.error
              : data.error?.message || data.message || JSON.stringify(data.error || data).slice(0, 500);
            const responseError = new Error(`HTTP ${res.status}${apiError ? `: ${apiError}` : ""}`) as Error & { status?: number };
            responseError.status = res.status;
            throw responseError;
          }
          const binary = atob(data.audio);
          const bytes = new Uint8Array(binary.length);
          for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
          recordStableTikTokRequest();
          return data.format === "mp3" ? new Blob([bytes], { type: "audio/mp3" }) : data.format === "wav" ? new Blob([bytes], { type: "audio/wav" }) : pcmToWav(bytes, 24000);
        } catch (error: any) {
          if (pipelineSignal.aborted) throw new DOMException("Tác vụ TTS đã được hủy.", "AbortError");
          lastError = error?.name === "AbortError" ? "Hết thời gian chờ TTS (90 giây)." : (error?.message || String(error));
          const isThrottled = error?.status === 429 || /\b429\b|rate.?limit|too many requests/i.test(lastError);
          const isFatalConfigurationError = error?.status === 400 || error?.status === 401 || error?.status === 403 ||
            /session id.*(?:không hợp lệ|hết hạn)|thiếu tik.?tok session|engine không hợp lệ/i.test(lastError);
          if (isFatalConfigurationError) {
            fatalTtsError = new Error(lastError);
            throw fatalTtsError;
          }
          if (error?.name === "AbortError" || isThrottled) {
            reduceTikTokConcurrency(isThrottled ? "API giới hạn tốc độ (429)" : "request bị timeout");
            if (isThrottled) tiktokCooldownUntil = Math.max(tiktokCooldownUntil, Date.now() + 8_000);
          } else if (error?.status >= 500 && activeTtsEngine === "tiktok") {
            reduceTikTokConcurrency(`TikTok tạm thời lỗi HTTP ${error.status}`);
            tiktokCooldownUntil = Math.max(tiktokCooldownUntil, Date.now() + 4_000);
          }
          if (attempt < 3) {
            const retryDelay = (attempt === 1 ? 2_000 : 5_000) + Math.floor(Math.random() * 1_500);
            await new Promise((resolve) => window.setTimeout(resolve, retryDelay));
          }
        } finally {
          window.clearTimeout(timeout);
          pipelineSignal.removeEventListener("abort", abortFromPipeline);
        }
      }
      throw new Error(`Phân đoạn #${subtitleNumber} lỗi sau 3 lần thử: ${lastError}`);
    };

    try {
      let nextSubtitleIndex = 0;
      let completedSubtitleCount = 0;
      const generationErrors: Array<{ index: number; subtitleId: string; text: string; error: unknown }> = [];
      const describeTtsError = (error: unknown) => {
        if (error instanceof Error) return error.message || error.name;
        if (typeof error === "string") return error;
        try { return JSON.stringify(error); } catch { return String(error); }
      };

      const generateSubtitleAudio = async (i: number) => {
        const sub = subtitles[i];

        // Empty/punctuation-only cues still need a cache entry so finalize has
        // exactly one audio checkpoint for every subtitle on the timeline.
        const textToSpeak = sub.translated?.trim() || sub.original?.trim();
        if (!textToSpeak) {
          const signature = `${activeTtsEngine}|${voice}|__silence__`;
          const audioBlob = pcmToWav(new Uint8Array(2400), 24000);
          cacheRef.current[sub.id] = URL.createObjectURL(audioBlob);
          ttsCacheSignatureRef.current[sub.id] = signature;
          const activeProjectId = currentProjectId || (videoFile ? makeProjectId(videoFile) : "");
          if (activeProjectId) {
            await projectDbPut("tts", {
              id: `${activeProjectId}|tts-v2|${sub.id}|${stableHash(signature)}`,
              projectId: activeProjectId,
              signature,
              subtitleId: sub.id,
              blob: audioBlob,
              updatedAt: Date.now(),
            } satisfies StoredTtsClip);
          }
          addLog(`[TTS ${i + 1}/${subtitles.length}] Câu rỗng; đã lưu checkpoint im lặng.`);
          return;
        }
        const signature = `${activeTtsEngine}|${voice}|${textToSpeak}`;
        if (cacheRef.current[sub.id] && ttsCacheSignatureRef.current[sub.id] === signature) {
          return;
        }
        if (cacheRef.current[sub.id]) URL.revokeObjectURL(cacheRef.current[sub.id]);

        const activeProjectId = currentProjectId || (videoFile ? makeProjectId(videoFile) : "");
        const ttsCacheId = activeProjectId
          ? `${activeProjectId}|tts-v2|${sub.id}|${stableHash(signature)}`
          : "";
        if (ttsCacheId) {
          const storedTts = await projectDbGet<StoredTtsClip>("tts", ttsCacheId).catch(() => undefined);
          if (storedTts?.blob && storedTts.signature === signature) {
            cacheRef.current[sub.id] = URL.createObjectURL(storedTts.blob);
            ttsCacheSignatureRef.current[sub.id] = signature;
            addLog(`[TTS ${i + 1}/${subtitles.length}] Khôi phục audio từ checkpoint, không gọi API.`);
            return;
          }
        }

        let audioBlob: Blob;
        if (!/[\p{L}\p{N}]/u.test(textToSpeak)) {
          // Punctuation-only subtitles such as "..." carry timing/visual
          // meaning but have nothing pronounceable. TikTok returns a generic
          // status code for them which used to be misreported as an expired
          // session. Persist a tiny silent clip so Smart TTS remains complete.
          audioBlob = pcmToWav(new Uint8Array(2400), 24000);
          addLog(`[TTS ${i + 1}/${subtitles.length}] Bỏ qua câu chỉ có dấu câu "${textToSpeak}"; đã lưu đoạn im lặng.`);
        } else {
          const clauses = splitTtsTextIntoClauses(textToSpeak);
          const clauseBlobs: Blob[] = [];
          for (const clause of clauses) clauseBlobs.push(await synthesizeBlob(clause, i + 1));
          audioBlob = await concatenateAudioBlobs(clauseBlobs);
        }
        cacheRef.current[sub.id] = URL.createObjectURL(audioBlob);
        ttsCacheSignatureRef.current[sub.id] = signature;
        if (ttsCacheId && activeProjectId) {
          const ttsCheckpointSaved = await projectDbPut("tts", {
            id: ttsCacheId,
            projectId: activeProjectId,
            signature,
            subtitleId: sub.id,
            blob: audioBlob,
            updatedAt: Date.now(),
          } satisfies StoredTtsClip).then(() => true).catch((error) => {
            console.warn("Could not persist TTS clip:", error);
            return false;
          });
          if (ttsCheckpointSaved) addLog(`[TTS ${i + 1}/${subtitles.length}] Đã lưu checkpoint audio.`);
        }
      };

      const workerCount = activeTtsEngine === "tiktok" ? Math.min(8, subtitles.length) : 1;
      if (activeTtsEngine === "tiktok" && workerCount > 1) {
        addLog(`[TikTok TTS] Bắt đầu ${adaptiveTikTokConcurrency} luồng, tự điều chỉnh tối đa ${workerCount}; vẫn lưu checkpoint riêng từng câu.`);
      }

      const runWorker = async (workerIndex: number) => {
        while (true) {
          if (fatalTtsError) return;
          if (nextSubtitleIndex >= subtitles.length) return;
          await waitForPipeline(pipelineSignal);
          while (workerIndex >= adaptiveTikTokConcurrency) {
            if (fatalTtsError) return;
            if (nextSubtitleIndex >= subtitles.length) return;
            await new Promise((resolve) => window.setTimeout(resolve, 350));
            await waitForPipeline(pipelineSignal);
          }
          const i = nextSubtitleIndex++;
          if (i >= subtitles.length) return;
          try {
            await generateSubtitleAudio(i);
            completedSubtitleCount += 1;
            updateTtsEstimate(completedSubtitleCount);
          } catch (error) {
            const failedSubtitle = subtitles[i];
            const failedText = failedSubtitle.translated?.trim() || failedSubtitle.original?.trim() || "(câu rỗng)";
            const cause = describeTtsError(error);
            generationErrors.push({ index: i, subtitleId: failedSubtitle.id, text: failedText, error });
            addLog(`[TTS ${i + 1}/${subtitles.length}] Lỗi: ${cause} | Nội dung: "${failedText.slice(0, 120)}" | Engine: ${activeTtsEngine}, voice: ${voice}.`);
            completedSubtitleCount += 1;
            updateTtsEstimate(completedSubtitleCount);
            if (fatalTtsError) return;
          }
        }
      };

      await Promise.all(Array.from({ length: workerCount }, (_, workerIndex) => runWorker(workerIndex)));
      if (generationErrors.length > 0) {
        const failedNumbers = generationErrors.slice(0, 12).map(({ index }) => index + 1).join(", ");
        const details = generationErrors.slice(0, 5).map(({ index, subtitleId, text, error }) =>
          `• Câu ${index + 1} (${subtitleId}): ${describeTtsError(error)}\n  Nội dung: "${text.slice(0, 180)}"`,
        ).join("\n");
        const message = `TTS còn ${generationErrors.length} câu lỗi (${failedNumbers}${generationErrors.length > 12 ? ", ..." : ""}).\nEngine: ${activeTtsEngine} · Voice: ${voice}\n${details}${generationErrors.length > 5 ? `\n• Và ${generationErrors.length - 5} lỗi khác — xem Nhật ký để biết chi tiết.` : ""}\nCác câu thành công đã lưu checkpoint; chạy lại chỉ thử các câu còn thiếu.`;
        ttsGenerationErrorRef.current = message;
        setErrorMsg(message);
        return false;
      }
      setPreGenerateProgress(100);
      return true;
    } catch (err: any) {
      if (err?.name === "AbortError" || pipelineSignal.aborted) {
        ttsGenerationErrorRef.current = "Tác vụ TTS đã được hủy. Các câu hoàn thành vẫn được giữ trong checkpoint.";
        addLog(ttsGenerationErrorRef.current);
        return false;
      }
      console.error("Lỗi khi tạo thuyết minh hàng loạt:", err);
      const message = "Không thể tạo thuyết minh hàng loạt: " + err.message + " Các câu đã tạo được lưu; lần chạy sau sẽ tiếp tục từ câu còn thiếu.";
      ttsGenerationErrorRef.current = message;
      setErrorMsg(message);
      return false;
    } finally {
      setIsPreGenerating(false);
      setPreGenerateEtaSeconds(null);
      if (!parentSignal) finishPipelineJob(pipelineSignal);
    }
  };

  const generateMergedVoiceoverBlob = async (
    fitAttempt = 0,
    skipPreGenerate = false,
    parentSignal?: AbortSignal,
  ): Promise<Blob> => {
    const pipelineSignal = parentSignal || pipelineAbortRef.current?.signal || beginPipelineJob("smart-tts", "Đang finalize Smart TTS");
    if (subtitles.length === 0) {
      throw new Error("Không có phụ đề nào để tạo thuyết minh.");
    }

    // Automatically generate missing audio files for all subtitles!
    if (!skipPreGenerate) {
      const success = await preGenerateAllTts(pipelineSignal);
      if (!success) {
        throw new Error(ttsGenerationErrorRef.current || "Quá trình tổng hợp giọng đọc bị lỗi hoặc dừng giữa chừng.");
      }
    }

    const activeTtsEngine = ttsEngine;
    const cacheRef = activeTtsEngine === "tiktok" ? tiktokAudioCacheRef : vieneuAudioCacheRef;
    const validSubs = subtitles.filter(s => cacheRef.current[s.id]);
    if (validSubs.length === 0) {
      throw new Error("Chưa có phân đoạn thuyết minh AI nào được tạo. Hãy dịch và chạy thuyết minh trước.");
    }
    if (validSubs.length !== subtitles.length) {
      const missingCount = subtitles.length - validSubs.length;
      throw new Error(`Thiếu âm thanh thuyết minh cho ${missingCount}/${subtitles.length} phụ đề; không thể xuất video có gián đoạn giọng đọc.`);
    }

    const detectedVideoDuration = workspaceVideoRef.current?.duration || videoRef.current?.duration || duration;
    const totalDuration = Number.isFinite(detectedVideoDuration) && detectedVideoDuration > 0
      ? detectedVideoDuration
      : Math.max(...subtitles.map(s => s.end));
    const sampleRate = 24000;
    
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const tempCtx = new AudioContextClass();
    
    // Decoding thousands of clips with one unbounded Promise.all can exhaust
    // Chromium's media decoder pool. Worse, decodeAudioData may never settle
    // for a damaged blob, leaving Smart TTS stuck at 100% forever. Keep a
    // small bounded queue and fail a specific clip after a real timeout.
    const decodedResults = new Array<{ sub: Subtitle; decoded: AudioBuffer }>(validSubs.length);
    let decodeCursor = 0;
    let decodedCount = 0;
    const decodeWorker = async () => {
      while (decodeCursor < validSubs.length) {
        await waitForPipeline(pipelineSignal);
        const index = decodeCursor++;
        const sub = validSubs[index];
        const url = cacheRef.current[sub.id];
        let timeoutId = 0;
        try {
          const decoded = await Promise.race([
            (async () => {
              const res = await fetch(url, { signal: pipelineSignal });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const arrayBuffer = await res.arrayBuffer();
              if (arrayBuffer.byteLength < 64) throw new Error("audio rỗng hoặc không đầy đủ");
              return tempCtx.decodeAudioData(arrayBuffer.slice(0));
            })(),
            new Promise<never>((_, reject) => {
              timeoutId = window.setTimeout(() => reject(new Error("decode quá 30 giây")), 30_000);
            }),
          ]);
          decodedResults[index] = { sub, decoded };
        } catch (error: any) {
          delete cacheRef.current[sub.id];
          const signature = ttsCacheSignatureRef.current[sub.id];
          delete ttsCacheSignatureRef.current[sub.id];
          const activeProjectId = currentProjectId || (videoFile ? makeProjectId(videoFile) : "");
          if (activeProjectId && signature) {
            const cacheId = `${activeProjectId}|tts-v2|${sub.id}|${stableHash(signature)}`;
            await projectDbDelete("tts", cacheId).catch(() => undefined);
          }
          throw new Error(`Audio TTS câu #${index + 1} bị hỏng (${sub.id}): ${error?.message || error}. Checkpoint lỗi đã được loại; chạy lại để chỉ tạo lại câu này.`);
        } finally {
          if (timeoutId) window.clearTimeout(timeoutId);
        }
        decodedCount += 1;
        if (decodedCount === validSubs.length || decodedCount % 100 === 0) {
          setPreGenerateProgress(95 + Math.floor((decodedCount / validSubs.length) * 2));
          addLog(`[Smart TTS decode] ${decodedCount}/${validSubs.length} câu đã kiểm tra.`);
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, validSubs.length) }, () => decodeWorker()));

    const decodedClips = decodedResults
      .map(({ sub, decoded }) => {
        const trimmed = trimAudioBufferSilence(decoded);
        const text = fittedTtsTextRef.current[sub.id]?.trim() || sub.translated?.trim() || sub.original?.trim() || "";
        const characterCount = countSpeechCharacters(text);
        return {
          sub,
          text,
          rawDuration: decoded.duration,
          trimmed,
          characterCount,
          charsPerSecond: characterCount / Math.max(0.05, trimmed.duration),
        };
      })
      .sort((a, b) => a.sub.start - b.sub.start);
    await tempCtx.close();

    const medianCharsPerSecond = median(
      decodedClips
        .map((clip) => clip.charsPerSecond)
        .filter((value) => Number.isFinite(value) && value > 0),
    );
    const baseRate = Math.max(SMART_TTS_MIN_RATE, Math.min(SMART_TTS_MAX_RATE, ttsRate));
    const cueGroupIds: string[] = [];
    let cueGroupNumber = 0;
    let cueGroupStart = decodedClips[0]?.sub.start ?? 0;
    let cueGroupSize = 0;
    decodedClips.forEach((clip, index) => {
      const previous = decodedClips[index - 1];
      const gapFromPrevious = previous ? Math.max(0, clip.sub.start - previous.sub.end) : 0;
      if (index === 0 || gapFromPrevious > 0.65 || cueGroupSize >= 5 || clip.sub.end - cueGroupStart > 12) {
        cueGroupNumber += 1;
        cueGroupStart = clip.sub.start;
        cueGroupSize = 0;
      }
      cueGroupSize += 1;
      cueGroupIds[index] = `smart-group-${cueGroupNumber}`;
    });
    const preparedClips = decodedClips.map((clip, index) => {
      const naturalTarget = medianCharsPerSecond > 0
        ? clip.characterCount / medianCharsPerSecond
        : clip.trimmed.duration;
      const normalizationRate = Math.max(
        0.85,
        Math.min(1.3, clip.trimmed.duration / Math.max(0.05, naturalTarget)),
      );
      const previousEnd = decodedClips[index - 1]?.sub.end ?? 0;
      const nextStart = decodedClips[index + 1]?.sub.start ?? totalDuration;
      const slotDuration = Math.max(0.1, clip.sub.end - clip.sub.start);
      const gapBefore = Math.max(0, clip.sub.start - previousEnd);
      const gapAfter = Math.max(0, nextStart - clip.sub.end);
      const borrowedBefore = Math.min(0.15, gapBefore * 0.35);
      const borrowedAfter = Math.max(0, Math.min(gapAfter * 0.8, gapAfter - 0.1));
      const adjustedStart = Math.max(0, clip.sub.start - borrowedBefore);
      const adjustedEnd = Math.min(totalDuration, clip.sub.end + borrowedAfter);
      const availableDuration = Math.max(0.1, adjustedEnd - adjustedStart);
      // Nếu audio đã ngắn hơn slot thì không cần tăng tốc, để rate=1.0
      // Nếu audio dài hơn slot thì mới cần tăng để vừa slot
      const requiredRate = clip.trimmed.duration / availableDuration;
      let preferredRate: number;
      if (!smartTtsEnabled) {
        preferredRate = baseRate;
      } else if (requiredRate <= baseRate) {
        // Audio ngắn hơn slot: không cần tăng tốc
        preferredRate = baseRate;
      } else {
        // Audio dài hơn slot: tăng tối thiểu để vừa, nhưng không thấp hơn baseRate
        preferredRate = Math.max(baseRate, normalizationRate, requiredRate);
      }
      return {
        ...clip,
        groupId: cueGroupIds[index],
        slotDuration,
        gapBefore,
        gapAfter,
        borrowedBefore,
        borrowedAfter,
        adjustedStart,
        adjustedEnd,
        availableDuration,
        requiredRate,
        preferredRate,
      };
    });

    const groupFitAtMaxRate = new Map<string, boolean>();
    for (const groupId of new Set(preparedClips.map((clip) => clip.groupId))) {
      const group = preparedClips.filter((clip) => clip.groupId === groupId);
      const groupStart = group[0].adjustedStart;
      const groupEnd = group[group.length - 1].adjustedEnd;
      const requiredDuration = group.reduce((sum, clip) => sum + clip.trimmed.duration / SMART_TTS_MAX_RATE, 0)
        + Math.max(0, group.length - 1) * SMART_TTS_VOICE_GAP_SECONDS;
      groupFitAtMaxRate.set(groupId, requiredDuration <= groupEnd - groupStart + 0.01);
    }
    addLog(`Smart TTS Pass 1-2: đo ${preparedClips.length} câu, chia ${new Set(cueGroupIds).size} nhóm cue và phân bổ GAP an toàn.`);

    type ScheduledVoiceClip = {
      subtitleId: string;
      buffer: AudioBuffer;
      start: number;
      rate: number;
      originalStart: number;
      desiredStart: number;
      end: number;
    };

    // Xếp giọng tuần tự trên toàn track. Timestamp vẫn là vị trí ưu tiên, nhưng nếu
    // hai dòng bị Gemini dồn sát nhau thì dòng sau được nhích sang phải thay vì ép
    // dòng trước lên hàng chục lần tốc độ hoặc trộn hai giọng lên nhau.
    const buildVoiceSchedule = (
      rateMultiplier: number,
      gapSeconds: number,
      rateCeiling = SMART_TTS_MAX_RATE,
    ): ScheduledVoiceClip[] => {
      let voiceCursor = 0;
      return preparedClips.map((clip, index) => {
        const rate = Math.min(rateCeiling, clip.preferredRate * rateMultiplier);
        const originalStart = Math.max(0, Math.min(totalDuration, clip.sub.start));
        const desiredStart = clip.adjustedStart;
        const start = index === 0
          ? desiredStart
          : Math.max(desiredStart, voiceCursor + gapSeconds);
        const end = start + clip.trimmed.duration / rate;
        voiceCursor = end;
        return { subtitleId: clip.sub.id, buffer: clip.trimmed, start, rate, originalStart, desiredStart, end };
      });
    };

    const backshiftScheduleToVideoEnd = (clips: ScheduledVoiceClip[]): ScheduledVoiceClip[] | null => {
      const shifted = new Array<ScheduledVoiceClip>(clips.length);
      let cursor = totalDuration;
      for (let index = clips.length - 1; index >= 0; index--) {
        const clip = clips[index];
        const clipDuration = clip.end - clip.start;
        const end = Math.min(cursor, clip.desiredStart + clipDuration, totalDuration);
        const start = end - clipDuration;
        if (start < -0.001) return null;
        shifted[index] = { ...clip, start: Math.max(0, start), end: Math.max(0, start) + clipDuration };
        cursor = start;
      }
      return shifted;
    };

    const scheduleEnd = (clips: ScheduledVoiceClip[]) => clips.at(-1)?.end ?? 0;
    const MAX_SMART_TTS_BLACK_TAIL_SECONDS = 2;
    const buildEmergencyPitchSafeSchedule = (): ScheduledVoiceClip[] | null => {
      const minimumPreferredRate = Math.min(...preparedClips.map((clip) => clip.preferredRate));
      const regularMultiplier = SMART_TTS_MAX_RATE / minimumPreferredRate;
      const emergencyRateCeiling = SMART_TTS_MAX_RATE * 1.05;
      const emergencyMultiplier = emergencyRateCeiling / minimumPreferredRate;
      if (scheduleEnd(buildVoiceSchedule(emergencyMultiplier, 0, emergencyRateCeiling)) > totalDuration + 0.01) {
        return null;
      }
      let low = regularMultiplier;
      let high = emergencyMultiplier;
      for (let iteration = 0; iteration < 28; iteration++) {
        const middle = (low + high) / 2;
        if (scheduleEnd(buildVoiceSchedule(middle, 0, emergencyRateCeiling)) <= totalDuration + 0.01) high = middle;
        else low = middle;
      }
      return buildVoiceSchedule(high, 0, emergencyRateCeiling);
    };
    let selectedGap = SMART_TTS_VOICE_GAP_SECONDS;
    let rateMultiplier = 1;
    let scheduledClips = buildVoiceSchedule(rateMultiplier, selectedGap);
    const requiresContentFit = preparedClips.some((clip, index) => {
      const availableDuration = Math.max(0.35, clip.availableDuration);
      const durationRatio = Math.min(0.88, (availableDuration * SMART_TTS_MAX_RATE) / Math.max(0.05, clip.trimmed.duration));
      const fullCharacterCount = Math.max(1, Array.from(clip.text).length);
      const maxChars = Math.max(8, Math.floor(fullCharacterCount * Math.max(0.18, durationRatio) * 0.92));
      const exceedsOwnSlot = clip.trimmed.duration / SMART_TTS_MAX_RATE > availableDuration;
      // Only start another AI fitting pass when the character budget can
      // actually become shorter. Otherwise the sequential scheduler safely
      // borrows a following gap without reordering subtitle timestamps.
      return exceedsOwnSlot && !groupFitAtMaxRate.get(clip.groupId) && maxChars < fullCharacterCount - 1;
    });

    smartTtsFit: if (smartTtsEnabled && (requiresContentFit || scheduleEnd(scheduledClips) > totalDuration + 0.01)) {
      const naturalTailOverflow = Math.max(0, scheduleEnd(scheduledClips) - totalDuration);
      if (!requiresContentFit && naturalTailOverflow <= MAX_SMART_TTS_BLACK_TAIL_SECONDS) {
        addLog(
          `Smart TTS: voice cuối dài hơn video ${naturalTailOverflow.toFixed(2)}s; `
          + `giữ nhịp đọc và sẽ nối nền đen ở cuối (giới hạn ${MAX_SMART_TTS_BLACK_TAIL_SECONDS}s).`,
        );
        break smartTtsFit;
      }
      const maxMultiplier = SMART_TTS_MAX_RATE / Math.min(
        ...preparedClips.map((clip) => clip.preferredRate),
      );
      const maxRateSchedule = buildVoiceSchedule(maxMultiplier, selectedGap);

      // Chỉ tăng vừa đủ để toàn bộ track nằm trong thời lượng video.
      if (!requiresContentFit && scheduleEnd(maxRateSchedule) <= totalDuration + 0.01) {
        let low = 1;
        let high = maxMultiplier;
        for (let iteration = 0; iteration < 28; iteration++) {
          const middle = (low + high) / 2;
          if (scheduleEnd(buildVoiceSchedule(middle, selectedGap)) <= totalDuration + 0.01) high = middle;
          else low = middle;
        }
        rateMultiplier = high;
        scheduledClips = buildVoiceSchedule(rateMultiplier, selectedGap);
      } else {
        // Bất khả kháng: bỏ khoảng nghỉ 60ms trước khi kết luận nội dung thật sự quá dài.
        selectedGap = 0;
        const compactMaxSchedule = buildVoiceSchedule(maxMultiplier, selectedGap);
        if (!requiresContentFit && scheduleEnd(compactMaxSchedule) <= totalDuration + 0.01) {
          let low = 1;
          let high = maxMultiplier;
          for (let iteration = 0; iteration < 28; iteration++) {
            const middle = (low + high) / 2;
            if (scheduleEnd(buildVoiceSchedule(middle, selectedGap)) <= totalDuration + 0.01) high = middle;
            else low = middle;
          }
          rateMultiplier = high;
          scheduledClips = buildVoiceSchedule(rateMultiplier, selectedGap);
        } else {
          const overrun = Math.max(0, scheduleEnd(compactMaxSchedule) - totalDuration);
          const backshiftedSchedule = backshiftScheduleToVideoEnd(compactMaxSchedule);
          if (overrun <= MAX_SMART_TTS_BLACK_TAIL_SECONDS) {
            rateMultiplier = maxMultiplier;
            scheduledClips = compactMaxSchedule;
            selectedGap = 0;
            addLog(
              `Smart TTS: sau khi cân timing còn dư ${overrun.toFixed(2)}s; `
              + "giữ nguyên voice cuối và chuyển phần dư sang nền đen khi render.",
            );
            break smartTtsFit;
          }
          if (fitAttempt >= 3) {
            if (backshiftedSchedule) {
              rateMultiplier = maxMultiplier;
              scheduledClips = backshiftedSchedule;
              addLog(`Smart TTS: đã lùi nhẹ timestamp để hấp thụ ${overrun.toFixed(2)}s còn dư, giữ nguyên thứ tự và không chồng giọng.`);
              break smartTtsFit;
            }
            const emergencySchedule = buildEmergencyPitchSafeSchedule();
            if (emergencySchedule) {
              scheduledClips = emergencySchedule;
              selectedGap = 0;
              addLog(
                `Smart TTS: còn dư ${overrun.toFixed(2)}s sau 3 lượt; `
                + `đã dùng time-stretch giữ pitch tối đa ${Math.max(...emergencySchedule.map((clip) => clip.rate)).toFixed(2)}x để hoàn tất.`,
              );
              break smartTtsFit;
            }
            throw new Error(
              `Smart TTS đã tự rút gọn 3 lượt nhưng lời đọc vẫn dài hơn video ${overrun.toFixed(2)} giây. ` +
              "Hãy kiểm tra lại timestamp hoặc nội dung bản dịch.",
            );
          }

          const normalizeForDedup = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
          type RawFitItem = {
            id: string;
            text: string;
            previousText: string;
            nextText: string;
            maxSeconds: number;
            groupId: string;
            maxChars: number;
            contributesToOverrun: boolean;
            recoverableSeconds: number;
            index: number;
          };
          const makeFitItem = (
            clip: typeof preparedClips[number],
            index: number,
            maxChars: number,
            contributesToOverrun: boolean,
          ): RawFitItem => {
            const fullCharacterCount = Math.max(1, Array.from(clip.text).length);
            return {
              id: clip.sub.id,
              text: clip.text,
              previousText: preparedClips[index - 1]?.text || "",
              nextText: preparedClips[index + 1]?.text || "",
              maxSeconds: Math.max(0.35, clip.availableDuration),
              groupId: clip.groupId,
              maxChars,
              contributesToOverrun,
              recoverableSeconds: (clip.trimmed.duration / SMART_TTS_MAX_RATE)
                * Math.max(0, 1 - maxChars / fullCharacterCount),
              index,
            };
          };
          let fitItemsRaw: RawFitItem[] = preparedClips.map((clip, index) => {
            const availableDuration = Math.max(0.35, clip.availableDuration);
            const durationRatio = Math.min(0.88, (availableDuration * SMART_TTS_MAX_RATE) / Math.max(0.05, clip.trimmed.duration));
            const fullCharacterCount = Math.max(1, Array.from(clip.text).length);
            const maxChars = Math.max(8, Math.floor(fullCharacterCount * Math.max(0.18, durationRatio) * 0.92));
            return makeFitItem(
              clip,
              index,
              maxChars,
              clip.trimmed.duration / SMART_TTS_MAX_RATE > availableDuration && !groupFitAtMaxRate.get(clip.groupId),
            );
          }).filter((item) => (
            item.contributesToOverrun
            && item.maxChars < Array.from(item.text).length - 1
            && /[\p{L}\p{N}]/u.test(item.text)
          ));

          const localRecovery = fitItemsRaw.reduce((sum, item) => sum + item.recoverableSeconds, 0);
          if (localRecovery < overrun + 0.1) {
            // Many tiny scheduling delays can overflow the whole track even
            // though every cue fits its own borrowed slot. Select meaningful
            // clips from the aggregate timing chain instead of aborting with
            // an empty local-overflow candidate list.
            const compressedSpeechDuration = preparedClips.reduce(
              (sum, clip) => sum + clip.trimmed.duration / SMART_TTS_MAX_RATE,
              0,
            );
            const globalReductionRatio = Math.max(
              0.06,
              Math.min(0.38, ((overrun - localRecovery) + 0.2) / Math.max(0.1, compressedSpeechDuration) * 1.4),
            );
            const existingIds = new Set(fitItemsRaw.map((item) => item.id));
            const globalCandidates = preparedClips
              .map((clip, index) => {
                const fullCharacterCount = Array.from(clip.text).length;
                if (
                  existingIds.has(clip.sub.id)
                  || countSpeechCharacters(clip.text) < 3
                  || fullCharacterCount < 5
                  || !/[\p{L}\p{N}]/u.test(clip.text)
                ) return null;
                const maxChars = Math.max(
                  3,
                  Math.min(fullCharacterCount - 2, Math.floor(fullCharacterCount * (1 - globalReductionRatio))),
                );
                return makeFitItem(clip, index, maxChars, true);
              })
              .filter((item): item is RawFitItem => Boolean(item))
              .sort((a, b) => b.recoverableSeconds - a.recoverableSeconds);

            let selectedRecovery = localRecovery;
            for (const item of globalCandidates) {
              fitItemsRaw.push(item);
              selectedRecovery += item.recoverableSeconds;
              if (selectedRecovery >= overrun * 1.35 + 0.15) break;
            }
            fitItemsRaw.sort((a, b) => a.index - b.index);
            if (fitItemsRaw.length > 0) {
              addLog(
                `Smart TTS: track tràn cộng dồn ${overrun.toFixed(2)}s dù từng cue không tràn; `
                + `đã chọn ${fitItemsRaw.length} câu trên chuỗi timing để cân lại toàn track.`,
              );
            }
          }

          type FitGroup = { normalizedText: string; text: string; previousText: string; nextText: string; maxSeconds: number; groupId: string; maxChars: number; memberIds: string[] };
          const fitGroups = new Map<string, FitGroup>();
          for (const item of fitItemsRaw) {
            const key = normalizeForDedup(item.text);
            const existing = fitGroups.get(key);
            if (existing) {
              // The strictest member budget makes the shared result fit every repeated line.
              existing.maxChars = Math.min(existing.maxChars, item.maxChars);
              existing.memberIds.push(item.id);
            } else {
              fitGroups.set(key, { normalizedText: key, text: item.text, previousText: item.previousText, nextText: item.nextText, maxSeconds: item.maxSeconds, groupId: item.groupId, maxChars: item.maxChars, memberIds: [item.id] });
            }
          }
          const fitItems = [...fitGroups.values()].map((group) => ({
            id: group.memberIds[0],
            text: group.text,
            previousText: group.previousText,
            nextText: group.nextText,
            maxSeconds: group.maxSeconds,
            groupId: group.groupId,
            maxChars: group.maxChars,
          }));

          if (fitItems.length === 0) {
            if (backshiftedSchedule) {
              rateMultiplier = maxMultiplier;
              scheduledClips = backshiftedSchedule;
              addLog("Smart TTS: câu đã đạt giới hạn rút gọn; giữ đúng thứ tự và mượn khoảng trống kế tiếp thay vì dừng render.");
              break smartTtsFit;
            }
            const emergencySchedule = buildEmergencyPitchSafeSchedule();
            if (emergencySchedule) {
              scheduledClips = emergencySchedule;
              selectedGap = 0;
              addLog(
                `Smart TTS: không còn câu phù hợp để rút gọn; đã hấp thụ ${overrun.toFixed(2)}s `
                + `bằng time-stretch giữ pitch tối đa ${Math.max(...emergencySchedule.map((clip) => clip.rate)).toFixed(2)}x.`,
              );
              break smartTtsFit;
            }
            throw new Error(`Không tìm được câu đang gây tràn có thể rút gọn dù track còn vượt ${overrun.toFixed(2)} giây.`);
          }

          const totalDuplicates = fitItemsRaw.length - fitGroups.size;
          if (totalDuplicates > 0) {
            addLog(`Smart TTS: gộp ${fitItemsRaw.length} câu cần rút gọn thành ${fitGroups.size} nhóm duy nhất (${totalDuplicates} câu trùng lặp không gọi AI lại).`);
          }

          addLog(
            `Smart TTS: lời đọc vượt ${overrun.toFixed(2)}s; đang tự rút gọn ${fitItems.length} câu theo đúng ngân sách timestamp (lượt ${fitAttempt + 1}/3).`,
          );
          const FIT_BATCH_SIZE = 40;
          const batchCount = Math.ceil(fitItems.length / FIT_BATCH_SIZE);
          const fittedTextByOriginalId: Record<string, string> = {};
          for (let offset = 0; offset < fitItems.length; offset += FIT_BATCH_SIZE) {
            const batch = fitItems.slice(offset, offset + FIT_BATCH_SIZE);
            const controller = new AbortController();
            const abortFromPipeline = () => controller.abort();
            pipelineSignal.addEventListener("abort", abortFromPipeline, { once: true });
            const timeout = window.setTimeout(() => controller.abort(), 120_000);
            try {
              const fitResponse = await fetch("/api/fit-tts-subtitles", {
                method: "POST",
                signal: controller.signal,
                headers: {
                  "Content-Type": "application/json",
                  ...getGeminiRequestHeaders(geminiApiKey),
                },
                body: JSON.stringify({
                  items: batch,
                  apiPlatform,
                  customApiUrl: apiPlatform === "custom" ? customApiUrl : "",
                  customApiKey: apiPlatform === "custom" ? customApiKey : "",
                  customModel: apiPlatform === "custom" ? customModel : "",
                  allowGeminiFallback,
                  translationGlossary: translationGlossary.trim() || undefined,
                  translationStyle: translationStyle.trim() || undefined,
                }),
              });
              const fittedPayload = await readJsonResponse(fitResponse);
              const fittedBatch = Array.isArray(fittedPayload.items) ? fittedPayload.items : [];
              for (const item of fittedBatch) {
                const id = String(item?.id || "");
                const text = String(item?.text || "").replace(/\s+/g, " ").trim();
                if (id && text) fittedTextByOriginalId[id] = text;
              }
              const missingIds = batch.map((item) => item.id).filter((id) => !fittedTextByOriginalId[id]);
              if (missingIds.length > 0) {
                throw new Error(`API thiếu ${missingIds.length}/${batch.length} câu trong batch.`);
              }
              addLog(`Smart TTS: đã rút gọn batch ${Math.floor(offset / FIT_BATCH_SIZE) + 1}/${batchCount} (${fittedBatch.length} câu).`);
            } catch (error: any) {
              const prefix = controller.signal.aborted
                ? `Rút gọn câu quá thời gian (120s) ở batch bắt đầu từ câu #${offset + 1}.`
                : `Rút gọn câu thất bại ở batch bắt đầu từ câu #${offset + 1}: ${error?.message || error}`;
              throw new Error(prefix);
            } finally {
              window.clearTimeout(timeout);
              pipelineSignal.removeEventListener("abort", abortFromPipeline);
            }
          }

          const activeVoice = activeTtsEngine === "tiktok"
            ? tiktokVoice
            : (ttsEngine === "browser" ? "Phạm Tuyên" : vieneuVoice);
          const synthesizeFittedBlob = async (text: string): Promise<Blob> => {
            if (!/[\p{L}\p{N}]/u.test(text)) return pcmToWav(new Uint8Array(2400), 24000);
            let lastError = "TTS không trả âm thanh cho câu đã rút gọn.";
            for (let attempt = 1; attempt <= 3; attempt++) {
              const controller = new AbortController();
              const abortFromPipeline = () => controller.abort();
              pipelineSignal.addEventListener("abort", abortFromPipeline, { once: true });
              const timeout = window.setTimeout(() => controller.abort(), 90_000);
              try {
                const response = await fetch("/api/synthesize-tts", {
                  method: "POST",
                  signal: controller.signal,
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    text,
                    voiceName: activeVoice,
                    engine: activeTtsEngine,
                    sessionId: activeTtsEngine === "tiktok" ? tiktokSessionId : undefined,
                  }),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                  const detail = data?.error || data?.detail || `HTTP ${response.status}`;
                  throw new Error(`HTTP ${response.status}: ${detail}`);
                }
                if (!data.audio) throw new Error("TTS không trả dữ liệu audio.");
                const binary = atob(data.audio);
                const bytes = new Uint8Array(binary.length);
                for (let byteIndex = 0; byteIndex < binary.length; byteIndex++) bytes[byteIndex] = binary.charCodeAt(byteIndex);
                return data.format === "mp3"
                  ? new Blob([bytes], { type: "audio/mp3" })
                  : data.format === "wav"
                    ? new Blob([bytes], { type: "audio/wav" })
                    : pcmToWav(bytes, 24000);
              } catch (error: any) {
                if (pipelineSignal.aborted) throw new DOMException("Tác vụ TTS đã được hủy.", "AbortError");
                lastError = controller.signal.aborted ? "Hết thời gian chờ TTS (90 giây)." : (error?.message || String(error));
                if (/\b(?:400|401|403)\b|session id.*(?:không hợp lệ|hết hạn)/i.test(lastError)) throw new Error(lastError);
                if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, attempt * 2_000));
              } finally {
                window.clearTimeout(timeout);
                pipelineSignal.removeEventListener("abort", abortFromPipeline);
              }
            }
            throw new Error(`Tạo lại câu rút gọn thất bại sau 3 lần thử: ${lastError}`);
          };

          const fittedById: Record<string, string> = {};
          const fittedEntries = Object.entries(fittedTextByOriginalId);
          for (let index = 0; index < fittedEntries.length; index++) {
            const [representativeId, fittedText] = fittedEntries[index];
            const group = [...fitGroups.values()].find((value) => value.memberIds.includes(representativeId));
            const targetIds = group?.memberIds ?? [representativeId];
            addLog(`[Smart TTS ${index + 1}/${fittedEntries.length}] Đang tạo lại câu đã rút gọn (áp dụng cho ${targetIds.length} dòng trùng lặp)...`);
            const fittedBlob = await synthesizeFittedBlob(fittedText);
            const signature = `${activeTtsEngine}|${activeVoice}|${fittedText}`;
            const activeProjectId = currentProjectId || (videoFile ? makeProjectId(videoFile) : "");
            for (const subtitleId of targetIds) {
              if (cacheRef.current[subtitleId]) URL.revokeObjectURL(cacheRef.current[subtitleId]);
              cacheRef.current[subtitleId] = URL.createObjectURL(fittedBlob);
              ttsCacheSignatureRef.current[subtitleId] = signature;
              fittedTtsTextRef.current[subtitleId] = fittedText;
              fittedById[subtitleId] = fittedText;

              if (activeProjectId) {
                const ttsCacheId = `${activeProjectId}|tts-v2|${subtitleId}|${stableHash(signature)}`;
                await projectDbPut("tts", {
                  id: ttsCacheId,
                  projectId: activeProjectId,
                  signature,
                  subtitleId,
                  blob: fittedBlob,
                  updatedAt: Date.now(),
                } satisfies StoredTtsClip).catch((error) => console.warn("Could not persist fitted TTS clip:", error));
              }
            }
          }

          if (Object.keys(fittedById).length === 0) {
            throw new Error("Không tạo được âm thanh cho các câu Smart TTS đã rút gọn.");
          }
          addLog(`Smart TTS: đã rút gọn và lưu ${Object.keys(fittedById).length} câu; đang đo lại toàn bộ track.`);
          return generateMergedVoiceoverBlob(fitAttempt + 1, true, pipelineSignal);
        }
      }
    }

    scheduledClips.forEach((clip, index) => {
      const source = preparedClips[index];
      const shiftedBy = Math.max(0, clip.start - clip.originalStart);
      addLog(
        `[Smart TTS #${index + 1} · ${source.groupId}] slot=${source.slotDuration.toFixed(2)}s, ` +
        `GAP mượn=${source.borrowedBefore.toFixed(2)}s trước/${source.borrowedAfter.toFixed(2)}s sau, ` +
        `raw=${source.rawDuration.toFixed(2)}s, trim=${source.trimmed.duration.toFixed(2)}s, ` +
        `mốc=${clip.originalStart.toFixed(2)}s→${clip.start.toFixed(2)}s, nhích=${shiftedBy.toFixed(2)}s, ` +
        `rate cần=${source.requiredRate.toFixed(2)}x, áp dụng=${clip.rate.toFixed(2)}x, final=${(clip.end - clip.start).toFixed(2)}s`,
      );
    });

    const naturalCount = scheduledClips.filter((clip) => clip.rate <= 1.001).length;
    const borrowedCount = preparedClips.filter((clip) => clip.borrowedBefore + clip.borrowedAfter > 0.01).length;
    const rewrittenCount = preparedClips.filter((clip) => Boolean(fittedTtsTextRef.current[clip.sub.id])).length;
    const stretchedCount = scheduledClips.filter((clip) => clip.rate > 1.001).length;
    addLog(
      `Smart TTS Pass 3-4: ${naturalCount} câu giữ nhịp tự nhiên, ${borrowedCount} câu mượn GAP, ` +
      `${rewrittenCount} câu đã rút gọn, ${stretchedCount} câu time-stretch giữ nguyên cao độ.`,
    );

    const shiftedCount = scheduledClips.filter((clip) => clip.start - clip.originalStart > 0.02).length;
    if (shiftedCount > 0) {
      addLog(
        `Smart TTS: đã tự dời ${shiftedCount} câu có timestamp quá sát để giọng đọc không chồng nhau; ` +
        `tốc độ cao nhất ${Math.max(...scheduledClips.map((clip) => clip.rate)).toFixed(2)}x.`,
      );
    }

    voiceTimingRef.current = Object.fromEntries(
      scheduledClips.map((clip) => [
        clip.subtitleId,
        { subtitleId: clip.subtitleId, start: clip.start, end: clip.end, rate: clip.rate },
      ]),
    );



    // Time-stretch dùng OfflineAudioContext (Web Audio API); atempo do server ffmpeg.exe xử lý khi render.
    const pitchPreservingCtx = new AudioContextClass();
    type PitchPreservedClip = ScheduledVoiceClip & { renderedBuffer: AudioBuffer };
    const pitchPreservedClips = new Array<PitchPreservedClip>(scheduledClips.length);
    let stretchCursor = 0;
    const stretchWorker = async () => {
      while (stretchCursor < scheduledClips.length) {
        const clipIndex = stretchCursor++;
        const clip = scheduledClips[clipIndex];
        if (Math.abs(clip.rate - 1) < 0.001) {
          pitchPreservedClips[clipIndex] = { ...clip, renderedBuffer: clip.buffer };
          continue;
        }
      const sourceBytes = new Uint8Array(await (await bufferToWavAsync(clip.buffer)).arrayBuffer());
      let binary = "";
      const chunkSize = 0x8000;
      for (let offset = 0; offset < sourceBytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...sourceBytes.subarray(offset, offset + chunkSize));
      }
      const response = await fetch("/api/time-stretch-audio", {
        method: "POST",
        signal: pipelineSignal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: btoa(binary), rate: clip.rate }),
      });
      const payload = await readJsonResponse(response);
      const decodedBytes = Uint8Array.from(atob(String(payload.audio || "")), (char) => char.charCodeAt(0));
      const renderedBuffer = await pitchPreservingCtx.decodeAudioData(decodedBytes.buffer);
        pitchPreservedClips[clipIndex] = { ...clip, renderedBuffer };
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, scheduledClips.length) }, () => stretchWorker()));
    await pitchPreservingCtx.close();

    const voiceTrackDuration = Math.min(
      totalDuration + MAX_SMART_TTS_BLACK_TAIL_SECONDS,
      Math.max(totalDuration, scheduleEnd(scheduledClips)),
    );
    const offlineCtx = new OfflineAudioContext(1, Math.max(1, Math.ceil(sampleRate * voiceTrackDuration)), sampleRate);
    pitchPreservedClips.forEach((clip) => {
      const source = offlineCtx.createBufferSource();
      source.buffer = clip.renderedBuffer;
      source.playbackRate.value = 1;
      source.connect(offlineCtx.destination);
      source.start(clip.start);
    });
    return bufferToWavAsync(await offlineCtx.startRendering());
  };

  const getVoiceoverPreparationSignature = () => stableHash(JSON.stringify({
    pipeline: "smart-tts-4pass-black-tail-v2",
    subtitles: subtitles.map((sub) => [sub.id, sub.start, sub.end, sub.translated || sub.original]),
    engine: ttsEngine,
    voice: ttsEngine === "tiktok" ? tiktokVoice : vieneuVoice,
    rate: ttsRate,
    smartTtsEnabled,
  }));

  const loadPreparedVoiceover = async (): Promise<Blob | null> => {
    const signature = getVoiceoverPreparationSignature();
    if (preparedVoiceoverRef.current?.signature === signature) return preparedVoiceoverRef.current.blob;
    const projectId = currentProjectId || (videoFile ? makeProjectId(videoFile) : "");
    if (!projectId) return null;
    const stored = await projectDbGet<StoredPreparedVoiceover>("media", `${projectId}|prepared-voiceover`).catch(() => undefined);
    if (!stored?.blob || stored.signature !== signature) return null;
    preparedVoiceoverRef.current = { signature, blob: stored.blob };
    voiceTimingRef.current = stored.timing || {};
    fittedTtsTextRef.current = stored.fittedText || {};
    addLog("Đã khôi phục Smart TTS hoàn chỉnh từ checkpoint; không đo hoặc tạo lại audio.");
    return stored.blob;
  };

  const prepareVoiceoverForRender = async (): Promise<Blob> => {
    if (preparingVoiceoverPromiseRef.current) return preparingVoiceoverPromiseRef.current;
    const ownsPipeline = !pipelineAbortRef.current;
    const pipelineSignal = pipelineAbortRef.current?.signal || beginPipelineJob("smart-tts", "Đang finalize Smart TTS");
    const task = (async () => {
      await waitForPipeline(pipelineSignal);
      const restored = await loadPreparedVoiceover();
      if (restored) return restored;
      setIsFinalizingVoiceover(true);
      setPreGenerateProgress(95);
      addLog("Bắt đầu giai đoạn Smart TTS finalize trước khi render...");
      const blob = await generateMergedVoiceoverBlob(0, false, pipelineSignal);
      if (!blob.size) throw new Error("Track Smart TTS hoàn chỉnh trả về rỗng.");
      const signature = getVoiceoverPreparationSignature();
      preparedVoiceoverRef.current = { signature, blob };
      const projectId = currentProjectId || (videoFile ? makeProjectId(videoFile) : "");
      if (projectId) {
        await projectDbPut("media", {
          id: `${projectId}|prepared-voiceover`,
          projectId,
          signature,
          blob,
          timing: voiceTimingRef.current,
          fittedText: fittedTtsTextRef.current,
          updatedAt: Date.now(),
        } satisfies StoredPreparedVoiceover);
        addLog("Smart TTS đã finalize và lưu checkpoint. Bước render sau đó chỉ mux/encode video.");
      }
      setPreGenerateProgress(100);
      return blob;
    })();
    preparingVoiceoverPromiseRef.current = task;
    try {
      return await task;
    } finally {
      preparingVoiceoverPromiseRef.current = null;
      setIsFinalizingVoiceover(false);
      if (ownsPipeline) finishPipelineJob(pipelineSignal);
    }
  };

  const downloadMergedVoiceover = async () => {
    setIsMergingAudio(true);
    setErrorMsg("");
    try {
      const wavBlob = await prepareVoiceoverForRender();
      const wavUrl = URL.createObjectURL(wavBlob);

      const link = document.createElement("a");
      link.href = wavUrl;
      link.download = `tool-dubbing-video-${ttsEngine}.wav`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(wavUrl), 1000);
    } catch (err: any) {
      console.error("Lỗi khi ghép nhạc thuyết minh:", err);
      let errMsg = err.message || String(err);
      if (
        errMsg.toLowerCase().includes("decode") || 
        errMsg.toLowerCase().includes("fetch") || 
        errMsg.toLowerCase().includes("audiocontext") ||
        errMsg.toLowerCase().includes("refused")
      ) {
        errMsg += " -> [GỢI Ý]: Hãy bấm nút \"MỞ TAB MỚI\" (Open in New Tab) ở góc trên bên phải màn hình để thực hiện tải tệp thuyết minh thành công.";
      }
      setErrorMsg("Lỗi khi tải thuyết minh: " + errMsg);
    } finally {
      setIsMergingAudio(false);
    }
  };

  const startBrowserRecording = async () => {
    if (isRecordingVideo) {
      cancelActivePipeline();
      return;
    }
    const pipelineSignal = beginPipelineJob("render", "Đang render video final");
    
    try {
      if (!videoSrc) throw new Error("Chưa có video gốc.");

      if (window.electronAPI?.runSystemDiagnostics) {
        addLog("Đang preflight tài nguyên và thư mục xuất...");
        const diagnostics = await window.electronAPI.runSystemDiagnostics(outputFolder || undefined);
        if (!diagnostics.ffmpeg?.exists) throw new Error("Thiếu FFmpeg Runtime. Mở Cài đặt > Chẩn đoán hệ thống để kiểm tra.");
        if (!diagnostics.disk?.writable) throw new Error("Thư mục xuất không có quyền ghi. Hãy chọn thư mục khác.");
        if (diagnostics.disk.free > 0 && diagnostics.disk.free < 1024 ** 3) throw new Error("Ổ đĩa còn dưới 1 GB, không đủ an toàn để render và lưu video.");
        addLog(`Preflight đạt: ${diagnostics.ffmpeg.encoder} · còn ${(diagnostics.disk.free / 1024 ** 3).toFixed(1)} GB.`);
      }

      addLog("Đang kiểm tra engine FFmpeg native...");
      const engineResponse = await fetch("/api/render/verify", { signal: pipelineSignal });
      const engineStatus = await engineResponse.json().catch(() => ({}));
      if (!engineResponse.ok || !engineStatus.ok) {
        throw new Error(engineStatus.error || "FFmpeg native chưa sẵn sàng. Hãy chạy cài đặt engine trước khi xuất video.");
      }
      addLog(`FFmpeg native sẵn sàng: ${engineStatus.version || engineStatus.ffmpegPath || "OK"}`);
      
      if (exportedVideoUrl) {
        try {
          URL.revokeObjectURL(exportedVideoUrl);
        } catch (e) {}
        setExportedVideoUrl("");
      }
      
      setIsRecordingVideo(true);
      setRecordingProgress(0);
      const estimatedRenderFactor = exportResolution === "720" ? 0.55 : exportResolution === "1440" ? 1.25 : 0.85;
      setRecordingEtaSeconds(Math.max(20, Math.ceil((duration || 1) * estimatedRenderFactor + subtitles.length * 1.5)));
      setErrorMsg("");
      addLog("Khởi tạo bộ xuất bản video final (chỉ mux/encode)...");
      
      let voiceoverBlob: Blob | null = null;

      if (subtitles.length > 0) {
        setRecordingProgress(5);
        addLog("Đang nạp track Smart TTS đã finalize từ checkpoint...");
        try {
          voiceoverBlob = await loadPreparedVoiceover();
          if (!voiceoverBlob) {
            throw new Error("Smart TTS chưa được finalize. Hãy chạy bước Chuẩn bị/TTS trước khi render.");
          }
          if (!voiceoverBlob || voiceoverBlob.size === 0) throw new Error("Blob thuyết minh trả về rỗng.");
          addLog(`Đã nạp track Smart TTS (${(voiceoverBlob.size / 1024).toFixed(1)} KB); bắt đầu render.`);
        } catch (err: any) {
          console.error("Could not load finalized voiceover for video export:", err);
          throw new Error("Không thể nạp track thuyết minh đã chuẩn bị: " + err.message);
        }
      }

      const sourceVideoDuration = Math.max(0.1, workspaceVideoRef.current?.duration || videoRef.current?.duration || duration || Math.max(...subtitles.map(sub => sub.end), 0));
      const voiceTrackEnd = voiceoverBlob
        ? Math.max(0, ...Object.values(voiceTimingRef.current).map((timing) => Number(timing.end) || 0))
        : 0;
      const requestedBlackTail = Math.max(0, voiceTrackEnd - sourceVideoDuration);
      if (requestedBlackTail > 2.01) {
        throw new Error(
          `Smart TTS còn vượt video ${requestedBlackTail.toFixed(2)} giây, lớn hơn giới hạn nền đen 2 giây. `
          + "Hãy chạy lại bước chuẩn bị Smart TTS để cân timing trước khi render.",
        );
      }
      const blackTailDuration = Math.min(2, requestedBlackTail);
      const exportDuration = sourceVideoDuration + blackTailDuration;
      if (blackTailDuration > 0.01) {
        addLog(`Video final sẽ nối ${blackTailDuration.toFixed(2)}s nền đen để phát hết voice cuối.`);
      }
      const sourceVideoWidth = workspaceVideoRef.current?.videoWidth || videoRef.current?.videoWidth || 1920;
      const sourceVideoHeight = workspaceVideoRef.current?.videoHeight || videoRef.current?.videoHeight || 1080;
      const resolutionBase = Number(exportResolution);
      const selectedRatio = exportAspectRatio === "original"
        ? sourceVideoWidth / Math.max(1, sourceVideoHeight)
        : ({ "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4 } as const)[exportAspectRatio];
      const { width: outputWidth, height: outputHeight } = getSubtitleExportFrame(resolutionBase, selectedRatio);
      addLog(`Khung hình xuất: ${exportAspectRatio === "original" ? "theo video gốc" : exportAspectRatio} (${outputWidth}x${outputHeight}), giữ toàn bộ hình và thêm viền nền khi cần.`);
      let burnedSubtitleAssets: BurnedSubtitleAsset[] = [];

      if (subtitles.length > 0) {
        const synchronizedSubtitles = subtitles.map((sub) => {
          const voiceTiming = voiceoverBlob ? voiceTimingRef.current[sub.id] : undefined;
          const fittedText = fittedTtsTextRef.current[sub.id];
          return voiceTiming
            ? { ...sub, translated: fittedText || sub.translated, start: voiceTiming.start, end: voiceTiming.end }
            : { ...sub, translated: fittedText || sub.translated };
        });
        const sortedSubtitles = validateSubtitleTimeline(synchronizedSubtitles, exportDuration, 0)
          .filter((sub) => sub.end > sub.start && Boolean((sub.translated || sub.original || "").trim()))
          .sort((a, b) => a.start - b.start);
        if (sortedSubtitles.length === 0) {
          throw new Error("Dự án có track phụ đề nhưng không có dòng chữ hợp lệ để burn-in.");
        }

        const srtContent = sortedSubtitles
          .sort((a, b) => a.start - b.start)
          .map((sub, index) => {
            const text = (sub.translated || sub.original || "")
              .replace(/\r?\n/g, " ")
              .trim();
            return `${index + 1}\n${formatSecondsToSRT(sub.start)} --> ${formatSecondsToSRT(Math.max(sub.end, sub.start + 0.1))}\n${text}\n`;
          })
          .join("\n");
        const alignedCount = sortedSubtitles.filter((sub) => Boolean(voiceTimingRef.current[sub.id])).length;
        addLog(`Hardsub sync: ${alignedCount}/${sortedSubtitles.length} dòng đã khóa theo đúng track Smart TTS.`);
        addLog("Đang dựng lớp hardsub PNG độc lập...");

        const generatedAssets: Array<BurnedSubtitleAsset | null> = new Array(sortedSubtitles.length);
        let assetCursor = 0;
        const assetWorker = async () => {
          while (assetCursor < sortedSubtitles.length) {
            const index = assetCursor++;
            generatedAssets[index] = await createBurnedSubtitleAsset(
              sortedSubtitles[index], index, subSettings, blurBoxes, activeBlurBoxId,
              outputWidth, outputHeight,
            );
            if ((index + 1) % 100 === 0) {
              addLog(`[Hardsub] Đã dựng ${index + 1}/${sortedSubtitles.length} khung phụ đề.`);
              await new Promise((resolve) => window.setTimeout(resolve, 0));
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, sortedSubtitles.length) }, () => assetWorker()));
        burnedSubtitleAssets = generatedAssets.filter((asset): asset is BurnedSubtitleAsset => Boolean(asset));
        if (burnedSubtitleAssets.length !== sortedSubtitles.length) {
          throw new Error(`Không tạo đủ lớp hardsub (${burnedSubtitleAssets.length}/${sortedSubtitles.length}); đã hủy render để không xuất video thiếu phụ đề.`);
        }
        for (const asset of burnedSubtitleAssets) {
          if (asset.blob.size < 100 || asset.width < 2 || asset.height < 2) {
            throw new Error(`Lớp hardsub ${asset.fileName} không hợp lệ; đã hủy render.`);
          }
        }
        addLog(`Đã tạo và kiểm tra ${burnedSubtitleAssets.length}/${sortedSubtitles.length} lớp hardsub PNG · cỡ chữ xuất ${Math.round(subSettings.fontSize)}px.`);
      }
      
      let filterComplex = "";
      let lastOverlay = "0:v";
      let filterChain = "";
      
      if (flipHorizontal || flipVertical) {
        if (flipHorizontal && flipVertical) {
           filterChain += `[0:v]hflip,vflip[flipped];`;
        } else if (flipHorizontal) {
           filterChain += `[0:v]hflip[flipped];`;
        } else if (flipVertical) {
           filterChain += `[0:v]vflip[flipped];`;
        }
        lastOverlay = "flipped";
      }
      
      if (blurBoxes.length > 0) {
        const w = sourceVideoWidth;
        const h = sourceVideoHeight;
        
        blurBoxes.forEach((box, i) => {
          const bw = Math.max(2, Math.round(w * (box.width / 100)));
          const bh = Math.max(2, Math.round(h * (box.height / 100)));
          const bx = Math.round(w * (box.xPosition / 100));
          const by = Math.round(h * (box.yPosition / 100));
          const blurAmt = Math.max(1, box.blurAmount);
          const coverColor = getBlurCoverFfmpegColor(box.bgColor, box.opacity);
          const boxStart = Math.max(0, box.start ?? 0);
          const boxEnd = Math.max(boxStart + 0.04, Math.min(exportDuration, box.end ?? exportDuration));
          
          // Filter labels must always be enclosed in brackets. Without them
          // FFmpeg parses "0:vsplit" as a filter name instead of "[0:v]split".
          const source = `[${lastOverlay}]`;
          const bg = i === 0 ? source : `[ov${i-1}]`;
          filterChain += `${bg}split[bg${i}][src${i}];`;
          
          const boxBase =
            `[src${i}]crop=${bw}:${bh}:${bx}:${by},` +
            `boxblur=${blurAmt}:${blurAmt},` +
            `drawbox=x=0:y=0:w=iw:h=ih:color=${coverColor}:t=fill`;
          filterChain += `${boxBase}[b${i}];`;
          
          filterChain += `[bg${i}][b${i}]overlay=${bx}:${by}:enable='between(t,${boxStart.toFixed(3)},${boxEnd.toFixed(3)})'[ov${i}];`;
          
          lastOverlay = `ov${i}`;
        });
      }

      // Dùng đúng kích thước đã dùng khi dựng PNG để tọa độ hardsub khớp từng pixel.
      filterChain += `[${lastOverlay}]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease,` +
        `pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1` +
        (blackTailDuration > 0.001
          ? `,tpad=stop_mode=add:stop_duration=${blackTailDuration.toFixed(3)}:color=black`
          : "") +
        `[scaled];`;
      lastOverlay = "scaled";

      // Burn-in bằng PNG alpha để không phụ thuộc filter subtitles/libass của
      // FFmpeg WASM. Mỗi ảnh chỉ xuất hiện đúng khoảng timestamp của dòng đó.
      const firstSubtitleInputIndex = voiceoverBlob ? 2 : 1;
      if (burnedSubtitleAssets.length > 0) {
        filterChain += `[${lastOverlay}][${firstSubtitleInputIndex}:v]overlay=0:0:eof_action=pass:shortest=0[hardSubTrack];`;
        lastOverlay = "hardSubTrack";
      }

      if (subtitles.length > 0 && (burnedSubtitleAssets.length === 0 || lastOverlay !== "hardSubTrack")) {
        throw new Error("Chuỗi render chưa map qua lớp hardsub; đã hủy để không xuất video thiếu phụ đề.");
      }
      
      if (lastOverlay !== "0:v") {
          lastOverlay = `[${lastOverlay}]`;
      }
      
      filterComplex = filterChain.endsWith(";") ? filterChain.slice(0, -1) : filterChain;

      // ── Upload to server and run native ffmpeg ──────────────────────────────
      addLog("Đang render video bằng FFmpeg local...");
      setRecordingProgress(15);

      // Build audio filter if voiceover present
      let finalFilterComplex = filterComplex;
      const hasVoiceover = Boolean(voiceoverBlob);
      if (hasVoiceover) {
        const audioFilter = blackTailDuration > 0.001
          ? `[0:a]volume=${originalAudioMixVolume},apad=pad_dur=${blackTailDuration.toFixed(3)}[bg];[1:a]volume=1.0[voice];[bg][voice]amix=inputs=2:duration=longest:normalize=0:dropout_transition=0[outa]`
          : `[0:a]volume=${originalAudioMixVolume}[bg];[1:a]volume=1.0[voice];[bg][voice]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[outa]`;
        finalFilterComplex = filterComplex ? filterComplex + ";" + audioFilter : audioFilter;
      }

      const formData = new FormData();
      if (videoFile) {
        formData.append("video", videoFile, "input.mp4");
      } else {
        const videoBlob = await fetch(videoSrc, { signal: pipelineSignal }).then(r => r.blob());
        formData.append("video", videoBlob, "input.mp4");
      }
      if (voiceoverBlob) formData.append("voiceover", voiceoverBlob, "voiceover.wav");
      for (const asset of burnedSubtitleAssets) {
        formData.append("subtitle", asset.blob, asset.fileName);
      }
      if (burnedSubtitleAssets.length > 0) {
        formData.append("subtitleBlank", await createTransparentSubtitleFrame(outputWidth, outputHeight), "hardsub-blank.png");
      }
      formData.append("params", JSON.stringify({
        filterComplex: finalFilterComplex,
        lastOverlay,
        outputWidth,
        outputHeight,
        exportDuration: exportDuration.toFixed(3),
        originalAudioMixVolume,
        hasVoiceover,
        useAudio: !hasVoiceover,
        subtitleTimeline: burnedSubtitleAssets.map((asset) => ({
          start: asset.start, end: asset.end, x: asset.x, y: asset.y,
          width: asset.width, height: asset.height,
        })),
      }));

      const renderResp = await fetch("/api/render", { method: "POST", body: formData, signal: pipelineSignal });
      if (!renderResp.ok || !renderResp.body) throw new Error(`Server render thất bại (HTTP ${renderResp.status}).`);

      const reader = renderResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let outputDownloadUrl = "";
      const renderStartedAt = performance.now();

      while (true) {
        if (pipelineSignal.aborted) throw new DOMException("Render đã được hủy.", "AbortError");
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "progress") {
              heartbeatPipeline();
              setRecordingProgress(Math.min(99, 15 + Math.round(msg.percent * 0.84)));
              const elapsed = (performance.now() - renderStartedAt) / 1000;
              if (msg.percent > 1) {
                const eta = Math.ceil((elapsed / msg.percent) * (100 - msg.percent));
                setRecordingEtaSeconds(Math.max(1, eta));
              }
            } else if (msg.type === "done") {
              outputDownloadUrl = msg.downloadUrl || "";
              addLog(`Server render xong! Kích thước: ${(msg.size / 1024 / 1024).toFixed(1)} MB`);
            } else if (msg.type === "engine") {
              const encoderLabels: Record<string, string> = {
                h264_nvenc: "NVIDIA NVENC",
                h264_qsv: "Intel Quick Sync",
                h264_amf: "AMD AMF",
                libx264: "CPU libx264",
              };
              addLog(`Render đang dùng ${encoderLabels[msg.encoder] || msg.encoder}${msg.hardware ? " (GPU)" : ""}.`);
            } else if (msg.type === "retry") {
              heartbeatPipeline();
              setRecordingProgress((current) => Math.max(15, Math.min(current, 92)));
              addLog(
                `[TỰ PHỤC HỒI ${msg.attempt}/${msg.maxAttempts || 3}] Render trước gặp lỗi; `
                + `đang thử lại bằng ${msg.strategy || "chế độ tương thích"}.`,
              );
            } else if (msg.type === "error") {
              throw new Error(msg.error);
            }
          } catch (parseErr: any) {
            if (parseErr.message?.includes("JSON")) continue;
            throw parseErr;
          }
        }
      }

      if (!outputDownloadUrl) throw new Error("Server không trả về đường dẫn tải video đã render.");
      const isElectronRender = typeof window !== "undefined" && navigator.userAgent.toLowerCase().includes("electron") && window.electronAPI?.saveRenderedVideo;
      let blob: Blob | null = null;
      if (isElectronRender) {
        addLog("Render đạt 100%; đang lưu file an toàn vào ổ đĩa...");
        const saveResult = await window.electronAPI!.saveRenderedVideo(outputDownloadUrl, outputFolder, getOutputVideoFilename());
        if (saveResult.canceled) throw new DOMException("Đã hủy lưu video.", "AbortError");
        if (!saveResult.success) throw new Error(saveResult.error || "Không thể lưu video đã render.");
        addLog(`Đã stream video trực tiếp vào: ${saveResult.filePath}`);
      } else {
        const outputResponse = await fetch(outputDownloadUrl, { signal: pipelineSignal });
        if (!outputResponse.ok) throw new Error(`Không tải được video đã render (HTTP ${outputResponse.status}).`);
        blob = await outputResponse.blob();
      }

      addLog("Bộ giải mã video đã xử lý xong! Đang nạp tệp xuất ra...");

      if (blob && burnedSubtitleAssets.length > 0) {
        try {
          const proofIndexes = Array.from(new Set([0, Math.floor(burnedSubtitleAssets.length / 2), burnedSubtitleAssets.length - 1]));
          await Promise.race([
            (async () => {
              for (const proofIndex of proofIndexes) {
                const proofAsset = burnedSubtitleAssets[proofIndex];
                const proofTime = Math.max(0.05, (proofAsset.start + proofAsset.end) / 2);
                addLog(`Đang hậu kiểm hardsub #${proofIndex + 1} tại ${proofTime.toFixed(2)}s...`);
                const proofFrame = await captureVideoFrame(blob, proofTime, outputWidth, outputHeight);
                const ok = await verifyBurnedSubtitlePixels(proofFrame, proofAsset, outputWidth, outputHeight);
                if (!ok) addLog(`[CẢNH BÁO]: Không tìm thấy phụ đề #${proofIndex + 1} tại ${proofTime.toFixed(2)}s.`);
              }
              addLog(`HẬU KIỂM HOÀN TẤT (${burnedSubtitleAssets.length} dòng).`);
            })(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Quá thời gian hậu kiểm (8s)")), 8000)),
          ]);
        } catch (proofErr: any) {
          addLog(`[CẢNH BÁO HẬU KIỂM]: ${proofErr.message}. Video vẫn sẽ được xuất ra.`);
        }
      } else if (blob && subtitles.length > 0) {
        addLog("[CẢNH BÁO]: Video có phụ đề nhưng không có lớp hardsub để hậu kiểm.");
      }

      if (blob) {
        const url = URL.createObjectURL(blob);
        setExportedVideoUrl(url);
      }
      if (blob && currentProjectId) {
        await projectDbPut("media", {
          id: `${currentProjectId}|latest-render`,
          blob,
          name: `final-${videoName || "video"}.mp4`,
          type: "video/mp4",
          lastModified: Date.now(),
        } satisfies StoredProjectMedia).catch((error) => console.warn("Could not persist final render:", error));
        addLog("Đã lưu video final vào checkpoint dự án.");
      }

      if (blob) await saveVideoBlob(blob, getOutputVideoFilename());

      setRecordingProgress(100);
      setRecordingEtaSeconds(0);
      setIsRecordingVideo(false);
      addLog("Xuất video thành phẩm thành công!");
    } catch (err: any) {
      if (err?.name === "AbortError" || pipelineSignal.aborted) {
        addLog("Đã hủy render. Track TTS và checkpoint dự án vẫn được giữ nguyên.");
        setIsRecordingVideo(false);
        setRecordingEtaSeconds(null);
        finishPipelineJob(pipelineSignal);
        return;
      }
      console.error("Lỗi khi kết xuất video:", err);
      let errMsg = err.message || String(err);
      addLog(`Lỗi xử lý kết xuất video final: ${errMsg}`);
      if (
        errMsg.toLowerCase().includes("sharedarraybuffer") || 
        errMsg.toLowerCase().includes("security") || 
        errMsg.toLowerCase().includes("permission") || 
        errMsg.toLowerCase().includes("load") ||
        errMsg.toLowerCase().includes("fetch") ||
        errMsg.toLowerCase().includes("refused")
      ) {
        errMsg += " -> [GỢI Ý QUAN TRỌNG]: Hãy click nút \"MỞ TAB MỚI\" (Open in New Tab) ở góc trên bên phải màn hình để xuất và tải video thành công. Trình duyệt chặn xử lý video (FFmpeg) khi chạy trong khung xem thử của AI Studio.";
      }
      setErrorMsg("Lỗi khi xuất video: " + errMsg);
      setIsRecordingVideo(false);
      setRecordingEtaSeconds(null);
    } finally {
      finishPipelineJob(pipelineSignal);
    }
  };

  const handleAutoDubbingRender = async () => {
    if (!videoSrc) {
      setErrorMsg("Vui lòng tải video lên trước khi render tự động.");
      return;
    }

    // Translation is the only prerequisite that may not yet exist. Once it
    // finishes, the effect below continues with TTS generation and rendering.
    if (subtitles.length === 0 || subtitlePipelineVersion < 4) {
      if (subtitles.length > 0) {
        addLog("Phụ đề của checkpoint cũ dùng bộ timestamp lỗi; đang nhận dạng lại bằng pipeline v4 trước khi render.");
      }
      setAutoRenderRequested(true);
      await handleTranslateVideo();
      return;
    }

    try {
      await prepareVoiceoverForRender();
      setShowPreRenderChoice(true);
      addLog("Pipeline tự động đã dừng trước render để bạn chọn Render ngay hoặc mở Trình chỉnh sửa.");
    } catch (error: any) {
      setErrorMsg(`Không thể hoàn tất giai đoạn chuẩn bị Smart TTS: ${error?.message || error}`);
    }
  };

  const handleStartOrContinueProject = async () => {
    if (!videoSrc) {
      setErrorMsg("Vui lòng tải video lên trước khi bắt đầu.");
      return;
    }

    // Lần đầu chạy STT/dịch. Effect bên dưới sẽ tự nối tiếp sang TTS ngay
    // khi React nhận được danh sách phụ đề mới.
    if (subtitles.length === 0 || subtitlePipelineVersion < 4) {
      if (subtitles.length > 0) {
        addLog("Checkpoint phụ đề cũ cần được căn lại timestamp bằng pipeline v4.");
      }
      setAutoPrepareRequested(true);
      await handleTranslateVideo();
      return;
    }

    const completed = await preGenerateAllTts();
    if (completed) {
      await prepareVoiceoverForRender();
      addLog("Đã chuẩn bị và finalize xong Smart TTS. Render sau đó chỉ còn mux/encode video final.");
      setShowPreRenderChoice(true);
    }
  };

  const handleTimelineResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = timelineHeight;
    const onMove = (moveEvent: PointerEvent) => {
      const nextHeight = startHeight + startY - moveEvent.clientY;
      setTimelineHeight(Math.max(92, Math.min(420, nextHeight)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  useEffect(() => {
    if (!autoRenderRequested || isLoading || isRecordingVideo) return;

    setAutoRenderRequested(false);
    const untranslatedCount = subtitles.filter((subtitle) => !cleanOcrText(String(subtitle.translated || ""))).length;
    if (subtitles.length > 0 && subtitlePipelineVersion >= 4 && untranslatedCount === 0) {
      void prepareVoiceoverForRender()
        .then(() => {
          setShowPreRenderChoice(true);
          addLog("Pipeline tự động đã sẵn sàng; đang chờ lựa chọn Render ngay hoặc Tinh chỉnh.");
        })
        .catch((error: any) => setErrorMsg(`Không thể hoàn tất Smart TTS trước khi render: ${error?.message || error}`));
    } else if (untranslatedCount > 0) {
      setErrorMsg(`Chưa thể tự render/TTS vì còn ${untranslatedCount} câu chưa dịch xong.`);
    } else {
      setErrorMsg("Không thể tự render vì phụ đề chưa được tạo/căn timestamp thành công. Hãy kiểm tra cấu hình dịch thuật.");
    }
  }, [autoRenderRequested, isLoading, isRecordingVideo, subtitles.length, subtitlePipelineVersion]);

  useEffect(() => {
    if (!autoPrepareRequested || isLoading || isPreGenerating) return;

    setAutoPrepareRequested(false);
    if (subtitles.length === 0 || subtitlePipelineVersion < 4) {
      setErrorMsg("Không thể tiếp tục vì phụ đề chưa được tạo/căn timestamp thành công. Hãy kiểm tra cấu hình dịch thuật.");
      return;
    }
    const untranslatedCount = subtitles.filter((subtitle) => !cleanOcrText(String(subtitle.translated || ""))).length;
    if (untranslatedCount > 0) {
      setErrorMsg(`Chưa thể tạo TTS vì còn ${untranslatedCount} câu chưa dịch xong.`);
      return;
    }

    void preGenerateAllTts().then(async (completed) => {
      if (completed) {
        await prepareVoiceoverForRender();
        addLog("Đã chuẩn bị và finalize xong Smart TTS. Có thể render ngay mà không xử lý lại audio.");
        setShowPreRenderChoice(true);
      }
    }).catch((error: any) => setErrorMsg(`Không thể finalize Smart TTS: ${error?.message || error}`));
  }, [autoPrepareRequested, isLoading, isPreGenerating, subtitles.length, subtitlePipelineVersion]);

  const handleEditorRender = async () => {
    try {
      const completed = await preGenerateAllTts();
      if (!completed) return;
      await prepareVoiceoverForRender();
      await startBrowserRecording();
    } catch (error: any) {
      setErrorMsg(`Không thể chuẩn bị dự án từ Editor: ${error?.message || error}`);
    }
  };

  const regenerateSingleTts = async (subtitle: Subtitle) => {
    if (isPreGenerating || regeneratingTtsId) return;
    setRegeneratingTtsId(subtitle.id);
    try {
      const cacheRef = ttsEngine === "tiktok" ? tiktokAudioCacheRef : vieneuAudioCacheRef;
      const previousUrl = cacheRef.current[subtitle.id];
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      delete cacheRef.current[subtitle.id];
      const previousSignature = ttsCacheSignatureRef.current[subtitle.id];
      delete ttsCacheSignatureRef.current[subtitle.id];
      const activeProjectId = currentProjectId || (videoFile ? makeProjectId(videoFile) : "");
      if (activeProjectId && previousSignature) {
        await projectDbDelete("tts", `${activeProjectId}|tts-v2|${subtitle.id}|${stableHash(previousSignature)}`).catch(() => undefined);
      }
      addLog(`[TTS] Đang tạo lại riêng câu ${subtitle.id}; các câu khác dùng checkpoint.`);
      await preGenerateAllTts();
    } finally {
      setRegeneratingTtsId(null);
    }
  };

  // Filtered tracks for Right Panel
  const filteredSubtitles = useMemo(() => {
    return subtitles.filter(sub => 
      sub.original.toLowerCase().includes(searchQuery.toLowerCase()) ||
      sub.translated.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [subtitles, searchQuery]);

  // Add a new custom blur box
  const handleAddBlurBox = () => {
    const nextId = `blur-box-${Date.now()}`;
    const offset = (blurBoxes.length * 5) % 30;
    const newBox: BlurBox = {
      id: nextId,
      xPosition: 15 + offset,
      yPosition: 55 + offset,
      width: 70,
      height: 12,
      blurAmount: 12,
      opacity: 0.75,
      bgColor: BLUR_COVER_PRESETS[0].bgColor,
      start: 0,
      end: duration || 1,
    };
    setBlurBoxes(prev => [...prev, newBox]);
    setActiveBlurBoxId(nextId);
    setWorkspacePropertyTarget("blur");
  };

  const updateActiveBlurBox = (patch: Partial<BlurBox>) => {
    if (!activeBlurBoxId) return;
    setBlurBoxes(prev => prev.map(box => box.id === activeBlurBoxId ? { ...box, ...patch } : box));
  };

  const updateActiveOcrRegion = (patch: Partial<OcrRegion>) => {
    setOcrRegions((regions) => regions.map((region) => region.id === activeOcrRegionId ? { ...region, ...patch } : region));
  };

  const addSuggestedOcrRegion = () => {
    const id = `ocr-region-${Date.now()}`;
    const offset = (ocrRegions.length * 4) % 20;
    const region: OcrRegion = { id, label: `Vùng ${ocrRegions.length + 1}`, x: 8, y: Math.max(5, 72 - offset), width: 84, height: 20 };
    setOcrRegions((current) => [...current, region]);
    setActiveOcrRegionId(id);
    setWorkspacePropertyTarget("ocr");
  };

  const removeActiveOcrRegion = () => {
    setOcrRegions((current) => {
      const remaining = current.filter((region) => region.id !== activeOcrRegionId);
      setActiveOcrRegionId(remaining[0]?.id || "");
      return remaining;
    });
    setOcrPreviewText("");
  };

  const handleWorkspaceOcrRegionDrag = (event: React.PointerEvent<HTMLButtonElement>, id: string, resize = false) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    const region = ocrRegions.find((item) => item.id === id);
    if (!bounds || !region) return;
    setActiveOcrRegionId(id);
    setWorkspacePropertyTarget("ocr");
    const startX = event.clientX;
    const startY = event.clientY;
    const onMove = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / bounds.width) * 100;
      const dy = ((moveEvent.clientY - startY) / bounds.height) * 100;
      const patch = resize
        ? { width: Math.max(2, Math.min(100 - region.x, region.width + dx)), height: Math.max(2, Math.min(100 - region.y, region.height + dy)) }
        : { x: Math.max(0, Math.min(100 - region.width, region.x + dx)), y: Math.max(0, Math.min(100 - region.height, region.y + dy)) };
      setOcrRegions((current) => current.map((item) => item.id === id ? {
        ...item,
        ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, Math.round(Number(value) * 10) / 10])),
      } : item));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleDrawOcrRegion = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDrawingOcrRegion) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const startX = Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100));
    const startY = Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100));
    const id = `ocr-region-${Date.now()}`;
    const region: OcrRegion = { id, label: `Vùng ${ocrRegions.length + 1}`, x: startX, y: startY, width: 2, height: 2 };
    setOcrRegions((current) => [...current, region]);
    setActiveOcrRegionId(id);
    const onMove = (moveEvent: PointerEvent) => {
      const currentX = Math.max(0, Math.min(100, ((moveEvent.clientX - bounds.left) / bounds.width) * 100));
      const currentY = Math.max(0, Math.min(100, ((moveEvent.clientY - bounds.top) / bounds.height) * 100));
      const x = Math.min(startX, currentX);
      const y = Math.min(startY, currentY);
      setOcrRegions((current) => current.map((item) => item.id === id ? {
        ...item,
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        width: Math.round(Math.min(Math.max(2, Math.abs(currentX - startX)), 100 - x) * 10) / 10,
        height: Math.round(Math.min(Math.max(2, Math.abs(currentY - startY)), 100 - y) * 10) / 10,
      } : item));
    };
    const onUp = () => {
      setIsDrawingOcrRegion(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleWatermarkRegionDrag = (event: React.PointerEvent<HTMLButtonElement>, id: string, isResize = false) => {
    event.preventDefault();
    event.stopPropagation();
    const container = (event.currentTarget.closest(".relative.h-full") as HTMLElement | null);
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const region = watermarkRegions.find(r => r.id === id);
    if (!region) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const origX = region.x; const origY = region.y;
    const origW = region.width; const origH = region.height;
    const onMove = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / bounds.width) * 100;
      const dy = ((moveEvent.clientY - startY) / bounds.height) * 100;
      setWatermarkRegions(current => current.map(r => r.id !== id ? r : isResize
        ? { ...r, width: Math.round(Math.min(Math.max(5, origW + dx), 100 - origX) * 10) / 10, height: Math.round(Math.min(Math.max(3, origH + dy), 100 - origY) * 10) / 10 }
        : { ...r, x: Math.round(Math.min(Math.max(0, origX + dx), 100 - origW) * 10) / 10, y: Math.round(Math.min(Math.max(0, origY + dy), 100 - origH) * 10) / 10 }
      ));
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const scanCurrentFrameForWatermarks = async () => {
    const video = workspaceVideoRef.current ?? videoRef.current;
    if (!video || !video.videoWidth) {
      setErrorMsg("Hãy tải video và seek tới frame có watermark trước.");
      return;
    }
    setIsScanningWatermark(true);
    setWatermarkScanDetections([]);
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1920 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Không tạo được canvas.");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      // Scan full frame, no region filter
      const fullFrameRegion: OcrRegion[] = [{ id: "full-frame", label: "Toàn khung hình", x: 0, y: 0, width: 100, height: 100 }];
      const response = await fetch("/api/ocr/frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: canvas.toDataURL("image/jpeg", 0.92).split(",")[1], timestamp: video.currentTime, regions: fullFrameRegion, minConfidence: 0.15, scanWatermarks: true }),
      });
      const payload = await readJsonResponse(response);
      const detections: OcrDetection[] = (payload.detections || [])
        .filter((detection: OcrDetection) => Boolean(detection.box))
        .sort((left: OcrDetection, right: OcrDetection) => {
          const leftLikelyWatermark = isLikelyOcrWatermark(left.text) ? 1 : 0;
          const rightLikelyWatermark = isLikelyOcrWatermark(right.text) ? 1 : 0;
          return rightLikelyWatermark - leftLikelyWatermark || right.confidence - left.confidence;
        });
      if (!detections.length) {
        addLog("Không phát hiện chữ nào trong frame hiện tại.");
      }
      setWatermarkScanDetections(detections);
    } catch (e: any) {
      setErrorMsg(`Quét watermark thất bại: ${e?.message || e}`);
    } finally {
      setIsScanningWatermark(false);
    }
  };

  const addWatermarkFromDetection = (detection: OcrDetection) => {
    const box = detection.box;
    if (!box) return;
    // Preserve a small tolerance for OCR polygon drift between video frames.
    const pad = 2;
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    const width = Math.min(100 - x, box.width + pad * 2);
    const height = Math.min(100 - y, box.height + pad * 2);
    const duplicate = watermarkRegions.some((region) => {
      const intersectionWidth = Math.max(0, Math.min(x + width, region.x + region.width) - Math.max(x, region.x));
      const intersectionHeight = Math.max(0, Math.min(y + height, region.y + region.height) - Math.max(y, region.y));
      const overlap = intersectionWidth * intersectionHeight;
      return overlap / Math.max(1, Math.min(width * height, region.width * region.height)) >= 0.7;
    });
    if (duplicate) {
      addLog(`Watermark "${detection.text}" đã có vùng lọc tương ứng.`);
      setWatermarkScanDetections(prev => prev.filter(d => d !== detection));
      return;
    }
    const id = `wm-${Date.now()}`;
    const label = detection.text.slice(0, 20);
    setWatermarkRegions(prev => [...prev, { id, label, x, y, width, height }]);
    setActiveWatermarkRegionId(id);
    // Remove from pending list
    setWatermarkScanDetections(prev => prev.filter(d => d !== detection));
  };

  const getWorkspaceVideoContentStyle = (): React.CSSProperties => {
    const videoRatio = workspaceVideoDimensions.width / Math.max(1, workspaceVideoDimensions.height);
    const containerRatio = exportAspectRatio === "original"
      ? videoRatio
      : ({ "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4 } as const)[exportAspectRatio];
    if (videoRatio >= containerRatio) {
      const heightPercent = (containerRatio / videoRatio) * 100;
      return { position: "absolute", left: 0, width: "100%", height: `${heightPercent}%`, top: `${(100 - heightPercent) / 2}%` };
    }
    const widthPercent = (videoRatio / containerRatio) * 100;
    return { position: "absolute", top: 0, height: "100%", width: `${widthPercent}%`, left: `${(100 - widthPercent) / 2}%` };
  };

  const getSubtitlePreviewMetrics = (containerSize: { width: number; height: number }) => {
    const previewFrame = getFittedSubtitleFrame(containerSize.width || 640, containerSize.height || 360, exportPreviewRatio);
    const scale = getSubtitleVisualScale(previewFrame.height);
    const fontSize = Math.max(1, subSettings.fontSize * scale);
    const outlineWidth = Math.max(1, subSettings.outlineWidth * scale);
    const letterSpacing = subSettings.letterSpacing * scale;
    const effectPadding = Math.max(fontSize * 0.35, outlineWidth * 3, subSettings.textEffect === "glow" ? fontSize * 0.5 : 0);
    const horizontalPadding = effectPadding + fontSize * 0.45;
    const verticalPadding = effectPadding + fontSize * 0.24;
    return { scale, fontSize, outlineWidth, letterSpacing, horizontalPadding, verticalPadding };
  };

  const getSubtitlePreviewTextStyle = (containerSize: { width: number; height: number }): React.CSSProperties => {
    const metrics = getSubtitlePreviewMetrics(containerSize);
    const shadow = subSettings.textEffect === "outline"
      ? `0 0 0 ${metrics.outlineWidth}px ${subSettings.outlineColor}`
      : subSettings.textEffect === "glow"
        ? `0 0 ${Math.max(4, metrics.fontSize * 0.35)}px ${subSettings.textColor}`
        : subSettings.textEffect === "shadow"
          ? `${Math.max(1, metrics.fontSize * 0.08)}px ${Math.max(1, metrics.fontSize * 0.08)}px ${Math.max(2, metrics.fontSize * 0.12)}px rgba(0,0,0,.9)`
          : "none";
    return {
      fontFamily: `"${subSettings.fontFamily || "Arial"}", Arial, sans-serif`,
      fontSize: `${metrics.fontSize}px`,
      lineHeight: "1.22",
      letterSpacing: `${metrics.letterSpacing}px`,
      padding: `${metrics.verticalPadding}px ${metrics.horizontalPadding}px`,
      borderRadius: `${Math.max(4, metrics.fontSize * 0.22)}px`,
      color: subSettings.textColor,
      backgroundColor: subSettings.bgColor,
      fontWeight: subSettings.fontWeight,
      textShadow: shadow,
      maxWidth: "86%",
      whiteSpace: "normal",
    };
  };

  const previewCurrentFrameWithPaddleOcr = async () => {
    const video = workspaceVideoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      setErrorMsg("Hãy tải video và seek tới frame có phụ đề trước khi Preview OCR.");
      return;
    }
    setIsPreviewingOcr(true);
    setOcrPreviewText("");
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1920 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Không tạo được ảnh preview OCR.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error("Không mã hóa được frame preview OCR.")),
        "image/jpeg",
        0.9,
      ));
      const response = await fetch("/api/ocr/frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: canvas.toDataURL("image/jpeg", 0.9).split(",")[1],
          timestamp: video.currentTime,
          regions: ocrRegions,
          minConfidence: 0.25,
        }),
      });
      const payload = await readJsonResponse(response);
      const detections: OcrDetection[] = payload.detections || [];
      await checkOcrService(false);
      setOcrPreviewText(detections.length
        ? `[PaddleOCR Python] ${detections.map((item) => `${item.text} (${Math.round(item.confidence * 100)}%)`).join(" · ")}`
        : "[PaddleOCR Python] Không thấy chữ trong frame/vùng đang chọn.");
    } catch (error: any) {
      setErrorMsg(`Preview PaddleOCR thất bại: ${error?.message || String(error)}`);
    } finally {
      setIsPreviewingOcr(false);
    }
  };

  const saveOcrRegionPreset = () => {
    const name = ocrPresetName.trim();
    if (!name || !ocrRegions.length) {
      setErrorMsg("Nhập tên preset và tạo ít nhất một vùng OCR trước.");
      return;
    }
    const preset: OcrRegionPreset = { id: `ocr-preset-${Date.now()}`, name, regions: ocrRegions.map((region) => ({ ...region })) };
    setOcrPresets((current) => [...current.filter((item) => item.name.toLowerCase() !== name.toLowerCase()), preset]);
    setOcrPresetName("");
  };

  const applyOcrRegionPreset = (preset: OcrRegionPreset) => {
    const stamp = Date.now();
    const regions = preset.regions.map((region, index) => ({ ...region, id: `ocr-region-${stamp}-${index}` }));
    setOcrRegions(regions);
    setActiveOcrRegionId(regions[0]?.id || "");
  };

  const handleWorkspaceBlurDrag = (event: React.PointerEvent<HTMLButtonElement>, id: string, resize = false) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    const box = blurBoxes.find(item => item.id === id);
    if (!bounds || !box) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const onMove = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / bounds.width) * 100;
      const dy = ((moveEvent.clientY - startY) / bounds.height) * 100;
      const patch = resize ? { width: Math.max(4, Math.min(100 - box.xPosition, box.width + dx)), height: Math.max(3, Math.min(100 - box.yPosition, box.height + dy)) } : { xPosition: Math.max(0, Math.min(100 - box.width, box.xPosition + dx)), yPosition: Math.max(0, Math.min(100 - box.height, box.yPosition + dy)) };
      setBlurBoxes(prev => prev.map(item => item.id === id ? { ...item, ...patch } : item));
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  };

  const handleWorkspaceSubtitleDrag = (event: React.PointerEvent<HTMLDivElement>, resize = false) => {
    event.preventDefault();
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startFontSize = subSettings.fontSize;
    const startPositionX = subSettings.customX ?? 50;
    const startPositionY = subSettings.customY ?? 82;
    const onMove = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / bounds.width) * 100;
      const dy = ((moveEvent.clientY - startY) / bounds.height) * 100;
      setSubSettings(prev => resize ? { ...prev, fontSize: Math.max(12, Math.min(120, Math.round(startFontSize + dx))) } : { ...prev, position: "custom", customX: Math.max(0, Math.min(100, startPositionX + dx)), customY: Math.max(0, Math.min(100, startPositionY + dy)) });
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  };

  const renderWorkspaceProperties = () => {
    const activeBox = blurBoxes.find(box => box.id === activeBlurBoxId);
    const activeOcrRegion = ocrRegions.find(region => region.id === activeOcrRegionId);
    const fieldClass = "mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800";
    if (workspacePropertyTarget === "ocr") {
      return <div className="mt-4 space-y-3 text-xs">
        {ocrHealth && <div className={`rounded-lg border p-2 ${ocrHealth.connected ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
          <strong>Python OCR Server: {ocrHealth.connected ? "sẵn sàng" : ocrHealth.state === "initializing" ? "đang nạp" : "chưa kết nối"}</strong>
          {ocrHealth.model && <p className="mt-1 text-[10px] leading-4">{ocrHealth.model.name} · {ocrHealth.model.backend} · {ocrHealth.model.concurrency || 1} worker</p>}
          {ocrHealth.error && <p className="mt-1 break-words text-[10px]">{ocrHealth.error}</p>}
        </div>}
        <label className="block font-bold text-slate-600">Tần suất quét: {ocrFps} FPS
          <input type="range" min="1" max="20" step="1" value={ocrFps} onChange={(event) => setOcrFps(Number(event.target.value))} className="mt-1 w-full accent-indigo-600" />
          <span className="mt-1 block text-[9px] font-normal text-slate-400">PaddleOCR Python quét tuần tự toàn bộ video theo FPS đã chọn, tối đa 20 FPS; không dùng WebGPU/WASM.</span>
        </label>
        <div className="flex flex-wrap gap-1">{ocrRegions.map((region, index) => <button key={region.id} type="button" onClick={() => setActiveOcrRegionId(region.id)} className={`rounded px-2 py-1 text-[10px] font-bold ${region.id === activeOcrRegionId ? "bg-emerald-600 text-white" : "bg-white text-slate-500"}`}>Vùng #{index + 1}</button>)}</div>
        <div className="grid grid-cols-2 gap-1"><button type="button" onClick={() => setIsDrawingOcrRegion(true)} className={`rounded px-2 py-1.5 text-[10px] font-bold text-white ${isDrawingOcrRegion ? "bg-amber-500" : "bg-indigo-600"}`}>{isDrawingOcrRegion ? "Kéo chuột trên video..." : "+ Vẽ vùng OCR"}</button><button type="button" onClick={addSuggestedOcrRegion} className="rounded border border-slate-200 bg-white px-2 py-1.5 text-[10px] font-bold text-slate-600">+ Vùng gợi ý</button></div>
        {activeOcrRegion ? <>
          <label className="block font-bold text-slate-600">Tên vùng<input value={activeOcrRegion.label} onChange={(event) => updateActiveOcrRegion({ label: event.target.value })} className={fieldClass} /></label>
          <div className="grid grid-cols-2 gap-2">{([['x','Vị trí X'],['y','Vị trí Y'],['width','Chiều rộng'],['height','Chiều cao']] as const).map(([key, label]) => <label key={key} className="font-bold text-slate-600">{label} (%)<input type="number" min="0" max="100" step="0.1" value={activeOcrRegion[key]} onChange={(event) => updateActiveOcrRegion({ [key]: Number(event.target.value) })} className={fieldClass} /></label>)}</div>
          <button type="button" onClick={removeActiveOcrRegion} className="flex w-full items-center justify-center gap-1 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[10px] font-bold text-rose-600"><Trash2 className="h-3 w-3" /> Xóa vùng đang chọn</button>
        </> : <p className="rounded bg-sky-50 p-2 text-[10px] text-sky-700">Không có ROI: PaddleOCR sẽ quét toàn bộ frame.</p>}
        <button type="button" onClick={() => void previewCurrentFrameWithPaddleOcr()} disabled={isPreviewingOcr || !videoSrc} className="w-full rounded bg-emerald-600 px-3 py-2 text-[11px] font-extrabold text-white disabled:opacity-50">{isPreviewingOcr ? "Đang OCR frame thật..." : "Preview OCR tại frame hiện tại"}</button>
        {ocrPreviewText && <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-[10px] leading-4 text-emerald-800"><strong>Kết quả:</strong> {ocrPreviewText}</div>}
        <div className="rounded-lg border border-slate-200 bg-white p-2"><p className="font-bold text-slate-600">Preset vùng OCR</p><div className="mt-1 flex gap-1"><input value={ocrPresetName} onChange={(event) => setOcrPresetName(event.target.value)} placeholder="Tên preset..." className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-[10px]" /><button type="button" onClick={saveOcrRegionPreset} className="rounded bg-slate-800 px-2 text-[10px] font-bold text-white">Lưu</button></div>{ocrPresets.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{ocrPresets.map((preset) => <button key={preset.id} type="button" onClick={() => applyOcrRegionPreset(preset)} className="rounded bg-slate-100 px-2 py-1 text-[9px] font-bold text-slate-600">{preset.name}</button>)}</div>}</div>
      </div>;
    }
    if (workspacePropertyTarget === "subtitle") {
      return <div className="mt-4 space-y-3 text-xs">
        <label className="block font-bold text-slate-600">Kích thước chữ: {subSettings.fontSize}px<input type="range" min="12" max="120" value={subSettings.fontSize} onChange={(e) => setSubSettings(prev => ({ ...prev, fontSize: Number(e.target.value) }))} className="mt-1 w-full accent-indigo-600" /></label>
        <label className="block font-bold text-slate-600">Phông chữ<select value={subSettings.fontFamily} onChange={(e) => setSubSettings(prev => ({ ...prev, fontFamily: e.target.value }))} className={fieldClass}><option>Bangers</option><option>Arial</option><option>Inter</option><option>JetBrains Mono</option></select></label>
        <div className="grid grid-cols-2 gap-2"><label className="font-bold text-slate-600">Độ đậm<select value={subSettings.fontWeight} onChange={(e) => setSubSettings(prev => ({ ...prev, fontWeight: e.target.value as SubtitleSettings["fontWeight"] }))} className={fieldClass}><option value="normal">Thường</option><option value="medium">Vừa</option><option value="bold">Đậm</option><option value="black">Rất đậm</option></select></label><label className="font-bold text-slate-600">Khoảng cách: {subSettings.letterSpacing}px<input type="range" min="-2" max="12" value={subSettings.letterSpacing} onChange={(e) => setSubSettings(prev => ({ ...prev, letterSpacing: Number(e.target.value) }))} className="mt-2 w-full accent-indigo-600" /></label></div>
        <div><p className="font-bold text-slate-600">Vị trí hiển thị</p><div className="mt-1 grid grid-cols-2 gap-1">{([['bottom','Phía dưới'],['top','Phía trên'],['center','Ở giữa'],['custom','Tự do (kéo thả)']] as const).map(([value,label]) => <button key={value} onClick={() => setSubSettings(prev => ({ ...prev, position: value }))} className={`rounded border px-2 py-1.5 text-[10px] font-bold ${subSettings.position === value ? "border-indigo-500 bg-indigo-50 text-indigo-600" : "border-slate-200 bg-white text-slate-500"}`}>{label}</button>)}</div></div>
        <div className="grid grid-cols-2 gap-2"><label className="font-bold text-slate-600">Màu chữ<input type="color" value={subSettings.textColor} onChange={(e) => setSubSettings(prev => ({ ...prev, textColor: e.target.value }))} className="mt-1 h-9 w-full rounded border border-slate-200" /></label><label className="font-bold text-slate-600">Nền chữ<select value={subSettings.bgColor} onChange={(e) => setSubSettings(prev => ({ ...prev, bgColor: e.target.value }))} className={fieldClass}><option value="transparent">Tắt</option><option value="rgba(0,0,0,0.6)">Nền đen</option><option value="rgba(15,23,42,0.75)">Nền xanh đậm</option><option value="rgba(255,255,255,0.7)">Nền trắng</option></select></label></div>
        <div><p className="font-bold text-slate-600">Hiệu ứng chữ</p><div className="mt-1 grid grid-cols-2 gap-1">{([['none','Không'],['outline','Viền chữ'],['glow','Phát sáng'],['shadow','Đổ bóng']] as const).map(([value,label]) => <button key={value} onClick={() => setSubSettings(prev => ({ ...prev, textEffect: value }))} className={`rounded border px-2 py-1.5 text-[10px] font-bold ${subSettings.textEffect === value ? "border-indigo-500 bg-indigo-50 text-indigo-600" : "border-slate-200 bg-white text-slate-500"}`}>{label}</button>)}</div></div>
        {subSettings.textEffect === "outline" && <div className="grid grid-cols-2 gap-2"><label className="font-bold text-slate-600">Màu viền<input type="color" value={subSettings.outlineColor} onChange={(e) => setSubSettings(prev => ({ ...prev, outlineColor: e.target.value }))} className="mt-1 h-8 w-full" /></label><label className="font-bold text-slate-600">Độ dày: {subSettings.outlineWidth}px<input type="range" min="1" max="8" value={subSettings.outlineWidth} onChange={(e) => setSubSettings(prev => ({ ...prev, outlineWidth: Number(e.target.value) }))} className="mt-2 w-full accent-indigo-600" /></label></div>}
      </div>;
    }
    return <div className="mt-4 space-y-3 text-xs">
      <div className="flex items-center justify-between"><span className="font-bold text-slate-600">Kích hoạt</span><input type="checkbox" checked={blurSettings.enabled} onChange={(e) => setBlurSettings(prev => ({ ...prev, enabled: e.target.checked }))} className="h-4 w-4 accent-indigo-600" /></div>
      <div className="flex flex-wrap gap-1">{blurBoxes.map((box, index) => <button key={box.id} onClick={() => setActiveBlurBoxId(box.id)} className={`rounded px-2 py-1 text-[10px] font-bold ${box.id === activeBlurBoxId ? "bg-indigo-600 text-white" : "bg-white text-slate-500"}`}>Hộp #{index + 1}</button>)}<button onClick={handleAddBlurBox} className="rounded bg-indigo-600 px-2 py-1 text-[10px] font-bold text-white">+ Thêm</button></div>
      {activeBox ? <><button type="button" onClick={(e) => handleRemoveBlurBox(activeBox.id, e)} className="flex w-full items-center justify-center gap-1.5 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[10px] font-bold text-rose-600 transition-colors hover:border-rose-300 hover:bg-rose-100"><Trash2 className="h-3.5 w-3.5" /> Xóa hộp đang chọn</button><div className="grid grid-cols-2 gap-2">{([['xPosition','Vị trí X'],['yPosition','Vị trí Y'],['width','Chiều rộng'],['height','Chiều cao']] as const).map(([key,label]) => <label key={key} className="font-bold text-slate-600">{label}<input type="number" value={activeBox[key]} onChange={(e) => updateActiveBlurBox({ [key]: Number(e.target.value) })} className={fieldClass} /></label>)}</div><div><p className="font-bold text-slate-600">Kiểu che</p><div className="mt-1 grid grid-cols-4 gap-1">{BLUR_COVER_PRESETS.map((preset) => { const selected = getBlurCoverPresetKey(activeBox.bgColor) === preset.key; return <button key={preset.key} type="button" aria-pressed={selected} onClick={() => updateActiveBlurBox({ bgColor: preset.bgColor })} className={`rounded border px-1 py-1.5 text-[10px] font-bold transition-colors ${selected ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-indigo-300"}`}>{preset.label}</button>; })}</div></div><label className="block font-bold text-slate-600">Mức độ làm mờ: {activeBox.blurAmount}px<input type="range" min="0" max="30" value={activeBox.blurAmount} onChange={(e) => updateActiveBlurBox({ blurAmount: Number(e.target.value) })} className="mt-1 w-full accent-indigo-600" /></label><label className="block font-bold text-slate-600">Độ che phủ: {Math.round(activeBox.opacity * 100)}%<input type="range" min="0" max="1" step="0.05" value={activeBox.opacity} onChange={(e) => updateActiveBlurBox({ opacity: Number(e.target.value) })} className="mt-1 w-full accent-indigo-600" /></label></> : <p className="rounded bg-indigo-50 p-2 text-indigo-700">Thêm hoặc chọn Blur Box trên preview để tinh chỉnh.</p>}
    </div>;
  };

  // Remove a blur box
  const handleRemoveBlurBox = (id: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
    }
    setBlurBoxes(prev => {
      const filtered = prev.filter(b => b.id !== id);
      if (activeBlurBoxId === id) {
        setActiveBlurBoxId(filtered[0]?.id || null);
      }
      return filtered;
    });
  };

  // Handle pointer down for drag & resize
  const handleBoxPointerDown = (
    e: React.PointerEvent<HTMLDivElement>, 
    boxId: string, 
    action: 'move' | 'resize-n' | 'resize-s' | 'resize-e' | 'resize-w' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se'
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveBlurBoxId(boxId);
    setIsAdjustingCensor(true);
    
    const container = document.getElementById("video-container");
    if (!container) return;
    const rect = container.getBoundingClientRect();
    
    const initialPointerX = e.clientX;
    const initialPointerY = e.clientY;
    
    const currentBox = blurBoxes.find(b => b.id === boxId);
    if (!currentBox) return;
    
    const initialX = currentBox.xPosition;
    const initialY = currentBox.yPosition;
    const initialW = currentBox.width;
    const initialH = currentBox.height;
    
    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = ((moveEvent.clientX - initialPointerX) / rect.width) * 100;
      const deltaY = ((moveEvent.clientY - initialPointerY) / rect.height) * 100;
      
      setBlurBoxes(prevBoxes => prevBoxes.map(b => {
        if (b.id !== boxId) return b;
        
        let newX = b.xPosition;
        let newY = b.yPosition;
        let newW = b.width;
        let newH = b.height;
        
        if (action === 'move') {
          newX = Math.max(0, Math.min(100 - b.width, initialX + deltaX));
          newY = Math.max(0, Math.min(100 - b.height, initialY + deltaY));
        } else {
          if (action.includes('e')) {
            newW = Math.max(2, Math.min(100 - b.xPosition, initialW + deltaX));
          }
          if (action.includes('w')) {
            const maxW = initialX + initialW;
            newX = Math.max(0, Math.min(maxW - 2, initialX + deltaX));
            newW = maxW - newX;
          }
          if (action.includes('s')) {
            newH = Math.max(2, Math.min(100 - b.yPosition, initialH + deltaY));
          }
          if (action.includes('n')) {
            const maxH = initialY + initialH;
            newY = Math.max(0, Math.min(maxH - 2, initialY + deltaY));
            newH = maxH - newY;
          }
        }
        
        return {
          ...b,
          xPosition: Math.round(newX * 10) / 10,
          yPosition: Math.round(newY * 10) / 10,
          width: Math.round(newW * 10) / 10,
          height: Math.round(newH * 10) / 10
        };
      }));
    };
    
    const onPointerUp = () => {
      setIsAdjustingCensor(false);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    };
    
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  };

  // Handle pointer down for dragging subtitles
  const handleSubtitlePointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    const container = document.getElementById("video-container");
    if (!container) return;
    const rect = container.getBoundingClientRect();
    
    let initialX = subSettings.customX ?? 50;
    let initialY = subSettings.customY ?? 82;
    
    if (subSettings.position !== "custom") {
      switch (subSettings.position) {
        case "top":
          initialX = 50;
          initialY = 12;
          break;
        case "center":
          initialX = 50;
          initialY = 50;
          break;
        case "blur-box": {
          const activeBox = blurBoxes.find(b => b.id === activeBlurBoxId) || blurBoxes[0];
          if (activeBox) {
            initialX = activeBox.xPosition + (activeBox.width / 2);
            initialY = activeBox.yPosition + (activeBox.height / 2);
          } else {
            initialX = 50;
            initialY = 82;
          }
          break;
        }
        case "bottom":
        default:
          initialX = 50;
          initialY = 82;
          break;
      }
    }
    
    // Set position to custom immediately and set the base coordinates
    setSubSettings(prev => ({
      ...prev,
      position: "custom",
      customX: Math.round(initialX * 10) / 10,
      customY: Math.round(initialY * 10) / 10,
    }));
    
    const initialPointerX = e.clientX;
    const initialPointerY = e.clientY;
    
    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = ((moveEvent.clientX - initialPointerX) / rect.width) * 100;
      const deltaY = ((moveEvent.clientY - initialPointerY) / rect.height) * 100;
      
      const newX = Math.max(0, Math.min(100, initialX + deltaX));
      const newY = Math.max(0, Math.min(100, initialY + deltaY));
      
      setSubSettings(prev => ({
        ...prev,
        customX: Math.round(newX * 10) / 10,
        customY: Math.round(newY * 10) / 10,
      }));
    };
    
    const onPointerUp = () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    };
    
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  };

  // Translate vertical placement selection into style coordinates
  const getSubtitlePositionStyle = (): React.CSSProperties => {
    switch (subSettings.position) {
      case "top":
        return { left: "50%", top: "12%", bottom: "auto", transform: "translateX(-50%)" };
      case "center":
        return { left: "50%", top: "50%", transform: "translate(-50%, -50%)", bottom: "auto" };
      case "blur-box": {
        const activeBox = blurBoxes.find(b => b.id === activeBlurBoxId) || blurBoxes[0];
        if (activeBox) {
          return {
            left: `${activeBox.xPosition + (activeBox.width / 2)}%`,
            top: `${activeBox.yPosition + (activeBox.height / 2)}%`,
            transform: "translate(-50%, -50%)",
            bottom: "auto"
          };
        }
        return { left: "50%", bottom: "12%", top: "auto", transform: "translateX(-50%)" };
      }
      case "custom":
        return {
          left: `${subSettings.customX ?? 50}%`,
          top: `${subSettings.customY ?? 80}%`,
          transform: "translate(-50%, -50%)",
          bottom: "auto"
        };
      case "bottom":
      default:
        return { left: "50%", bottom: "12%", top: "auto", transform: "translateX(-50%)" };
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="h-screen max-h-screen overflow-hidden bg-slate-950 text-slate-100 font-sans flex flex-col justify-between relative p-4 md:p-6 select-none" id="login-container">
        {/* Modern SaaS Blue Print Grid Overlay */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#1e293b_1px,transparent_1px),linear-gradient(to_bottom,#1e293b_1px,transparent_1px)] bg-[size:3rem_3rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_40%,transparent_100%)] opacity-25 pointer-events-none" />

        {/* Decorative Modern Glowing Orbs */}
        <div className="absolute top-[-10%] left-[-10%] w-[45%] h-[45%] rounded-full bg-indigo-500/10 blur-[130px] pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[45%] h-[45%] rounded-full bg-violet-600/10 blur-[130px] pointer-events-none" />
        <div className="absolute top-[30%] left-[25%] w-[250px] h-[250px] rounded-full bg-emerald-500/5 blur-[100px] pointer-events-none" />

        {/* Minimal Clean Header */}
        <header className="w-full max-w-5xl mx-auto flex items-center justify-between relative z-10 py-1 border-b border-slate-900/60 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl overflow-hidden shadow-2xl border border-slate-800 bg-slate-900 flex items-center justify-center shrink-0">
              <img src="/logo.png" alt="Logo" className="w-full h-full object-cover" />
            </div>
            <div>
              <h1 className="text-sm font-black tracking-tight bg-gradient-to-r from-white via-slate-200 to-indigo-400 bg-clip-text text-transparent leading-none">
                26DUBBIN
              </h1>
              <p className="text-[8px] text-slate-500 font-black uppercase tracking-widest mt-1">Sản xuất nội dung AI chuyên nghiệp</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 bg-slate-900/80 border border-slate-800/60 rounded-full px-3 py-1 text-[9px] text-slate-400 font-bold backdrop-blur-md shadow-inner">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span>Hệ thống hoạt động ổn định</span>
          </div>
        </header>

        {/* Main Content Area: Flex centered without overflow */}
        <div className="flex-1 flex items-center justify-center py-4 relative z-10 overflow-hidden">
          <motion.div
            initial={{ opacity: 0, y: 25, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
            className="w-full max-w-[390px] bg-slate-900/40 border border-slate-800/80 hover:border-slate-800 transition-colors duration-300 rounded-3xl p-5 md:p-6 shadow-[0_20px_50px_rgba(0,0,0,0.5)] backdrop-blur-xl relative overflow-hidden flex flex-col gap-4"
          >
            {/* Fine Top Border Glow */}
            <div className="absolute top-0 left-0 right-0 h-[1.5px] bg-gradient-to-r from-transparent via-indigo-500/80 to-transparent" />
            
            {/* Card Head / Branding */}
            <div className="text-center flex flex-col items-center">
              <div className="w-11 h-11 rounded-2xl bg-gradient-to-b from-indigo-500/10 to-violet-500/5 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mb-3 shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]">
                <Key className="w-5 h-5" />
              </div>
              <h2 className="text-lg font-extrabold text-white tracking-tight">Kích Hoạt Hệ Thống</h2>
              <p className="text-[11px] text-slate-400 mt-1 max-w-[280px] font-medium leading-relaxed">
                Nhập mã kích hoạt do admin cấp để truy cập. Mã có thời hạn: 1 ngày, 1 tháng, 1 năm hoặc vĩnh viễn.
              </p>
            </div>

            {/* Token Input Form */}
            <form onSubmit={handleLoginSubmit} className="space-y-3">
              <div className="space-y-1">
                <label className="text-[9px] font-bold text-slate-400 tracking-wider uppercase px-0.5">Mã Kích Hoạt</label>
                <textarea
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Dán mã kích hoạt vào đây..."
                  rows={3}
                  className="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl py-2 px-3 text-[10px] text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 transition-all font-mono resize-none"
                  disabled={isLoggingIn}
                />
              </div>

              {loginError && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-2 bg-red-500/10 border border-red-500/20 text-red-400 text-[10px] rounded-lg font-bold text-left leading-normal flex items-start gap-1.5"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0 mt-1"></span>
                  <span>{loginError}</span>
                </motion.div>
              )}

              <button
                type="submit"
                disabled={isLoggingIn}
                className="w-full py-2.5 px-4 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white font-extrabold rounded-xl shadow-[0_4px_12px_rgba(79,70,229,0.25)] hover:shadow-[0_4px_16px_rgba(79,70,229,0.35)] active:scale-[0.99] transition-all text-xs flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {isLoggingIn ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Đang xác thực mã...</span>
                  </>
                ) : (
                  <>
                    <Lock className="w-3.5 h-3.5" />
                    <span>Kích Hoạt Ngay</span>
                  </>
                )}
              </button>
            </form>

            {/* HWID display — user copy gửi cho admin */}
            <div className="w-full bg-slate-950/80 border border-slate-800/60 rounded-xl px-3 py-2.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Mã Thiết Bị (HWID)</span>
                <button
                  type="button"
                  onClick={() => { navigator.clipboard.writeText(hwid); }}
                  className="text-[9px] text-indigo-400 hover:text-indigo-300 font-black cursor-pointer transition-colors"
                >
                  Copy
                </button>
              </div>
              <p className="text-[10px] font-mono text-slate-300 break-all leading-relaxed select-all">{hwid || "Đang tải..."}</p>
              <p className="text-[9px] text-slate-600 font-medium">Gửi mã này cho admin để nhận License Key</p>
            </div>

            {/* Contact banner */}
            <div className="w-full py-2 px-3 bg-slate-950/60 border border-slate-800/60 rounded-xl text-[10px] text-slate-500 text-center font-semibold leading-relaxed">
              Chưa có mã? Liên hệ admin để được cấp license.
              <span className="block text-indigo-400 font-black mt-0.5">Hotline: 0373491922</span>
              <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-2.5 text-left">
                <a href="https://zalo.me/g/mjtdnc945" target="_blank" rel="noopener noreferrer" className="shrink-0 overflow-hidden rounded-lg border border-white/10 bg-white p-1 shadow-lg" title="Quét QR để tham gia nhóm Zalo">
                  <img src="https://dubbintool.io.vn/assets/zalo-group-qr.png" alt="QR tham gia nhóm Zalo DubbinTool" className="h-16 w-16 object-contain" />
                </a>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-black text-slate-200">Vào nhóm Zalo để lấy key</p>
                  <p className="mt-0.5 text-[9px] font-medium leading-relaxed text-slate-500">Quét QR hoặc bấm nút để tham gia nhóm hỗ trợ DubbinTool.</p>
                  <a href="https://zalo.me/g/mjtdnc945" target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-flex w-full items-center justify-center rounded-lg bg-indigo-600 px-2 py-1.5 text-[9px] font-black text-white transition hover:bg-indigo-500">Tham gia nhóm Zalo lấy key</a>
                </div>
              </div>
            </div>
          </motion.div>
        </div>

        {/* Minimal Clean Footer */}
        <footer className="w-full py-1.5 text-center text-[9px] text-slate-600 font-bold relative z-10 border-t border-slate-900/40 max-w-5xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-1.5 shrink-0">
          <span>© {new Date().getFullYear()} 26Dubbin. All rights reserved.</span>
          <div className="flex items-center gap-3">
            <span className="hover:text-slate-400 transition-colors cursor-pointer">Hotline: 0373491922</span>
            <span className="text-slate-800">•</span>
            <span className="hover:text-slate-400 transition-colors cursor-pointer">Zalo Hỗ Trợ Kỹ Thuật</span>
          </div>
        </footer>
      </div>
    );
  }

  const isElectron = typeof window !== "undefined" && navigator.userAgent.toLowerCase().includes("electron");
  const updateNoticeKey = `${updateStatus.state}:${updateStatus.version || ""}`;
  const showUpdateNotice = isElectron && (updateStatus.state === "downloading" || updateStatus.state === "ready") && dismissedUpdateState !== updateNoticeKey;

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-800 font-sans selection:bg-[#4f46e5] selection:text-white" id="main-container">
      <AnimatePresence>
        {showPreRenderChoice && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[120] grid place-items-center bg-slate-950/45 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pre-render-title"
          >
            <motion.div initial={{ y: 18, scale: 0.97 }} animate={{ y: 0, scale: 1 }} className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
              <div className="h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500" />
              <div className="p-5">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600"><Check className="h-5 w-5" /></div>
                  <div>
                    <h2 id="pre-render-title" className="text-base font-extrabold text-slate-900">Dự án đã sẵn sàng để xuất</h2>
                    <p className="mt-1 text-xs leading-5 text-slate-500">OCR, bản dịch và Smart TTS đã được lưu checkpoint. Bạn có thể render ngay hoặc kiểm tra timeline trước.</p>
                  </div>
                </div>
                <div className="mt-5 grid gap-2 sm:grid-cols-2">
                  <button type="button" onClick={() => { setShowPreRenderChoice(false); void startBrowserRecording(); }} className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-xs font-extrabold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700"><Play className="h-4 w-4 fill-white" /> Render ngay</button>
                  <button type="button" onClick={() => { setShowPreRenderChoice(false); setActiveTab("editor"); }} className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-4 text-xs font-extrabold text-indigo-700 hover:bg-indigo-100"><Edit3 className="h-4 w-4" /> Tinh chỉnh timeline</button>
                </div>
                <button type="button" onClick={() => setShowPreRenderChoice(false)} className="mt-3 w-full py-2 text-[11px] font-bold text-slate-400 hover:text-slate-600">Để sau</button>
              </div>
            </motion.div>
          </motion.div>
        )}
        {showUpdateNotice && (
          <motion.aside
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            className="fixed bottom-5 right-5 z-[100] w-[min(calc(100vw-2.5rem),390px)] overflow-hidden rounded-2xl border border-indigo-100 bg-white shadow-2xl shadow-slate-900/20"
            role="status"
            aria-live="polite"
          >
            <div className="h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500" />
            <div className="p-4">
              <div className="flex items-start gap-3">
                <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${updateStatus.state === "ready" ? "bg-emerald-100 text-emerald-600" : "bg-indigo-100 text-indigo-600"}`}>
                  {updateStatus.state === "ready" ? <Check className="h-5 w-5" /> : <Download className="h-5 w-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-extrabold text-slate-900">{updateStatus.state === "ready" ? "Bản cập nhật đã sẵn sàng" : "Đang tải bản cập nhật"}</p>
                    <button type="button" onClick={() => setDismissedUpdateState(updateNoticeKey)} className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700" aria-label="Ẩn thông báo cập nhật"><X className="h-4 w-4" /></button>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    {updateStatus.state === "ready"
                      ? `DubbinTool ${updateStatus.version || "mới"} đã tải xong. Dự án và dữ liệu hiện tại vẫn được giữ nguyên.`
                      : `DubbinTool ${updateStatus.version || "mới"} đang được tải trong nền. Bạn vẫn có thể tiếp tục làm việc.`}
                  </p>
                </div>
              </div>
              {updateStatus.state === "downloading" ? (
                <div className="mt-4">
                  <div className="mb-1.5 flex justify-between text-[11px] font-bold text-indigo-600"><span>Tải nền an toàn</span><span>{Math.round(updateStatus.percent || 0)}%</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, updateStatus.percent || 0))}%` }} /></div>
                </div>
              ) : (
                <div className="mt-4 flex gap-2">
                  <button type="button" onClick={() => { void window.electronAPI?.installUpdate(); }} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-2.5 text-xs font-extrabold text-white shadow-lg shadow-indigo-200 transition hover:bg-indigo-700"><RefreshCw className="h-3.5 w-3.5" />Khởi động lại để cài</button>
                  <button type="button" onClick={() => setDismissedUpdateState(updateNoticeKey)} className="rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-600 transition hover:bg-slate-50">Để sau</button>
                </div>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
      <AppSidebar
        activeRoute={activeTab}
        onNavigate={setActiveTab}
        onDonate={() => setShowDonatePopup(true)}
        onSignOut={handleSignOut}
        activityLogs={activityLogs}
        onClearLogs={() => setActivityLogs([])}
      />
      <AppNavbar
        engineStatus={engineStatus}
        isDownloading={isDownloadingEngine}
        downloadProgress={engineDownloadProgress}
        onDownloadEngines={handleCheckResources}
        updateStatus={updateStatus}
        onInstallUpdate={() => { void window.electronAPI?.installUpdate(); }}
      />

      <main className={`mx-auto grid max-w-7xl grid-cols-1 gap-6 px-4 py-6 sm:p-6 lg:ml-64 lg:max-w-none lg:grid-cols-12 lg:gap-8 ${activeTab === "dubbin" || activeTab === "editor" ? (isElectron ? "lg:h-[calc(100vh-111px)] lg:py-3" : "lg:h-[calc(100vh-73px)] lg:py-3") : ""} ${activeTab === "dubbin" ? "lg:overflow-y-auto" : ""} ${activeTab === "editor" ? "lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden" : ""} ${activeTab === "settings" ? "hidden" : ""}`} id="main-content">
        <React.Suspense fallback={<div className="col-span-12 flex min-h-64 items-center justify-center rounded-2xl border border-slate-200 bg-white text-sm font-bold text-slate-500"><RefreshCw className="mr-2 h-4 w-4 animate-spin text-indigo-600" />Đang tải giao diện...</div>}>
        {activeTab === "projects" && (
          <ProjectLibraryTab
            projectLibrary={projectLibrary}
            currentProjectId={currentProjectId}
            isProjectLibraryLoading={isProjectLibraryLoading}
            onRefresh={refreshProjectLibrary}
            onCreateNew={handleCreateNewProject}
            onOpen={handleOpenLibraryProject}
            onReExport={handleReExportLibraryProject}
            onDelete={handleDeleteLibraryProject}
          />
        )}

        {activeTab === "script-shorts" && (
          <AiScriptShortsTab geminiApiKey={geminiApiKey} tiktokSessionId={tiktokSessionId} onActivity={addLog} />
        )}

        {activeTab === "editor" && (
          <TimelineEditorTab
            videoSrc={videoSrc}
            videoName={videoName}
            duration={duration}
            subtitles={subtitles}
            blurBoxes={blurBoxes}
            subSettings={subSettings}
            ttsEnabled={ttsEnabled}
            voiceAudioUrls={{ ...(ttsEngine === "tiktok" ? tiktokAudioCacheRef.current : vieneuAudioCacheRef.current) }}
            ttsPlaybackRate={ttsRate}
            ttsVolume={ttsVolume}
            sourceAudioVolume={volume * originalAudioMixVolume}
            isRendering={isRecordingVideo || isPreGenerating || isFinalizingVoiceover}
            onChangeSubtitles={setSubtitles}
            onChangeBlurBoxes={setBlurBoxes}
            onRender={() => { void handleEditorRender(); }}
            onBack={() => setActiveTab("dubbin")}
          />
        )}

        {activeTab === "extract" && (
          <>
            <input ref={autoDubbingFileInputRef} type="file" accept="video/*,.mp4,.m4v,.mov,.webm,.avi,.mkv,.mpeg,.mpg,.3gp,.ts" onChange={handleFileChange} className="hidden" />
            <SubtitleExtractionTab
            videoSrc={videoSrc}
            videoName={videoName}
            subtitles={subtitles}
            ocrRegions={ocrRegions}
            ocrFps={ocrFps}
            extractionMethod="localocr"
            ocrHealth={ocrHealth}
            isLoading={isLoading}
            loadingProgress={loadingProgress}
            loadingStep={loadingStep}
            errorMsg={errorMsg}
            watermarkRegions={watermarkRegions}
            watermarkScanDetections={watermarkScanDetections}
            isScanningWatermark={isScanningWatermark}
            activeWatermarkRegionId={activeWatermarkRegionId}
            onSelectVideo={() => autoDubbingFileInputRef.current?.click()}
            onExtract={() => void handleExtractSubtitles()}
            onScanMissing={() => void handleExtractSubtitles(true)}
            onMethodChange={() => { setExtractionMethod("localocr"); setWorkspacePropertyTarget("ocr"); }}
            onFpsChange={setOcrFps}
            onUpdateRegion={(id, patch) => setOcrRegions((regions) => regions.map((region) => region.id === id ? { ...region, ...patch } : region))}
            onSetActiveRegion={setActiveOcrRegionId}
            onExportSrt={exportSRT}
            onExportVtt={exportVTT}
            onExportJson={exportJSON}
            onOpenTracks={() => setActiveTab("tracks")}
            onOptimizeSubtitles={(optimized, stats) => {
              setSubtitles(optimized);
              addLog(`Tối ưu phụ đề: ${stats.before} → ${stats.after} dòng; lọc ${stats.duplicatesRemoved} câu trùng, làm sạch ${stats.textCleaned + stats.emptyRemoved} câu, sửa ${stats.overlapsFixed} timestamp chồng lấn.`);
            }}
            onScanWatermarks={() => void scanCurrentFrameForWatermarks()}
            onAddWatermarkDetection={addWatermarkFromDetection}
            onSetActiveWatermarkRegion={setActiveWatermarkRegionId}
            onRemoveWatermarkRegion={(id) => { setWatermarkRegions((regions) => regions.filter((region) => region.id !== id)); if (activeWatermarkRegionId === id) setActiveWatermarkRegionId(null); }}
            />
          </>
        )}

        {activeTab === "dubbin" && (
          <AutoDubbingLayout>
          <input ref={autoDubbingFileInputRef} type="file" accept="video/*,.mp4,.m4v,.mov,.webm,.avi,.mkv,.mpeg,.mpg,.3gp,.ts" onChange={handleFileChange} className="hidden" />
          <motion.section
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="h-fit overflow-visible rounded-2xl border border-slate-200/80 bg-white p-5 text-left text-slate-800 shadow-md transition-all duration-300 hover:border-slate-300/80 hover:shadow-lg lg:col-span-12"
            id="auto-dubbing-workspace"
          >
            <div className="mb-4 flex flex-col gap-4 border-b border-slate-200 pb-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-base font-bold text-slate-800"><Sparkles className="h-4 w-4 text-sky-500" /> Auto Dubbing</h2>
                <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                  <span>Tải video, thiết lập phụ đề, blur, giọng đọc và render chỉ với một nút.</span>
                  {isRestoringProject ? (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 font-bold text-amber-600">Đang tìm checkpoint...</span>
                  ) : currentProjectId ? (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-bold text-emerald-600">● Tự động lưu dự án</span>
                  ) : null}
                </div>
                <div className="mt-2 inline-flex rounded-lg bg-slate-100 p-0.5 text-[10px] font-extrabold">
                  <button type="button" onClick={() => setIsAutoExpertMode(false)} className={`rounded-md px-2.5 py-1 transition-colors ${!isAutoExpertMode ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>Tự động</button>
                  <button type="button" onClick={() => { setIsAutoExpertMode(true); setIsAutoAdvancedOpen(true); }} className={`rounded-md px-2.5 py-1 transition-colors ${isAutoExpertMode ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>Chỉnh sửa nâng cao</button>
                  <button type="button" onClick={() => setActiveTab("editor")} disabled={!videoSrc} className="rounded-md px-2.5 py-1 text-slate-500 transition-colors hover:bg-white hover:text-indigo-600 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-40">Trình chỉnh sửa</button>
                </div>
              </div>
              <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
                <div className="flex items-center gap-1.5 text-[10px] font-bold">
                  <span className={`rounded-full px-2 py-1 ${videoSrc ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>{videoSrc ? "✓ Video" : "1 Video"}</span>
                  <span className={`rounded-full px-2 py-1 ${subtitles.length > 0 ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>{subtitles.length > 0 ? `✓ ${subtitles.length} phụ đề` : "2 Phụ đề"}</span>
                  <span className={`rounded-full px-2 py-1 ${exportedVideoUrl ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>{exportedVideoUrl ? "✓ Hoàn tất" : "3 Xuất video"}</span>
                </div>
                <button
                  onClick={() => !videoSrc ? autoDubbingFileInputRef.current?.click() : subtitles.length === 0 ? handleStartOrContinueProject() : handleAutoDubbingRender()}
                  disabled={isLoading || isRecordingVideo || isPreGenerating || isFinalizingVoiceover}
                  className="min-h-10 rounded-xl bg-indigo-600 px-5 text-xs font-extrabold text-white shadow-md shadow-indigo-600/20 transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {!videoSrc ? "Chọn video để bắt đầu" : isLoading ? "Đang tạo phụ đề..." : isPreGenerating ? `Đang tạo TTS ${preGenerateProgress}%` : isFinalizingVoiceover ? "Đang finalize Smart TTS..." : isRecordingVideo ? `Đang xuất ${recordingProgress}%` : subtitles.length === 0 ? "Phân tích & tạo phụ đề" : "Render tự động"}
                </button>
              </div>
            </div>

            {(isLoading || isRecordingVideo || isPreGenerating || isFinalizingVoiceover) && (
              <div className="mb-4 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2.5">
                <div className="mb-1.5 flex items-center justify-between gap-3 text-[10px] font-bold text-indigo-700">
                  <span className="truncate">{isRecordingVideo ? "Đang render video final" : isFinalizingVoiceover ? "Đang finalize Smart TTS và lưu checkpoint" : isPreGenerating ? "Đang tạo giọng thuyết minh" : loadingStep || "Đang phân tích video"}</span>
                  <span>{isRecordingVideo ? recordingProgress : (isPreGenerating || isFinalizingVoiceover) ? preGenerateProgress : loadingProgress}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white"><div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${isRecordingVideo ? recordingProgress : (isPreGenerating || isFinalizingVoiceover) ? preGenerateProgress : loadingProgress}%` }} /></div>
                <div className="mt-2 flex justify-end gap-2">
                  {pipelineJob?.stage !== "render" && <button type="button" onClick={togglePipelinePause} disabled={pipelineJob?.status === "cancelling"} className="rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-[10px] font-extrabold text-indigo-700 disabled:opacity-50">{pipelineJob?.status === "paused" ? "Tiếp tục" : "Tạm dừng"}</button>}
                  <button type="button" onClick={cancelActivePipeline} disabled={!pipelineJob || pipelineJob.status === "cancelling"} className="rounded-lg bg-rose-600 px-3 py-1.5 text-[10px] font-extrabold text-white disabled:opacity-50">{pipelineJob?.status === "cancelling" ? "Đang hủy..." : "Hủy tác vụ"}</button>
                </div>
              </div>
            )}

            <div className={`grid min-h-0 gap-3 ${isAutoExpertMode ? "lg:grid-cols-[280px_minmax(360px,1fr)_220px] xl:grid-cols-[300px_minmax(420px,1fr)_240px]" : "lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)] [&>aside:last-child]:hidden"}`}>
              <aside className="max-h-[650px] space-y-3 overflow-y-auto rounded-xl border border-slate-200/60 bg-slate-50 p-3">
                <fieldset className="rounded-xl border border-slate-200/60 bg-white p-3 shadow-sm"><legend className="px-1 text-xs font-extrabold text-slate-800">1. File Video</legend>
                  <button onClick={() => autoDubbingFileInputRef.current?.click()} className="flex h-20 w-full flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-xs text-slate-500 transition-colors hover:border-indigo-400 hover:text-indigo-600"><Upload className="mb-1 h-4 w-4" />{videoName || "Kéo thả hoặc chọn video"}</button>
                  <p className="mt-2 text-[10px] text-slate-500">{videoSrc ? "Video đã sẵn sàng" : "Chưa có video"}</p>
                </fieldset>
                <fieldset className="rounded-xl border border-slate-200/60 bg-white p-3 shadow-sm"><legend className="px-1 text-xs font-extrabold text-slate-800">2. Phụ đề</legend>
                  <label className="mb-2 flex items-center gap-2 text-xs"><input type="radio" checked={extractionMethod === "audio"} onChange={() => setExtractionMethod("audio")} /> Nhận dạng từ Audio (STT)</label>
                  <label className="mb-2 flex items-center gap-2 text-xs"><input type="radio" checked={extractionMethod === "localocr" || extractionMethod === "ocr"} onChange={() => { setExtractionMethod("localocr"); setWorkspacePropertyTarget("ocr"); }} /> PaddleOCR Python</label>
                  <label className="flex items-center gap-2 text-xs"><input type="radio" checked={extractionMethod === "aiocr"} onChange={() => setExtractionMethod("aiocr")} /> AI Vision OCR</label>
                  {isAutoExpertMode && <div className="mt-3 grid grid-cols-[1fr_58px] gap-2"><select value={subSettings.fontFamily} onChange={(e) => setSubSettings(prev => ({ ...prev, fontFamily: e.target.value }))} className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-800"><option>Bangers</option><option>Arial</option><option>Inter</option></select><input type="number" value={subSettings.fontSize} onChange={(e) => setSubSettings(prev => ({ ...prev, fontSize: Number(e.target.value) || 24 }))} className="rounded border border-slate-200 bg-slate-50 px-2 text-xs text-slate-800" /></div>}
                </fieldset>
                <TranslationConfigPanel glossary={translationGlossary} setGlossary={setTranslationGlossary} style={translationStyle} setStyle={setTranslationStyle} compact />
                <fieldset className="rounded-xl border border-slate-200/60 bg-white p-3 shadow-sm"><legend className="px-1 text-xs font-extrabold text-slate-800">3. Smart Blur</legend>
                  <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={blurSettings.enabled} onChange={(e) => setBlurSettings(prev => ({ ...prev, enabled: e.target.checked }))} className="accent-sky-500" /> Bật phát hiện/blur phụ đề gốc</label>
                  <button onClick={handleAddBlurBox} className="mt-2 w-full rounded bg-slate-100 py-1.5 text-[11px] font-bold text-slate-700 hover:bg-slate-200">+ Thêm Blur Box</button>
                </fieldset>
                <fieldset className="rounded-xl border border-slate-200/60 bg-white p-3 shadow-sm"><legend className="px-1 text-xs font-extrabold text-slate-800">4. Thuyết minh</legend>
                  <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={ttsEnabled} onChange={(e) => setTtsEnabled(e.target.checked)} className="accent-sky-500" /> Tạo TTS tự động</label>
                  {isAutoExpertMode && <><div className="mt-2 grid grid-cols-2 gap-2"><select value={ttsEngine} onChange={(e) => setTtsEngine(e.target.value as any)} className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-800"><option value="vieneu">VieNeu TTS</option><option value="tiktok">TikTok</option><option value="browser">Edge TTS</option></select><input type="number" min="1.2" max="1.3" step="0.05" value={ttsRate} onChange={(e) => setTtsRate(Math.max(SMART_TTS_MIN_RATE, Math.min(SMART_TTS_MAX_RATE, Number(e.target.value))))} className="rounded border border-slate-200 bg-slate-50 px-2 text-xs text-slate-800" /></div><label className="mt-3 flex items-center justify-between gap-2 text-[11px] text-slate-400">Âm lượng video gốc <span className="font-mono text-sky-400">{Math.round(originalAudioMixVolume * 100)}%</span></label><input type="range" min="0" max="1" step="0.05" value={originalAudioMixVolume} onChange={(e) => setOriginalAudioMixVolume(Number(e.target.value))} className="mt-1 w-full accent-sky-500" /></>}
                </fieldset>
                {!isAutoExpertMode ? <button type="button" onClick={() => { setIsAutoExpertMode(true); setIsAutoAdvancedOpen(true); }} className="flex w-full items-center justify-between rounded-xl border border-dashed border-indigo-200 bg-indigo-50/50 px-3 py-2.5 text-xs font-extrabold text-indigo-600 hover:bg-indigo-50"><span>Cần chỉnh kỹ hơn?</span><span>Mở nâng cao →</span></button> : <button type="button" onClick={() => setIsAutoAdvancedOpen((value) => !value)} className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-extrabold text-slate-600 shadow-sm hover:border-indigo-300 hover:text-indigo-600" aria-expanded={isAutoAdvancedOpen}><span>Cài đặt video & watermark</span><ChevronDown className={`h-4 w-4 transition-transform ${isAutoAdvancedOpen ? "rotate-180" : ""}`} /></button>}
                {isAutoExpertMode && isAutoAdvancedOpen && <>
                <fieldset className="rounded-xl border border-slate-200/60 bg-white p-3 shadow-sm"><legend className="px-1 text-xs font-extrabold text-slate-800">5. Cài đặt Video</legend><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={flipHorizontal} onChange={(e) => setFlipHorizontal(e.target.checked)} /> Lật ngang (gương)</label><label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={flipVertical} onChange={(e) => setFlipVertical(e.target.checked)} /> Lật dọc (đảo ngược)</label></fieldset>
                <fieldset className="rounded-xl border border-slate-200/60 bg-white p-3 shadow-sm">
                  <legend className="px-1 text-xs font-extrabold text-slate-800">6. Lọc Watermark</legend>
                  <p className="mb-2 text-[10px] text-slate-400">Seek video tới frame có watermark rồi bấm quét. Chọn chữ nào là watermark để thêm vùng lọc.</p>
                  <button
                    onClick={scanCurrentFrameForWatermarks}
                    disabled={isScanningWatermark || !videoSrc}
                    className="mb-2 w-full rounded border border-amber-300 bg-amber-50 py-1.5 text-[11px] font-bold text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                  >{isScanningWatermark ? "Đang quét..." : "Quét OCR frame hiện tại"}</button>
                  {watermarkScanDetections.length > 0 && (
                    <div className="mb-2">
                      <p className="mb-1 text-[10px] font-bold text-slate-500">Chữ phát hiện — bấm để thêm làm watermark:</p>
                      <div className="space-y-1">
                        {watermarkScanDetections.map((detection, index) => (
                          <button key={`${detection.text}-${index}`} type="button" onClick={() => addWatermarkFromDetection(detection)} className="flex w-full items-center justify-between gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-left text-[10px] text-amber-800 hover:bg-amber-100">
                            <span className="truncate font-mono">{detection.text}</span>
                            <span className="shrink-0 text-amber-500">{Math.round((detection.confidence || 0) * 100)}% +</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {watermarkRegions.length > 0 ? (
                    <div className="mb-2 space-y-1">
                      <p className="text-[10px] font-bold text-slate-500">Vùng đã đánh dấu:</p>
                      {watermarkRegions.map((region, index) => (
                        <div key={region.id} className={`flex items-center justify-between rounded-lg border px-2 py-1 text-[10px] ${activeWatermarkRegionId === region.id ? "border-rose-400 bg-rose-50 text-rose-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}>
                          <button type="button" onClick={() => setActiveWatermarkRegionId(region.id)} className="min-w-0 truncate text-left font-bold">WM {index + 1}: {region.label}</button>
                          <button type="button" onClick={() => { setWatermarkRegions((regions) => regions.filter((item) => item.id !== region.id)); if (activeWatermarkRegionId === region.id) setActiveWatermarkRegionId(null); }} className="ml-2 shrink-0 font-bold text-rose-400 hover:text-rose-600">✕</button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[10px] italic text-slate-400">Chưa có vùng watermark nào.</p>
                  )}
                </fieldset>
                </>}
              </aside>

              <div className="flex h-[650px] min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200/60 bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2 border-b border-slate-200/60 px-3 py-2 text-[10px] text-slate-500"><span>Font</span><span className="rounded bg-slate-100 px-3 py-1 text-slate-700 font-bold">{subSettings.fontFamily}</span><span>Cỡ {subSettings.fontSize}px</span><span className="ml-auto rounded bg-emerald-500/10 px-2 py-1 text-emerald-400">{extractionMethod === "ocr" || extractionMethod === "localocr" ? "PaddleOCR Python" : "Engine Connected"}</span></div>
                <div ref={workspacePreviewHostRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-5">
                  <div style={getFittedCanvasStyle(workspacePreviewSize)} className="relative shrink-0 overflow-hidden rounded-lg border border-slate-700 bg-black shadow-2xl">
                    {videoSrc ? <video ref={workspaceVideoRef} src={videoSrc} onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)} onLoadedMetadata={(e) => { setDuration(e.currentTarget.duration); setWorkspaceVideoDimensions({ width: e.currentTarget.videoWidth || 16, height: e.currentTarget.videoHeight || 9 }); }} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} className="h-full w-full object-contain" /> : <div className="flex h-full flex-col items-center justify-center text-slate-600"><Video className="mb-3 h-10 w-10" /><span className="text-sm">Preview video</span></div>}
                    {videoSrc && <div style={getWorkspaceVideoContentStyle()} className="pointer-events-none z-20">{blurBoxes.map((box) => <button key={box.id} onPointerDown={(e) => { if (isDrawingOcrRegion) return; setActiveBlurBoxId(box.id); setWorkspacePropertyTarget("blur"); handleWorkspaceBlurDrag(e, box.id); }} className={`pointer-events-auto absolute border-2 ${activeBlurBoxId === box.id ? "border-indigo-500 bg-indigo-500/15" : "border-slate-100/80 bg-slate-900/15"}`} style={{ left: `${box.xPosition}%`, top: `${box.yPosition}%`, width: `${box.width}%`, height: `${box.height}%`, backdropFilter: `blur(${box.blurAmount}px)` }} title="Kéo để di chuyển Blur Box"><span onPointerDown={(e) => handleWorkspaceBlurDrag(e as any, box.id, true)} className="absolute -bottom-1 -right-1 h-3 w-3 cursor-nwse-resize rounded-sm bg-indigo-500" /></button>)}</div>}
                    {videoSrc && <div style={getWorkspaceVideoContentStyle()} className="pointer-events-none z-40">{ocrRegions.map((region, index) => <button key={region.id} type="button" onPointerDown={(event) => handleWorkspaceOcrRegionDrag(event, region.id)} className={`pointer-events-auto absolute border-2 ${activeOcrRegionId === region.id ? "border-emerald-400 bg-emerald-400/15" : "border-amber-300 bg-amber-300/10"}`} style={{ left: `${region.x}%`, top: `${region.y}%`, width: `${region.width}%`, height: `${region.height}%` }} title={`${region.label}: kéo để di chuyển`}><span className="absolute left-0 top-0 rounded-br bg-emerald-500 px-1 py-0.5 text-[8px] font-bold text-white">OCR {index + 1}</span><span onPointerDown={(event) => handleWorkspaceOcrRegionDrag(event as any, region.id, true)} className="absolute -bottom-1 -right-1 h-3 w-3 cursor-nwse-resize rounded-sm bg-emerald-400" /></button>)}{isDrawingOcrRegion && <div onPointerDown={handleDrawOcrRegion} className="pointer-events-auto absolute inset-0 cursor-crosshair bg-emerald-400/5" title="Kéo để vẽ vùng OCR" />}</div>}
                    {videoSrc && watermarkRegions.length > 0 && <div style={getWorkspaceVideoContentStyle()} className="pointer-events-none z-45">{watermarkRegions.map((region, index) => <button key={region.id} type="button" onPointerDown={(event) => { setActiveWatermarkRegionId(region.id); handleWatermarkRegionDrag(event, region.id); }} className={`pointer-events-auto absolute border-2 border-dashed ${activeWatermarkRegionId === region.id ? "border-rose-500 bg-rose-500/20" : "border-rose-400 bg-rose-400/10"}`} style={{ left: `${region.x}%`, top: `${region.y}%`, width: `${region.width}%`, height: `${region.height}%` }} title={`Watermark ${index + 1}: kéo để di chuyển`}><span className="absolute left-0 top-0 rounded-br bg-rose-500 px-1 py-0.5 text-[8px] font-bold text-white">WM {index + 1}</span><span onPointerDown={(event) => { event.stopPropagation(); handleWatermarkRegionDrag(event as any, region.id, true); }} className="absolute -bottom-1 -right-1 h-3 w-3 cursor-nwse-resize rounded-sm bg-rose-500" /></button>)}</div>}
                    {videoSrc && <div onPointerDown={(e) => { if (isDrawingOcrRegion) return; setWorkspacePropertyTarget("subtitle"); handleWorkspaceSubtitleDrag(e); }} className={`absolute z-30 text-center ${isDrawingOcrRegion ? "pointer-events-none" : "cursor-move"}`} style={getSubtitlePositionStyle()}><span className="relative inline-block text-center" style={getSubtitlePreviewTextStyle(workspacePreviewSize)}>{currentSubtitle?.translated || "Phụ đề sẽ xuất hiện ở đây!"}<span onPointerDown={(e) => { e.stopPropagation(); handleWorkspaceSubtitleDrag(e as any, true); }} className="absolute -bottom-1 -right-1 h-3 w-3 cursor-nwse-resize rounded-sm bg-indigo-500" /></span></div>}
                  </div>
                </div>
                {/* Playback controls */}
                <div className="flex flex-col gap-2 border-t border-slate-200/60 bg-white px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono font-bold text-slate-500 w-12 text-right">{formatTtsTime(currentTime)}</span>
                    <input
                      type="range"
                      min={0}
                      max={duration || 100}
                      step={0.05}
                      value={currentTime}
                      onChange={handleScrub}
                      className="flex-1 accent-indigo-600 bg-slate-200 h-1 rounded-lg appearance-none cursor-pointer"
                    />
                    <span className="text-xs font-mono font-bold text-slate-500 w-12">{formatTtsTime(duration)}</span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={togglePlay}
                        disabled={!videoSrc}
                        className="p-2.5 rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                        title={isPlaying ? "Tạm dừng" : "Phát"}
                      >
                        {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                      </button>
                      <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-100 p-0.5">
                        {[0.75, 1.0, 1.25, 1.5].map((rate) => (
                          <button
                            key={rate}
                            onClick={() => handlePlaybackRateChange(rate)}
                            className={`px-2 py-1 text-[11px] font-bold rounded-md transition-all ${playbackRate === rate ? "bg-indigo-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
                          >
                            {rate}x
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setShowSubtitles(prev => !prev)}
                        className={`p-1.5 rounded-lg border transition-all ${showSubtitles ? "bg-indigo-50 border-indigo-200 text-indigo-600" : "bg-slate-100 border-slate-200 text-slate-400"}`}
                        title={showSubtitles ? "Tắt hiển thị phụ đề" : "Bật hiển thị phụ đề"}
                      >
                        {showSubtitles ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                      </button>
                      <div className="flex items-center gap-2 bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200">
                        <Volume2 className="w-4 h-4 text-slate-500" />
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={volume}
                          onChange={handleVolumeChange}
                          className="w-16 accent-indigo-600 bg-slate-200 h-1 rounded appearance-none cursor-pointer"
                        />
                      </div>
                    </div>
                  </div>
                </div>
                <div className="relative border-t border-slate-200/60 bg-slate-50 p-3" style={{ height: timelineHeight }}><div onPointerDown={handleTimelineResizeStart} className="absolute -top-1.5 left-0 right-0 z-30 flex h-3 cursor-row-resize items-center justify-center touch-none"><span className="h-1 w-12 rounded-full bg-slate-300 transition-colors hover:bg-indigo-500" /></div><div className="mb-2 flex items-center justify-between text-[10px] text-slate-500"><span>{currentTime.toFixed(2)} / {Math.round(duration)}s</span><span>Kéo mép trên để đổi kích thước timeline</span></div><div className="relative h-[calc(100%-28px)] space-y-1 overflow-auto rounded border border-slate-200 bg-white p-1"><div className="absolute left-14 top-0 z-20 h-full w-px bg-rose-500" style={{ left: `calc(3.5rem + ${duration ? (currentTime / duration) * 100 : 0}% * (1 - 3.5rem / 100%))` }} />{([{ label: "Video", color: "bg-emerald-500", clips: videoSrc && duration ? [{ id: "video", start: 0, end: duration, text: videoName }] : [] }, { label: "Text", color: "bg-sky-500", clips: subtitles.map(sub => ({ id: sub.id, start: sub.start, end: sub.end, text: sub.translated })) }, { label: "Hiệu ứng", color: "bg-amber-400", clips: blurBoxes.length && duration ? blurBoxes.map(box => ({ id: box.id, start: 0, end: duration, text: "Blur Box" })) : [] }, { label: "Voice", color: "bg-violet-500", clips: ttsEnabled ? subtitles.map(sub => ({ id: `voice-${sub.id}`, start: sub.start, end: sub.end, text: sub.translated })) : [] }]).map(track => <div key={track.label} className="relative flex h-8 items-center gap-2 border-b border-slate-100 last:border-0"><span className="w-12 pl-1 text-[9px] font-bold text-slate-400">{track.label}</span><div onClick={(e) => { if (!duration) return; const rect = e.currentTarget.getBoundingClientRect(); const time = Math.max(0, Math.min(duration, ((e.clientX - rect.left) / rect.width) * duration)); setCurrentTime(time); if (workspaceVideoRef.current) workspaceVideoRef.current.currentTime = time; }} className="relative h-6 flex-1 cursor-pointer rounded bg-slate-100">{track.clips.map(clip => <button key={clip.id} title={clip.text} onClick={() => { setCurrentTime(clip.start); if (workspaceVideoRef.current) workspaceVideoRef.current.currentTime = clip.start; }} className={`absolute top-0 h-full overflow-hidden rounded px-1 text-left text-[9px] font-bold text-white ${track.color}`} style={{ left: `${duration ? (clip.start / duration) * 100 : 0}%`, width: `${duration ? Math.max(1, ((clip.end - clip.start) / duration) * 100) : 0}%` }}>{clip.text}</button>)}</div></div>)}</div></div>
              </div>

              <aside className="overflow-y-auto border-t border-slate-200/60 bg-slate-50 p-4 xl:border-l xl:border-t-0"><div className="border-b border-slate-200/60 pb-3 text-xs font-extrabold text-slate-800">Thuộc tính</div><div className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-slate-200 p-1"><button onClick={() => setWorkspacePropertyTarget("subtitle")} className={`rounded px-1 py-1.5 text-[10px] font-bold transition-colors ${workspacePropertyTarget === "subtitle" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500"}`}>Phụ đề</button><button onClick={() => setWorkspacePropertyTarget("blur")} className={`rounded px-1 py-1.5 text-[10px] font-bold transition-colors ${workspacePropertyTarget === "blur" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500"}`}>Blur Box</button><button onClick={() => setWorkspacePropertyTarget("ocr")} className={`rounded px-1 py-1.5 text-[10px] font-bold transition-colors ${workspacePropertyTarget === "ocr" ? "bg-white text-emerald-600 shadow-sm" : "text-slate-500"}`}>Vùng OCR</button></div>{renderWorkspaceProperties()}</aside>
            </div>

            {false && videoSrc && (
              <section className="mt-5 border-t border-slate-200 pt-5" aria-labelledby="auto-export-title">
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600"><Download className="h-4 w-4" /></div>
                    <div>
                      <h3 id="auto-export-title" className="text-sm font-extrabold text-slate-800">Trung tâm xuất bản & tải về</h3>
                      <p className="text-[11px] font-medium text-slate-500">Tải tài nguyên hoặc xuất video hoàn chỉnh ngay tại cuối quy trình Auto.</p>
                    </div>
                  </div>
                  <span className={`w-fit rounded-full px-2.5 py-1 text-[10px] font-extrabold ${isRecordingVideo ? "bg-indigo-50 text-indigo-600" : exportedVideoUrl ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"}`}>
                    {isRecordingVideo ? `Đang xuất ${recordingProgress}%` : exportedVideoUrl ? "Đã xuất xong" : "Sẵn sàng xuất"}
                  </span>
                </div>

                <div className="grid gap-4 xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,2.2fr)]">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                    <button onClick={exportSRT} disabled={subtitles.length === 0} className="group flex min-h-20 items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-left transition-all hover:border-amber-300 hover:bg-amber-50/40 disabled:cursor-not-allowed disabled:opacity-50">
                      <span className="rounded-lg bg-amber-100 p-2 text-amber-600"><FileText className="h-4 w-4" /></span>
                      <span className="min-w-0 flex-1"><b className="block text-xs text-slate-700">Tải phụ đề .SRT</b><small className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">Dùng cho CapCut, Premiere hoặc lưu trữ.</small></span>
                      <Download className="h-4 w-4 text-slate-400 group-hover:text-amber-600" />
                    </button>
                    <button onClick={downloadMergedVoiceover} disabled={isMergingAudio || subtitles.length === 0} className="group flex min-h-20 items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-left transition-all hover:border-sky-300 hover:bg-sky-50/40 disabled:cursor-not-allowed disabled:opacity-50">
                      <span className="rounded-lg bg-sky-100 p-2 text-sky-600"><Volume2 className="h-4 w-4" /></span>
                      <span className="min-w-0 flex-1"><b className="block text-xs text-slate-700">{isMergingAudio ? "Đang ghép âm thanh..." : "Tải thuyết minh .WAV"}</b><small className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">Track giọng đọc đã căn theo timeline.</small></span>
                      {isMergingAudio ? <RefreshCw className="h-4 w-4 animate-spin text-sky-600" /> : <Download className="h-4 w-4 text-slate-400 group-hover:text-sky-600" />}
                    </button>
                  </div>

                  <div className="rounded-xl border border-indigo-100 bg-indigo-50/30 p-4">
                    <div className="mb-3 flex items-center gap-2"><Video className="h-4 w-4 text-indigo-600" /><b className="text-xs text-slate-800">Video Final</b></div>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <label className="flex flex-col gap-1 text-[10px] font-bold uppercase text-slate-500">Độ phân giải<select value={exportResolution} onChange={(e) => setExportResolution(e.target.value as "720" | "1080" | "1440")} disabled={isRecordingVideo} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs font-bold normal-case text-slate-700 outline-none focus:border-indigo-500"><option value="720">720p (nhanh)</option><option value="1080">1080p</option><option value="1440">2K / 1440p</option></select></label>
                      <label className="flex flex-col gap-1 text-[10px] font-bold uppercase text-slate-500">Tỷ lệ khung<select value={exportAspectRatio} onChange={(e) => setExportAspectRatio(e.target.value as typeof exportAspectRatio)} disabled={isRecordingVideo} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs font-bold normal-case text-slate-700 outline-none focus:border-indigo-500"><option value="original">Theo video gốc</option><option value="16:9">16:9 — Ngang</option><option value="9:16">9:16 — Dọc</option><option value="1:1">1:1 — Vuông</option><option value="4:3">4:3 — Ngang</option><option value="3:4">3:4 — Dọc</option></select></label>
                      <label className="flex flex-col gap-1 text-[10px] font-bold uppercase text-slate-500">Tên video<div className="flex h-9 items-center rounded-lg border border-slate-200 bg-white px-2 focus-within:border-indigo-500"><input value={outputVideoName} onChange={(event) => setOutputVideoName(event.target.value)} onBlur={() => setOutputVideoName(getOutputVideoFilename().replace(/\.mp4$/i, ""))} placeholder="Nhập tên video" disabled={isRecordingVideo} className="min-w-0 flex-1 bg-transparent text-xs font-medium normal-case text-slate-700 outline-none" /><span className="text-[10px] font-mono normal-case text-slate-400">.mp4</span></div></label>
                      <div className="flex flex-col gap-1 text-[10px] font-bold uppercase text-slate-500"><span>Thư mục xuất</span><button type="button" onClick={async () => { const folder = await window.electronAPI?.selectOutputFolder(); if (folder) setOutputFolder(folder); }} disabled={!isElectron || isRecordingVideo} title={outputFolder || "Chưa chọn thư mục"} className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 text-left text-xs font-bold normal-case text-slate-700 hover:border-indigo-400 disabled:opacity-50"><FolderOpen className="h-3.5 w-3.5 shrink-0 text-indigo-500" /><span className="truncate">{outputFolder || "Chọn thư mục"}</span></button></div>
                    </div>

                    {isRecordingVideo ? (
                      <div className="mt-4 rounded-xl border border-indigo-200 bg-white p-3">
                        <div className="mb-2 flex items-center justify-between text-[11px] font-bold text-indigo-600"><span>Đang mã hóa video...</span><span>{recordingProgress}%</span></div>
                        <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-600 transition-all duration-300" style={{ width: `${recordingProgress}%` }} /></div>
                        <button onClick={startBrowserRecording} className="mt-2 text-[10px] font-bold text-rose-500 hover:text-rose-600">Hủy xuất video</button>
                      </div>
                    ) : (
                      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
                        {exportedVideoUrl && <button type="button" onClick={async () => { const res = await fetch(exportedVideoUrl); const blob = await res.blob(); await saveVideoBlob(blob, getOutputVideoFilename()); }} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-5 text-xs font-extrabold text-emerald-700 hover:bg-emerald-100"><Download className="h-4 w-4" />Lưu video đã xuất</button>}
                        <button onClick={startBrowserRecording} disabled={subtitles.length === 0} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 text-xs font-extrabold text-white shadow-md shadow-indigo-600/20 hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"><Play className="h-4 w-4 fill-white" />Xuất Video Final</button>
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
                  <button type="button" onClick={() => setIsAutoLogExpanded((value) => !value)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50" aria-expanded={isAutoLogExpanded}>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${isRecordingVideo || isLoading || isPreGenerating ? "animate-pulse bg-indigo-500" : errorMsg ? "bg-rose-500" : "bg-emerald-500"}`} />
                    <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-slate-600">{activityLogs.at(-1) || "Sẵn sàng xử lý dự án."}</span>
                    <span className="text-[10px] font-bold text-slate-400">{activityLogs.length} logs</span>
                    <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${isAutoLogExpanded ? "rotate-180" : ""}`} />
                  </button>
                  {isAutoLogExpanded && (
                    <div className="border-t border-slate-200 p-3">
                      <div className="mb-2 flex justify-end gap-2">
                        <button type="button" onClick={() => void navigator.clipboard?.writeText(activityLogs.join("\n"))} disabled={activityLogs.length === 0} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-200 disabled:opacity-50"><Copy className="h-3 w-3" />Sao chép</button>
                        <button type="button" onClick={() => setActivityLogs([])} disabled={activityLogs.length === 0} className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2 py-1 text-[10px] font-bold text-rose-600 hover:bg-rose-100 disabled:opacity-50"><Trash2 className="h-3 w-3" />Xóa log</button>
                      </div>
                      <div className="max-h-44 overflow-y-auto rounded-lg bg-slate-950 p-3 font-mono text-[10px] text-emerald-400">
                        {activityLogs.length === 0 ? <span className="italic text-slate-500">Chưa có hoạt động nào được ghi nhận.</span> : activityLogs.slice(-10).map((log, idx) => <div key={`${idx}-${log}`} className={`border-b border-slate-800 py-1 last:border-0 ${/lỗi|error|failed/i.test(log) ? "text-rose-400" : /xong|hoàn tất|đã /i.test(log) ? "text-emerald-400" : "text-sky-300"}`}>{log}</div>)}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}
          </motion.section>

          </AutoDubbingLayout>
        )}
        
        {/* LEFT COLUMN: Player & Censor Controller (7 Cols) */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className={`${activeTab === "dubbin" || activeTab === "script-shorts" || activeTab === "editor" || activeTab === "projects" || activeTab === "extract" || activeTab === "export" ? "hidden" : "lg:col-span-7 flex flex-col gap-6"}`}
          id="player-column"
        >
          
          {/* Main Video View Container */}
          <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-md flex flex-col gap-4 overflow-hidden">
            
            {/* These secondary tabs only preview the active project video. */}
            {!videoSrc ? (
              <div className="flex aspect-video flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-950 px-6 text-center">
                <div className="mb-4 rounded-2xl bg-white/10 p-4 text-slate-400">
                  <Video className="h-10 w-10" />
                </div>
                <h3 className="text-base font-extrabold text-white">Chưa có video để xem trước</h3>
                <p className="mt-1 max-w-sm text-xs text-slate-400">Video chỉ được tải lên trong Tool Auto Dubbing.</p>
                <button onClick={() => setActiveTab("dubbin")} className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-extrabold text-white hover:bg-indigo-500">Về Tool Auto Dubbing</button>
              </div>
            ) : (
              /* Actual Video Work Surface */
              <div className="flex flex-col gap-4">
                
                {/* Title and Metadata */}
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-2 text-slate-700">
                    <Video className="w-4 h-4 text-[#4f46e5]" />
                    <span className="text-sm font-bold truncate max-w-xs">{videoName}</span>
                  </div>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-500">Chỉ xem trước</span>
                </div>

                {isExtractingAudio && (
                  <div className="bg-[#4f46e5]/10 border border-[#4f46e5]/20 rounded-xl p-3 flex items-center justify-between gap-3 text-xs text-[#4f46e5] font-semibold animate-pulse shadow-sm">
                    <div className="flex items-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-[#4f46e5]" />
                      <span>{extractingProgressStep || "Đang trích xuất dữ liệu âm thanh từ video..."}</span>
                    </div>
                    <span className="text-[10px] bg-[#4f46e5]/20 text-[#4f46e5] px-2 py-0.5 rounded-full uppercase tracking-wider font-extrabold animate-pulse">
                      Xử lý nền
                    </span>
                  </div>
                )}

                {/* Simulated Player Box with overlays */}
                <div ref={secondaryPreviewHostRef} className="flex min-h-[360px] w-full items-center justify-center overflow-hidden rounded-xl bg-slate-950 p-3">
                <div 
                  className="relative flex max-h-[620px] items-center justify-center overflow-hidden rounded-xl border border-black/15 bg-black shadow-xl group"
                  style={getFittedCanvasStyle(secondaryPreviewSize)}
                  id="video-container"
                >
                  <video
                    ref={videoRef}
                    src={videoSrc}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                    onClick={togglePlay}
                    className="w-full h-full object-contain transition-transform duration-300"
                    style={{ transform: `scaleX(${flipHorizontal ? -1 : 1}) scaleY(${flipVertical ? -1 : 1})` }}
                  />

                  {/* ACTIVE CENSOR BLUR OVERLAYS */}
                  {blurBoxes.map((box, index) => {
                    const isActive = box.id === activeBlurBoxId;
                    return (
                      <div 
                        key={box.id}
                        className={`absolute flex items-center justify-center cursor-move transition-all ${
                          isActive 
                            ? "ring-2 ring-[#4f46e5] z-20 shadow-xl" 
                            : "hover:ring-1 hover:ring-slate-300/60 z-10"
                        }`}
                        style={{
                          left: `${box.xPosition}%`,
                          top: `${box.yPosition}%`,
                          width: `${box.width}%`,
                          height: `${box.height}%`,
                          backdropFilter: `blur(${box.blurAmount}px)`,
                          backgroundColor: getBlurCoverCssColor(box.bgColor, box.opacity),
                          borderRadius: "6px",
                          boxShadow: "0 4px 30px rgba(0, 0, 0, 0.15)",
                          userSelect: "none",
                          touchAction: "none",
                        }}
                        onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'move')}
                        id={`blur-overlay-block-${box.id}`}
                      >
                        {/* Box label and delete button when selected */}
                        <div className="absolute top-1 left-1.5 pointer-events-none bg-slate-900/85 text-white text-[9px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1 shadow">
                          <span>Hộp mờ #{index + 1}</span>
                        </div>

                        {/* Drag and resize indicator */}
                        {isActive && isAdjustingCensor && (
                          <span className="text-[8px] text-[#F17B77] font-mono font-bold uppercase bg-[#010101]/80 px-1.5 py-0.5 rounded border border-[#F17B77]/20 pointer-events-none">
                            X:{box.xPosition}% Y:{box.yPosition}%
                          </span>
                        )}

                        {/* Resize Anchors (Only show for the active/selected box) */}
                        {isActive && (
                          <>
                            {/* Top-Left */}
                            <div 
                              className="absolute -top-1 -left-1 w-2.5 h-2.5 bg-white border-2 border-[#4f46e5] rounded-full cursor-nwse-resize z-30 shadow"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-nw')}
                            />
                            {/* Top-Right */}
                            <div 
                              className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-white border-2 border-[#4f46e5] rounded-full cursor-nesw-resize z-30 shadow"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-ne')}
                            />
                            {/* Bottom-Left */}
                            <div 
                              className="absolute -bottom-1 -left-1 w-2.5 h-2.5 bg-white border-2 border-[#4f46e5] rounded-full cursor-nesw-resize z-30 shadow"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-sw')}
                            />
                            {/* Bottom-Right */}
                            <div 
                              className="absolute -bottom-1 -right-1 w-2.5 h-2.5 bg-white border-2 border-[#4f46e5] rounded-full cursor-nwse-resize z-30 shadow"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-se')}
                            />
                            {/* Edge Drag handles */}
                            <div 
                              className="absolute top-0 left-2 right-2 h-1 cursor-ns-resize z-30"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-n')}
                            />
                            <div 
                              className="absolute bottom-0 left-2 right-2 h-1 cursor-ns-resize z-30"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-s')}
                            />
                            <div 
                              className="absolute top-2 bottom-2 right-0 w-1 cursor-ew-resize z-30"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-e')}
                            />
                            <div 
                              className="absolute top-2 bottom-2 left-0 w-1 cursor-ew-resize z-30"
                              onPointerDown={(e) => handleBoxPointerDown(e, box.id, 'resize-w')}
                            />
                          </>
                        )}
                      </div>
                    );
                  })}

                  {/* SUBTITLE OVERLAY */}
                  {showSubtitles && currentSubtitle && (
                    <div 
                      className="absolute text-center transition-all z-40 select-none pointer-events-none max-w-full px-4"
                      style={{
                        ...getSubtitlePositionStyle()
                      }}
                      id="active-subtitle-rendered"
                    >
                      <span 
                        onPointerDown={handleSubtitlePointerDown}
                        className="inline-block text-center transition-all pointer-events-auto cursor-move active:scale-[0.98] hover:ring-2 hover:ring-[#4f46e5]/40 relative group"
                        title="Kéo thả phụ đề để di chuyển vị trí bất kỳ"
                        style={getSubtitlePreviewTextStyle(secondaryPreviewSize)}
                      >
                        {currentSubtitle.translated}
                      </span>
                    </div>
                  )}
                  
                  {/* Ambient Big Pause/Play overlay on center */}
                  <AnimatePresence>
                    {!isPlaying && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        className="absolute inset-0 bg-black/30 flex items-center justify-center pointer-events-none"
                      >
                        <div className="p-4 bg-white/5 backdrop-blur-md border border-white/10 rounded-full text-[#6366f1] shadow-xl">
                          <Play className="w-8 h-8 fill-current translate-x-0.5" />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                </div>

                {/* Subtitle Scrubber & Playback Controls bar */}
                <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl flex flex-col gap-3 shadow-sm">
                  
                  {/* Scrubber Timeline Slider */}
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-slate-500 font-bold w-12 text-right">
                      {formatSecondsToVTT(currentTime).substring(3, 11)}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={duration || 100}
                      step={0.05}
                      value={currentTime}
                      onChange={handleScrub}
                      className="flex-1 accent-[#6366f1] bg-slate-200 h-1 rounded-lg appearance-none cursor-pointer"
                    />
                    <span className="text-xs font-mono text-slate-500 font-bold w-12">
                      {formatSecondsToVTT(duration).substring(3, 11)}
                    </span>
                  </div>

                  {/* Main Control Panel Actions */}
                  <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={togglePlay}
                        className="p-2.5 bg-gradient-to-r from-[#4f46e5] to-[#6366f1] hover:opacity-90 rounded-lg text-white font-bold shadow-lg shadow-[#4f46e5]/15 transition-all"
                        title={isPlaying ? "Tạm dừng" : "Phát"}
                      >
                        {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                      </button>

                      {/* Playback speed buttons */}
                      <div className="flex items-center bg-slate-200/60 rounded-lg p-0.5 border border-slate-200/40 ml-2">
                        {[0.75, 1.0, 1.25, 1.5].map((rate) => (
                          <button
                            key={rate}
                            onClick={() => handlePlaybackRateChange(rate)}
                            className={`px-2 py-1 text-[11px] font-bold rounded-md transition-all ${
                              playbackRate === rate 
                                ? "bg-[#4f46e5] text-white shadow" 
                                : "text-slate-500 hover:text-slate-800"
                            }`}
                          >
                            {rate}x
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Quick Settings: Subtitle Font Size & Volume Side-by-Side */}
                    <div className="flex flex-wrap items-center gap-3">
                      {/* Toggle Subtitles Button */}
                      <button
                        onClick={() => setShowSubtitles(prev => !prev)}
                        className={`p-1.5 rounded-lg border transition-all flex items-center justify-center shadow-sm ${
                          showSubtitles 
                            ? "bg-[#4f46e5]/10 border-[#4f46e5]/30 text-[#4f46e5]" 
                            : "bg-slate-100 border-slate-200 text-slate-400"
                        }`}
                        title={showSubtitles ? "Tắt hiển thị phụ đề" : "Bật hiển thị phụ đề"}
                      >
                        {showSubtitles ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                      </button>

                      {/* Subtitle Font Size Quick Slider */}
                      <div className="flex items-center gap-2 bg-[#4f46e5]/5 px-3 py-1.5 rounded-lg border border-[#4f46e5]/20 shadow-sm" title="Điều chỉnh kích thước chữ phụ đề nhanh">
                        <Type className="w-3.5 h-3.5 text-[#4f46e5]" />
                        <span className="text-[10px] font-extrabold text-slate-600 uppercase">Cỡ chữ Sub:</span>
                        <input
                          type="range"
                          min={12}
                          max={60}
                          step={1}
                          value={subSettings.fontSize}
                          onChange={(e) => setSubSettings(prev => ({ ...prev, fontSize: parseInt(e.target.value) || 12 }))}
                          className="w-20 accent-[#6366f1] bg-slate-200 h-1.5 rounded-lg appearance-none cursor-pointer"
                        />
                        <span className="text-xs font-mono font-bold text-[#4f46e5] w-7 text-center">{subSettings.fontSize}px</span>
                      </div>

                      {/* Volume setting */}
                      <div className="flex items-center gap-2 bg-slate-200/60 px-3 py-1.5 rounded-lg border border-slate-200/40">
                        <Volume2 className="w-4 h-4 text-slate-500" />
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={volume}
                          onChange={handleVolumeChange}
                          className="w-16 accent-[#6366f1] bg-slate-200 h-1 rounded appearance-none cursor-pointer"
                        />
                      </div>
                    </div>
                  </div>
                </div>

              </div>
            )}
          </div>

          {/* Interactive Censor Customizer Panel (Only visible if video is loaded) */}
          {videoSrc && activeTab === "style" && (
            <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-md flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2.5">
                  <Sliders className="w-4 h-4 text-[#4f46e5]" />
                  <h3 className="font-bold text-slate-800">Quản Lý Các Hộp Làm Mờ</h3>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 font-bold">Kích hoạt:</span>
                  <button
                    onClick={() => setBlurSettings(prev => ({ ...prev, enabled: !prev.enabled }))}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      blurSettings.enabled ? "bg-[#4f46e5]" : "bg-slate-200"
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        blurSettings.enabled ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              </div>

              {blurSettings.enabled ? (
                <div className="flex flex-col gap-4">
                  {/* Blur Boxes List & Add Button */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-600">Danh sách hộp mờ ({blurBoxes.length})</span>
                      <button
                        onClick={handleAddBlurBox}
                        className="px-2.5 py-1 text-[11px] font-bold bg-[#4f46e5] hover:bg-[#34533e] text-white rounded-lg transition-all flex items-center gap-1 shadow-sm"
                      >
                        <Plus className="w-3 h-3" />
                        Thêm hộp mới
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-2 max-h-36 overflow-y-auto p-1 bg-slate-50 border border-slate-100 rounded-xl">
                      {blurBoxes.map((box, index) => {
                        const isSelected = box.id === activeBlurBoxId;
                        return (
                          <div
                            key={box.id}
                            onClick={() => setActiveBlurBoxId(box.id)}
                            className={`px-3 py-1.5 rounded-lg border text-xs font-bold flex items-center gap-2 cursor-pointer transition-all ${
                              isSelected
                                ? "bg-[#4f46e5] text-white border-[#4f46e5] shadow-sm"
                                : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                            }`}
                          >
                            <span>Hộp mờ #{index + 1}</span>
                            {blurBoxes.length > 1 && (
                              <button
                                onClick={(e) => handleRemoveBlurBox(box.id, e)}
                                className={`p-0.5 rounded transition-all ${
                                  isSelected 
                                    ? "text-white/80 hover:text-white hover:bg-white/15" 
                                    : "text-slate-400 hover:text-red-500 hover:bg-slate-100"
                                }`}
                                title="Xóa hộp mờ này"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Selected Box customizers */}
                  {(() => {
                    const selectedBox = blurBoxes.find(b => b.id === activeBlurBoxId) || blurBoxes[0];
                    if (!selectedBox) return null;

                    const updateSelectedBox = (updater: (prev: BlurBox) => BlurBox) => {
                      setBlurBoxes(prev => prev.map(b => b.id === selectedBox.id ? updater(b) : b));
                    };

                    return (
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 border-t border-slate-100 pt-4">
                        
                        {/* Tip direct drag resize */}
                        <div className="xl:col-span-2 py-2 px-3.5 bg-[#4f46e5]/5 border border-[#4f46e5]/10 rounded-xl text-xs text-[#4f46e5] flex items-start gap-2 shadow-sm">
                          <Info className="w-4 h-4 shrink-0 mt-0.5" />
                          <p className="leading-relaxed font-semibold">
                            Hộp mờ đã chuyển sang chế độ tự do: Nhấp giữ và di chuyển chuột/chạm trực tiếp trên video để Kéo thả & Co giãn kích thước linh hoạt!
                          </p>
                        </div>

                        {/* COLUMN 1: TỌA ĐỘ VÀ KIỂU CHE CHẮN */}
                        <div className="flex flex-col gap-4">
                          {/* Coordinate readouts */}
                          <div className="bg-slate-50 border border-slate-150 rounded-xl p-3.5 flex flex-col gap-2 shadow-sm">
                            <span className="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider">Thông số tọa độ trực quan</span>
                            <div className="grid grid-cols-4 gap-2 text-xs">
                              <div className="bg-white px-1 py-1.5 rounded-lg border border-slate-200/60 text-center shadow-sm">
                                <span className="text-slate-400 block text-[9px] font-bold">Vị trí X</span>
                                <span className="font-mono font-bold text-slate-700">{selectedBox.xPosition}%</span>
                              </div>
                              <div className="bg-white px-1 py-1.5 rounded-lg border border-slate-200/60 text-center shadow-sm">
                                <span className="text-slate-400 block text-[9px] font-bold">Vị trí Y</span>
                                <span className="font-mono font-bold text-slate-700">{selectedBox.yPosition}%</span>
                              </div>
                              <div className="bg-white px-1 py-1.5 rounded-lg border border-slate-200/60 text-center shadow-sm">
                                <span className="text-slate-400 block text-[9px] font-bold">Chiều rộng</span>
                                <span className="font-mono font-bold text-slate-700">{selectedBox.width}%</span>
                              </div>
                              <div className="bg-white px-1 py-1.5 rounded-lg border border-slate-200/60 text-center shadow-sm">
                                <span className="text-slate-400 block text-[9px] font-bold">Chiều cao</span>
                                <span className="font-mono font-bold text-slate-700">{selectedBox.height}%</span>
                              </div>
                            </div>
                          </div>

                          {/* Censor bar background theme block */}
                          <div className="flex flex-col gap-2 bg-slate-50 border border-slate-150 rounded-xl p-3.5 shadow-sm">
                            <span className="text-xs text-slate-600 font-bold">Kiểu che chắn hộp đang chọn</span>
                            <div className="grid grid-cols-4 gap-2">
                              {BLUR_COVER_PRESETS.map((item) => (
                                <button
                                  key={item.key}
                                  type="button"
                                  aria-pressed={getBlurCoverPresetKey(selectedBox.bgColor) === item.key}
                                  onClick={() => updateSelectedBox(prev => ({ ...prev, bgColor: item.bgColor }))}
                                  className={`py-1.5 px-1.5 text-[11px] font-bold rounded-lg border text-center transition-all ${
                                    getBlurCoverPresetKey(selectedBox.bgColor) === item.key
                                      ? "bg-[#4f46e5] border-[#4f46e5] text-white shadow-sm"
                                      : "bg-white border-slate-200 text-slate-600 hover:text-slate-800 hover:bg-slate-50"
                                  }`}
                                >
                                  {item.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>

                        {/* COLUMN 2: CÁC THANH ĐIỀU CHỈNH TRỰC QUAN */}
                        <div className="flex flex-col gap-4 bg-slate-50 border border-slate-150 rounded-xl p-4 shadow-sm justify-center">
                          {/* Blur Intensity Slider */}
                          <div className="flex flex-col gap-1.5 bg-white p-3 rounded-lg border border-slate-200/60 shadow-sm">
                            <div className="flex justify-between text-xs font-bold">
                              <span className="text-slate-600">Mức độ làm mờ (Blur)</span>
                              <span className="text-[#4f46e5] font-mono">{selectedBox.blurAmount}px</span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={30}
                              value={selectedBox.blurAmount}
                              onChange={(e) => updateSelectedBox(prev => ({ ...prev, blurAmount: parseInt(e.target.value) }))}
                              className="accent-[#6366f1] bg-slate-200 h-1.5 rounded-lg appearance-none cursor-pointer mt-1"
                            />
                          </div>

                          {/* Solid/Backplate Opacity Slider */}
                          <div className="flex flex-col gap-1.5 bg-white p-3 rounded-lg border border-slate-200/60 shadow-sm">
                            <div className="flex justify-between text-xs font-bold">
                              <span className="text-slate-600">Độ che mờ tối (Opacity)</span>
                              <span className="text-[#4f46e5] font-mono">{Math.round(selectedBox.opacity * 100)}%</span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={selectedBox.opacity}
                              onChange={(e) => updateSelectedBox(prev => ({ ...prev, opacity: parseFloat(e.target.value) }))}
                              className="accent-[#6366f1] bg-slate-200 h-1.5 rounded-lg appearance-none cursor-pointer mt-1"
                            />
                          </div>
                        </div>

                      </div>
                    );
                  })()}

                  {/* Cài Đặt Hình Ảnh Video */}
                  <div className="mt-2 pt-4 border-t border-slate-200">
                    <h3 className="font-bold text-slate-800 mb-2 flex items-center gap-2 text-sm">
                      <Video className="w-4 h-4 text-[#4f46e5]" />
                      Cài Đặt Video (Lật video)
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl cursor-pointer hover:border-[#4f46e5] transition-colors">
                        <input 
                          type="checkbox"
                          checked={flipHorizontal}
                          onChange={(e) => setFlipHorizontal(e.target.checked)}
                          className="w-4 h-4 text-[#4f46e5] rounded border-slate-300 focus:ring-[#4f46e5]"
                        />
                        <span className="text-xs font-bold text-slate-700">Lật Ngang (Gương)</span>
                      </label>
                      <label className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl cursor-pointer hover:border-[#4f46e5] transition-colors">
                        <input 
                          type="checkbox"
                          checked={flipVertical}
                          onChange={(e) => setFlipVertical(e.target.checked)}
                          className="w-4 h-4 text-[#4f46e5] rounded border-slate-300 focus:ring-[#4f46e5]"
                        />
                        <span className="text-xs font-bold text-slate-700">Lật Dọc (Đảo ngược)</span>
                      </label>
                    </div>
                  </div>

                </div>
              ) : (
                <p className="text-xs text-slate-500 py-4 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                  Tính năng làm mờ phụ đề gốc đang tắt. Bật lên để tạo một thanh filter che giấu các dòng chữ gốc dưới video.
                </p>
              )}
            </div>
          )}
        </motion.div>

        {/* RIGHT COLUMN: Options, Styles, & Subtitle Tracks List (5 Cols) */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          className={`${activeTab === "dubbin" || activeTab === "script-shorts" || activeTab === "editor" || activeTab === "projects" ? "hidden" : activeTab === "export" ? "lg:col-span-12 flex flex-col gap-6" : "lg:col-span-5 flex flex-col gap-6"}`}
          id="dashboard-column"
        >
          
          {/* Action Tabs Selector */}
          <div className={`${activeTab === "export" ? "hidden" : "flex"} items-center gap-1 overflow-x-auto rounded-xl border border-slate-200/60 bg-slate-100 p-1 shadow-inner scrollbar-none lg:hidden`} id="tab-selector-container">
            <button
              onClick={() => setActiveTab("dubbin")}
              className="flex-1 shrink-0 min-w-[105px] md:min-w-max py-2 px-3 text-xs font-extrabold rounded-lg relative flex items-center justify-center gap-1.5 transition-all focus:outline-none cursor-pointer whitespace-nowrap"
              id="tab-btn-translate"
            >
              {activeTab === "dubbin" && (
                <motion.span
                  layoutId="activeTabPill"
                  className="absolute inset-0 bg-gradient-to-r from-[#4f46e5] to-[#6366f1] rounded-lg shadow-md shadow-indigo-600/15 z-0"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <span className={`relative z-10 flex items-center gap-1.5 transition-colors duration-150 ${activeTab === "dubbin" ? "text-white" : "text-slate-500 hover:text-slate-800"}`}>
                <Languages className="w-3.5 h-3.5" />
                Dịch Thuật
              </span>
            </button>
            <button
              onClick={() => setActiveTab("style")}
              className="flex-1 shrink-0 min-w-[105px] md:min-w-max py-2 px-3 text-xs font-extrabold rounded-lg relative flex items-center justify-center gap-1.5 transition-all focus:outline-none cursor-pointer whitespace-nowrap"
              id="tab-btn-style"
            >
              {activeTab === "style" && (
                <motion.span
                  layoutId="activeTabPill"
                  className="absolute inset-0 bg-gradient-to-r from-[#4f46e5] to-[#6366f1] rounded-lg shadow-md shadow-indigo-600/15 z-0"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <span className={`relative z-10 flex items-center gap-1.5 transition-colors duration-150 ${activeTab === "style" ? "text-white" : "text-slate-500 hover:text-slate-800"}`}>
                <Type className="w-3.5 h-3.5" />
                Tinh Chỉnh Phụ Đề
              </span>
            </button>
            <button
              onClick={() => setActiveTab("tracks")}
              className="flex-1 shrink-0 min-w-[105px] md:min-w-max py-2 px-3 text-xs font-extrabold rounded-lg relative flex items-center justify-center gap-1.5 transition-all focus:outline-none cursor-pointer whitespace-nowrap"
              id="tab-btn-tracks"
            >
              {activeTab === "tracks" && (
                <motion.span
                  layoutId="activeTabPill"
                  className="absolute inset-0 bg-gradient-to-r from-[#4f46e5] to-[#6366f1] rounded-lg shadow-md shadow-indigo-600/15 z-0"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <span className={`relative z-10 flex items-center gap-1.5 transition-colors duration-150 ${activeTab === "tracks" ? "text-white" : "text-slate-500 hover:text-slate-800"}`}>
                <FileText className="w-3.5 h-3.5" />
                Bản Dịch/Phụ Đề ({subtitles.length})
              </span>
            </button>
            <button
              onClick={() => setActiveTab("tts")}
              className="flex-1 shrink-0 min-w-[105px] md:min-w-max py-2 px-3 text-xs font-extrabold rounded-lg relative flex items-center justify-center gap-1.5 transition-all focus:outline-none cursor-pointer whitespace-nowrap"
              id="tab-btn-tts"
            >
              {activeTab === "tts" && (
                <motion.span
                  layoutId="activeTabPill"
                  className="absolute inset-0 bg-gradient-to-r from-[#4f46e5] to-[#6366f1] rounded-lg shadow-md shadow-indigo-600/15 z-0"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <span className={`relative z-10 flex items-center gap-1.5 transition-colors duration-150 ${activeTab === "tts" ? "text-white" : "text-slate-500 hover:text-slate-800"}`}>
                <Megaphone className="w-3.5 h-3.5" />
                Thuyết minh
              </span>
            </button>
          </div>

          {/* Animated Tab Contents container */}
          <AnimatePresence mode="wait">
            {activeTab === "dubbin" && (
              <motion.div
                key="dubbin"
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -15 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-md flex flex-col gap-5 hover:border-slate-300/80 hover:shadow-lg transition-all duration-300 text-left"
              >
              <div>
                <h3 className="font-bold text-slate-800 mb-1 flex items-center gap-2 text-base">
                  <Languages className="w-4.5 h-4.5 text-[#4f46e5]" />
                  Cấu Hình Dịch Thuật AI
                </h3>
                <p className="text-xs text-slate-500">
                  Tận dụng AI để lắng nghe giọng nói trong video, tự động ghi phụ đề gốc và tạo bản dịch chính xác.
                </p>
              </div>

              {/* Dynamic API Platform Active Indicator */}
              <div className="flex items-center justify-between bg-slate-50 border border-slate-200/60 rounded-xl p-3">
                <div className="flex flex-col gap-0.5 text-left">
                  <span className="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider">Nguồn dịch thuật hoạt động</span>
                  <span className="text-[10px] text-slate-400 font-medium">Thay đổi cấu hình trong phần cài đặt</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`text-[10px] font-extrabold px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-sm border ${
                    apiPlatform === "gemini" 
                      ? "bg-amber-500/10 text-amber-600 border-amber-500/20"
                      : "bg-indigo-500/10 text-indigo-600 border-indigo-500/20"
                  }`}>
                    {apiPlatform === "gemini" ? (
                      <>
                        <Sparkles className="w-3 h-3 text-amber-500 animate-pulse" />
                        Google Gemini AI
                      </>
                    ) : (
                      <>
                        <Layers className="w-3 h-3 text-indigo-500 animate-pulse" />
                        Custom API
                      </>
                    )}
                  </span>
                </div>
              </div>

              {/* Selector boxes */}
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-600 flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5 text-[#4f46e5]" />
                    Phương thức trích xuất phụ đề
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setExtractionMethod("audio")}
                      className={`p-3 rounded-xl border text-xs font-bold flex flex-col gap-1 text-left transition-all cursor-pointer ${
                        extractionMethod === "audio"
                          ? "bg-indigo-50 border-indigo-500 text-indigo-700 shadow-sm"
                          : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <Volume2 className="w-3.5 h-3.5" />
                        Nhận diện giọng nói
                      </span>
                      <span className="text-[10px] text-slate-400 font-medium">Phân tích tiếng nói trong video</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => { setExtractionMethod("localocr"); setWorkspacePropertyTarget("ocr"); }}
                      className={`p-3 rounded-xl border text-xs font-bold flex flex-col gap-1 text-left transition-all cursor-pointer ${
                        extractionMethod === "localocr"
                          ? "bg-indigo-50 border-indigo-500 text-indigo-700 shadow-sm"
                          : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <Cpu className="w-3.5 h-3.5" />
                        PaddleOCR Python
                      </span>
                      <span className="text-[10px] text-slate-400 font-medium">Quét tuần tự toàn bộ video bằng PaddleOCR Python</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setExtractionMethod("aiocr")}
                      className={`p-3 rounded-xl border text-xs font-bold flex flex-col gap-1 text-left transition-all cursor-pointer ${
                        extractionMethod === "aiocr"
                          ? "bg-indigo-50 border-indigo-500 text-indigo-700 shadow-sm"
                          : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <Cpu className="w-3.5 h-3.5" />
                        AI Vision OCR cũ
                      </span>
                      <span className="text-[10px] text-slate-400 font-medium">Gemini/Custom API đọc trực tiếp ảnh</span>
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-600">Ngôn ngữ gốc của video</label>
                  <select
                    value={sourceLang}
                    onChange={(e) => setSourceLang(e.target.value)}
                    className="bg-white border border-slate-200 px-3.5 py-2 rounded-xl text-sm focus:outline-none focus:border-[#4f46e5] text-slate-800 w-full cursor-pointer font-medium"
                  >
                    <option value="auto">Tự động nhận diện (Khuyên dùng)</option>
                    <option value="English">Tiếng Anh (English)</option>
                    <option value="Vietnamese">Tiếng Việt</option>
                    <option value="Japanese">Tiếng Nhật (日本語)</option>
                    <option value="Chinese">Tiếng Trung (中文)</option>
                    <option value="Korean">Tiếng Hàn (한국어)</option>
                    <option value="French">Tiếng Pháp (Français)</option>
                    <option value="Spanish">Tiếng Tây Ban Nha (Español)</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-600">Ngôn ngữ đích (Dịch phụ đề sang)</label>
                  <select
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    className="bg-white border border-slate-200 px-3.5 py-2 rounded-xl text-sm focus:outline-none focus:border-[#4f46e5] text-slate-800 w-full cursor-pointer font-medium"
                  >
                    <option value="Vietnamese">Tiếng Việt (Vietnamese)</option>
                    <option value="English">Tiếng Anh (English)</option>
                    <option value="Japanese">Tiếng Nhật (日本語)</option>
                    <option value="Korean">Tiếng Hàn (한국어)</option>
                    <option value="Chinese">Tiếng Trung (中文)</option>
                    <option value="French">Tiếng Pháp (Français)</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-600">Bảng thuật ngữ (Glossary)</label>
                  <textarea
                    value={translationGlossary}
                    onChange={(e) => setTranslationGlossary(e.target.value)}
                    placeholder={"Mỗi dòng một cặp thuật ngữ, ví dụ:\nStar Wars = Chiến tranh giữa các vì sao\nLuke Skywalker = Luke Skywalker (giữ nguyên)"}
                    rows={3}
                    className="bg-white border border-slate-200 px-3 py-2 rounded-xl text-xs focus:outline-none focus:border-[#4f46e5] text-slate-800 w-full resize-none font-mono leading-relaxed"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-600">Phong cách dịch</label>
                  <input
                    type="text"
                    value={translationStyle}
                    onChange={(e) => setTranslationStyle(e.target.value)}
                    placeholder="VD: Dịch tự nhiên, thân mật, dùng từ ngữ miền Nam Việt Nam"
                    className="bg-white border border-slate-200 px-3 py-2 rounded-xl text-xs focus:outline-none focus:border-[#4f46e5] text-slate-800 w-full"
                  />
                </div>
              </div>

              {/* Translation Action button */}
              <div className="pt-2">
                <button
                  type="button"
                  disabled={isLoading || !videoSrc}
                  onClick={handleTranslateVideo}
                  className={`w-full py-3 px-4 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 shadow-md ${
                    !videoSrc 
                      ? "bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed" 
                      : "bg-gradient-to-r from-[#4f46e5] to-[#6366f1] hover:opacity-90 text-white shadow-[#4f46e5]/15"
                  }`}
                  id="btn-trigger-translate"
                >
                  <Languages className="w-4 h-4" />
                  Bắt đầu dịch thuật & tạo phụ đề
                </button>
              </div>

              {/* Status indicators and loaders */}
              {isLoading && (
                <div className="bg-slate-50 p-4 border border-[#6366f1]/25 rounded-xl flex flex-col gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-[#4f46e5] animate-ping"></div>
                    <span className="text-xs font-bold text-[#4f46e5]">{loadingStep}</span>
                  </div>
                  <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-gradient-to-r from-[#4f46e5] to-[#6366f1] h-full w-[65%] animate-pulse rounded-full"></div>
                  </div>
                  <p className="text-[10px] text-slate-500 font-medium">
                    Quá trình này có thể tốn từ 10 - 30 giây tùy thuộc vào dung lượng video của bạn.
                  </p>
                </div>
              )}

              {/* Error messages */}
              {errorMsg && (
                <div className="bg-[#F17B77]/10 border border-[#F17B77]/20 text-[#D32F2F] p-4 rounded-xl text-xs flex items-start gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#D32F2F] shrink-0 mt-1"></span>
                  <p className="leading-relaxed font-semibold">{errorMsg}</p>
                </div>
              )}

              {!videoSrc && (
                <div className="border border-amber-100 bg-amber-50/70 p-4 rounded-xl text-xs text-amber-800 flex items-start gap-2 shadow-sm">
                  <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <p className="leading-relaxed">
                    Vui lòng <strong>tải video lên trước</strong> bằng khu vực bên trái. Sau đó tùy chọn ngôn ngữ và bấm nút dịch để AI phân tích.
                  </p>
                </div>
              )}
              </motion.div>
            )}

              {activeTab === "style" && (
                <PersonalizationTab
                  subSettings={subSettings}
                  setSubSettings={setSubSettings}
                  blurBoxes={blurBoxes}
                  activeBlurBoxId={activeBlurBoxId}
                />
              )}

              {activeTab === "tracks" && (
                <TranslationTab
                  subtitles={subtitles}
                  filteredSubtitles={filteredSubtitles}
                  currentTime={currentTime}
                  duration={duration}
                  translationGlossary={translationGlossary}
                  setTranslationGlossary={setTranslationGlossary}
                  translationStyle={translationStyle}
                  setTranslationStyle={setTranslationStyle}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  editingSubId={editingSubId}
                  setEditingSubId={setEditingSubId}
                  editStart={editStart}
                  setEditStart={setEditStart}
                  editEnd={editEnd}
                  setEditEnd={setEditEnd}
                  editOriginal={editOriginal}
                  setEditOriginal={setEditOriginal}
                  editTranslated={editTranslated}
                  setEditTranslated={setEditTranslated}
                  setSubtitles={setSubtitles}
                  onTranslate={() => { void handleTranslateExistingSubtitles(false); }}
                  onRetryTranslation={() => { void handleTranslateExistingSubtitles(true); }}
                  onRetranslateOne={(id) => { void handleTranslateExistingSubtitles(false, [id]); }}
                  isTranslating={isLoading && pipelineJob?.stage === "ocr-translation"}
                  onAddSub={handleAddSub}
                  onSaveEdit={handleSaveEdit}
                  onDeleteSub={handleDeleteSub}
                  onSeekTo={handleSeekTo}
                  onStartEdit={handleStartEdit}
                  exportSRT={exportSRT}
                  exportVTT={exportVTT}
                  exportJSON={exportJSON}
                  formatSecondsToVTT={formatSecondsToVTT}
                />
              )}

              {activeTab === "tts" && (
                <NarrationTab
                  subtitles={subtitles}
                  ttsEnabled={ttsEnabled}
                  setTtsEnabled={setTtsEnabled}
                  ttsEngine={ttsEngine}
                  setTtsEngine={setTtsEngine}
                  tiktokVoice={tiktokVoice}
                  setTiktokVoice={setTiktokVoice}
                  tiktokSessionId={tiktokSessionId}
                  setTiktokSessionId={setTiktokSessionId}
                  vieneuVoice={vieneuVoice}
                  setVieneuVoice={setVieneuVoice}
                  ttsVoiceName={ttsVoiceName}
                  setTtsVoiceName={setTtsVoiceName}
                  voices={voices}
                  originalAudioMixVolume={originalAudioMixVolume}
                  setOriginalAudioMixVolume={setOriginalAudioMixVolume}
                  isPreGenerating={isPreGenerating}
                  preGenerateProgress={preGenerateProgress}
                  isMergingAudio={isMergingAudio}
                  fullTtsText={fullTtsText}
                  setFullTtsText={setFullTtsText}
                  preGenerateAllTts={preGenerateAllTts}
                  downloadMergedVoiceover={downloadMergedVoiceover}
                  voiceAudioUrls={{ ...(ttsEngine === "tiktok" ? tiktokAudioCacheRef.current : vieneuAudioCacheRef.current) }}
                  regeneratingTtsId={regeneratingTtsId}
                  onRegenerateTts={(subtitle) => { void regenerateSingleTts(subtitle); }}
                  onUpdateSubtitleText={(id, text) => setSubtitles((items) => items.map((item) => item.id === id ? { ...item, translated: text } : item))}
                />
              )}
          </AnimatePresence>

          {/* PHẦN XUẤT BẢN & TẢI VỀ THÀNH PHẨM (Nằm ở cuối cột phải, thẳng hàng song song) */}
          {activeTab === "export" && (
            <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-md flex flex-col gap-5">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 bg-indigo-600/10 rounded-lg text-indigo-600">
                    <Download className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-800 text-sm">Trung Tâm Xuất Bản & Tải Về</h3>
                    <p className="text-[11px] text-slate-500 font-medium text-left">Xuất bản các tệp thành phẩm của dự án</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* 1. Tải Phụ Đề */}
                <div className="flex flex-col gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl hover:border-indigo-500/20 transition-all text-left">
                  <div className="flex items-center gap-2">
                    <div className="p-1 bg-amber-500/10 text-amber-600 rounded">
                      <FileText className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-xs font-bold text-slate-700">1. Tệp Phụ Đề</span>
                  </div>
                  <p className="text-[10px] text-slate-500 font-medium min-h-[30px] leading-relaxed">
                    Tải về tệp phụ đề rời chuẩn SRT để biên tập thêm bằng CapCut hoặc Premiere.
                  </p>
                  <button
                    onClick={exportSRT}
                    disabled={subtitles.length === 0}
                    className="w-full mt-auto py-1.5 px-2.5 bg-white border border-slate-200 hover:border-indigo-600 hover:text-indigo-600 text-slate-700 rounded-lg text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Download className="w-3 h-3" />
                    Tải File .SRT
                  </button>
                </div>

                {/* 2. Tải Thuyết Minh (WAV) */}
                <div className="flex flex-col gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl hover:border-indigo-500/20 transition-all text-left">
                  <div className="flex items-center gap-2">
                    <div className="p-1 bg-sky-500/10 text-sky-600 rounded">
                      <Volume2 className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-xs font-bold text-slate-700">2. Âm Thanh</span>
                  </div>
                  <p className="text-[10px] text-slate-500 font-medium min-h-[30px] leading-relaxed">
                    Tải về tệp thuyết minh đầy đủ đã ghép các phân đoạn thoại AI theo mốc thời gian.
                  </p>
                  <button
                    onClick={downloadMergedVoiceover}
                    disabled={isMergingAudio || subtitles.length === 0}
                    className="w-full mt-auto py-1.5 px-2.5 bg-white border border-slate-200 hover:border-indigo-600 hover:text-indigo-600 text-slate-700 rounded-lg text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {isMergingAudio ? (
                      <>
                        <RefreshCw className="w-3 h-3 animate-spin" />
                        Đang xử lý...
                      </>
                    ) : (
                      <>
                        <Download className="w-3 h-3" />
                        Tải File .WAV
                      </>
                    )}
                  </button>
                </div>

                {/* 3. Tải Video Final */}
                <div className="flex flex-col gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl hover:border-indigo-500/20 transition-all text-left">
                  <div className="flex items-center gap-2">
                    <div className="p-1 bg-indigo-500/10 text-indigo-600 rounded">
                      <Video className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-xs font-bold text-slate-700">3. Video Final</span>
                  </div>
                  <p className="text-[10px] text-slate-500 font-medium min-h-[30px] leading-relaxed">
                    Mã hóa tệp video hoàn chỉnh tích hợp cả vùng che mờ và tệp thuyết minh AI.
                  </p>
                  <label className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                    Độ phân giải
                    <select
                      value={exportResolution}
                      onChange={(e) => setExportResolution(e.target.value as "720" | "1080" | "1440")}
                      disabled={isRecordingVideo}
                      className="flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-700 outline-none focus:border-indigo-500 disabled:opacity-60"
                    >
                      <option value="720">720p (nhanh)</option>
                      <option value="1080">1080p</option>
                      <option value="1440">2K / 1440p</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-[10px] font-bold text-slate-600">
                    Tỉ lệ khung
                    <select
                      value={exportAspectRatio}
                      onChange={(e) => setExportAspectRatio(e.target.value as typeof exportAspectRatio)}
                      disabled={isRecordingVideo}
                      className="flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-700 outline-none focus:border-indigo-500 disabled:opacity-60"
                    >
                      <option value="original">Theo video gốc</option>
                      <option value="16:9">16:9 — Ngang</option>
                      <option value="9:16">9:16 — Dọc</option>
                      <option value="1:1">1:1 — Vuông</option>
                      <option value="4:3">4:3 — Ngang</option>
                      <option value="3:4">3:4 — Dọc</option>
                    </select>
                  </label>
                  {isRecordingVideo ? (
                    <div className="w-full mt-auto flex flex-col gap-1.5 bg-white border border-indigo-600/30 rounded-lg p-1 shadow-sm">
                      <div className="w-full bg-slate-100 rounded-full h-1">
                        <div 
                          className="bg-indigo-600 h-1 rounded-full transition-all duration-300" 
                          style={{ width: `${recordingProgress}%` }}
                        />
                      </div>
                      <button
                        onClick={startBrowserRecording}
                        className="w-full text-rose-500 hover:text-rose-600 text-[9px] font-bold transition-all flex items-center justify-center gap-1.5 animate-pulse cursor-pointer"
                      >
                        <Pause className="w-2.5 h-2.5" />
                        Hủy ({recordingProgress}%)
                      </button>
                    </div>
                  ) : (
                    <div className="w-full mt-auto flex flex-col gap-1.5">
                      <label className="flex flex-col gap-1">
                        <span className="text-[9px] text-slate-500 font-bold uppercase">Tên video xuất</span>
                        <div className="flex items-center rounded border border-slate-200 bg-slate-50 px-2 focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500/20">
                          <input
                            type="text"
                            value={outputVideoName}
                            onChange={(event) => setOutputVideoName(event.target.value)}
                            onBlur={() => setOutputVideoName(getOutputVideoFilename().replace(/\.mp4$/i, ""))}
                            placeholder="Nhập tên video"
                            className="min-w-0 flex-1 bg-transparent py-1 text-[10px] font-medium text-slate-700 outline-none"
                          />
                          <span className="shrink-0 text-[9px] font-mono text-slate-400">.mp4</span>
                        </div>
                      </label>
                      {isElectron && (
                        <div className="flex flex-col gap-1">
                          <span className="text-[9px] text-slate-500 font-bold uppercase">Thư mục xuất video</span>
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={async () => {
                                const folder = await window.electronAPI?.selectOutputFolder();
                                if (folder) setOutputFolder(folder);
                              }}
                              className="shrink-0 py-1 px-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-[9px] font-bold transition-all cursor-pointer border border-slate-200"
                            >
                              Chọn thư mục
                            </button>
                            <span className="flex-1 text-[9px] text-slate-500 truncate bg-slate-50 border border-slate-200 rounded px-1.5 py-1 font-mono" title={outputFolder}>
                              {outputFolder || "Chưa chọn (sẽ hỏi khi xuất)"}
                            </span>
                          </div>
                        </div>
                      )}
                      <button
                        onClick={startBrowserRecording}
                        disabled={subtitles.length === 0}
                        className="w-full py-1.5 px-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[11px] font-extrabold transition-all flex items-center justify-center gap-1.5 shadow-sm active:scale-[0.98] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Play className="w-3 h-3 text-white fill-white" />
                        Xuất Video Final
                      </button>

                      {exportedVideoUrl && (
                        <button
                          type="button"
                          onClick={async () => {
                            const res = await fetch(exportedVideoUrl);
                            const blob = await res.blob();
                            await saveVideoBlob(blob, getOutputVideoFilename());
                          }}
                          className="w-full py-1.5 px-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-extrabold transition-all flex items-center justify-center gap-1.5 shadow-md active:scale-[0.98] animate-bounce cursor-pointer"
                        >
                          <Download className="w-3 h-3 text-white" />
                          Lưu Video Final
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {false && <div className="flex flex-col gap-1.5 border-t border-slate-100 pt-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-slate-500 font-bold uppercase flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    Nhật ký xử lý (Logs - 5 dòng gần nhất):
                  </span>
                  <button
                    type="button"
                    onClick={() => setActivityLogs([])}
                    className="text-[9px] text-slate-400 hover:text-indigo-600 font-bold flex items-center gap-1 cursor-pointer bg-slate-50 hover:bg-slate-100 px-1.5 py-0.5 rounded transition-colors"
                  >
                    Xóa logs
                  </button>
                </div>
                <div className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 shadow-inner h-24 overflow-y-auto font-mono text-[10px] text-emerald-400 flex flex-col gap-0.5 text-left select-all">
                  {activityLogs.length === 0 ? (
                    <span className="text-slate-500 italic">Chưa có hoạt động nào được ghi nhận...</span>
                  ) : (
                    activityLogs.slice(-10).map((log, idx) => (
                      <div key={idx} className="whitespace-pre-wrap break-all leading-normal py-0.5 border-b border-emerald-950/20 last:border-0">
                        {log}
                      </div>
                    ))
                  )}
                </div>
              </div>}

              <div className="bg-blue-50/50 border border-blue-200/50 rounded-lg p-2.5 flex gap-2 text-[10px] text-blue-600 leading-relaxed font-semibold text-left">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  <strong>Xuất bản cục bộ:</strong> Video được render bằng Python/FFmpeg ngay trên máy của bạn. Các tệp trung gian chỉ dùng trong lúc xử lý và được tự động dọn sau khi hoàn tất.
                </span>
              </div>
            </div>
          )}

        </motion.div>

        </React.Suspense>
      </main>

      <AppFooter activeRoute={activeTab} />

      <AnimatePresence>
        {errorPopupQueue.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-sm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="persistent-error-title"
            aria-describedby="persistent-error-message"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 18 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              className="w-full max-w-md overflow-hidden rounded-2xl border border-rose-200 bg-white shadow-2xl"
            >
              <div className="flex items-start gap-3 border-b border-rose-100 bg-rose-50 px-5 py-4">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600">
                  <X className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 id="persistent-error-title" className="text-base font-extrabold text-rose-700">Đã xảy ra lỗi</h2>
                  <p className="mt-0.5 text-[11px] font-medium text-rose-500">Tiến trình đã dừng hoặc cần bạn kiểm tra trước khi tiếp tục.</p>
                </div>
                <button onClick={dismissErrorPopup} className="rounded-lg p-1.5 text-rose-400 hover:bg-rose-100 hover:text-rose-700" aria-label="Tắt cảnh báo lỗi"><X className="h-4 w-4" /></button>
              </div>
              <div className="p-5">
                <p id="persistent-error-message" className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm font-semibold leading-6 text-slate-700">{errorPopupQueue[0]}</p>
                {errorPopupQueue.length > 1 && <p className="mt-2 text-right text-[10px] font-bold text-amber-600">Còn {errorPopupQueue.length - 1} cảnh báo tiếp theo</p>}
                <button onClick={dismissErrorPopup} autoFocus className="mt-4 w-full rounded-xl bg-rose-600 px-4 py-3 text-sm font-extrabold text-white shadow-sm hover:bg-rose-500">Đã hiểu, tắt cảnh báo</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {(isLoading || isRecordingVideo || isPreGenerating || isFinalizingVoiceover) && activeTab !== "dubbin" && (
        <div className={`fixed z-[80] border border-indigo-200 bg-white shadow-2xl transition-all ${isProgressMinimized ? "bottom-4 right-4 w-64 rounded-xl p-3" : "inset-x-1/2 top-6 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl p-5"}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-extrabold text-slate-800">{isRecordingVideo ? "Đang render video" : isFinalizingVoiceover ? "Đang finalize Smart TTS" : isPreGenerating ? "Đang tạo thuyết minh" : "Đang tạo phụ đề"}</p>
              <p className="mt-0.5 text-[11px] text-slate-500">{isRecordingVideo ? `${recordingProgress}% hoàn thành` : isPreGenerating ? `${preGenerateProgress}% · Đang tiếp tục từ checkpoint` : loadingStep || "Đang xử lý bằng AI..."}</p>
              {isRecordingVideo && recordingEtaSeconds !== null && (
                <p className="mt-1 text-[11px] font-bold text-indigo-600">{recordingEtaSeconds > 0 ? `Dự tính render còn ${formatEstimatedTime(recordingEtaSeconds)}` : "Đang hoàn tất video"}</p>
              )}
              {!isRecordingVideo && isPreGenerating && preGenerateEtaSeconds !== null && (
                <p className="mt-1 text-[11px] font-bold text-indigo-600">{preGenerateEtaSeconds > 0 ? `Dự tính tạo giọng còn ${formatEstimatedTime(preGenerateEtaSeconds)}` : "Đang hoàn tất thuyết minh"}</p>
              )}
              {isLoading && loadingEtaSeconds !== null && (
                <p className="mt-1 text-[11px] font-bold text-indigo-600">
                  {loadingEtaSeconds > 0 ? `Dự tính còn ${formatEstimatedTime(loadingEtaSeconds)}` : "Sắp hoàn tất"} · {loadingProgress}%
                </p>
              )}
            </div>
            <button onClick={() => setIsProgressMinimized(v => !v)} className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-xs font-bold text-slate-600">{isProgressMinimized ? "Mở" : "Thu nhỏ"}</button>
          </div>
          {!isProgressMinimized && <><div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${isRecordingVideo ? recordingProgress : isPreGenerating ? preGenerateProgress : loadingProgress}%` }} /></div><div className="mt-3 flex justify-end gap-2">{pipelineJob?.stage !== "render" && <button type="button" onClick={togglePipelinePause} disabled={pipelineJob?.status === "cancelling"} className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-bold text-indigo-700 disabled:opacity-50">{pipelineJob?.status === "paused" ? "Tiếp tục" : "Tạm dừng"}</button>}<button type="button" onClick={cancelActivePipeline} disabled={!pipelineJob || pipelineJob.status === "cancelling"} className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{pipelineJob?.status === "cancelling" ? "Đang hủy..." : "Hủy tác vụ"}</button></div></>}
        </div>
      )}

      {/* Subscription plans */}
      <AnimatePresence>
        {showDonatePopup && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-y-0 left-0 right-0 z-[100] flex items-center justify-center bg-slate-900/60 p-3 backdrop-blur-sm sm:p-4 lg:left-64"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="relative flex max-h-[calc(100dvh-24px)] w-full min-w-0 max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl sm:max-h-[90dvh] sm:rounded-3xl"
            >
              <button
                onClick={() => setShowDonatePopup(false)}
                className="absolute top-4 right-4 p-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-full transition-colors z-10 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
              
              <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-100 shadow-inner sm:mb-4 sm:h-14 sm:w-14">
                  <Crown className="h-7 w-7 text-indigo-600" />
                </div>
                <h3 className="mb-2 text-center text-xl font-black text-slate-900 sm:text-2xl">Chọn thời hạn sử dụng</h3>
                <p className="mx-auto mb-4 max-w-2xl text-center text-xs font-medium leading-relaxed text-slate-500 sm:mb-6 sm:text-sm">
                  Mọi gói đều mở khóa toàn bộ tính năng, bao gồm AI Script Shorts. Chọn thời hạn phù hợp với bạn.
                </p>
                <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  {[
                    { name: "DÙNG THỬ", term: "1 ngày", price: "0đ", note: "Mỗi thiết bị một lần" },
                    { name: "SALE RA MẮT", term: "1 tháng", price: "99.000đ", note: "Giá ưu đãi 7 ngày" },
                    { name: "SALE RA MẮT", term: "3 tháng", price: "279.000đ", note: "Chỉ 93.000đ / tháng" },
                    { name: "ƯU ĐÃI TỐT NHẤT", term: "1 năm", price: "699.000đ", note: "Khoảng 58.000đ / tháng", featured: true },
                    { name: "GIỚI HẠN 50 KEY", term: "Trọn đời", price: "1.799.000đ", note: "Áp dụng cho 50 key đầu tiên" },
                  ].map((plan) => (
                    <article key={plan.name} className={`relative flex min-h-56 flex-col rounded-2xl border p-4 text-left transition sm:p-5 ${plan.featured ? "border-indigo-500 bg-gradient-to-b from-indigo-50 to-white shadow-xl shadow-indigo-500/15 lg:-translate-y-2" : "border-slate-200 bg-white hover:-translate-y-1 hover:border-indigo-300 hover:shadow-lg"}`}>
                      {plan.featured && <span className="absolute right-3 top-3 rounded-full bg-indigo-600 px-2 py-1 text-[9px] font-extrabold text-white shadow-sm">KHUYÊN DÙNG</span>}
                      <p className="text-[10px] font-black tracking-widest text-indigo-600">{plan.name}</p>
                      <h4 className="mt-2 text-lg font-extrabold text-slate-800">{plan.term}</h4>
                      <p className="mt-4 whitespace-nowrap text-2xl font-black tracking-tight text-slate-950">{plan.price}</p>
                      <p className="mt-2 min-h-10 text-[11px] font-semibold leading-5 text-slate-500">{plan.note}</p>
<a href={plan.price === "0đ" ? "https://dubbintool.io.vn/admin" : "https://zalo.me/0373491922"} target="_blank" rel="noreferrer" className={`mt-auto flex w-full items-center justify-center rounded-xl px-3 py-2.5 text-xs font-extrabold transition ${plan.featured ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20 hover:bg-indigo-700" : "bg-slate-100 text-slate-700 hover:bg-indigo-100 hover:text-indigo-700"}`}>
                        {plan.price === "0đ" ? "Dùng thử miễn phí" : "Chọn gói này"}
                      </a>
                    </article>
                  ))}
                </div>
                <p className="mt-5 text-center text-[11px] font-medium text-slate-400">Giá và chính sách được đồng bộ theo dubbintool.io.vn.</p>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {whatsNewVersion && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm lg:left-64">
            <motion.section initial={{ opacity: 0, y: 20, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.97 }} className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-indigo-100 bg-white shadow-2xl">
              <button type="button" onClick={() => { localStorage.setItem("26dubbin_seen_release_notes", whatsNewVersion); setWhatsNewVersion(null); }} className="absolute right-4 top-4 rounded-full bg-white/80 p-2 text-indigo-300 hover:bg-white hover:text-indigo-700" aria-label="Đóng thông tin cập nhật"><X className="h-4 w-4" /></button>
              <div className="bg-gradient-to-br from-indigo-600 to-violet-600 px-6 py-6 text-white">
                <span className="inline-flex rounded-full bg-white/15 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider">Cập nhật hoàn tất</span>
                <h2 className="mt-3 text-2xl font-black">Có gì mới trong v{whatsNewVersion}?</h2>
                <p className="mt-1 text-sm font-medium text-indigo-100">DubbinTool đã được cập nhật thành công. Dữ liệu dự án của bạn vẫn được giữ nguyên.</p>
              </div>
              <div className="p-6">
                <ul className="space-y-3">
                  {RELEASE_NOTES[whatsNewVersion].map((note) => <li key={note} className="flex items-start gap-3 text-sm font-semibold leading-relaxed text-slate-700"><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600"><Check className="h-3 w-3" /></span><span>{note}</span></li>)}
                </ul>
                <button type="button" onClick={() => { localStorage.setItem("26dubbin_seen_release_notes", whatsNewVersion); setWhatsNewVersion(null); }} className="mt-6 w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-extrabold text-white shadow-md shadow-indigo-600/20 hover:bg-indigo-700">Đã hiểu, bắt đầu sử dụng</button>
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Settings Page */}
        {activeTab === "settings" && (
          <SettingsTab
            apiQuotaEntries={apiQuotaEntries}
            quotaUpdatedAt={quotaUpdatedAt}
            quotaLoadError={quotaLoadError}
            isLoadingQuota={isLoadingQuota}
            onRefreshQuota={refreshApiQuota}
            removeGeminiApiKey={removeGeminiApiKey}
            tiktokSessionId={tiktokSessionId}
            setTiktokSessionId={setTiktokSessionId}
            geminiApiKey={geminiApiKey}
            geminiApiKeyDraft={geminiApiKeyDraft}
            setGeminiApiKeyDraft={setGeminiApiKeyDraft}
            submitGeminiApiKeys={submitGeminiApiKeys}
            parseGeminiApiKeys={parseGeminiApiKeys}
            apiPlatform={apiPlatform}
            setApiPlatform={setApiPlatform}
            extractionMethod={extractionMethod}
            customApiUrl={customApiUrl}
            setCustomApiUrl={setCustomApiUrl}
            customApiKey={customApiKey}
            setCustomApiKey={setCustomApiKey}
            customModel={customModel}
            setCustomModel={setCustomModel}
            sanitizeCustomApiBaseUrl={sanitizeCustomApiBaseUrl}
            allowGeminiFallback={allowGeminiFallback}
            setAllowGeminiFallback={setAllowGeminiFallback}
            isTestingConnection={isTestingConnection}
            testResult={testResult}
            testCustomApiConnection={testCustomApiConnection}
            smartTtsEnabled={smartTtsEnabled}
            setSmartTtsEnabled={setSmartTtsEnabled}
          />
        )}

      {/* Engine Download Modal */}
      <AnimatePresence>
        {showEngineModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="bg-white rounded-3xl shadow-2xl max-w-lg w-full max-h-[85vh] flex flex-col relative border border-slate-200 overflow-hidden"
            >
              <button
                onClick={() => setShowEngineModal(false)}
                className="absolute top-4 right-4 p-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-full transition-colors z-10 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
              
              <div className="p-6 sm:p-8 flex flex-col overflow-y-auto scrollbar-none flex-1">
                <div className="flex items-center gap-3 mb-6 shrink-0">
                  <div className="p-2 bg-indigo-100 rounded-xl">
                    <Cpu className="w-6 h-6 text-indigo-600" />
                  </div>
                  <div>
                    <h3 className="text-lg font-black text-slate-800">Trình tải & Cài đặt Engine</h3>
                    <p className="text-xs text-slate-400 font-medium">Cài đặt Python OCR và kiểm tra môi trường render</p>
                  </div>
                </div>

                <div className="space-y-5">
                  {/* Progress Indicator */}
                  <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-4 flex flex-col gap-3">
                    <div className="flex justify-between items-center text-xs font-bold text-slate-600">
                      <span>Tiến trình cài đặt</span>
                      <span className="text-indigo-600 font-mono">{engineDownloadProgress}%</span>
                    </div>
                    
                    {/* Progress Bar */}
                    <div className="w-full bg-slate-200 h-2.5 rounded-full overflow-hidden relative">
                      <motion.div
                        className="bg-gradient-to-r from-[#4f46e5] to-indigo-500 h-full rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${engineDownloadProgress}%` }}
                        transition={{ duration: 0.3 }}
                      />
                    </div>
                    
                    <span className="text-xs text-slate-500 font-semibold leading-relaxed">
                      {engineCurrentStep || "Đang chờ bắt đầu..."}
                    </span>
                  </div>

                  {/* Terminal Installation Logs */}
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold text-slate-600">Nhật ký cài đặt (Install Logs)</span>
                    <div ref={logContainerRef} className="bg-slate-900 rounded-2xl p-4 font-mono text-[11px] text-indigo-300 h-48 overflow-y-auto space-y-1.5 border border-slate-800 scrollbar-none flex flex-col">
                      {engineInstallLogs.map((log, index) => (
                        <div key={index} className="leading-relaxed">
                          <span className="text-emerald-500">▶</span> {log}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Status Note */}
                  {engineStatus === "installed" ? (
                    <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-xs text-emerald-700 leading-relaxed font-semibold text-left">
                      🟢 <strong>Đã hoàn thành:</strong> Python OCR đã được cài đặt và kiểm tra. Video render dùng ffmpeg.exe gốc.
                    </div>
                  ) : (
                    <div className="p-4 bg-amber-50 border border-amber-200/80 rounded-2xl text-xs text-amber-700 leading-relaxed font-semibold text-left">
                      💡 <strong>Lưu ý:</strong> Render video dùng ffmpeg.exe gốc qua server. PaddleOCR được Node tải một lần và tái sử dụng cho mọi request.
                    </div>
                  )}
                </div>

                <div className="mt-6 flex gap-3">
                  {engineStatus !== "installed" && !isDownloadingEngine && (
                    <button
                      onClick={handleCheckResources}
                      className="flex-1 py-3 px-4 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-600/10 text-sm"
                    >
                      Kiểm tra tài nguyên
                    </button>
                  )}
                  {engineStatus === "error" && (
                    <button
                      onClick={() => { setEngineInstallLogs([]); handleCheckResources(); }}
                      className="py-3 px-4 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-colors text-sm"
                    >
                      Thử lại
                    </button>
                  )}
                  <button
                    onClick={() => { navigator.clipboard?.writeText(engineInstallLogs.join('\n')); }}
                    className="py-3 px-4 bg-slate-100 text-slate-700 rounded-xl font-bold hover:bg-slate-200 transition-colors text-sm"
                  >
                    Sao chép nhật ký
                  </button>
                  <button
                    onClick={() => setShowEngineModal(false)}
                    className="flex-1 py-3 px-4 bg-slate-100 text-slate-700 rounded-xl font-bold hover:bg-slate-200 transition-colors text-sm"
                  >
                    Đóng cửa sổ
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
