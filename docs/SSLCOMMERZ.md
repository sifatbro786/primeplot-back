# SSLCommerz — sandbox setup ও IPN test (B5.2)

> কোড পুরোটা তৈরি। আপনার কাজ শুধু sandbox store-এর **Store ID** আর **Store Password** `.env`-এ বসানো, তারপর নিচের ধাপে test করা। Live-এ যাওয়ার সময় client-এর live key বসালেই হবে — কোড বদলাতে হবে না।

## ১. Sandbox store নিন (একবারই)

1. https://developer.sslcommerz.com/registration/ — ফর্ম পূরণ করুন। কয়েক মিনিটে ই-মেইলে **Store ID** (যেমন `testbox`) আর **Store Password** (যেমন `qwerty@ssl`) আসবে।
2. ই-মেইলে আসা merchant panel-এ লগইন করে রাখুন (sandbox transaction এখানে দেখা যায়)।

## ২. `.env` (primeplot-back)

```env
SSLCZ_STORE_ID=your_store_id
SSLCZ_STORE_PASS=your_store_password
SSLCZ_IS_LIVE=false
# ধাপ ৩-এর tunnel address (শেষে / ছাড়া)
API_PUBLIC_URL=https://xxxx-xxxx.trycloudflare.com
```

- দুটো key না থাকলে portal-এ “Pay online” বাটন দেখাবেই না (`features.onlinePayment = false`)।
- Dashboard → Accounts settings → `portal.onlinePayment` বন্ধ করেও অনলাইন পেমেন্ট লুকানো যায়; `portal.onlineMinAmount` (ডিফল্ট ৳১,০০০) সর্বনিম্ন অঙ্ক।

## ৩. Tunnel — কেন আর কীভাবে

SSLCommerz-এর **IPN** (সার্ভার থেকে সার্ভারে নিশ্চিতকরণ) আপনার PC-র `localhost`-এ পৌঁছাতে পারে না। তাই একটা পাবলিক https ঠিকানা লাগে — Cloudflare Tunnel ফ্রি, অ্যাকাউন্ট ছাড়াই চলে।

