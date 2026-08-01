import { isSubtitleTranslationMissing, optimizeExtractedSubtitles } from "../src/lib/subtitle";
import type { Subtitle } from "../src/types";

const cue = (id: string, start: number, end: number, original: string): Subtitle => ({
  id,
  start,
  end,
  original,
  translated: "",
});

const result = optimizeExtractedSubtitles([
  cue("a", 0, 1, "  Trang bị\u200B thường!!!  "),
  cue("b", 1.08, 2, "Trang bị thường!!"),
  cue("c", 3, 4.2, "Câu hợp lệ"),
  cue("d", 4.1, 5, "Câu tiếp theo"),
  cue("empty", 6, 6.5, "..."),
  cue("repeat-later", 20, 21, "Trang bị thường!!"),
], 30);

if (result.subtitles.length !== 4) {
  throw new Error(`Expected 4 optimized cues, received ${result.subtitles.length}: ${JSON.stringify(result)}`);
}
if (result.stats.duplicatesRemoved !== 1 || result.stats.emptyRemoved !== 1) {
  throw new Error(`Unexpected optimizer stats: ${JSON.stringify(result.stats)}`);
}
if (result.subtitles[1].end >= result.subtitles[2].start) {
  throw new Error(`Overlap was not repaired: ${JSON.stringify(result.subtitles.slice(1, 3))}`);
}
if (!result.subtitles.some((item) => item.start === 20)) {
  throw new Error("Legitimate repeated dialogue far apart was incorrectly removed.");
}

console.log("Subtitle optimizer regression passed", result.stats);

if (!isSubtitleTranslationMissing(cue("retry-empty", 0, 1, "你好"))) {
  throw new Error("Empty translation was not marked for retry.");
}
if (!isSubtitleTranslationMissing({ ...cue("retry-same", 0, 1, "你好！"), translated: "你好" })) {
  throw new Error("Translation identical to original was not marked for retry.");
}
if (isSubtitleTranslationMissing({ ...cue("done", 0, 1, "你好"), translated: "Xin chào" })) {
  throw new Error("Successful translation was incorrectly marked for retry.");
}

const simultaneous = optimizeExtractedSubtitles([
  cue("line-1", 1, 2, "Dòng trên"),
  cue("line-2", 1, 2, "Dòng dưới"),
], 3);
if (simultaneous.subtitles.length !== 1 || !simultaneous.subtitles[0].original.includes("Dòng trên") || !simultaneous.subtitles[0].original.includes("Dòng dưới")) {
  throw new Error(`Simultaneous OCR lines were lost instead of being preserved: ${JSON.stringify(simultaneous)}`);
}
