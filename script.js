'use strict';

const API = {
  chatStart: 'https://elik.app.n8n.cloud/webhook/385ba59c-5c9b-4ff6-bda8-9222d33e7445',
  chatStatus: 'https://elik.app.n8n.cloud/webhook/ofek-chat-status',
  fitStart: 'https://elik.app.n8n.cloud/webhook/ofek-fit',
  fitStatus: 'https://elik.app.n8n.cloud/webhook/ofek-fit-status',
};
const POLL_EVERY_MS = 2000;
const POLL_CAP_MS = 90000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_STATUS_FAILURES = 3; // consecutive failed status checks before giving up
const OFFICE_PHONE = '⁦03-555-0100⁩';

const CHAT_ERRORS = {
  offline: { title: 'אין חיבור לאינטרנט', action: 'בדקו את החיבור ולחצו "נסו שוב".' },
  unreachable: { title: 'הסוכן לא זמין כרגע', action: `השרת לא ענה. נסו שוב בעוד דקה, או התקשרו למשרד: ${OFFICE_PHONE}.` },
  server: { title: 'הסוכן החזיר שגיאה', action: `נסו שוב בעוד דקה. אם זה חוזר, התקשרו למשרד: ${OFFICE_PHONE}.` },
  failed: { title: 'הסוכן נתקל בתקלה בעיבוד השאלה', action: 'נסו לנסח את השאלה מחדש ולשלוח שוב.' },
  notFound: { title: 'הבקשה לא נמצאה במערכת', action: 'ייתכן שהיא פגה. שלחו את השאלה שוב.' },
  timeout: { title: 'הסוכן מתעכב יותר מהרגיל', action: 'נסו שוב, או השאירו שם וטלפון בצ\'אט ונחזור אליכם.' },
};

const FIT_ERRORS = {
  offline: { title: 'אין חיבור לאינטרנט', action: 'בדקו את החיבור ולחצו "נסו שוב". הפרטים שמילאתם נשמרו בטופס.' },
  unreachable: { title: 'שירות ההתאמה לא זמין כרגע', action: `השרת לא ענה. נסו שוב בעוד דקה, או התקשרו למשרד: ${OFFICE_PHONE}.` },
  server: { title: 'שירות ההתאמה החזיר שגיאה', action: `נסו שוב בעוד דקה. אם זה חוזר, התקשרו למשרד: ${OFFICE_PHONE}.` },
  failed: { title: 'הבדיקה נכשלה באמצע', action: 'נסו לשלוח שוב. אם זה חוזר, התקשרו למשרד.' },
  notFound: { title: 'הבקשה לא נמצאה במערכת', action: 'שלחו את הטופס שוב.' },
  timeout: { title: 'הבדיקה מתעכבת יותר מהרגיל', action: 'ייתכן שההמלצה עוד תגיע למייל. אפשר גם לנסות שוב.' },
};

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =====================================================================
   Shared: network + polling
   ===================================================================== */
class JobError extends Error {
  constructor(kind, data) { super(kind); this.kind = kind; this.data = data; }
}

async function fetchJson(url, options = {}) {
  if (!navigator.onLine) throw new JobError('offline');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...options, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    throw new JobError(navigator.onLine ? 'unreachable' : 'offline');
  } finally {
    clearTimeout(t);
  }
  let data = null;
  try { data = await res.json(); } catch { /* handled below */ }
  if (res.status === 400 && data && data.error) throw new JobError('invalid', data);
  if (!res.ok || !data) throw new JobError('server');
  return data;
}

async function startJob(url, body) {
  const job = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!job.jobId) throw new JobError('server');
  return job.jobId;
}

// Polls until the job leaves "pending". onUpdate receives every status response.
async function pollJob(statusUrl, jobId, startedAt, onUpdate) {
  let failures = 0;
  for (;;) {
    if (Date.now() - startedAt > POLL_CAP_MS) throw new JobError('timeout');
    await sleep(POLL_EVERY_MS);
    let status;
    try {
      status = await fetchJson(`${statusUrl}?jobId=${encodeURIComponent(jobId)}`);
      failures = 0;
    } catch (err) {
      // A single dropped status check is not fatal; keep polling.
      failures += 1;
      if (failures >= MAX_STATUS_FAILURES) throw err;
      continue;
    }
    if (onUpdate) onUpdate(status);
    if (status.status === 'pending') continue;
    if (status.status === 'done') return status;
    if (status.status === 'not_found') throw new JobError('notFound');
    throw new JobError('failed');
  }
}

