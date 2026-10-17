# مرجع الـ API — Veta Messenger

- **الرابط الأساسي:** `https://msg.veta.example.com/api/v1`
- **المصادقة:** كل طلب يحمل الهيدر `Authorization: Bearer vk_live_...` (أو `X-API-Key: vk_live_...`)
- **الصيغة:** JSON. كل رد يكون بالشكل `{"success": true, "data": ...}` أو `{"success": false, "error": {"code", "message", "details?"}}`
- **الأرقام:** تُقبل بأي صيغة: `+9647701234567` أو `009647701234567` أو `07701234567` (مع `DEFAULT_COUNTRY_CODE`)، والأرقام العربية `٠٧٧٠...` أيضاً. تُخزن دائماً بالصيغة الدولية بدون `+`.

| الكود | المعنى |
|---|---|
| 400 | خطأ في البيانات (`details` يوضح الحقل) |
| 401 | مفتاح API مفقود أو غير صالح |
| 403 | العملية تحتاج جلسة لوحة التحكم (مفاتيح API) |
| 404 | غير موجود |
| 409 | الرقم غير متصل / متصل مسبقاً |
| 429 | طلبات كثيرة (`retry_after` بالثواني + هيدر `Retry-After`) |

---

## الرسائل

### إرسال رسالة — `POST /messages`

```json
{
  "to": "+9647701234567",
  "channel": "auto",
  "type": "text",
  "text": "مرحباً بك في فيتا",
  "reference": "order-1234",
  "metadata": { "user_id": 55 }
}
```

| الحقل | الوصف |
|---|---|
| `to` | رقم المستلم، أو معرف مجموعة واتساب `...@g.us` |
| `channel` | `auto` (افتراضي: واتساب، وإن فشل أو الرقم ليس عليه واتساب يُرسل SMS) · `whatsapp` · `sms` |
| `type` | `text` · `image` · `video` · `audio` · `document` · `location` (غير النص لواتساب فقط) |
| `text` | النص، أو التعليق على الصورة/الملف (يُقبل أيضاً `message` أو `body`) |
| `media_url` | رابط الملف (للوسائط) |
| `media_base64` | بديل عن `media_url`: محتوى الملف base64 أو `data:image/png;base64,...` |
| `filename`, `mimetype` | للملفات (`document`) |
| `ptt` | `true` لإرسال الصوت كرسالة صوتية |
| `latitude`, `longitude`, `location_name`, `address` | للموقع |
| `instance_id` | رقم واتساب محدد (وإلا يُستخدم الافتراضي/المتاح) |
| `device_id`, `sim` | هاتف SMS محدد / رقم الشريحة (1 أو 2) |
| `fallback` | `false` لإيقاف التحويل لـ SMS في `auto`. و`true` مع `whatsapp` أو `sms` لتفعيل التحويل للقناة الأخرى |
| `scheduled_at` | وقت إرسال لاحق (ISO 8601) |
| `reference` | معرّفك الخاص (يرجع في الـ webhooks ويمكن البحث به) |
| `metadata` | أي بيانات JSON تُعاد كما هي |

الرد (`201`) يحتوي الرسالة مع `id` و`status: "queued"`. الحالات بالترتيب: `queued` ← `sending` ← `sent` ← `delivered` ← `read`، أو `failed` / `cancelled`. الرسائل الواردة حالتها `received`.

اختصارات: `POST /whatsapp/send` و`POST /sms/send` (نفس الحقول مع تثبيت القناة).

### إرسال جماعي — `POST /messages/bulk`

```json
{ "defaults": { "channel": "whatsapp", "text": "تذكير بموعدك غداً" },
  "messages": [ { "to": "+9647700000001" }, { "to": "+9647700000002", "text": "نص مختلف" } ] }
```
حتى 1000 رسالة. يرجع نتيجة كل عنصر على حدة. الإرسال يتم بالتدريج مع فاصل عشوائي (حماية من الحظر).

### الاستعلام
- `GET /messages?channel=&status=&direction=inbound|outbound&phone=&reference=&since=&before=&limit=` (حتى 200)
- `GET /messages/{id}`
- `DELETE /messages/{id}` — إلغاء رسالة ما زالت `queued` (مثلاً المجدولة)

---

## OTP (رموز التحقق)

### `POST /otp/send`
```json
{ "phone": "07701234567", "purpose": "login", "channel": "auto", "ip": "203.0.113.5" }
```
| الحقل | الوصف |
|---|---|
| `purpose` | غرض الرمز (`login`, `register`, `reset_password`...). الرمز الجديد يلغي القديم لنفس الغرض |
| `channel` | `auto` (واتساب ثم SMS) · `whatsapp` · `sms` |
| `length` | 4-10 (الافتراضي `OTP_LENGTH`) |
| `expires_in` | بالثواني، 30-3600 |
| `template` | نص مخصص يجب أن يحتوي `{code}`، ويدعم `{minutes}` و`{app}` |
| `ip` | IP المستخدم (للسجل فقط) |

الرد:
```json
{ "id": "otp_...", "phone": "9647701234567", "channel": "whatsapp", "fallback_channel": "sms",
  "message_id": "msg_...", "expires_at": "2026-10-17T14:22:27.773Z", "resend_after": 60 }
```
حدود الحماية: رمز واحد كل `OTP_RESEND_COOLDOWN_SEC` لنفس الرقم والغرض، و`OTP_MAX_PER_HOUR` رموز في الساعة للرقم. عند تجاوزها: `429`.

