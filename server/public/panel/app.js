const $ = (s) => document.querySelector(s);
const nf = new Intl.NumberFormat('ru-RU');
const dtf = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
const df = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });

// Всё, что приходит с сервера, вставляется только через textContent.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { showLogin(); throw new Error('Требуется вход'); }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Ошибка ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

const copy = async (text) => {
  try { await navigator.clipboard.writeText(text); toast('Скопировано'); } catch { toast('Не удалось скопировать'); }
};

let state = { links: [], tag: '', q: '' };

function showLogin() { $('#login').hidden = false; $('#app').hidden = true; $('#userbar').hidden = true; }

async function load() {
  const qs = new URLSearchParams();
  if (state.q) qs.set('q', state.q);
  if (state.tag) qs.set('tag', state.tag);
  const [links, tags] = await Promise.all([api(`/api/links?${qs}`), api('/api/tags')]);
  state.links = links;
  renderTags(tags);
  renderList();
}

function renderTags(tags) {
  const bar = $('#tagbar');
  bar.replaceChildren(...tags.map((t) =>
    h('button', { class: `chip${state.tag === t.tag ? ' on' : ''}`, onclick: () => { state.tag = state.tag === t.tag ? '' : t.tag; load(); } }, `#${t.tag} · ${t.n}`)));
}

function validity(l) {
  const now = Date.now();
  if (l.valid_since && now < l.valid_since) return h('span', { class: 'badge pending' }, `с ${dtf.format(l.valid_since)}`);
  if (l.valid_until && now > l.valid_until) return h('span', { class: 'badge expired' }, 'истекла');
  if (l.valid_until) return h('span', { class: 'badge soon' }, `до ${dtf.format(l.valid_until)}`);
  return null;
}

