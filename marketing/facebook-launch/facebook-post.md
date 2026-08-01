# Bài đăng Facebook giới thiệu DubbinTool

🚀 **BIẾN VIDEO NƯỚC NGOÀI THÀNH VIDEO THUYẾT MINH TIẾNG VIỆT — CHỈ TRONG MỘT TOOL**

Mình vừa hoàn thiện phiên bản mới của **DubbinTool – AI Dubbing Studio**, công cụ hỗ trợ tự động hóa gần như toàn bộ quy trình làm video thuyết minh:

✅ Nhận diện phụ đề cứng bằng PaddleOCR  
✅ Lọc và gộp các câu OCR bị trùng  
✅ Dịch phụ đề theo ngữ cảnh, glossary và văn phong riêng  
✅ Tạo giọng đọc TikTok/VieNeu TTS  
✅ Smart TTS tự căn thời lượng, tận dụng khoảng nghỉ và hạn chế méo giọng  
✅ Làm mờ phụ đề gốc, watermark hoặc vùng tùy chọn  
✅ Chỉnh phụ đề, timeline, font chữ và tỷ lệ khung hình  
✅ Xuất SRT, WAV và video hoàn chỉnh  
✅ Render bằng NVIDIA NVENC, Intel Quick Sync hoặc AMD AMF nếu thiết bị hỗ trợ  
✅ Tự lưu checkpoint — lỗi ở đâu có thể tiếp tục từ đó, không phải làm lại từ đầu

Điểm mình tập trung nhiều nhất không phải chỉ là “dịch được”, mà là tạo ra một workflow đủ ổn định cho video dài:

**Video → OCR → Dịch → Smart TTS → Kiểm tra → Render**

Mỗi giai đoạn đều có tiến trình rõ ràng, có thể tạm dừng hoặc hủy. Bước render chỉ ghép những tài nguyên đã chuẩn bị xong, không gọi lại AI/TTS khiến người dùng phải chờ lại từ đầu.

Phiên bản hiện tại cũng đã có **FFmpeg Runtime Manager**: tool tự kiểm tra GPU, chọn encoder phù hợp và tự tải runtime nếu máy còn thiếu. Máy không có card rời vẫn chạy bằng CPU.

🎬 Video bên dưới là một sản phẩm được xử lý và xuất trực tiếp bằng DubbinTool.

Phù hợp với:

• Kênh review phim, hoạt hình và truyện tranh  
• Video TikTok, Shorts, Reels  
• Podcast và video thuyết minh  
• Người làm nội dung số lượng lớn  
• Team muốn giảm thời gian OCR, dịch, tạo giọng và dựng video

🌐 Website: https://dubbintool.io.vn  
👥 Tham gia group Zalo: https://zalo.me/g/mjtdnc945

Ai muốn trải nghiệm hoặc cần mình hướng dẫn workflow thì để lại bình luận/inbox nhé.

#DubbinTool #AIDubbing #SmartTTS #PaddleOCR #VideoAutomation #TikTokTTS #ContentCreator #AITranslation

## Thứ tự media khi đăng

1. `01-tool-auto.png` — ảnh tổng quan Tool Auto.
2. `02-smart-tts.png` — màn hình Smart TTS và checkpoint.
3. `03-goi-dich-vu.png` — giao diện gói dịch vụ.
4. `04-video-result.jpg` — ảnh bìa sản phẩm đầu ra.
5. Video `final-好人有好报嗷 #自制动画#轻漫计划.mp4` — đăng cuối carousel hoặc đăng kèm bài.

## Tiêu đề ngắn để đặt lên ảnh bìa

**Một tool cho toàn bộ quy trình OCR → Dịch → TTS → Render**