### `POST /otp/verify`
```json
{ "phone": "07701234567", "purpose": "login", "code": "123456" }
```
الرد دائماً `200`:
```json
{ "valid": true, "otp_id": "otp_...", "phone": "9647701234567", "purpose": "login" }
{ "valid": false, "reason": "invalid_code", "attempts_left": 3 }
```
قيم `reason`: `invalid_code` · `expired` · `too_many_attempts` · `already_used` · `replaced` · `not_found`.

الرمز يُخزن كبصمة HMAC فقط، يُستخدم مرة واحدة، ويُقفل بعد `OTP_MAX_ATTEMPTS` محاولات خاطئة.

- `GET /otp/{id}` — حالة رمز · `GET /otp?limit=` — آخر الرموز

---

## أرقام واتساب (Instances)

| الطلب | الوصف |
|---|---|
| `GET /instances` | القائمة مع الحالة: `connecting` · `qr` · `connected` · `disconnected` · `logged_out` |
| `POST /instances` `{ "name": "..." }` | إنشاء رقم جديد وبدء الاتصال (أول رقم يصبح الافتراضي) |
| `GET /instances/{id}/qr` | `{ status, qr, qr_image }` — `qr_image` صورة PNG بصيغة data URL |
| `POST /instances/{id}/pairing-code` `{ "phone": "9647..." }` | كود ربط بدل QR |
| `POST /instances/{id}/connect` · `/restart` · `/logout` | تحكم بالاتصال |
| `PATCH /instances/{id}` `{ "name", "is_default": true }` | تعديل |
| `DELETE /instances/{id}` | حذف وتسجيل خروج |
| `GET /instances/{id}/groups` | المجموعات (لإرسال رسائل لـ `...@g.us`) |
| `POST /whatsapp/check` `{ "phones": ["+964..."] }` | هل الأرقام مسجلة على واتساب؟ |

---

## هواتف SMS

| الطلب | الوصف |
|---|---|
| `GET /devices` | الهواتف مع `online` والبطارية والشرائح وآخر اتصال |
| `POST /devices` `{ "name": "..." }` | إنشاء هاتف ← يرجع `token` و`pairing_qr` (يظهر مرة واحدة) |
| `PATCH /devices/{id}` `{ "enabled": false }` | تعطيل/تفعيل |
| `POST /devices/{id}/rotate-token` | رمز ربط جديد (يُبطل القديم) |
| `DELETE /devices/{id}` | حذف |

إذا كان أكثر من هاتف متصلاً تتوزع الرسائل بينها تلقائياً.

---

## Webhooks

| الطلب | الوصف |
|---|---|
| `POST /webhooks` `{ "url": "https://...", "events": ["*"] }` | إنشاء (يرجع `secret` للتوقيع) |
| `GET /webhooks` · `PATCH /webhooks/{id}` · `DELETE /webhooks/{id}` | إدارة. `PATCH` مع `"rotate_secret": true` يولد مفتاحاً جديداً |
| `POST /webhooks/{id}/test` | إرسال حدث `webhook.test` |
| `GET /webhooks/{id}/deliveries` | سجل الإرسال |
| `POST /webhook-deliveries/{id}/retry` | إعادة إرسال |

**الأحداث:** `message.received` · `message.sent` · `message.delivered` · `message.read` · `message.failed` · `otp.verified` · `instance.connected` · `instance.disconnected` · `instance.logged_out` · `device.online` · `device.offline` (أو `*` للكل). يمكن ربط webhook برقم واتساب معين عبر `instance_id`.

**شكل الطلب:**
```http
POST /your/endpoint
Content-Type: application/json
X-Veta-Event: message.received
X-Veta-Delivery: evt_...
X-Veta-Timestamp: 1760710647
X-Veta-Signature: sha256=<hex>

{ "id": "evt_...", "event": "message.received", "created_at": "...",
  "data": { "id": "msg_...", "direction": "inbound", "channel": "whatsapp", "from": "9647701234567",
            "push_name": "أحمد", "type": "text", "text": "مرحبا", "media_url": null, ... } }
```

**التحقق من التوقيع:** `X-Veta-Signature == "sha256=" + HMAC_SHA256(secret, timestamp + "." + rawBody)`، ويُفضّل رفض الطلبات التي يزيد عمر `X-Veta-Timestamp` فيها عن 5 دقائق.

**إعادة المحاولة:** أي رد غير 2xx (أو مهلة 10 ثوانٍ) يُعاد بعد 10ث، 30ث، 2د، 10د، 30د، 1س، 3س ثم يتوقف. استخدم `X-Veta-Delivery` لتجاهل التكرار.

الوسائط الواردة (صور/ملفات واتساب) تُحفظ على السيرفر، و`media_url` رابط موقّع يمكن تحميله مباشرة.

---

## الحالة العامة — `GET /status`
عدد أرقام واتساب المتصلة وهواتف SMS المتصلة وإحصائيات آخر 24 ساعة.

---

## API الخاص بتطبيق الأندرويد (`/api/device/v1`)
يستخدمه تطبيق Veta SMS Gateway فقط، بالهيدر `Authorization: Bearer vmd_...`:

| الطلب | الوصف |
|---|---|
| `POST /heartbeat` | معلومات الجهاز (البطارية، الشرائح...) ← يرجع الإعدادات |
| `GET /outbox?wait=25&limit=5` | long-poll: ينتظر حتى تتوفر رسائل ويحجزها للهاتف |
| `POST /status` `{ "id", "status": "sent|delivered|failed", "error" }` | نتيجة الإرسال (أو `{ "updates": [...] }`) |
| `POST /inbox` `{ "from", "text", "received_at", "sim" }` | رسالة SMS واردة (أو `{ "messages": [...] }`) |
