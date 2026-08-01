export type BeeknoeeVoice = {
  id: string;
  model: string;
  label: string;
  group: string;
  engine: "beeknoee" | "vieneu" | "tiktok";
};

export const BEEKNOEE_GOOGLE_VOICES: BeeknoeeVoice[] = [
  { id: "vi", model: "google/google-tts", label: "Google miễn phí · Nữ miền Bắc", group: "Google TTS", engine: "beeknoee" },
];

export const LOCAL_TOOL_VOICES: BeeknoeeVoice[] = [
  ...["Phạm Tuyên", "Minh Đức", "Trúc Ly", "Quang Sơn", "Ngọc Trân", "Ngọc Huyền · Tin tức (Fine-tune)"].map((id) => ({
    id, model: "vieneu", label: id, group: "VieNeu TTS", engine: "vieneu" as const,
  })),
  { id: "BV074_streaming", model: "tiktok", label: "BV074 · Nữ hoạt ngôn, ấm áp", group: "TikTok TTS", engine: "tiktok" },
  { id: "BV075_streaming", model: "tiktok", label: "BV075 · Nam tự tin, thanh niên", group: "TikTok TTS", engine: "tiktok" },
];

BEEKNOEE_GOOGLE_VOICES.push(...LOCAL_TOOL_VOICES);
export const AI_SHORTS_VOICES = BEEKNOEE_GOOGLE_VOICES;

// Keep the demo-key default on the free Google model; Gemini TTS is intentionally excluded.
export const DEFAULT_BEEKNOEE_VOICE = BEEKNOEE_GOOGLE_VOICES.find((voice) => voice.model === "google/google-tts")!;
export const DEFAULT_AI_SHORTS_VOICE = LOCAL_TOOL_VOICES.find((voice) => voice.id.includes("Ngọc Huyền"))!;

export function encodeBeeknoeeVoice(voice: Pick<BeeknoeeVoice, "model" | "id">): string {
  return `${voice.model}|${voice.id}`;
}

export function resolveBeeknoeeVoice(value: unknown): BeeknoeeVoice {
  const selected = String(value || "");
  return AI_SHORTS_VOICES.find((voice) => encodeBeeknoeeVoice(voice) === selected)
    || DEFAULT_BEEKNOEE_VOICE;
}
