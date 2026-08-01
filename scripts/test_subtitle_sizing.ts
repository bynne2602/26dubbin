import assert from "node:assert/strict";
import { getFittedSubtitleFrame, getSubtitleExportFrame, getSubtitleVisualScale } from "../src/lib/subtitleSizing";

assert.deepEqual(getSubtitleExportFrame(1080, 16 / 9), { width: 1920, height: 1080 });
assert.deepEqual(getSubtitleExportFrame(1080, 9 / 16), { width: 1080, height: 1920 });
assert.deepEqual(getFittedSubtitleFrame(960, 540, 16 / 9), { width: 960, height: 540 });
assert.deepEqual(getFittedSubtitleFrame(960, 540, 9 / 16), { width: 303.75, height: 540 });
assert.equal(getSubtitleVisualScale(360), 1);
assert.equal(getSubtitleVisualScale(1080), 3);
assert.equal(getSubtitleVisualScale(180), 0.5);

console.log("Subtitle sizing regression passed");
