import { mergeOcrFramesToSubtitles, type OcrDetection } from "../src/lib/ocr";

const box = { x: 10, y: 80, width: 70, height: 10 };
const detection = (text: string, confidence = 0.9): OcrDetection => ({
  text,
  confidence,
  region_id: "subtitle-bottom",
  box,
});

const subtitles = mergeOcrFramesToSubtitles([
  { timestamp: 0, detections: [detection("Tô gấp mấy lần")] },
  { timestamp: 0.5, detections: [] },
  { timestamp: 1, detections: [detection("Tô gấp mấy lần")] },
  { timestamp: 1.5, detections: [detection("Tô gấp mấy lẩn", 0.45)] },
  { timestamp: 2, detections: [detection("Tô gấp mấy lần")] },
  { timestamp: 3, detections: [detection("Đây là câu mới")] },
], 0.5, 4);

if (subtitles.length !== 2) {
  throw new Error(`Expected 2 subtitles after OCR dedupe, received ${subtitles.length}: ${JSON.stringify(subtitles)}`);
}
if (subtitles[0].original !== "Tô gấp mấy lần" || subtitles[1].original !== "Đây là câu mới") {
  throw new Error(`OCR dedupe changed subtitle order/content: ${JSON.stringify(subtitles)}`);
}

console.log("OCR dedupe regression passed", subtitles);

const confirmedLate = mergeOcrFramesToSubtitles([
  { timestamp: 10.1, detections: [{ ...detection("Xuất hiện ngay"), first_seen_ts: 10 }] },
  { timestamp: 10.2, detections: [{ ...detection("Xuất hiện ngay"), first_seen_ts: 10 }] },
], 0.1, 12);
if (confirmedLate[0]?.start !== 9.95) {
  throw new Error(`Debounced OCR must recover the first visual timestamp, received ${JSON.stringify(confirmedLate)}`);
}