/* Waiting card with real steps, a live clock and an error box with retry. */
function createJobCard(container, steps, scrollEl = container) {
  const card = document.createElement('div');
  card.className = 'job';
  card.setAttribute('aria-live', 'polite');
  const list = document.createElement('ol');
  list.className = 'job-steps';
  for (const s of steps) {
    const li = document.createElement('li');
    li.dataset.step = s.key;
    li.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="label"></span><span class="meta"></span>';
    li.querySelector('.label').textContent = s.label;
    list.appendChild(li);
  }
  card.appendChild(list);
  container.appendChild(card);
  const scroll = () => { scrollEl.scrollTop = scrollEl.scrollHeight; };
  scroll();

  const step = (key) => card.querySelector(`[data-step="${key}"]`);
  let clock;
  return {
    el: card,
    active(key) { step(key).classList.add('active'); },
    done(key) { const li = step(key); li.classList.remove('active'); li.classList.add('done'); },
    // Marks every step before `key` done and `key` active (for server-reported stages).
    reach(key) {
      let seen = false;
      for (const s of steps) {
        const li = step(s.key);
        if (s.key === key) { seen = true; if (!li.classList.contains('done')) li.classList.add('active'); }
        else if (!seen) { li.classList.remove('active'); li.classList.add('done'); }
      }
    },
    finish() { clearInterval(clock); for (const s of steps) this.done(s.key); },
    meta(key, node) { step(key).querySelector('.meta').replaceChildren(node); },
    showJobId(key, jobId) {
      const idEl = document.createElement('bdi');
      idEl.dir = 'ltr';
      idEl.className = 'job-id';
      idEl.textContent = `#${jobId}`;
      this.meta(key, idEl);
    },
    startClock(key, startedAt) {
      const seconds = document.createElement('span');
      const tick = () => { seconds.textContent = `${Math.round((Date.now() - startedAt) / 1000)} שנ׳`; };
      tick();
      this.meta(key, seconds);
      clock = setInterval(tick, 1000);
    },
    error(info, onRetry) {
      clearInterval(clock);
      card.querySelectorAll('.active').forEach((li) => li.classList.replace('active', 'failed'));
      const box = document.createElement('div');
      box.className = 'job-error';
      box.setAttribute('role', 'alert');
      const title = document.createElement('b');
      title.textContent = info.title;
      const action = document.createElement('p');
      action.textContent = info.action;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn';
      retry.textContent = 'נסו שוב';
      retry.addEventListener('click', () => { box.remove(); onRetry(); }, { once: true });
      box.append(title, action, retry);
      card.appendChild(box);
      scroll();
    },
  };
}

/* =====================================================================
   Chat with the agent
   ===================================================================== */
const messages = $('#messages');
const composer = $('#composer');
const input = $('#chatInput');
const sendBtn = $('#sendBtn');
const chips = $('#chips');
const chatState = $('#chatState');
let chatBusy = false;

