'use strict';
/*
 * Polling client for long-running n8n jobs.
 *
 * Contract:
 *   POST <startUrl>            -> { jobId }            (400 -> { error, field })
 *   GET  <statusUrl>?jobId=…   -> { status: 'pending'|'done'|'error'|'not_found', stage, result }
 *
 * Usage (see runExample at the bottom):
 *   const card = createJobCard(container, STEPS);
 *   const jobId = await startJob(START_URL, body);
 *   const status = await pollJob(STATUS_URL, jobId, startedAt, (s) => card.reach(s.stage));
 */

const POLL_EVERY_MS = 2000;
const POLL_CAP_MS = 90000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_STATUS_FAILURES = 3; // consecutive failed status checks before giving up

// One entry per failure kind: what happened + what to do now. Adapt the wording to the feature.
const JOB_ERRORS = {
  offline: { title: 'אין חיבור לאינטרנט', action: 'בדקו את החיבור ולחצו "נסו שוב".' },
  unreachable: { title: 'השירות לא זמין כרגע', action: 'השרת לא ענה. נסו שוב בעוד דקה.' },
  server: { title: 'השירות החזיר שגיאה', action: 'נסו שוב בעוד דקה. אם זה חוזר, צרו איתנו קשר.' },
  failed: { title: 'הפעולה נכשלה באמצע', action: 'נסו לשלוח שוב.' },
  notFound: { title: 'הבקשה לא נמצאה במערכת', action: 'ייתכן שהיא פגה. שלחו שוב.' },
  timeout: { title: 'הפעולה מתעכבת יותר מהרגיל', action: 'נסו שוב בעוד רגע.' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // 400 with { error, field } is a validation answer, not a crash: the caller shows it next to the field.
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

/*
 * Waiting card. `steps` = [{ key, label }] in order.
 * Only list steps you can really report: the keys after the first should match the server's `stage` values.
 */
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
      if (!step(key)) return;
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

/*
 * Example wiring for a form. Copy, rename and adapt:
 *  - STEPS: first step is "received"; the rest mirror the server's stage values.
 *  - renderResult(result): build DOM with textContent only (server text is untrusted).
 *  - showFieldError(field, message): mark the field and show the server's message.
 */
function createRunner({ startUrl, statusUrl, steps, panel, submitButton, errors = JOB_ERRORS, renderResult, showFieldError }) {
  let busy = false;
  return async function run(data) {
    if (busy) return;                       // a double click must not create two jobs
    busy = true;
    if (submitButton) submitButton.disabled = true;
    panel.replaceChildren();
    const card = createJobCard(panel, steps, panel);
    const startedAt = Date.now();
    try {
      card.active(steps[0].key);
      const jobId = await startJob(startUrl, data);
      card.showJobId(steps[0].key, jobId);
      if (steps[1]) { card.reach(steps[1].key); card.startClock(steps[1].key, startedAt); }
      const status = await pollJob(statusUrl, jobId, startedAt, (s) => {
        if (s.status === 'pending' && s.stage) card.reach(s.stage);
      });
      if (status.result == null) throw new JobError('failed');
      card.finish();
      await sleep(500);
      panel.replaceChildren(renderResult(status.result));
    } catch (err) {
      if (err instanceof JobError && err.kind === 'invalid' && showFieldError) {
        panel.replaceChildren();
        showFieldError(err.data.field, err.data.error);
      } else {
        const kind = err instanceof JobError && errors[err.kind] ? err.kind : 'server';
        console.error('[job]', kind, err);
        card.error(errors[kind], () => run(data));   // retry re-sends the same data
      }
    } finally {
      busy = false;
      if (submitButton) submitButton.disabled = false;
    }
  };
}
