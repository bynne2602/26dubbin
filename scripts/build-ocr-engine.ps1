param(
  [string]$Python = "$PSScriptRoot\..\.venv\Scripts\python.exe",
  [string]$Output = "$PSScriptRoot\..\resources\ocr-engine"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..").Path
$cudaBin = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v11.8\bin"
$hfCache = Join-Path $env:USERPROFILE ".cache\huggingface\hub"
$paddlexModels = Join-Path $env:USERPROFILE ".paddlex\official_models"
$requiredCudaDlls = @("zlibwapi.dll", "cudnn64_8.dll", "cudnn_ops_infer64_8.dll", "cudnn_cnn_infer64_8.dll", "cudnn_adv_infer64_8.dll", "cublas64_11.dll", "cublasLt64_11.dll", "cudart64_110.dll")

if (!(Test-Path $Python)) { throw "Python venv not found: $Python" }
& $Python -m pip install --upgrade pyinstaller
& $Python -m pip install "paddlepaddle-gpu==3.1.1" -i "https://www.paddlepaddle.org.cn/packages/stable/cu118/"
if ($LASTEXITCODE) { throw "PaddlePaddle GPU 3.1.1 CUDA 11.8 installation failed." }
& $Python -m pip install "paddleocr==3.5.0" "numpy<2.4" opencv-python-headless pyclipper shapely rapidfuzz tqdm ffmpeg-python imageio-ffmpeg vieneu
if ($LASTEXITCODE) { throw "Python dependency installation failed." }
& $Python -m pip install torch --index-url "https://download.pytorch.org/whl/cu118"
if ($LASTEXITCODE) { throw "PyTorch CUDA 11.8 installation for Ngoc Huyen voice failed." }
& $Python -m pip install transformers peft accelerate safetensors "yt-dlp[default,curl-cffi]"
if ($LASTEXITCODE) { throw "Ngoc Huyen LoRA dependencies installation failed." }

foreach ($dll in $requiredCudaDlls) {
  if (!(Test-Path (Join-Path $cudaBin $dll))) { throw "Missing CUDA GPU dependency: $dll" }
}

$dist = Join-Path $root "build\ocr-engine-dist"
Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
& $Python -m PyInstaller --noconfirm --clean --onedir --name ocr_engine --distpath $dist --paths $root `
  --add-data "$root\scripts\ocr_frame.py;scripts" `
  --add-data "$root\scripts\ocr_video_stream.py;scripts" `
  --add-data "$root\scripts\render_video.py;scripts" `
  --add-data "$root\scripts\vieneu_tts.py;scripts" `
  --collect-all paddle `
  --collect-all paddleocr `
  --collect-all paddlex `
  --collect-all rapidfuzz `
  --collect-all Cython `
  --collect-all cv2 `
  --collect-all imageio_ffmpeg `
  --collect-all vieneu `
  --collect-all sea_g2p `
  --collect-all torch `
  --collect-all transformers `
  --collect-all peft `
  --collect-all accelerate `
  --copy-metadata imagesize `
  --copy-metadata opencv-contrib-python `
  --copy-metadata pyclipper `
  --copy-metadata pypdfium2 `
  --copy-metadata python-bidi `
  --copy-metadata shapely `
  (Join-Path $root "scripts\engine_main.py")
if ($LASTEXITCODE) { throw "PyInstaller build failed." }
Remove-Item $Output -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Output -Force | Out-Null
Copy-Item (Join-Path $dist "ocr_engine\*") $Output -Recurse -Force
foreach ($modelName in @("PP-OCRv5_mobile_det", "PP-OCRv5_mobile_rec")) {
  $modelSource = Join-Path $paddlexModels $modelName
  if (!(Test-Path $modelSource)) { throw "Required offline PP-OCRv5 model missing: $modelSource" }
  $modelDestination = Join-Path $Output "_internal\paddlex\official_models\$modelName"
  New-Item -ItemType Directory -Path (Split-Path $modelDestination) -Force | Out-Null
  Copy-Item $modelSource -Destination $modelDestination -Recurse -Force
}
if (!(Test-Path $hfCache)) { throw "Hugging Face model cache not found: $hfCache. Run OCR and VieNeu verification once before packaging." }
$bundledCache = Join-Path $Output "_internal\hf\hub"
New-Item -ItemType Directory -Path $bundledCache -Force | Out-Null
@("models--PaddlePaddle--*", "models--pnnbao-ump--VieNeu-TTS-v3-Turbo*", "models--pnnbao-ump--VieNeu-TTS-0.3B", "models--pnnbao-ump--VieNeu-TTS-0.3B-lora-ngoc-huyen", "models--OpenMOSS-Team--MOSS-Audio-Tokenizer-Nano-ONNX") | ForEach-Object {
  $matches = Get-ChildItem -Path $hfCache -Directory -Filter $_ -ErrorAction SilentlyContinue
  if (!$matches) { throw "Required offline model cache missing: $_" }
  $matches | ForEach-Object { Copy-Item $_.FullName -Destination $bundledCache -Recurse -Force }
}
$tokenizerModel = Join-Path $bundledCache "models--OpenMOSS-Team--MOSS-Audio-Tokenizer-Nano-ONNX\snapshots\ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae\moss_audio_tokenizer_decode_full.onnx"
if (!(Test-Path $tokenizerModel)) { throw "Required offline VieNeu tokenizer is missing: $tokenizerModel" }
Copy-Item "$cudaBin\*.dll" (Join-Path $root "resources\cuda-libs") -Force

$mediaDownloaderOutput = Join-Path $root "resources\media-downloader"
Remove-Item $mediaDownloaderOutput -Recurse -Force -ErrorAction SilentlyContinue
& $Python -m PyInstaller --noconfirm --clean --onefile --name yt-dlp --distpath $mediaDownloaderOutput `
  --collect-all yt_dlp `
  --collect-all curl_cffi `
  (Join-Path $root "scripts\yt_dlp_entry.py")
if ($LASTEXITCODE) { throw "PyInstaller media downloader build failed." }
Write-Host "PP-OCRv5 GPU engine (Paddle 3.1.1 / CUDA 11.8) ready: $Output"