function renderList() {
  $('#empty').hidden = state.links.length > 0;
  $('#list').replaceChildren(...state.links.map((l) => h('article', { class: 'item' },
    h('div', { class: 'short' },
      h('a', { href: l.short_url, target: '_blank', rel: 'noopener' }, l.short_url.replace(/^https?:\/\//, '')),
      h('button', { class: 'icon', title: 'Копировать', onclick: () => copy(l.short_url) }, '⧉'),
      validity(l)),
    l.title ? h('div', { class: 'title' }, l.title) : null,
    h('div', { class: 'long' }, l.url),
    h('div', { class: 'meta' },
      h('span', { title: 'Люди / всего, включая ботов и предпросмотры' }, `👁 ${nf.format(l.human_visits)} / ${nf.format(l.visits)}`),
      h('span', {}, `создана ${df.format(l.created_at)}`),
      l.tags.map((t) => h('span', { class: 'tag' }, `#${t}`))),
    h('div', { class: 'btns' },
      h('button', { onclick: () => openStats(l) }, 'Статистика'),
      h('button', { onclick: () => openQr(l) }, 'QR'),
      h('button', { onclick: () => openEditor(l) }, 'Изменить'),
      h('button', { class: 'danger', onclick: () => remove(l) }, 'Удалить')))));
}

async function remove(l) {
  if (!confirm(`Удалить ${l.short_url}?\nВместе со ссылкой пропадёт вся её статистика.`)) return;
  try { await api(`/api/links/${l.id}`, { method: 'DELETE' }); toast('Удалено'); await load(); } catch (e) { toast(e.message); }
}

// ---------- редактор ----------
const editor = $('#editor');
const form = $('#editform');
let editing = null;
const pad = (n) => String(n).padStart(2, '0');
const toLocal = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocal = (s) => (s ? new Date(s).getTime() : null);

function openEditor(l = null) {
  editing = l;
  form.reset();
  $('#edittitle').textContent = l ? `Изменить ${l.code}` : 'Новая ссылка';
  $('#formerr').textContent = '';
  if (l) {
    form.url.value = l.url; form.code.value = l.code; form.title.value = l.title ?? '';
    form.tags.value = l.tags.join(', ');
    form.valid_since.value = toLocal(l.valid_since); form.valid_until.value = toLocal(l.valid_until);
  }
  editor.showModal();
  form.url.focus();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#save');
  btn.disabled = true;
  $('#formerr').textContent = '';
  const body = {
    url: form.url.value.trim(),
    title: form.title.value.trim(),
    tags: form.tags.value.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean),
    valid_since: fromLocal(form.valid_since.value),
    valid_until: fromLocal(form.valid_until.value),
  };
  if (editing) body.code = form.code.value.trim() || editing.code;
  else if (form.code.value.trim()) body.code = form.code.value.trim();
  try {
    const saved = editing
      ? await api(`/api/links/${editing.id}`, { method: 'PUT', body })
      : await api('/api/links', { method: 'POST', body });
    editor.close();
    await load();
    if (!editing) { await copy(saved.short_url); }
  } catch (err) {
    $('#formerr').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- QR ----------
function openQr(l) {
  $('#qrimg').src = `/api/links/${l.id}/qr`;
  $('#qrurl').textContent = l.short_url;
  $('#qrsvg').href = `/api/links/${l.id}/qr`;
  $('#qrsvg').download = `${l.code}.svg`;
  $('#qrpng').href = `/api/links/${l.id}/qr?format=png`;
  $('#qrpng').download = `${l.code}.png`;
  $('#qr').showModal();
}

// ---------- статистика ----------
async function openStats(l) {
  $('#statstitle').textContent = l.short_url.replace(/^https?:\/\//, '');
  const body = $('#statsbody');
  body.replaceChildren(h('p', { class: 'muted' }, 'Загрузка…'));
  $('#stats').showModal();
  try {
    const s = await api(`/api/links/${l.id}/stats?days=30`);
    const byDay = new Map(s.daily.map((d) => [d.day, d]));
    const days = [];
    const now = Date.now() + 3 * 3600000; // сервер считает дни по Москве
    for (let i = 29; i >= 0; i--) days.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
    const rows = days.map((d) => ({ d, human: byDay.get(d)?.human ?? 0, bots: byDay.get(d)?.bots ?? 0 }));
    const max = Math.max(1, ...rows.map((r) => r.human + r.bots));
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    body.replaceChildren(
      h('div', { class: 'stat-grid' },
        h('div', {}, h('b', {}, nf.format(s.link.human_visits)), 'людей всего'),
        h('div', {}, h('b', {}, nf.format(s.link.visits)), 'всего с ботами'),
        h('div', {}, h('b', {}, nf.format(sum('human'))), 'людей за 30 дней')),
      s.link.last_visit ? h('p', { class: 'muted' }, `Последний переход: ${dtf.format(s.link.last_visit)}`) : null,
      h('div', { class: 'bars', role: 'img', 'aria-label': 'Переходы по дням за 30 дней' },
        rows.map((r) => h('div', { title: `${r.d}: людей ${r.human}, ботов ${r.bots}` },
          h('b', { style: `height:${(r.bots / max) * 100}%` }), h('i', { style: `height:${(r.human / max) * 100}%` })))),
      h('p', { class: 'muted' }, 'Красное — люди, серое — боты и предпросмотры.'),
      h('h3', {}, 'Откуда переходили (люди)'),
      s.referers.length
        ? h('ul', { class: 'refs' }, s.referers.map((r) => h('li', {}, h('span', {}, r.ref || 'напрямую / неизвестно'), h('b', {}, nf.format(r.n)))))
        : h('p', { class: 'muted' }, 'Пока нет данных.'));
  } catch (e) {
    body.replaceChildren(h('p', { class: 'err' }, e.message));
  }
}

// ---------- запуск ----------
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
$('#new').addEventListener('click', () => openEditor());
let st;
$('#search').addEventListener('input', (e) => { clearTimeout(st); st = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 250); });
$('#logout').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  location.reload();
});

try {
  const me = await fetch('/api/me').then((r) => r.json());
  if (me.authenticated) {
    $('#login').hidden = true; $('#app').hidden = false; $('#userbar').hidden = false;
    $('#username').textContent = me.name ?? `VK ${me.vk_id}`;
    await load();
  } else showLogin();
} catch { showLogin(); }
