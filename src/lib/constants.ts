/**
 * Constants and default values for the application
 */

// ============ Languages ============
export const SUPPORTED_LANGUAGES = {
  'auto': 'Tự động nhận diện',
  'vi': 'Vietnamese',
  'en': 'English',
  'ja': 'Japanese',
  'zh': 'Chinese',
  'ko': 'Korean',
  'fr': 'French',
  'es': 'Spanish',
} as const;

// ============ Extraction Methods ============
export const EXTRACTION_METHODS = {
  'audio': {
    label: 'Audio (Phát hiện giọng nói)',
    description: 'Trích xuất phụ đề từ âm thanh video',
    icon: 'Volume2',
  },
  'ocr': {
    label: 'PaddleOCR native',
    description: 'Detection + recognition bằng ONNX trong Node',
    icon: 'Eye',
  },
  'aiocr': {
    label: 'AI Vision OCR (cũ)',
    description: 'Gửi ảnh sang Gemini/Custom API để đọc chữ',
    icon: 'Sparkles',
  },
} as const;

// ============ API Platforms ============
export const API_PLATFORMS = {
  'gemini': {
    label: 'Gemini 3.5 Flash',
    description: 'Google Gemini API',
  },
  'custom': {
    label: 'Custom API',
    description: 'OpenAI-compatible API',
  },
} as const;

// ============ TTS Engines ============
export const TTS_ENGINES = {
  'gemini': {
    label: 'Gemini TTS',
    description: 'Google Gemini Text-to-Speech',
    requiresApiKey: true,
  },
  'browser': {
    label: 'Browser Native',
    description: 'Web Speech API (Limited)',
    requiresApiKey: false,
  },
  'tiktok': {
    label: 'TikTok TTS',
    description: 'TikTok Unofficial API',
    requiresApiKey: false,
  },
} as const;

// ============ Subtitle Settings ============
export const DEFAULT_SUBTITLE_SETTINGS = {
  fontSize: 18,
  fontFamily: 'Inter',
  textColor: '#FFFFFF',
  bgColor: 'rgba(0,0,0,0.7)',
  outline: true,
  outlineColor: '#000000',
  outlineWidth: 2,
  textEffect: 'outline' as const,
  fontWeight: 'bold' as const,
  letterSpacing: 0,
  position: 'bottom' as const,
} as const;

// ============ Blur Settings ============
export const DEFAULT_BLUR_SETTINGS = {
  enabled: false,
  yPosition: 82,
  height: 12,
  width: 100,
  blurAmount: 15,
  opacity: 0.8,
  bgColor: 'rgba(0,0,0,0.9)',
} as const;

export const DEFAULT_BLUR_BOXES = [
  {
    id: 'blur-1',
    xPosition: 10,
    yPosition: 20,
    width: 80,
    height: 15,
    blurAmount: 15,
    opacity: 0.9,
    bgColor: 'rgba(0,0,0,0.9)',
  },
] as const;

// ============ Error Messages ============
export const ERROR_MESSAGES = {
  NO_VIDEO: 'Vui lòng chọn hoặc tải video lên trước.',
  NO_API_KEY: 'Chưa cấu hình API Key. Vui lòng cấu hình trong mục Cài đặt.',
  INVALID_VIDEO: 'Vui lòng chọn một tập tin video hợp lệ (MP4, WebM, v.v.)',
  EXTRACTION_FAILED: 'Trích xuất âm thanh thất bại.',
  TRANSLATION_FAILED: 'Dịch thuật phụ đề thất bại.',
  NETWORK_ERROR: 'Lỗi kết nối mạng. Vui lòng kiểm tra kết nối internet.',
  TIMEOUT: 'Yêu cầu quá lâu. Vui lòng thử lại.',
  RATE_LIMIT: 'Đạt giới hạn API. Vui lòng chờ và thử lại.',
  INVALID_RESPONSE: 'Phản hồi từ API không hợp lệ.',
  PARSE_ERROR: 'Không thể phân tích dữ liệu phụ đề.',
  FIRESTORE_ERROR: 'Lỗi kết nối Firestore. Vui lòng chỉnh sửa Security Rules.',
  AUTH_ERROR: 'Lỗi xác thực. Vui lòng thử lại.',
} as const;

// ============ Success Messages ============
export const SUCCESS_MESSAGES = {
  AUDIO_EXTRACTED: 'Trích xuất âm thanh thành công!',
  FRAMES_EXTRACTED: 'Trích xuất khung hình thành công!',
  TRANSLATION_COMPLETE: 'Dịch thuật phụ đề thành công!',
  VIDEO_EXPORTED: 'Xuất video thành công!',
  LOGIN_SUCCESS: 'Đăng nhập thành công!',
  LOGOUT_SUCCESS: 'Đã đăng xuất.',
} as const;

// ============ Loading Steps ============
export const LOADING_STEPS = {
  PREPARING: 'Chuẩn bị dữ liệu video...',
  EXTRACTING_AUDIO: 'Đang trích xuất âm thanh từ video...',
  EXTRACTING_FRAMES: 'Đang trích xuất khung hình từ video...',
  TRANSLATING: 'Đang dịch thuật và trích xuất phụ đề bằng AI...',
  PROCESSING: 'Đang xử lý...',
  EXPORTING: 'Đang xuất video...',
} as const;

// ============ UI Configuration ============
export const UI_CONFIG = {
  TOAST_DURATION_MS: 3000,
  MODAL_ANIMATION_DURATION_MS: 300,
  DEBOUNCE_DELAY_MS: 300,
  AUTO_SAVE_DELAY_MS: 1000,
} as const;

// ============ Sample Data ============
export const SAMPLE_SUBTITLES = [
  {
    id: 'sample-1',
    start: 0,
    end: 2.5,
    original: 'Welcome to the video dubbing tool.',
    translated: 'Chào mừng đến với công cụ dubbing video.',
  },
  {
    id: 'sample-2',
    start: 2.5,
    end: 5,
    original: 'This tool helps you create professional subtitles.',
    translated: 'Công cụ này giúp bạn tạo phụ đề chuyên nghiệp.',
  },
  {
    id: 'sample-3',
    start: 5,
    end: 8,
    original: 'You can translate them to any language.',
    translated: 'Bạn có thể dịch chúng sang bất kỳ ngôn ngữ nào.',
  },
] as const;

// ============ Feature Flags ============
export const FEATURE_FLAGS = {
  ENABLE_CUSTOM_API: true,
  ENABLE_GEMINI_FALLBACK: true,
  ENABLE_TTS: true,
  ENABLE_VIDEO_EXPORT: true,
  ENABLE_FRAME_EXTRACTION: true,
  ENABLE_OCR: true,
  DEBUG_MODE: typeof window !== 'undefined' && localStorage.getItem('debug_mode') === 'true',
} as const;
