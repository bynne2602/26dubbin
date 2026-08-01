const packageJson = require("../package.json");
const includeOcrV5TransitionRuntime = ["1.0.24", "1.0.25", "1.0.26", "1.0.27"].includes(packageJson.version);

module.exports = {
  ...packageJson.build,
  directories: { output: "C:\\DubbinBuild\\release-update" },
  nsis: {
    ...packageJson.build.nsis,
    // Update packages must install immediately even when launched by an older
    // app whose updater did not request silent mode.
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    runAfterFinish: true,
    include: "build/installer-update.nsh",
  },
  // 1.0.24 is the one-time PP-OCRv5/Paddle 3 runtime transition. Later
  // lightweight updates reuse runtime-v2 from LOCALAPPDATA.
  extraResources: packageJson.build.extraResources.filter(({ to }) =>
    (includeOcrV5TransitionRuntime || to !== "ocr-engine")
      && to !== "cuda-libs"
      && to !== "ffmpeg/ffmpeg.exe"
  ),
};
