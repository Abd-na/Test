# Veta Messenger

منصة رسائل خاصة بك (بديل Hypersender) تعمل على نفس سيرفر **فيتا** بقاعدة بيانات **مستقلة** اسمها `sms_wa_gateway` (على نفس خادم MySQL، دون لمس قاعدة فيتا)، لإرسال واستقبال رسائل **واتساب** و**SMS** بدون أي اشتراك شهري.

- **واتساب:** تربط رقمك عن طريق مسح QR (مثل واتساب ويب) عبر مكتبة [Baileys](https://github.com/WhiskeySockets/Baileys). تستطيع ربط أكثر من رقم.
- **SMS:** هاتف أندرويد فيه شريحة يتحول إلى بوابة باستخدام تطبيق **Veta SMS Gateway** (Flutter) الموجود في هذا المستودع. الرسائل تُرسل من رصيد الشريحة.
- **OTP:** إرسال رموز التحقق والتحقق منها، مع التحويل التلقائي من واتساب إلى SMS إذا لم يكن الرقم على واتساب.
- **Webhooks:** الرسائل الواردة وحالات التسليم والقراءة تصل لتطبيق فيتا بطلبات موقّعة وإعادة محاولة تلقائية.
- **لوحة تحكم عربية:** ربط الأرقام والهواتف، إنشاء مفاتيح API، سجل الرسائل، تجربة الإرسال.
- **في النهاية تحصل على مفتاح API واحد** تضعه في تطبيق فيتا.

```
 تطبيق فيتا ──(API key)──▶  Veta Messenger  ──▶ واتساب (رقمك المربوط)
     ▲                      │   MySQL: قاعدة sms_wa_gateway
     └──── webhooks ◀───────┤
                            └──◀ long-poll ── هاتف أندرويد (تطبيق Veta SMS Gateway) ──▶ SMS
```

## محتويات المستودع

| المجلد | المحتوى |
|---|---|
| `server/` | المنصة (Node.js): الـ API، الطابور، واتساب، OTP، الـ webhooks، لوحة التحكم |
| `mobile/` | تطبيق Veta SMS Gateway (Flutter): الواجهة بـ Dart، ومحرك الإرسال في الخلفية بـ Kotlin |
| `examples/laravel/` | كلاس جاهز لفيتا + Controller للـ webhooks + مثال تسجيل دخول بـ OTP |
| `examples/node/` | عميل Node.js بسيط |
| `docs/API.md` | مرجع كامل لكل الـ endpoints |
| `deploy/` | إعداد Nginx و systemd |

---

## التثبيت على سيرفر فيتا

### الطريقة السريعة (أمر واحد)
ادخل إلى السيرفر بنفسك عبر SSH ثم شغّل:
```bash
curl -fsSL https://raw.githubusercontent.com/Abd-na/Test/claude/fervent-ride-xm2fik/deploy/install.sh | bash
```
السكربت يقوم بكل الخطوات التالية تلقائياً:
- ينشئ قاعدة بيانات مستقلة `sms_wa_gateway` ومستخدماً خاصاً بها لا يستطيع الوصول إلا إليها. يدخل إلى MySQL كمدير تلقائياً عبر `sudo`، وإن لم ينجح يطلب كلمة مرور root لـ MySQL مرة واحدة.
- يثبّت Node.js و PM2 إن لم يكونا موجودين.
- ينشئ جداول المنصة داخلها.
- يجهّز Nginx (أو Apache إن كان فيتا يعمل عليه) مع شهادة SSL مجانية.
- يطبع في النهاية **كلمة مرور لوحة التحكم** و**مفتاح API**.

لإضافة نطاق لاحقاً: `DOMAIN=msg.example.com bash /opt/veta-messenger/deploy/install.sh`. ولتحديث المنصة شغّل نفس الأمر مرة أخرى، وستبقى إعداداتك كما هي.

### الطريقة اليدوية

### المتطلبات
- Node.js 20.12 أو أحدث (يُنصح بـ 22) **أو** Docker
- MySQL 5.7+/8 أو MariaDB 10.4+ (نفس الخادم الذي يستخدمه فيتا، بقاعدة بيانات منفصلة)
- Nginx (موجود غالباً لفيتا)

### 1) تنزيل المنصة
```bash
cd /var/www
git clone <repo-url> veta-messenger
cd veta-messenger/server
cp .env.example .env
```

### 2) الإعداد (`server/.env`)
أنشئ قاعدة البيانات والمستخدم أولاً (مرة واحدة):
```sql
CREATE DATABASE sms_wa_gateway CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'sms_wa_gateway'@'localhost' IDENTIFIED BY 'كلمة-مرور-قوية';
CREATE USER 'sms_wa_gateway'@'127.0.0.1' IDENTIFIED BY 'كلمة-مرور-قوية';
GRANT ALL ON sms_wa_gateway.* TO 'sms_wa_gateway'@'localhost', 'sms_wa_gateway'@'127.0.0.1';
```
ثم في `.env`:
```env
PUBLIC_URL=https://msg.veta.example.com
APP_SECRET=        # openssl rand -hex 32
ADMIN_PASSWORD=    # كلمة مرور لوحة التحكم

DB_HOST=127.0.0.1
DB_DATABASE=sms_wa_gateway
DB_USERNAME=sms_wa_gateway
DB_PASSWORD=كلمة-مرور-قوية

DEFAULT_COUNTRY_CODE=964   # رمز دولتك للأرقام التي تبدأ بـ 0
```
> الجداول تُنشأ تلقائياً عند أول تشغيل (مثل `vm_messages`، `vm_otps`).

### 3) التشغيل — اختر طريقة واحدة

**أ) PM2 (الأبسط إذا كان Node مثبتاً):**
```bash
npm ci --omit=dev
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

**ب) Docker:**
```bash
docker compose up -d --build
```
(يعمل بـ `network_mode: host` حتى يصل إلى MySQL على `127.0.0.1`.)

**ج) systemd:** انظر `deploy/veta-messenger.service`.

> شغّل نسخة واحدة فقط من المنصة، لأن جلسات واتساب والطابور تعمل داخل عملية واحدة.

### 4) Nginx + SSL
```bash
sudo cp ../deploy/nginx.conf /etc/nginx/sites-available/veta-messenger
# عدّل server_name إلى نطاقك
sudo ln -s /etc/nginx/sites-available/veta-messenger /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d msg.veta.example.com
```

### 5) احصل على مفتاح API
من لوحة التحكم ← **مفاتيح API** ← إنشاء مفتاح، أو من الطرفية:
```bash
cd server && npm run key:create -- "Veta app"
#   VETA_MESSENGER_KEY=vk_live_xxxxxxxxxxxxxxxx
```
المفتاح يظهر مرة واحدة فقط (يُخزن كبصمة).

---

## ربط واتساب
1. افتح `https://msg.veta.example.com` وسجّل الدخول بـ `ADMIN_PASSWORD`.
2. **واتساب** ← إضافة رقم واتساب ← يظهر رمز QR.
3. على الهاتف: واتساب ← الإعدادات ← **الأجهزة المرتبطة** ← ربط جهاز ← امسح الرمز. (أو استخدم "كود الربط" بالرقم.)

