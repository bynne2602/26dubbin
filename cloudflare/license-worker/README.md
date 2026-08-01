# DubbinTool License Worker

Đây là Worker đang phục vụ `dubbintool.io.vn/admin`, API cấp/xác thực
license và đăng ký trial.

Triển khai từ thư mục gốc repository:

```powershell
npx wrangler deploy --config cloudflare/license-worker/wrangler.json
```

Không triển khai nhầm cấu hình legacy tại `cloudflare-worker/wrangler.toml`.
Cấu hình hiện tại phải giữ cả custom-domain routes và `workers_dev: true`, vì
ứng dụng desktop vẫn xác thực license qua hostname `workers.dev`.
