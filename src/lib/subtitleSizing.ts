export type SubtitleExportFrame = {
  width: number;
  height: number;
};

// The number entered in the editor is designed at a 360px-tall preview. This
// keeps its visual proportion identical when that preview or the final video
// is resized.
export const SUBTITLE_REFERENCE_HEIGHT = 360;

/**
 * Font size is an export-pixel value: 18px always means 18px in the saved
 * video, independent of whether the source happens to be 720p, 1080p or 4K.
 */
export function getSubtitleExportFrame(resolution: number, aspectRatio: number): SubtitleExportFrame {
  const safeResolution = Number.isFinite(resolution) ? Math.max(2, resolution) : 1080;
  const safeRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 16 / 9;
  const rawWidth = safeRatio >= 1 ? Math.round(safeResolution * safeRatio) : safeResolution;
  const rawHeight = safeRatio >= 1 ? safeResolution : Math.round(safeResolution / safeRatio);
  const toEven = (value: number) => {
    const rounded = Math.max(2, Math.round(value));
    return rounded % 2 === 0 ? rounded : rounded + 1;
  };
  return { width: toEven(rawWidth), height: toEven(rawHeight) };
}

export function getFittedSubtitleFrame(containerWidth: number, containerHeight: number, aspectRatio: number): SubtitleExportFrame {
  const safeWidth = Number.isFinite(containerWidth) ? Math.max(1, containerWidth) : 1;
  const safeHeight = Number.isFinite(containerHeight) ? Math.max(1, containerHeight) : 1;
  const safeRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 16 / 9;
  const width = Math.min(safeWidth, safeHeight * safeRatio);
  return { width, height: width / safeRatio };
}

export function getSubtitleVisualScale(frameHeight: number): number {
  const safeHeight = Number.isFinite(frameHeight) ? Math.max(1, frameHeight) : SUBTITLE_REFERENCE_HEIGHT;
  return safeHeight / SUBTITLE_REFERENCE_HEIGHT;
}
