# Hướng dẫn cài đặt & vận hành hola-autoreply trên OpenClaw

## Mục lục
1. [Cài đặt plugin](#1-cài-đặt-plugin)
2. [Cấu hình OpenClaw cho Zalo](#2-cấu-hình-openclaw-cho-zalo)
3. [Cấu hình FAQ](#3-cấu-hình-faq)
4. [Kiểm tra hoạt động](#4-kiểm-tra-hoạt-động)
5. [Xử lý sự cố thường gặp](#5-xử-lý-sự-cố-thường-gặp)
6. [Quản lý session Zalo](#6-quản-lý-session-zalo)
7. [Xóa sạch để cài lại từ đầu](#7-xóa-sạch-để-cài-lại-từ-đầu)

---

## 1. Cài đặt plugin

```bash
# Cài lần đầu
openclaw plugins install /đường/dẫn/tới/hola-autoreply

# Cài đè nếu đã tồn tại
openclaw plugins install --force /đường/dẫn/tới/hola-autoreply

# Dùng --link khi đang phát triển (sửa code không cần cài lại)
openclaw plugins install --link /đường/dẫn/tới/hola-autoreply

# Restart gateway sau khi cài
openclaw gateway restart
```

> **Lưu ý:** Plugin được copy vào `~/.openclaw/extensions/hola-autoreply/`. Nếu dùng copy (không --link), sửa source gốc phải chạy install --force lại.

---

## 2. Cấu hình OpenClaw cho Zalo

File config: `~/.openclaw/openclaw.json`

### Cấu hình mẫu đầy đủ cho auto-reply

```json
"channels": {
  "zalouser": {
    "enabled": true,
    "dmPolicy": "pairing",
    "groupPolicy": "allowlist",
    "groupAllowFrom": ["*"],
    "groups": {
      "GROUP_ID_1": {
        "enabled": true,
        "requireMention": false
      },
      "GROUP_ID_2": {
        "enabled": true,
        "requireMention": false
      }
    }
  }
}
```

### Các field quan trọng

#### `requireMention` (mặc định: true)
- **Phải đặt `false`** nếu muốn auto-reply cho mọi tin nhắn trong group
- Nếu để `true`: bot chỉ xử lý khi bị @mention trong group → `inbound_claim` không bao giờ được gọi với tin nhắn thường

#### `groupAllowFrom: ["*"]`
- **Bắt buộc phải có** nếu có cấu hình `groups` và muốn cho phép tất cả thành viên nhắn tin
- Nếu thiếu field này: `senderGroupPolicy = "allowlist"` với allowlist rỗng → **block tất cả thành viên group**
- Logic: khi có `groups` config nhưng không có `groupAllowFrom` → OpenClaw dùng `groupPolicy` làm sender policy → "allowlist" với 0 entry = không ai được phép

#### `dmPolicy`
- `"pairing"` *(mặc định)*: user DM lần đầu nhận thử thách pairing, cần approve thủ công
- `"open"`: cho phép tất cả DM mà không cần pairing

#### `groupPolicy`
- `"allowlist"`: chỉ các group có ID trong `groups` config mới được xử lý
- `"open"`: tất cả group đều được xử lý (không cần khai báo group ID)

### Lấy Group ID
Group ID là chuỗi số dài, lấy bằng:
```bash
openclaw directory groups list --channel zalouser
```

### Config thay đổi hot-reload
OpenClaw tự detect thay đổi trong `openclaw.json` và reload — **không cần restart gateway** khi sửa config (trừ khi thêm plugin mới).

---

## 3. Cấu hình FAQ

File FAQ: `~/.openclaw/extensions/hola-autoreply/faq.json`

### Cấu trúc

```json
[
  {
    "question": "câu hỏi chính",
    "aliases": ["cách nói khác 1", "cách nói khác 2"],
    "answer": "câu trả lời"
  }
]
```

### Cơ chế match (theo thứ tự ưu tiên)
1. **Exact question**: khớp chính xác với `question`
2. **Exact alias**: khớp chính xác với một trong `aliases`
3. **Fuzzy (Fuse.js)**: khớp gần đúng với ngưỡng score ≤ 0.35, loại bỏ nếu có 2 kết quả gần nhau (ambiguous)

### Hot-reload FAQ
Sửa `faq.json` trực tiếp tại `~/.openclaw/extensions/hola-autoreply/faq.json` — **không cần restart gateway**, plugin đọc lại file mỗi tin nhắn.

---

## 4. Kiểm tra hoạt động

### Xem log quyết định reply theo thời gian thực
```bash
tail -f ~/.openclaw/logs/faq-autoreply.jsonl
```

Ví dụ log thành công:
```json
{"incomingMessage":"how r u","matchedFaq":"how are you","fuseScore":0,"matchType":"exact_alias","reply":"I'm doing great. Thanks for asking!"}
```

Ví dụ log không match:
```json
{"incomingMessage":"are u ok","matchedFaq":null,"matchType":"fuzzy","skippedReason":"no_fuzzy_match"}
```

**`skippedReason` có thể là:**
- `no_fuzzy_match`: không tìm được match
- `weak_match`: score quá cao (> 0.35), không đủ tự tin
- `ambiguous_match`: 2 FAQ có score gần nhau, không chọn được
- `empty_message`: tin nhắn rỗng
- `no_faqs`: faq.json rỗng hoặc lỗi đọc file
- `own_message`: tin nhắn của chính bot

### Kiểm tra plugin đã load
```bash
openclaw plugins list | grep hola
# Kết quả mong muốn: Status = enabled, loaded
```

### Kiểm tra trạng thái gateway và channel
```bash
openclaw channels status --deep
openclaw health
```

---

## 5. Xử lý sự cố thường gặp

### Bot thấy tin nhắn nhưng không reply

**Bước 1:** Kiểm tra log xem plugin có xử lý không:
```bash
tail -5 ~/.openclaw/logs/faq-autoreply.jsonl
```
- Nếu **có entry** → plugin chạy, xem `skippedReason` để biết lý do không reply
- Nếu **không có entry** → tin nhắn bị block trước khi đến plugin (xem Bước 2)

**Bước 2:** Nếu không có entry trong log, kiểm tra gateway log:
```bash
openclaw logs 2>&1 | grep -i "hola\|faq\|error" | tail -20
```

**Nguyên nhân phổ biến khi không có log entry:**
| Triệu chứng | Nguyên nhân | Cách sửa |
|---|---|---|
| DM không vào | `dmPolicy: "pairing"`, user chưa approve | `openclaw pairing approve zalouser <CODE>` |
| Group không vào | Thiếu `groupAllowFrom: ["*"]` | Thêm vào openclaw.json |
| Group không vào | `requireMention: true` | Đổi thành `false` |
| Group không vào | Group ID sai | Kiểm tra lại ID bằng `openclaw directory groups list` |

### Plugin load lỗi `await is not defined`

OpenClaw plugin loader không hỗ trợ top-level `await`. Kiểm tra `index.js` không có:
```js
// SAI - gây lỗi
const x = await import("...");

// ĐÚNG - lazy import trong function
let _cached;
async function get() {
  if (!_cached) _cached = (await import("...")).fn;
  return _cached;
}
```

### Plugin không nhận tin nhắn từ user DM mới

User nhận được pairing challenge. Hai cách xử lý:
```bash
# Cách 1: approve từng user
openclaw pairing approve zalouser <PAIRING_CODE>

# Cách 2: thêm vào allowFrom (whitelist vĩnh viễn)
# Trong openclaw.json, thêm vào channels.zalouser:
"allowFrom": ["USER_ID_1", "USER_ID_2"]

# Cách 3: cho phép tất cả (không cần pairing)
# Đổi dmPolicy thành "open"
```

---

## 6. Quản lý session Zalo

### Kiểm tra trạng thái
```bash
openclaw channels status --deep
```

### Đăng nhập lại khi hết phiên
```bash
# Logout session cũ
openclaw channels logout --channel zalouser

# Login lại (scan QR nếu cần)
openclaw channels login --channel zalouser
```

Hoặc dùng guided setup:
```bash
openclaw channels add
```

> **Lưu ý:** Zalo có thể thu hồi session bất kỳ lúc nào (đổi mật khẩu, đăng xuất từ thiết bị khác). Không có cơ chế refresh tự động — khi hết hạn bắt buộc scan QR lại. OpenClaw không gửi thông báo chủ động khi session hết hạn, phải tự check bằng `openclaw channels status`.

---

## 7. Xóa sạch để cài lại từ đầu

Thực hiện theo thứ tự, **dừng OpenClaw trước**:

```bash
# 1. Xóa plugin extension
rm -rf ~/.openclaw/extensions/hola-autoreply

# 2. Restore monitor file về bản gốc (nếu đang dùng patch-based plugin)
BACKUP=$(find ~/.openclaw/npm/node_modules/@openclaw/zalouser/dist -name "*.bak")
if [ -n "$BACKUP" ]; then
  ORIG="${BACKUP%.bak}"
  cp "$BACKUP" "$ORIG" && rm "$BACKUP"
  echo "Restored: $ORIG"
fi

# 3. Xóa logs & cache
rm -f ~/.openclaw/logs/faq-autoreply.jsonl
rm -f ~/.openclaw/logs/zalouser-faq-auto-replies.jsonl
rm -f ~/.openclaw/logs/zalouser-faq-processed.json

# 4. Xóa credentials & pairing Zalo
rm -rf ~/.openclaw/credentials/zalouser
rm -f ~/.openclaw/credentials/zalouser-pairing.json
rm -f ~/.openclaw/credentials/zalouser-default-allowFrom.json
```

Sau đó sửa `~/.openclaw/openclaw.json`:
- Xóa block `channels.zalouser`
- Xóa entry `plugins.entries.hola-autoreply` (hoặc `zalouser-faq-autoreply`)

Khởi động lại OpenClaw → cài plugin mới → cấu hình lại từ đầu.