الجلسة تُحفظ في قاعدة البيانات، فلا تحتاج لإعادة المسح بعد إعادة تشغيل السيرفر.

**لتقليل خطر الحظر:** استخدم رقماً مخصصاً (يُفضّل WhatsApp Business)، وأرسل لأشخاص يتوقعون رسائلك (OTP، تأكيد الطلبات)، وتجنب الإرسال الجماعي لأرقام غريبة. المنصة تضيف فاصلاً عشوائياً بين الرسائل وتُظهر "يكتب..." قبل الإرسال. هذه طريقة غير رسمية (ليست WhatsApp Cloud API) فالحظر ممكن نظرياً مع سوء الاستخدام.

## ربط هاتف SMS
1. **ملف التطبيق (APK):** يُبنى تلقائياً عبر GitHub Actions مع كل تعديل على مجلد `mobile/`. من تبويب **Actions** ← **Android APK (Flutter)** ← آخر تشغيل ← حمّل `veta-sms-gateway-apk`. أو محلياً:
   ```bash
   cd mobile && flutter build apk --release
   # الملف: build/app/outputs/flutter-apk/app-release.apk
   ```
2. ثبّت التطبيق على هاتف أندرويد 7 أو أحدث، فيه شريحة ورصيد، ومتصل بالإنترنت (واي فاي أو بيانات).
3. في لوحة التحكم: **هواتف SMS** ← إضافة هاتف ← يظهر رمز QR.
4. في التطبيق: **مسح رمز QR** ← امنح صلاحيات الرسائل ← **إيقاف تحسين البطارية** ← شغّل المفتاح.

الهاتف هو من يتصل بالسيرفر (long-polling)، فلا يحتاج IP ثابت ولا فتح منافذ. يُفضّل إبقاؤه على الشاحن. الرسائل الواردة على الشريحة تصل لفيتا عبر الـ webhook `message.received`، ويمكن ربط أكثر من هاتف لتوزيع الحمل.