**Windows-এ cloudflared ইনস্টল (একবার):**
```powershell
winget install --id Cloudflare.cloudflared
```
(winget না থাকলে: https://github.com/cloudflare/cloudflared/releases থেকে `cloudflared-windows-amd64.exe` নামিয়ে `cloudflared.exe` নাম দিন।)

**প্রতিবার test-এর সময় (দুটো টার্মিনাল):**
```powershell
# টার্মিনাল ১ — API
cd E:\Works\PrimePlot\primeplot-back
npm run dev

# টার্মিনাল ২ — tunnel
cloudflared tunnel --url http://localhost:5030
```
টার্মিনাল ২-এ `https://<random>.trycloudflare.com` লেখা একটা লাইন আসবে। সেটা কপি করে `.env`-এর `API_PUBLIC_URL`-এ বসান, তারপর টার্মিনাল ১-এ API restart দিন (`node --watch` .env বদল ধরে না — Ctrl+C করে আবার `npm run dev`)।

> Quick tunnel-এর ঠিকানা প্রতিবার বদলায় — নতুন ঠিকানা হলে `.env` আবার আপডেট করুন। স্থায়ী ঠিকানা চাইলে Cloudflare অ্যাকাউন্টে named tunnel বানানো যায় (প্রোডাকশনে লাগবে না — VPS-এ `https://api.<domain>` থাকবে)।

## ৪. চেক স্ক্রিপ্ট

```powershell
npm run sslcz:check                    # key আছে কি না, callback URL, tunnel দিয়ে API পৌঁছায় কি না
npm run sslcz:check -- --session       # ৳১০-এর একটা sandbox session খুলে payment page-এর লিংক দেখাবে
npm run sslcz:check -- --validate <val_id>
npm run sslcz:check -- --query <tran_id>
```
সব ✔ হলে পরের ধাপ। `--session`-এর লিংকে sandbox কার্ড দিয়ে পে করলে API লগে “unknown tran_id” আসবে — এটা প্রত্যাশিত (ওই session কোনো বুকিংয়ের নয়), শুধু key আর URL ঠিক আছে কি না দেখার জন্য।

## ৫. পুরো flow test (portal থেকে)

1. Dashboard-এ একটা বুকিং করুন (বা আগেরটা ব্যবহার করুন)। Holder-এর জন্য client login নিজে থেকে তৈরি হয়; setup link SMS-এ (`SMS_DRIVER=log` হলে API লগে) আর ই-মেইলে যায়।
2. লিংক খুলে পাসওয়ার্ড সেট করুন → ফোন নম্বর বা ই-মেইল দিয়ে portal-এ লগইন।
3. Portal → বুকিং → **Pay online** → অঙ্ক দিন → SSLCommerz sandbox পেজ।
4. Sandbox test কার্ড বা মোবাইল ব্যাংকিং (পেজেই দেখায়; ডকুমেন্টেশন: https://developer.sslcommerz.com/doc/v4/) দিয়ে পে করুন।
5. পেমেন্টের পরে ব্রাউজার portal-এর payment পেজে ফেরে; সেখানে status `paid` আর রসিদ নম্বর দেখাবে।
6. যাচাই করুন:
   - Dashboard → বুকিং → Receipts: mode **online**, reference = bank tran id।
   - টার্মিনাল ২ (cloudflared)-এ `POST /api/v1/webhooks/sslcommerz/ipn 200` — মানে IPN এসেছে।
   - `GET /api/v1/online-payments` (staff) → events-এ `success`, `ipn`, `PAID`।
   - একই পেমেন্টের জন্য রসিদ **একটাই** (IPN আর redirect দুটো এলেও)।

### অন্যান্য কেস
| কী করবেন | কী হবে |
|---|---|
| Sandbox পেজে **Cancel** | status `cancelled`, রসিদ নেই |
| ব্রাউজার মাঝপথে বন্ধ | ১৫ মিনিট পর reconcile job (প্রতি ১০ মিনিটে) SSLCommerz-কে জিজ্ঞেস করে; পে হয়ে থাকলে রসিদ, না হলে ৩ ঘণ্টা পরে `expired` |
| Tunnel ছাড়া (`API_PUBLIC_URL` খালি) | redirect কাজ করে, IPN আসে না — তবু success redirect বা reconcile job রসিদ বানায় |
| ঝুঁকিপূর্ণ (risk_level 1) / অঙ্ক না মেলা / বকেয়ার চেয়ে বেশি / বুকিং বাতিল | status `review`, রসিদ নেই; ম্যানেজারের নোটিফিকেশন। `POST /online-payments/:id/approve` (রসিদ) বা `/reject` (SSLCommerz panel থেকে refund) |

## ৬. Live-এ যাওয়ার আগে
- Client-এর live store: `SSLCZ_STORE_ID`, `SSLCZ_STORE_PASS`, `SSLCZ_IS_LIVE=true`।
- `API_PUBLIC_URL=https://api.<domain>` (VPS, Nginx + Let's Encrypt)।
- SSLCommerz panel-এ IPN URL হিসেবে `https://api.<domain>/api/v1/webhooks/sslcommerz/ipn` দিন (session-এও পাঠানো হয়, panel-এ দেওয়া ভালো)।
- একটা ছোট অঙ্কের আসল পেমেন্ট দিয়ে শেষ পরীক্ষা, তারপর panel থেকে refund।

## নিরাপত্তা (কীভাবে কাজ করে)
- ব্রাউজার বা IPN যা পাঠায় তা বিশ্বাস করা হয় না — শুধু `val_id` নিয়ে **Order Validation API**-তে সার্ভার থেকে জিজ্ঞেস করা হয়। `tran_id`, অঙ্ক (পয়সা পর্যন্ত) আর currency (BDT) মিললেই রসিদ।
- রসিদের idempotency key `sslcz:<tran_id>` (unique) — redirect, IPN, reconcile, staff approve একসাথে এলেও রসিদ একটাই।
- IPN-এর `verify_sign`ও মেলানো হয় (না মিললে লগে সতর্কবার্তা), কিন্তু সিদ্ধান্ত সবসময় validation API-র উত্তরে।