const sessionId = (() => {
  const make = () => (crypto.randomUUID ? crypto.randomUUID() : `ofek-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    let id = localStorage.getItem('ofek_chat_session');
    if (!id) { id = make(); localStorage.setItem('ofek_chat_session', id); }
    return id;
  } catch {
    return make();
  }
})();

// Plain text with clickable links; never injects HTML from the server.
function fillWithLinks(el, text) {
  const parts = String(text).split(/(https?:\/\/[^\s)]+)/g);
  for (const part of parts) {
    if (/^https?:\/\//.test(part)) {
      const a = document.createElement('a');
      a.href = part;
      a.textContent = part;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.dir = 'ltr';
      el.appendChild(a);
    } else if (part) {
      el.appendChild(document.createTextNode(part));
    }
  }
}

function addBubble(text, who) {
  const b = document.createElement('div');
  b.className = `bubble ${who}`;
  b.dir = 'auto';
  fillWithLinks(b, text);
  messages.appendChild(b);
  messages.scrollTop = messages.scrollHeight;
  return b;
}

const CHAT_STEPS = [
  { key: 'sent', label: 'הבקשה נשלחה' },
  { key: 'job', label: 'התקבל מספר עבודה' },
  { key: 'working', label: 'הסוכן מחפש ומנסח תשובה' },
  { key: 'done', label: 'התקבלה תשובה' },
];

function setChatBusy(on) {
  chatBusy = on;
  sendBtn.disabled = on;
  chatState.textContent = on ? '● עובד על תשובה' : '● זמין';
  chatState.classList.toggle('is-busy', on);
}

async function ask(text) {
  if (chatBusy) return;
  setChatBusy(true);
  const card = createJobCard(messages, CHAT_STEPS);
  const startedAt = Date.now();
  try {
    card.active('sent');
    const jobId = await startJob(API.chatStart, { chatInput: text, sessionId });
    card.done('sent');
    card.showJobId('job', jobId);
    card.done('job');
    card.active('working');
    card.startClock('working', startedAt);
    const status = await pollJob(API.chatStatus, jobId, startedAt);
    if (!status.reply) throw new JobError('failed');
    card.finish();
    addBubble(status.reply, 'bot');
    setTimeout(() => card.el.remove(), 1200);
  } catch (err) {
    const kind = err instanceof JobError && CHAT_ERRORS[err.kind] ? err.kind : 'server';
    console.error('[ofek-chat]', kind, err);
    card.error(CHAT_ERRORS[kind], () => { card.el.remove(); ask(text); });
  } finally {
    setChatBusy(false);
  }
}

function submitChat(text) {
  const t = text.trim();
  if (!t || chatBusy) return;
  addBubble(t, 'user');
  input.value = '';
  ask(t);
}

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  submitChat(input.value);
});

chips.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) submitChat(chip.textContent);
});

/* =====================================================================
   Fit report form (automation)
   ===================================================================== */
const fitForm = $('#fitForm');
const fitPanel = $('#fitPanel');
const fitIntro = $('#fitIntro');
const fitSubmit = $('#fitSubmit');
const fitFormError = $('#fitFormError');

const FIT_STEPS = [
  { key: 'received', label: 'הפרטים התקבלו' },
  { key: 'calc', label: 'מחשבים מסלול לפי המחירון' },
  { key: 'ai', label: 'מנסחים המלצה אישית' },
  { key: 'save', label: 'שומרים את הפנייה' },
  { key: 'email', label: 'שולחים את ההמלצה למייל' },
];

function readFitForm() {
  const f = new FormData(fitForm);
  return {
    name: String(f.get('name') || '').trim(),
    email: String(f.get('email') || '').trim(),
    phone: String(f.get('phone') || '').trim(),
    type: f.get('type'),
    docs: Number(f.get('docs')),
    employees: Number(f.get('employees')),
    extras: f.getAll('extras'),
    consent: f.get('consent') === 'on',
    website: String(f.get('website') || ''),
  };
}

function clearFieldErrors() {
  fitForm.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
  fitFormError.hidden = true;
  fitFormError.textContent = '';
}

function showFieldError(field, message) {
  const el = fitForm.elements[field];
  const target = el && (el.length && !el.tagName ? el[0] : el);
  if (target && target.setAttribute) {
    target.setAttribute('aria-invalid', 'true');
    target.focus({ preventScroll: false });
  }
  fitFormError.textContent = message;
  fitFormError.hidden = false;
}

function renderFitResult(result) {
  const box = document.createElement('div');
  box.className = 'fit-result';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'המסלול המומלץ עבורכם';
  const plan = document.createElement('h3');
  plan.dir = 'auto';
  plan.textContent = result.plan;
  const summary = document.createElement('p');
  summary.className = 'muted';
  summary.textContent = result.summary;

  const list = document.createElement('ul');
  list.className = 'fit-lines';
  for (const l of result.lines) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.dir = 'auto';
    label.textContent = l.label + (l.note ? ` (${l.note})` : '');
    const price = document.createElement('b');
    price.textContent = l.price === null ? 'הצעה מותאמת' : `${l.price.toLocaleString('en-US')} ₪`;
    const period = document.createElement('small');
    period.textContent = l.period;
    li.append(label, price, period);
    list.appendChild(li);
  }

  const total = document.createElement('p');
  total.className = 'fit-total';
  total.textContent = `סה״כ חודשי משוער: ${result.total} (לפני מע״מ)`;

  const docsTitle = document.createElement('p');
  docsTitle.className = 'fit-docs-title';
  docsTitle.textContent = 'מסמכים שכדאי להכין להצטרפות:';
  const docs = document.createElement('ul');
  docs.className = 'fit-docs';
  for (const d of result.documents) {
    const li = document.createElement('li');
    li.textContent = d;
    docs.appendChild(li);
  }

  const mail = document.createElement('p');
  mail.className = result.emailSent ? 'fit-mail ok' : 'fit-mail warn';
  if (result.emailSent) {
    mail.append('✓ שלחנו עותק של ההמלצה אל ');
    const addr = document.createElement('bdi');
    addr.textContent = result.email;
    mail.append(addr, '. נציג יחזור אליכם לתיאום שיחת היכרות.');
  } else {
    mail.textContent = 'ההמלצה מוצגת כאן, אבל לא הצלחנו לשלוח אותה למייל. בדקו שהכתובת נכונה, או צלמו את המסך.';
  }

  const actions = document.createElement('div');
  actions.className = 'fit-actions';
  const toChat = document.createElement('a');
  toChat.className = 'btn';
  toChat.href = '#chat';
  toChat.textContent = 'יש שאלות? דברו עם הסוכן';
  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'btn btn-ghost';
  again.textContent = 'בדיקה חדשה';
  again.addEventListener('click', () => {
    fitPanel.replaceChildren(fitIntro);
    fitForm.reset();
    fitForm.elements.name.focus();
  });
  actions.append(toChat, again);

  const note = document.createElement('p');
  note.className = 'fit-note';
  note.textContent = 'זוהי הערכה ראשונית לפי המחירון ולא הצעת מחיר מחייבת.';

  box.append(eyebrow, plan, summary, list, total, docsTitle, docs, mail, actions, note);
  return box;
}

let fitBusy = false;

async function runFit(data) {
  if (fitBusy) return;
  fitBusy = true;
  fitSubmit.disabled = true;
  clearFieldErrors();
  fitPanel.replaceChildren();
  const card = createJobCard(fitPanel, FIT_STEPS, fitPanel);
  if (window.matchMedia('(max-width: 900px)').matches) fitPanel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const startedAt = Date.now();
  try {
    card.active('received');
    const jobId = await startJob(API.fitStart, data);
    card.showJobId('received', jobId);
    card.reach('calc');
    card.startClock('calc', startedAt);
    const status = await pollJob(API.fitStatus, jobId, startedAt, (s) => {
      if (s.status === 'pending' && s.stage) card.reach(s.stage);
    });
    if (!status.result) throw new JobError('failed');
    card.finish();
    await sleep(500);
    fitPanel.replaceChildren(renderFitResult(status.result));
  } catch (err) {
    if (err instanceof JobError && err.kind === 'invalid') {
      fitPanel.replaceChildren(fitIntro);
      showFieldError(err.data.field, err.data.error);
    } else {
      const kind = err instanceof JobError && FIT_ERRORS[err.kind] ? err.kind : 'server';
      console.error('[ofek-fit]', kind, err);
      card.error(FIT_ERRORS[kind], () => { runFit(data); });
    }
  } finally {
    fitBusy = false;
    fitSubmit.disabled = false;
  }
}

// Fixing a field clears its error right away.
fitForm.addEventListener('input', (e) => {
  const group = e.target.name && fitForm.querySelectorAll(`[name="${e.target.name}"]`);
  if (group) group.forEach((el) => el.removeAttribute('aria-invalid'));
  if (!fitForm.querySelector('[aria-invalid="true"]')) fitFormError.hidden = true;
});

fitForm.addEventListener('submit', (e) => {
  e.preventDefault();
  clearFieldErrors();
  if (!fitForm.checkValidity()) {
    const bad = fitForm.querySelector(':invalid');
    showFieldError(bad.name, bad.dataset.msg || 'נא להשלים את השדה המסומן.');
    return;
  }
  runFit(readFitForm());
});

/* =====================================================================
   Keep the chat composer visible above the mobile keyboard
   ===================================================================== */
function keepComposerVisible() {
  if (document.activeElement !== input) return;
  composer.scrollIntoView({ block: 'end', behavior: 'smooth' });
}
input.addEventListener('focus', () => setTimeout(keepComposerVisible, 300));

// Expose the visible height so CSS can shrink the message list while the keyboard is open.
function syncVisibleHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--vvh', `${Math.round(h)}px`);
}
syncVisibleHeight();
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => { syncVisibleHeight(); keepComposerVisible(); });
} else {
  window.addEventListener('resize', syncVisibleHeight);
}
