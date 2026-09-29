'use strict';

const API = {
  start: 'https://elik.app.n8n.cloud/webhook/385ba59c-5c9b-4ff6-bda8-9222d33e7445',
  status: 'https://elik.app.n8n.cloud/webhook/ofek-chat-status',
};
const POLL_EVERY_MS = 2000;
const POLL_CAP_MS = 90000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_STATUS_FAILURES = 3; // consecutive failed status checks before giving up

const ERRORS = {
  offline: {
    title: 'אין חיבור לאינטרנט',
    action: 'בדקו את החיבור ולחצו "נסו שוב".',
  },
  unreachable: {
    title: 'הסוכן לא זמין כרגע',
    action: 'השרת לא ענה. נסו שוב בעוד דקה, או התקשרו למשרד: ⁦03-555-0100⁩.',
  },
  server: {
    title: 'הסוכן החזיר שגיאה',
    action: 'נסו שוב בעוד דקה. אם זה חוזר, התקשרו למשרד: ⁦03-555-0100⁩.',
  },
  agent: {
    title: 'הסוכן נתקל בתקלה בעיבוד השאלה',
    action: 'נסו לנסח את השאלה מחדש ולשלוח שוב.',
  },
  notFound: {
    title: 'הבקשה לא נמצאה במערכת',
    action: 'ייתכן שהיא פגה. שלחו את השאלה שוב.',
  },
  timeout: {
    title: 'הסוכן מתעכב יותר מהרגיל',
    action: 'נסו שוב, או השאירו שם וטלפון בצ\'אט ונחזור אליכם.',
  },
};

const $ = (sel) => document.querySelector(sel);
const messages = $('#messages');
const form = $('#composer');
const input = $('#chatInput');
const sendBtn = $('#sendBtn');
const chips = $('#chips');
const chatState = $('#chatState');

let busy = false;

/* ---------- session id (per browser; falls back to memory) ---------- */
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

/* ---------- rendering ---------- */
function scrollToEnd() {
  messages.scrollTop = messages.scrollHeight;
}

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
  scrollToEnd();
  return b;
}

const STEPS = [
  { key: 'sent', label: 'הבקשה נשלחה' },
  { key: 'job', label: 'התקבל מספר עבודה' },
  { key: 'working', label: 'הסוכן מחפש ומנסח תשובה' },
  { key: 'done', label: 'התקבלה תשובה' },
];

function createJobCard() {
  const card = document.createElement('div');
  card.className = 'job';
  card.setAttribute('aria-live', 'polite');
  const list = document.createElement('ol');
  list.className = 'job-steps';
  for (const s of STEPS) {
    const li = document.createElement('li');
    li.dataset.step = s.key;
    li.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="label"></span><span class="meta"></span>';
    li.querySelector('.label').textContent = s.label;
    list.appendChild(li);
  }
  card.appendChild(list);
  messages.appendChild(card);
  scrollToEnd();

  const step = (key) => card.querySelector(`[data-step="${key}"]`);
  return {
    el: card,
    active(key) { step(key).classList.add('active'); },
    done(key) { const li = step(key); li.classList.remove('active'); li.classList.add('done'); },
    meta(key, node) { const m = step(key).querySelector('.meta'); m.replaceChildren(node); },
    error(kind, onRetry) {
      card.querySelectorAll('.active').forEach((li) => li.classList.replace('active', 'failed'));
      const info = ERRORS[kind];
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
      scrollToEnd();
    },
  };
}

function setBusy(on) {
  busy = on;
  sendBtn.disabled = on;
  chatState.textContent = on ? '● עובד על תשובה' : '● זמין';
  chatState.classList.toggle('is-busy', on);
}

/* ---------- network ---------- */
class ChatError extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}

async function fetchJson(url, options = {}) {
  if (!navigator.onLine) throw new ChatError('offline');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...options, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    throw new ChatError(navigator.onLine ? 'unreachable' : 'offline');
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new ChatError('server');
  try {
    return await res.json();
  } catch {
    throw new ChatError('server');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- the polling flow ---------- */
async function ask(text) {
  if (busy) return;
  setBusy(true);
  const card = createJobCard();
  const startedAt = Date.now();
  let clock;

  try {
    card.active('sent');
    const job = await fetchJson(API.start, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatInput: text, sessionId }),
    });
    if (!job || !job.jobId) throw new ChatError('server');
    card.done('sent');

    const idEl = document.createElement('bdi');
    idEl.dir = 'ltr';
    idEl.className = 'job-id';
    idEl.textContent = `#${job.jobId}`;
    card.meta('job', idEl);
    card.done('job');

    card.active('working');
    const seconds = document.createElement('span');
    const tick = () => { seconds.textContent = `${Math.round((Date.now() - startedAt) / 1000)} שנ׳`; };
    tick();
    card.meta('working', seconds);
    clock = setInterval(tick, 1000);

    let failures = 0;
    for (;;) {
      if (Date.now() - startedAt > POLL_CAP_MS) throw new ChatError('timeout');
      await sleep(POLL_EVERY_MS);
      let status;
      try {
        status = await fetchJson(`${API.status}?jobId=${encodeURIComponent(job.jobId)}`);
        failures = 0;
      } catch (err) {
        // A single dropped status check is not fatal; keep polling.
        failures += 1;
        if (failures >= MAX_STATUS_FAILURES) throw err;
        continue;
      }
      if (status.status === 'pending') continue;
      if (status.status === 'done' && status.reply) {
        clearInterval(clock);
        card.done('working');
        card.done('done');
        addBubble(status.reply, 'bot');
        setTimeout(() => card.el.remove(), 1200);
        return;
      }
      if (status.status === 'not_found') throw new ChatError('notFound');
      throw new ChatError('agent');
    }
  } catch (err) {
    clearInterval(clock);
    const kind = err instanceof ChatError ? err.kind : 'server';
    console.error('[ofek-chat]', kind, err);
    card.error(kind, () => { card.el.remove(); ask(text); });
  } finally {
    setBusy(false);
  }
}

function submit(text) {
  const t = text.trim();
  if (!t || busy) return;
  addBubble(t, 'user');
  input.value = '';
  ask(t);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  submit(input.value);
});

chips.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) submit(chip.textContent);
});

/* ---------- keep the composer visible above the mobile keyboard ---------- */
function keepComposerVisible() {
  if (document.activeElement !== input) return;
  form.scrollIntoView({ block: 'end', behavior: 'smooth' });
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
