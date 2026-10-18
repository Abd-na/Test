'use strict'

// ---------------------------------------------------------------- icons (Lucide-style, inline SVG)
const ICONS = {
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  sms: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  hook: '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'
}
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`
const paintIcons = (root = document) =>
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (!el.dataset.painted) {
      el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon))
      el.dataset.painted = '1'
    }
  })

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel)
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
const fmtDate = (d) => (d ? new Date(d).toLocaleString('ar', { dateStyle: 'short', timeStyle: 'medium' }) : '—')
const ago = (d) => {
  if (!d) return 'أبداً'
  const s = Math.round((Date.now() - new Date(d)) / 1000)
  if (s < 60) return `قبل ${s} ث`
  if (s < 3600) return `قبل ${Math.round(s / 60)} د`
  if (s < 86400) return `قبل ${Math.round(s / 3600)} س`
  return fmtDate(d)
}

const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* private mode */
    }
  },
  del: (k) => {
    try {
      localStorage.removeItem(k)
    } catch {
      /* private mode */
    }
  }
}
let token = store.get('vm_token')

function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toast.t)
  toast.t = setTimeout(() => el.classList.remove('show'), 3500)
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && !path.startsWith('/admin')) {
    logout()
    throw new Error('انتهت الجلسة')
  }
  if (!res.ok || data.success === false) {
    const details = data.error?.details?.map?.((d) => `${d.path?.join('.') ?? ''} ${d.message}`).join('، ')
    throw new Error([data.error?.message ?? `HTTP ${res.status}`, details].filter(Boolean).join(' — '))
  }
  return data.data
}

async function guarded(btn, fn) {
  if (btn) btn.disabled = true
  try {
    return await fn()
  } catch (err) {
    toast(err.message)
  } finally {
    if (btn) btn.disabled = false
  }
}

const STATUS_LABELS = {
  connected: ['متصل', 'ok'],
  connecting: ['جارٍ الاتصال', 'warn'],
  qr: ['بانتظار مسح QR', 'info'],
  disconnected: ['غير متصل', 'bad'],
  logged_out: ['تم تسجيل الخروج', 'bad'],
  queued: ['في الطابور', 'warn'],
  sending: ['يُرسل', 'warn'],
  sent: ['أُرسلت', 'info'],
  delivered: ['وصلت', 'ok'],
  read: ['قُرئت', 'ok'],
  failed: ['فشلت', 'bad'],
  received: ['واردة', 'info'],
  cancelled: ['أُلغيت', ''],
  pending: ['بانتظار التحقق', 'warn'],
  verified: ['تم التحقق', 'ok'],
  expired: ['منتهية', ''],
  replaced: ['استُبدلت', ''],
  success: ['نجح', 'ok'],
  processing: ['قيد الإرسال', 'warn']
}
const badge = (status) => {
  const [label, cls] = STATUS_LABELS[status] ?? [status, '']
  return `<span class="badge ${cls}">${esc(label)}</span>`
}
const channelBadge = (c) =>
  `<span class="badge ${c === 'whatsapp' ? 'ok' : 'info'}">${c === 'whatsapp' ? 'واتساب' : 'SMS'}</span>`

function copyButton(text) {
  return `<button class="btn sm" type="button" data-copy="${esc(text)}"><span data-icon="copy"></span>نسخ</button>`
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]')
  if (!btn) return
  navigator.clipboard?.writeText(btn.dataset.copy).then(
    () => toast('تم النسخ'),
    () => toast('تعذر النسخ')
  )
})

// ---------------------------------------------------------------- modal
let modalCleanup = null
function openModal(title, html, onClose) {
  $('#modalTitle').textContent = title
  $('#modalBody').innerHTML = html
  paintIcons($('#modal'))
  modalCleanup = onClose ?? null
  if (!$('#modal').open) $('#modal').showModal()
  return $('#modalBody')
}
$('#modal').addEventListener('close', () => {
  modalCleanup?.()
  modalCleanup = null
})
const closeModal = () => $('#modal').close()

// ---------------------------------------------------------------- views
const views = {}
let currentView = null
let viewTimer = null

views.overview = {
  title: 'الرئيسية',
  async render(el) {
    const [status, keys, hooks] = await Promise.all([api('/v1/status'), api('/v1/keys'), api('/v1/webhooks')])
    const sum = (filter) => status.last_24h.filter(filter).reduce((a, r) => a + r.total, 0)
    const sent = sum((r) => r.direction === 'outbound' && ['sent', 'delivered', 'read'].includes(r.status))
    const failed = sum((r) => r.direction === 'outbound' && r.status === 'failed')
    const received = sum((r) => r.direction === 'inbound')
    const queued = sum((r) => r.direction === 'outbound' && ['queued', 'sending'].includes(r.status))
    const step = (done, html) => `<li class="${done ? 'done' : ''}">${done ? '✓ ' : ''}${html}</li>`
    el.innerHTML = `
      <div class="stats">
        <div class="card stat"><div class="num">${status.whatsapp.connected}/${status.whatsapp.instances}</div><div class="label">أرقام واتساب متصلة</div></div>
        <div class="card stat"><div class="num">${status.sms.online}/${status.sms.devices}</div><div class="label">هواتف SMS متصلة</div></div>
        <div class="card stat"><div class="num">${sent}</div><div class="label">أُرسلت (24 ساعة)</div></div>
        <div class="card stat"><div class="num">${failed}</div><div class="label">فشلت (24 ساعة)</div></div>
        <div class="card stat"><div class="num">${received}</div><div class="label">واردة (24 ساعة)</div></div>
        <div class="card stat"><div class="num">${queued}</div><div class="label">في الطابور الآن</div></div>
      </div>
      <div class="card">
        <h3>خطوات التشغيل</h3>
        <ol class="steps">
          ${step(status.whatsapp.connected > 0, '<a href="#whatsapp">اربط رقم واتساب</a> بمسح رمز QR من هاتفك')}
          ${step(status.sms.devices > 0, '<a href="#devices">أضف هاتف أندرويد</a> وثبّت عليه تطبيق Veta SMS Gateway')}
          ${step(
            keys.some((k) => !k.revoked_at),
            '<a href="#keys">أنشئ مفتاح API</a> وضعه في ملف <code>.env</code> الخاص بتطبيق فيتا'
          )}
          ${step(hooks.length > 0, '<a href="#webhooks">أضف Webhook</a> لاستقبال الرسائل الواردة وحالات التسليم في فيتا (اختياري)')}
        </ol>
      </div>`
  }
}

views.whatsapp = {
  title: 'أرقام واتساب',
  async render(el) {
    const list = await api('/v1/instances')
    el.innerHTML = `
      <div class="card">
        <form id="newInstance" class="row">
          <input name="name" placeholder="اسم الرقم (مثال: رقم فيتا الرئيسي)" style="flex:1;min-width:200px" />
          <button class="btn primary" type="submit"><span data-icon="plus"></span>إضافة رقم واتساب</button>
        </form>
        <p class="muted small">يُربط الرقم كجهاز مرتبط (مثل واتساب ويب). استخدم رقماً مخصصاً لفيتا، وتجنب الإرسال الجماعي العشوائي حتى لا يُحظر الرقم.</p>
      </div>
      <div class="grid" style="margin-top:16px">
        ${
          list
            .map(
              (i) => `
          <div class="card">
            <div class="row spread"><strong>${esc(i.name)}</strong>${badge(i.status)}</div>
            <div class="muted small" style="margin:6px 0">${i.phone ? `<span class="mono">+${esc(i.phone)}</span>` : 'لم يُربط بعد'}</div>
            ${i.is_default ? '<span class="badge info">الافتراضي</span>' : ''}
            ${i.last_error && i.status !== 'connected' ? `<p class="error small">${esc(i.last_error)}</p>` : ''}
            <div class="row" style="margin-top:12px">
              ${i.status !== 'connected' ? `<button class="btn sm primary" data-act="qr" data-id="${esc(i.id)}"><span data-icon="qr"></span>ربط</button>` : ''}
              ${!i.is_default ? `<button class="btn sm" data-act="default" data-id="${esc(i.id)}">جعله افتراضياً</button>` : ''}
              <button class="btn sm" data-act="restart" data-id="${esc(i.id)}">إعادة تشغيل</button>
              ${i.status === 'connected' ? `<button class="btn sm danger" data-act="logout" data-id="${esc(i.id)}">تسجيل خروج</button>` : ''}
              <button class="btn sm danger" data-act="delete" data-id="${esc(i.id)}" aria-label="حذف"><span data-icon="trash"></span></button>
            </div>
            <div class="muted small mono" style="margin-top:8px">${esc(i.id)}</div>
          </div>`
            )
            .join('') || '<div class="card empty">لا توجد أرقام بعد</div>'
        }
      </div>`

    $('#newInstance', el).onsubmit = (e) => {
      e.preventDefault()
      guarded(e.submitter, async () => {
        const inst = await api('/v1/instances', { method: 'POST', body: { name: e.target.name.value || undefined } })
        await refresh()
        showQr(inst.id)
      })
    }
    el.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () =>
        guarded(btn, async () => {
          const id = btn.dataset.id
          const act = btn.dataset.act
          if (act === 'qr') return showQr(id)
          if (act === 'default') await api(`/v1/instances/${id}`, { method: 'PATCH', body: { is_default: true } })
          if (act === 'restart') await api(`/v1/instances/${id}/restart`, { method: 'POST' })
          if (act === 'logout') {
            if (!confirm('تسجيل الخروج من هذا الرقم؟')) return
            await api(`/v1/instances/${id}/logout`, { method: 'POST' })
          }
          if (act === 'delete') {
            if (!confirm('حذف هذا الرقم نهائياً؟')) return
            await api(`/v1/instances/${id}`, { method: 'DELETE' })
          }
          await refresh()
        })
    })
  }
}

async function showQr(id) {
  const inst = await api(`/v1/instances/${id}`)
  if (inst.status === 'disconnected' || inst.status === 'logged_out')
    await api(`/v1/instances/${id}/connect`, { method: 'POST' })
  let stopped = false
  const body = openModal(
    'ربط رقم واتساب',
    `
    <ol class="steps small">
      <li>افتح واتساب على الهاتف ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز</li>
      <li>امسح الرمز التالي (يتجدد تلقائياً)</li>
    </ol>
    <div id="qrBox" class="empty">جارٍ تجهيز الرمز…</div>
    <details>
      <summary class="small">أو اربط برقم الهاتف بدل QR</summary>
      <form id="pairForm" class="row" style="margin-top:8px">
        <input name="phone" dir="ltr" placeholder="9647701234567" style="flex:1" />
        <button class="btn" type="submit">احصل على كود الربط</button>
      </form>
      <div id="pairCode"></div>
    </details>`,
    () => {
      stopped = true
    }
  )

  $('#pairForm', body).onsubmit = (e) => {
    e.preventDefault()
    guarded(e.submitter, async () => {
      const { code } = await api(`/v1/instances/${id}/pairing-code`, {
        method: 'POST',
        body: { phone: e.target.phone.value }
      })
      $('#pairCode', body).innerHTML =
        `<div class="pair-code mono">${esc(code)}</div><p class="small muted">واتساب ← الأجهزة المرتبطة ← ربط جهاز ← الربط برقم الهاتف بدلاً من ذلك، ثم أدخل الكود.</p>`
    })
  }

  const poll = async () => {
    if (stopped) return
    try {
      const qr = await api(`/v1/instances/${id}/qr`)
      const box = $('#qrBox', body)
      if (qr.status === 'connected') {
        box.innerHTML = '<p style="color:var(--ok);font-weight:700">✓ تم الربط بنجاح</p>'
        refresh()
        return
      }
      if (qr.qr_image) box.innerHTML = `<img class="qr" src="${qr.qr_image}" alt="رمز QR لربط واتساب" />`
      else if (qr.status === 'disconnected') {
        box.innerHTML = '<p>انتهت صلاحية الرمز. <button class="btn sm" id="again">رمز جديد</button></p>'
        $('#again', box).onclick = async () => {
          await api(`/v1/instances/${id}/connect`, { method: 'POST' })
          box.textContent = 'جارٍ تجهيز الرمز…'
        }
      }
    } catch {
      /* keep polling */
    }
    setTimeout(poll, 2500)
  }
  poll()
}

views.devices = {
  title: 'هواتف SMS',
  async render(el) {
    const list = await api('/v1/devices')
    el.innerHTML = `
      <div class="card">
        <form id="newDevice" class="row">
          <input name="name" placeholder="اسم الهاتف (مثال: Samsung الشركة)" style="flex:1;min-width:200px" />
          <button class="btn primary" type="submit"><span data-icon="plus"></span>إضافة هاتف</button>
        </form>
        <p class="muted small">ثبّت تطبيق <b>Veta SMS Gateway</b> على هاتف أندرويد فيه شريحة، ثم امسح رمز الربط. الرسائل تُرسل من رصيد الشريحة مباشرة دون أي اشتراك.</p>
      </div>
      <div class="grid" style="margin-top:16px">
        ${
          list
            .map(
              (d) => `
          <div class="card">
            <div class="row spread"><strong>${esc(d.name)}</strong>${!d.enabled ? '<span class="badge">معطل</span>' : d.online ? '<span class="badge ok">متصل</span>' : '<span class="badge bad">غير متصل</span>'}</div>
            <div class="muted small" style="margin:6px 0">
              ${esc(d.model ?? 'لم يتصل بعد')} ${d.app_version ? '• v' + esc(d.app_version) : ''}<br/>
              ${d.battery !== null ? `البطارية ${esc(d.battery)}%${d.charging ? ' (يشحن)' : ''} • ` : ''}آخر اتصال: ${esc(ago(d.last_seen_at))}<br/>
              ${d.sims?.length ? 'الشرائح: ' + d.sims.map((s) => `SIM${esc(s.slot)} ${esc(s.carrier ?? '')}`).join('، ') : ''}
            </div>
            <div class="row" style="margin-top:12px">
              <button class="btn sm" data-act="toggle" data-id="${esc(d.id)}" data-enabled="${d.enabled}">${d.enabled ? 'تعطيل' : 'تفعيل'}</button>
              <button class="btn sm primary" data-act="test" data-id="${esc(d.id)}"><span data-icon="send"></span>SMS تجريبي</button>
              <button class="btn sm" data-act="rotate" data-id="${esc(d.id)}"><span data-icon="qr"></span>رمز ربط جديد</button>
              <button class="btn sm danger" data-act="delete" data-id="${esc(d.id)}" aria-label="حذف"><span data-icon="trash"></span></button>
            </div>
            <div class="muted small mono" style="margin-top:8px">${esc(d.id)}</div>
          </div>`
            )
            .join('') || '<div class="card empty">لا توجد هواتف بعد</div>'
        }
      </div>`

    $('#newDevice', el).onsubmit = (e) => {
      e.preventDefault()
      guarded(e.submitter, async () => {
        const dev = await api('/v1/devices', { method: 'POST', body: { name: e.target.name.value || undefined } })
        showPairing(dev)
        refresh()
      })
    }
    el.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () =>
        guarded(btn, async () => {
          const id = btn.dataset.id
          if (btn.dataset.act === 'toggle')
            await api(`/v1/devices/${id}`, { method: 'PATCH', body: { enabled: btn.dataset.enabled !== 'true' } })
          if (btn.dataset.act === 'test') {
            const to = prompt('رقم المستلم (مثال: +9647701234567)')
            if (!to) return
            const msg = await api('/v1/messages', {
              method: 'POST',
              body: { channel: 'sms', device_id: id, to, text: 'رسالة تجريبية من Veta Messenger ✓' }
            })
            return trackMessage(msg.id)
          }
          if (btn.dataset.act === 'rotate') {
            if (!confirm('سيتوقف الرمز القديم عن العمل. متابعة؟')) return
            showPairing(await api(`/v1/devices/${id}/rotate-token`, { method: 'POST' }))
          }
          if (btn.dataset.act === 'delete') {
            if (!confirm('حذف هذا الهاتف؟')) return
            await api(`/v1/devices/${id}`, { method: 'DELETE' })
          }
          refresh()
        })
    })
  }
}

function showPairing(dev) {
  openModal(
    `ربط الهاتف: ${dev.name}`,
    `
    <ol class="steps small">
      <li>ثبّت تطبيق Veta SMS Gateway (ملف APK) على الهاتف</li>
      <li>افتح التطبيق ← <b>مسح رمز QR</b> وامسح الرمز التالي</li>
      <li>امنح صلاحيات الرسائل وأوقف تحسين البطارية للتطبيق</li>
    </ol>
    <img class="qr" src="${dev.pairing_qr}" alt="رمز QR لربط الهاتف" />
    <p class="small muted">أو أدخل البيانات يدوياً في التطبيق:</p>
    <label>رابط السيرفر</label><div class="secret"><code>${esc(JSON.parse(dev.pairing).url)}</code>${copyButton(JSON.parse(dev.pairing).url)}</div>
    <label>رمز الجهاز (يظهر مرة واحدة فقط)</label><div class="secret"><code>${esc(dev.token)}</code>${copyButton(dev.token)}</div>`
  )
}

const MESSAGE_HINTS = {
  queued: 'بانتظار الإرسال. لـ SMS: الهاتف يسحب الرسائل خلال ثوانٍ إذا كان التطبيق يعمل ومتصلاً.',
  sending: 'الهاتف استلم الرسالة ويرسلها الآن من الشريحة…',
  sent: 'خرجت الرسالة من الشريحة/الرقم بنجاح. ننتظر تقرير الوصول (بعض الشبكات لا ترسله).',
  delivered: 'وصلت إلى هاتف المستلم ✓',
  read: 'قرأها المستلم ✓',
  failed: 'فشلت. السبب في الأسفل.'
}

/** Live status of one message, so a test shows exactly where it stops. */
function trackMessage(id) {
  let stopped = false
  const body = openModal(
    'متابعة الرسالة',
    '<div id="trackBox" class="empty">جارٍ التحميل…</div>',
    () => {
      stopped = true
    }
  )
  const started = Date.now()
  const poll = async () => {
    if (stopped) return
    try {
      const m = await api(`/v1/messages/${id}`)
      const box = $('#trackBox', body)
      box.className = ''
      box.innerHTML = `
        <p>${channelBadge(m.channel)} ${badge(m.status)} <span class="mono small">${esc(m.to)}</span></p>
        <p class="small">${esc(MESSAGE_HINTS[m.status] ?? '')}</p>
        ${m.error ? `<p class="error small">${m.status === 'queued' ? 'فشلت المحاولة السابقة وستُعاد تلقائياً: ' : ''}${esc(m.error)}</p>` : ''}
        ${m.fallback_id ? '<p class="small muted">أُعيد إرسالها عبر SMS تلقائياً.</p>' : ''}
        ${
          m.channel === 'sms' && m.status === 'queued' && Date.now() - started > 20000
            ? '<p class="error small">لم يسحبها الهاتف بعد: تأكد أن التطبيق مفتوح ومفتاح التشغيل مفعّل، وأن الهاتف يظهر "متصل" في صفحة هواتف SMS.</p>'
            : ''
        }`
      if (m.fallback_id) id = m.fallback_id
      if (['delivered', 'read'].includes(m.status) && !m.fallback_id) return
      if (m.status === 'failed' && !m.fallback_id) return
    } catch {
      /* keep polling */
    }
    if (Date.now() - started < 180000) setTimeout(poll, 2000)
  }
  poll()
}

views.send = {
  title: 'إرسال تجريبي',
  async render(el) {
    const instances = await api('/v1/instances')
    el.innerHTML = `
      <div class="card">
        <h3>إرسال رسالة</h3>
        <form id="sendForm">
          <div class="form-grid">
            <div><label for="s_to">رقم المستلم</label><input id="s_to" name="to" dir="ltr" placeholder="+9647701234567" required /></div>
            <div><label for="s_channel">القناة</label>
              <select id="s_channel" name="channel">
                <option value="auto">تلقائي (واتساب، وإن تعذر SMS)</option>
                <option value="whatsapp">واتساب فقط</option>
                <option value="sms">SMS فقط</option>
              </select></div>
            <div><label for="s_type">النوع</label>
              <select id="s_type" name="type">
                <option value="text">نص</option><option value="image">صورة</option><option value="document">ملف</option>
                <option value="video">فيديو</option><option value="audio">صوت</option>
              </select></div>
            <div><label for="s_instance">رقم واتساب</label>
              <select id="s_instance" name="instance_id"><option value="">الافتراضي</option>
                ${instances.map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('')}</select></div>
          </div>
          <label for="s_media">رابط الملف (للصور والملفات)</label><input id="s_media" name="media_url" dir="ltr" placeholder="https://…" />
          <label for="s_text">النص / التعليق</label><textarea id="s_text" name="text"></textarea>
          <div class="row" style="margin-top:12px"><button class="btn primary" type="submit"><span data-icon="send"></span>إرسال</button></div>
        </form>
        <div id="sendResult"></div>
      </div>
      <div class="card">
        <h3>تجربة OTP</h3>
        <form id="otpForm" class="form-grid">
          <div><label for="o_phone">الرقم</label><input id="o_phone" name="phone" dir="ltr" required /></div>
          <div><label for="o_channel">القناة</label><select id="o_channel" name="channel"><option value="auto">تلقائي</option><option value="whatsapp">واتساب</option><option value="sms">SMS</option></select></div>
          <div style="align-self:end"><button class="btn primary" type="submit">إرسال الرمز</button></div>
        </form>
        <form id="verifyForm" class="form-grid">
          <div><label for="v_code">الرمز المستلم</label><input id="v_code" name="code" dir="ltr" inputmode="numeric" required /></div>
          <div style="align-self:end"><button class="btn" type="submit">تحقق</button></div>
        </form>
        <div id="otpResult" class="small"></div>
      </div>`

    $('#sendForm', el).onsubmit = (e) => {
      e.preventDefault()
      const f = Object.fromEntries(new FormData(e.target))
      for (const k of Object.keys(f)) if (!f[k]) delete f[k]
      guarded(e.submitter, async () => {
        const msg = await api('/v1/messages', { method: 'POST', body: f })
        $('#sendResult', el).innerHTML =
          `<p class="small">تمت الإضافة للطابور: <code>${esc(msg.id)}</code> ${channelBadge(msg.channel)} ${badge(msg.status)}</p>`
        trackMessage(msg.id)
      })
    }
    $('#otpForm', el).onsubmit = (e) => {
      e.preventDefault()
      const f = Object.fromEntries(new FormData(e.target))
      guarded(e.submitter, async () => {
        const otp = await api('/v1/otp/send', { method: 'POST', body: { ...f, purpose: 'dashboard_test' } })
        $('#otpResult', el).innerHTML =
          `أُرسل الرمز عبر ${channelBadge(otp.channel)} — ينتهي ${esc(fmtDate(otp.expires_at))}`
      })
    }
    $('#verifyForm', el).onsubmit = (e) => {
      e.preventDefault()
      guarded(e.submitter, async () => {
        const r = await api('/v1/otp/verify', {
          method: 'POST',
          body: { phone: $('#o_phone', el).value, code: e.target.code.value, purpose: 'dashboard_test' }
        })
        $('#otpResult', el).innerHTML = r.valid
          ? '<span class="badge ok">الرمز صحيح ✓</span>'
          : `<span class="badge bad">غير صحيح: ${esc(r.reason)}</span>`
      })
    }
  }
}

views.messages = {
  title: 'سجل الرسائل',
  filters: {},
  async render(el) {
    const f = this.filters
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString()
    const list = await api(`/v1/messages?limit=100&${qs}`)
    el.innerHTML = `
      <div class="card">
        <form id="filters" class="form-grid">
          <div><label>القناة</label><select name="channel"><option value="">الكل</option><option value="whatsapp">واتساب</option><option value="sms">SMS</option></select></div>
          <div><label>الاتجاه</label><select name="direction"><option value="">الكل</option><option value="outbound">صادرة</option><option value="inbound">واردة</option></select></div>
          <div><label>الحالة</label><select name="status"><option value="">الكل</option>${['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'received'].map((s) => `<option value="${s}">${STATUS_LABELS[s][0]}</option>`).join('')}</select></div>
          <div><label>الرقم</label><input name="phone" dir="ltr" /></div>
        </form>
      </div>
      <div class="card table-wrap">
        <table>
          <thead><tr><th>الوقت</th><th>القناة</th><th>الاتجاه</th><th>الرقم</th><th>النص</th><th>الحالة</th></tr></thead>
          <tbody>${
            list
              .map(
                (m) => `
            <tr>
              <td class="small">${esc(fmtDate(m.created_at))}</td>
              <td>${channelBadge(m.channel)}</td>
              <td class="small">${m.direction === 'inbound' ? 'واردة' : 'صادرة'}</td>
              <td class="mono small">${esc(m.to ?? m.from)}${m.push_name ? `<br/><span class="muted">${esc(m.push_name)}</span>` : ''}</td>
              <td class="text small">${m.type !== 'text' ? `<span class="badge">${esc(m.type)}</span> ` : ''}${esc(m.text ?? '')}${m.media_url && m.direction === 'inbound' ? ` <a href="${esc(m.media_url)}" target="_blank" rel="noopener">فتح الملف</a>` : ''}${m.error ? `<div class="error">${esc(m.error)}</div>` : ''}</td>
              <td>${badge(m.status)}${m.fallback_id ? '<div class="small muted">← أُعيدت عبر SMS</div>' : ''}</td>
            </tr>`
              )
              .join('') || '<tr><td colspan="6" class="empty">لا توجد رسائل</td></tr>'
          }
          </tbody>
        </table>
      </div>`
    const form = $('#filters', el)
    for (const [k, v] of Object.entries(f)) if (form[k]) form[k].value = v
    form.onchange = () => {
      this.filters = Object.fromEntries(new FormData(form))
      refresh()
    }
  },
  auto: 10000
}

views.otp = {
  title: 'رموز OTP',
  async render(el) {
    const list = await api('/v1/otp?limit=100')
    el.innerHTML = `
      <div class="card table-wrap">
        <table>
          <thead><tr><th>الوقت</th><th>الرقم</th><th>الغرض</th><th>القناة</th><th>المحاولات</th><th>الحالة</th></tr></thead>
          <tbody>${
            list
              .map(
                (o) => `
            <tr><td class="small">${esc(fmtDate(o.created_at))}</td><td class="mono small">${esc(o.phone)}</td><td class="small">${esc(o.purpose)}</td>
            <td>${channelBadge(o.channel)}</td><td>${esc(o.attempts)}/${esc(o.max_attempts)}</td><td>${badge(o.status)}</td></tr>`
              )
              .join('') || '<tr><td colspan="6" class="empty">لا توجد رموز بعد</td></tr>'
          }
          </tbody>
        </table>
        <p class="muted small">الرموز لا تُخزن كنص، بل كبصمة مشفرة (HMAC) فقط.</p>
      </div>`
  },
  auto: 10000
}

const EVENT_NAMES = [
  'message.received',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'otp.verified',
  'instance.connected',
  'instance.disconnected',
  'instance.logged_out',
  'device.online',
  'device.offline'
]

views.webhooks = {
  title: 'Webhooks',
  async render(el) {
    const list = await api('/v1/webhooks')
    el.innerHTML = `
      <div class="card">
        <h3>إضافة Webhook</h3>
        <form id="hookForm">
          <label for="h_url">الرابط (في تطبيق فيتا)</label>
          <input id="h_url" name="url" dir="ltr" placeholder="https://veta.example.com/webhooks/messenger" required />
          <label>الأحداث</label>
          <div class="checks">
            <label><input type="checkbox" name="events" value="*" checked /> كل الأحداث</label>
            ${EVENT_NAMES.map((e) => `<label><input type="checkbox" name="events" value="${e}" /> <span class="mono">${e}</span></label>`).join('')}
          </div>
          <div class="row" style="margin-top:12px"><button class="btn primary" type="submit"><span data-icon="plus"></span>إضافة</button></div>
        </form>
      </div>
      ${list
        .map(
          (h) => `
        <div class="card">
          <div class="row spread"><code>${esc(h.url)}</code>${h.enabled ? '<span class="badge ok">مفعل</span>' : '<span class="badge">معطل</span>'}</div>
          <p class="small muted">${h.events.map((e) => `<span class="mono">${esc(e)}</span>`).join(' • ')}</p>
          <label>مفتاح التوقيع (للتحقق من الهيدر X-Veta-Signature)</label>
          <div class="secret"><code>${esc(h.secret)}</code>${copyButton(h.secret)}</div>
          <div class="row" style="margin-top:12px">
            <button class="btn sm" data-act="test" data-id="${esc(h.id)}">إرسال حدث تجريبي</button>
            <button class="btn sm" data-act="log" data-id="${esc(h.id)}">سجل الإرسال</button>
            <button class="btn sm" data-act="toggle" data-id="${esc(h.id)}" data-enabled="${h.enabled}">${h.enabled ? 'تعطيل' : 'تفعيل'}</button>
            <button class="btn sm danger" data-act="delete" data-id="${esc(h.id)}" aria-label="حذف"><span data-icon="trash"></span></button>
          </div>
        </div>`
        )
        .join('')}`

    $('#hookForm', el).onsubmit = (e) => {
      e.preventDefault()
      const events = [...e.target.querySelectorAll('[name=events]:checked')].map((c) => c.value)
      guarded(e.submitter, async () => {
        await api('/v1/webhooks', {
          method: 'POST',
          body: { url: e.target.url.value, events: events.includes('*') ? ['*'] : events }
        })
        toast('تمت إضافة الـ Webhook')
        refresh()
      })
    }
    el.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () =>
        guarded(btn, async () => {
          const id = btn.dataset.id
          if (btn.dataset.act === 'test') {
            await api(`/v1/webhooks/${id}/test`, { method: 'POST' })
            toast('أُرسل حدث تجريبي، راجع سجل الإرسال')
          }
          if (btn.dataset.act === 'log') return showDeliveries(id)
          if (btn.dataset.act === 'toggle')
            await api(`/v1/webhooks/${id}`, { method: 'PATCH', body: { enabled: btn.dataset.enabled !== 'true' } })
          if (btn.dataset.act === 'delete') {
            if (!confirm('حذف هذا الـ Webhook؟')) return
            await api(`/v1/webhooks/${id}`, { method: 'DELETE' })
          }
          refresh()
        })
    })
  }
}

async function showDeliveries(id) {
  const list = await api(`/v1/webhooks/${id}/deliveries?limit=50`)
  const body = openModal(
    'سجل إرسال الـ Webhook',
    `
    <div class="table-wrap"><table>
      <thead><tr><th>الوقت</th><th>الحدث</th><th>الحالة</th><th>الرد</th><th></th></tr></thead>
      <tbody>${
        list
          .map(
            (d) => `
        <tr><td class="small">${esc(fmtDate(d.created_at))}</td><td class="mono small">${esc(d.event)}</td>
        <td>${badge(d.status)}<div class="small muted">${esc(d.attempts)} محاولة</div></td>
        <td class="small">${esc(d.response_status ?? '')} ${d.error ? `<div class="error">${esc(d.error)}</div>` : ''}</td>
        <td>${d.status !== 'success' ? `<button class="btn sm" data-retry="${esc(d.id)}">إعادة</button>` : ''}</td></tr>`
          )
          .join('') || '<tr><td colspan="5" class="empty">لا يوجد</td></tr>'
      }
      </tbody></table></div>`
  )
  body.querySelectorAll('[data-retry]').forEach((b) => {
    b.onclick = () =>
      guarded(b, async () => {
        await api(`/v1/webhook-deliveries/${b.dataset.retry}/retry`, { method: 'POST' })
        toast('أُعيدت للطابور')
      })
  })
}

views.keys = {
  title: 'مفاتيح API',
  async render(el) {
    const list = await api('/v1/keys')
    el.innerHTML = `
      <div class="card">
        <form id="keyForm" class="row">
          <input name="name" placeholder="اسم المفتاح (مثال: تطبيق فيتا)" style="flex:1;min-width:200px" />
          <button class="btn primary" type="submit"><span data-icon="key"></span>إنشاء مفتاح</button>
        </form>
        <p class="muted small">ضع المفتاح في تطبيق فيتا وأرسله في كل طلب عبر الهيدر <code>Authorization: Bearer …</code></p>
      </div>
      <div class="card table-wrap">
        <table>
          <thead><tr><th>الاسم</th><th>المفتاح</th><th>آخر استخدام</th><th>الحالة</th><th></th></tr></thead>
          <tbody>${
            list
              .map(
                (k) => `
            <tr><td>${esc(k.name)}</td><td class="mono small">${esc(k.prefix)}…</td><td class="small">${esc(ago(k.last_used_at))}</td>
            <td>${k.revoked_at ? '<span class="badge bad">ملغى</span>' : '<span class="badge ok">فعال</span>'}</td>
            <td>${!k.revoked_at ? `<button class="btn sm danger" data-revoke="${esc(k.id)}">إلغاء</button>` : ''}</td></tr>`
              )
              .join('') || '<tr><td colspan="5" class="empty">لا توجد مفاتيح</td></tr>'
          }
          </tbody>
        </table>
      </div>`
    $('#keyForm', el).onsubmit = (e) => {
      e.preventDefault()
      guarded(e.submitter, async () => {
        const key = await api('/v1/keys', { method: 'POST', body: { name: e.target.name.value || 'Veta app' } })
        openModal(
          'مفتاح API جديد',
          `
          <p>انسخ المفتاح الآن، لن يظهر مرة أخرى:</p>
          <div class="secret"><code>${esc(key.key)}</code>${copyButton(key.key)}</div>
          <p class="small muted">في ملف <code>.env</code> لتطبيق فيتا:</p>
          <pre>VETA_MESSENGER_URL=${esc(location.origin)}\nVETA_MESSENGER_KEY=${esc(key.key)}</pre>`
        )
        refresh()
      })
    }
    el.querySelectorAll('[data-revoke]').forEach((b) => {
      b.onclick = () =>
        guarded(b, async () => {
          if (!confirm('إلغاء هذا المفتاح؟ أي تطبيق يستخدمه سيتوقف.')) return
          await api(`/v1/keys/${b.dataset.revoke}`, { method: 'DELETE' })
          refresh()
        })
    })
  }
}

views.docs = {
  title: 'طريقة الربط مع فيتا',
  async render(el) {
    const base = location.origin
    el.innerHTML = `
      <div class="card">
        <h3>إرسال رسالة (واتساب مع تحويل تلقائي لـ SMS)</h3>
        <pre>curl -X POST ${esc(base)}/api/v1/messages \\
  -H "Authorization: Bearer $VETA_MESSENGER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"to": "+9647701234567", "text": "مرحباً من فيتا", "channel": "auto"}'</pre>
      </div>
      <div class="card">
        <h3>إرسال رمز OTP والتحقق منه</h3>
        <pre>POST ${esc(base)}/api/v1/otp/send
{"phone": "+9647701234567", "purpose": "login", "channel": "auto"}

POST ${esc(base)}/api/v1/otp/verify
{"phone": "+9647701234567", "purpose": "login", "code": "123456"}
→ {"success": true, "data": {"valid": true, ...}}</pre>
      </div>
      <div class="card">
        <h3>التحقق من توقيع الـ Webhook (PHP)</h3>
        <pre>$payload   = file_get_contents('php://input');
$timestamp = $_SERVER['HTTP_X_VETA_TIMESTAMP'];
$expected  = 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $payload, env('VETA_MESSENGER_WEBHOOK_SECRET'));
if (!hash_equals($expected, $_SERVER['HTTP_X_VETA_SIGNATURE'])) abort(401);</pre>
        <p class="small muted">التوثيق الكامل لكل الـ endpoints في ملف <code>docs/API.md</code> داخل المستودع.</p>
      </div>`
  }
}

// ---------------------------------------------------------------- router
async function refresh() {
  if (!currentView) return
  const view = views[currentView]
  try {
    await view.render($('#view'))
    paintIcons($('#view'))
  } catch (err) {
    $('#view').innerHTML = `<div class="card error">${esc(err.message)}</div>`
  }
}

function route() {
  const name = location.hash.slice(1) || 'overview'
  currentView = views[name] ? name : 'overview'
  $('#viewTitle').textContent = views[currentView].title
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === currentView))
  $('#sidebar').classList.remove('open')
  clearInterval(viewTimer)
  const auto = views[currentView].auto ?? (['overview', 'whatsapp', 'devices'].includes(currentView) ? 15000 : 0)
  if (auto)
    viewTimer = setInterval(() => {
      if (!$('#modal').open && !document.hidden) refresh()
    }, auto)
  $('#view').innerHTML = '<div class="empty">جارٍ التحميل…</div>'
  refresh()
}

function showApp() {
  $('#login').hidden = true
  $('#app').hidden = false
  route()
}

function logout() {
  token = null
  store.del('vm_token')
  clearInterval(viewTimer)
  $('#app').hidden = true
  $('#login').hidden = false
}

$('#loginForm').onsubmit = async (e) => {
  e.preventDefault()
  $('#loginError').textContent = ''
  const btn = e.submitter
  btn.disabled = true
  try {
    const data = await api('/admin/login', { method: 'POST', body: { password: $('#password').value } })
    token = data.token
    store.set('vm_token', token)
    $('#password').value = ''
    showApp()
  } catch (err) {
    $('#loginError').textContent = err.message === 'Wrong password' ? 'كلمة المرور غير صحيحة' : err.message
  } finally {
    btn.disabled = false
  }
}
$('#logoutBtn').onclick = logout
$('#refreshBtn').onclick = refresh
$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open')
window.addEventListener('hashchange', route)

paintIcons()
if (token) showApp()
else logout()