> لتثبيت تحديثات التطبيق فوق النسخة القديمة يجب أن تُوقَّع كل النسخ بنفس المفتاح. أنشئ keystore مرة واحدة وأضفه إلى GitHub Secrets: `ANDROID_KEYSTORE_BASE64`، `ANDROID_KEYSTORE_PASSWORD`، `ANDROID_KEY_ALIAS`، `ANDROID_KEY_PASSWORD`. بدونها يُستخدم مفتاح debug مؤقت (وقتها يجب حذف التطبيق قبل تثبيت نسخة جديدة).

---

### استخدامه كتطبيق الرسائل الافتراضي

التطبيق فيه تبويبان: **الرسائل** (تطبيق رسائل كامل) و**البوابة** (الربط مع السيرفر). من تبويب الرسائل اضغط "تعيين كتطبيق افتراضي". بعدها:

- تصلك الرسائل في التطبيق مع إشعارات، وتظهر كل المحادثات القديمة.
- ترسل وترد من التطبيق، وتظهر حالة كل رسالة: ⏱ جاري الإرسال ← ✓ أُرسلت ← ✓✓ وصلت، أو فشلت مع إعادة المحاولة.
- رسائل البوابة (OTP وغيرها) تظهر هي أيضاً في محادثاتها.
- يعمل حذف المحادثات وتعليمها كمقروءة، وروابط `sms:` من أي تطبيق، والرد السريع من شاشة المكالمة.
- تظهر أسماء جهات الاتصال بعد منح صلاحية جهات الاتصال (زر في أعلى صفحة الرسائل).

**لا يدعم رسائل الوسائط (MMS):** عند وصول MMS يظهر إشعار ينبهك بذلك، لكن الرسالة نفسها لا تُعرض. وما دام التطبيق هو الافتراضي، فلن تستطيع فتح هذه الرسالة لاحقاً من تطبيق آخر.

في أندرويد 13 وما بعده، إذا لم تظهر نافذة "التطبيق الافتراضي" فاسمح أولاً بـ"الإعدادات المقيدة" للتطبيق (الخطوات في القسم التالي).

للرجوع إلى تطبيق الرسائل الأصلي: الإعدادات ← التطبيقات ← التطبيقات الافتراضية ← تطبيق الرسائل. المحادثات محفوظة في مخزن رسائل الهاتف المشترك، فلن تضيع.

### إذا لم تصل رسائل SMS

1. **جرّب من الهاتف مباشرة:** في التطبيق ← "اختبار الشريحة" ← إرسال رسالة تجريبية، ثم راقب سجل النشاط. إن فشلت هنا فالمشكلة في الهاتف أو الشريحة وليست في السيرفر.
2. **جرّب عبر السيرفر:** لوحة التحكم ← هواتف SMS ← زر "SMS تجريبي". تظهر نافذة تتابع حالة الرسالة لحظة بلحظة مع سبب الفشل إن وُجد.
   > في صفحة "إرسال تجريبي" إذا اخترت القناة "تلقائي" فالرسالة تذهب عبر **واتساب** عندما يكون متصلاً. اختر "SMS فقط" لاختبار الـ SMS.
3. **صلاحية الرسائل في أندرويد 13 وما بعده:** التطبيقات المثبتة من ملف APK (خارج Google Play) تُمنع من صلاحية الـ SMS حتى تسمح بذلك يدوياً:
   1. افتح الإعدادات ← التطبيقات ← Veta SMS Gateway.
   2. اضغط ⋮ ← **السماح بالإعدادات المقيدة**.
   3. ارجع إلى الأذونات ← الرسائل القصيرة ← سماح.
4. **هواتف شاومي/ريدمي/بوكو:** الإعدادات ← التطبيقات ← Veta SMS Gateway ← الأذونات ← **أذونات أخرى** ← "إرسال الرسائل" ← سماح.
5. **لا يلزم أن يكون التطبيق "تطبيق الرسائل الافتراضي" لكي تعمل البوابة.** أندرويد يسمح لأي تطبيق لديه صلاحية `SEND_SMS` بالإرسال، لكن جعله افتراضياً يتيح لك استخدامه كتطبيق رسائل كامل (القسم السابق).
6. **حد أندرويد للإرسال:** أندرويد يطلب تأكيداً عند إرسال أكثر من 30 رسالة خلال 30 دقيقة. لرفع الحد على هاتف البوابة، فعّل "تصحيح USB" ونفّذ من الكمبيوتر:
   ```bash
   adb shell settings put global sms_outgoing_check_max_count 100000
   adb shell settings put global sms_outgoing_check_interval_ms 60000
   ```
