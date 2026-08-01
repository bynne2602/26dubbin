const packageJson = require("../package.json");

module.exports = {
  ...packageJson.build,
  artifactName: `DubbinTool Full Setup ${packageJson.version}.\${ext}`,
  directories: { output: "C:\\DubbinBuild\\release-full" },
  // PaddleOCR v5 already contains and verifies its CUDA 11.8 runtime. The
  // legacy standalone CUDA bundle duplicates nearly 3 GB and pushes NSIS over
  // its 2 GB mmap limit. Keep OCR, FFmpeg, and VC++ in the full installer.
  extraResources: packageJson.build.extraResources.filter(({ to }) => to !== "cuda-libs"),
};
