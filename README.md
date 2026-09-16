<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

## Run Locally

**Prerequisites:** Node.js 20+


1. Install dependencies: `npm install`
2. Set Gemini/Custom API keys in the Settings page.
3. Start the app: `npm run dev`

## OCR engine

PaddleOCR runs natively in the Node/Express process through `ppu-paddle-ocr`
and `onnxruntime-node`; Python is not required. PP-OCRv6 detection,
recognition, and dictionary assets are loaded once from `models/paddle-ocr`
and reused by all OCR requests. Gemini/Custom APIs receive text only for the
translation step. Run an isolated image check with:

`npm run ocr:verify -- path/to/frame.png`