7. **هواتف بشريحتين:** التطبيق يستخدم الشريحة المحددة لرسائل SMS في الإعدادات، وإن لم تكن محددة فالأولى. ويمكن تحديد الشريحة لكل رسالة عبر الحقل `sim` (1 أو 2) في الـ API.

---

## الاستخدام من فيتا (Laravel)

1. انسخ `examples/laravel/VetaMessenger.php` إلى `app/Services/`.
2. في `.env` لفيتا:
   ```env
   VETA_MESSENGER_URL=https://msg.veta.example.com
   VETA_MESSENGER_KEY=vk_live_...
   VETA_MESSENGER_WEBHOOK_SECRET=whsec_...
   ```
3. في `config/services.php`:
   ```php
   'veta_messenger' => [
       'url' => env('VETA_MESSENGER_URL'),
       'key' => env('VETA_MESSENGER_KEY'),
       'webhook_secret' => env('VETA_MESSENGER_WEBHOOK_SECRET'),
   ],
   ```
4. الاستخدام:
   ```php
   $messenger = app(\App\Services\VetaMessenger::class);

   $messenger->send('+9647701234567', 'تم تأكيد طلبك رقم 1234');          // واتساب، وإن تعذر يُرسل SMS
   $messenger->sms('07701234567', 'رسالة SMS فقط');
   $messenger->media('+9647701234567', 'document', 'https://veta.example.com/invoice.pdf', 'فاتورتك', 'invoice.pdf');

   $messenger->sendOtp($phone, 'login');                   // يرسل الرمز
   $ok = $messenger->verifyOtp($phone, $code, 'login');    // true / false
   ```
5. لاستقبال الرسائل الواردة وحالات التسليم: انسخ `VetaMessengerWebhookController.php`، أضف المسار في `routes/api.php`، ثم أنشئ webhook من لوحة التحكم إلى `https://veta.example.com/api/webhooks/messenger` وضع الـ secret في `.env`.

أي لغة أخرى: مجرد طلبات HTTP، انظر `docs/API.md` و`examples/node/`.

```bash
curl -X POST https://msg.veta.example.com/api/v1/otp/send \
  -H "Authorization: Bearer $VETA_MESSENGER_KEY" -H "Content-Type: application/json" \
  -d '{"phone":"+9647701234567","purpose":"login"}'
```

---

## عن تطبيق Flutter

- **الواجهة (Dart):** `mobile/lib/` — الربط بمسح QR أو يدوياً، الحالة، الصلاحيات، سجل النشاط.
- **المحرك (Kotlin):** `mobile/android/app/src/main/kotlin/` — خدمة تعمل في الخلفية (foreground service) تسحب الرسائل من السيرفر وترسلها، ومستقبِل للرسائل الواردة، وتقارير الإرسال والتسليم، والتشغيل التلقائي بعد إعادة تشغيل الهاتف.
- يتواصلان عبر قناتي `veta/gateway` (أوامر) و`veta/gateway/events` (تحديثات الحالة).

الإرسال والاستقبال في الخلفية مكتوبان بـ Kotlin لأن أندرويد لا يسمح بتشغيل كود Dart بشكل موثوق عند إغلاق التطبيق، أو عند وصول رسالة والتطبيق مغلق. بهذا تبقى البوابة تعمل دائماً، والواجهة كلها Flutter.

اختبارات التطبيق: `cd mobile && flutter test`

## التطوير والاختبار
```bash
cd server
npm install
npm run dev
# الاختبارات (تحتاج قاعدة بيانات فارغة للاختبار)
TEST_DB_HOST=127.0.0.1 TEST_DB_USERNAME=root TEST_DB_PASSWORD=... TEST_DB_DATABASE=veta_test npm test
```

## النسخ الاحتياطي والأمان
- كل شيء (الرسائل، الرموز، جلسات واتساب) داخل قاعدة `sms_wa_gateway`. أضفها إلى نسخك الاحتياطي: `mysqldump sms_wa_gateway > backup.sql`. الوسائط في `server/data/media`.
- جلسات واتساب في `vm_wa_auth` تعادل تسجيل الدخول لحسابك، فاحمِ قاعدة البيانات.
- مفاتيح API ورموز الهواتف ورموز OTP تُخزن كبصمات فقط.
- لوحة التحكم محمية بكلمة مرور مع حد لمحاولات الدخول. يمكنك أيضاً تقييد `/` في Nginx على IP مكتبك، مع ترك `/api/` و`/media/` مفتوحة.
