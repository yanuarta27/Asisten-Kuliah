'use strict';

// `api` is exposed on window by preload.js (contextBridge).
const $ =(sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SECTIONS = ['Materi', 'Tugas'];

const S = {
  settings: null,
  courses: [],
  todos: [],
  schedule: [], // { id, course, day (0=Minggu..6), start 'HH:MM', end 'HH:MM', room }
  inbox: [],
  files: null, // file listing of the course currently open
  note: null, // note open in the editor: { folder, name, content }
  noteDirty: false,
  view: { type: 'home' }, // home | schedule | inbox | course
  showDone: false,
  inboxCourse: store('inboxCourse') || '',
};

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {}
}

// ---------- Formatting ----------

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtDate = (ms) => new Date(ms).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });

function icon(f) {
  if (f.isDir) return '📁';
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return '📕';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['ppt', 'pptx'].includes(ext)) return '📙';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return '🖼️';
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
  return '📄';
}

const startOfToday = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};
const parseDay = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const daysUntil = (s) => Math.round((parseDay(s) - startOfToday()) / 86400000);

function dueLabel(s) {
  const n = daysUntil(s);
  const fmt = parseDay(s).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  if (n < 0) return { text: `${fmt} · terlambat ${-n} hari`, cls: 'overdue' };
  if (n === 0) return { text: 'Hari ini', cls: 'soon' };
  if (n === 1) return { text: 'Besok', cls: 'soon' };
  return { text: n <= 7 ? `${fmt} · ${n} hari lagi` : fmt, cls: '' };
}

const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const isoToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const byStart = (a, b) => toMin(a.start) - toMin(b.start);

const courseTitle = (folder) => S.courses.find((c) => c.folder === folder)?.title ?? '';
const cleanErr = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---------- Toast & dialogs ----------

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 5000 : 2600);
}

function askText(title, placeholder, value = '') {
  return new Promise((resolve) => {
    const dlg = $('#dlg');
    dlg.innerHTML = `
      <form method="dialog">
        <h2>${esc(title)}</h2>
        <input class="dlg-input" name="v" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off" required>
        <div class="dlg-actions">
          <button type="button" class="btn" data-act="dlg-close">Batal</button>
          <button class="btn primary" value="ok">Simpan</button>
        </div>
      </form>`;
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? dlg.querySelector('input').value.trim() : null);
    dlg.returnValue = '';
    dlg.showModal();
  });
}

function renderSettings() {
  const dlg = $('#dlg');
  const s = S.settings;
  dlg.innerHTML = `
    <h2>Pengaturan</h2>
    <div class="set-label">Folder kuliah</div>
    <div class="set-row">
      <span class="path">${esc(s.root || '(belum dipilih)')}</span>
      <button class="btn small" data-act="set-root">Ubah…</button>
    </div>
    <div class="set-label">Folder Inbox (tempat file sering menumpuk)</div>
    ${s.inboxDirs
      .map(
        (d) => `<div class="set-row"><span class="path">${esc(d)}</span>
          <button class="btn small danger" data-act="set-rm-inbox" data-dir="${esc(d)}">Hapus</button></div>`
      )
      .join('') || '<div class="set-row"><span class="path">Belum ada.</span></div>'}
    <div class="set-row"><button class="btn small" data-act="set-add-inbox">＋ Tambah folder</button></div>
    <div class="dlg-actions"><button class="btn primary" data-act="dlg-close">Selesai</button></div>`;
}

function openSettings() {
  const dlg = $('#dlg');
  dlg.onclose = null;
  renderSettings();
  if (!dlg.open) dlg.showModal();
}

// ---------- Data ----------

async function loadAll() {
  S.settings = await api.getSettings();
  if (!S.settings.root) return render();
  const data = await api.loadData();
  S.todos = data.todos;
  S.schedule = data.schedule;
  await refresh();
}

async function refresh(background = false) {
  if (!S.settings?.root) return;
  const [courses, inbox] = await Promise.all([api.listCourses(), api.listInbox()]);
  S.courses = courses;
  S.inbox = inbox;
  if (S.view.type === 'course') {
    if (S.courses.some((c) => c.folder === S.view.folder)) {
      S.files = await api.courseFiles(S.view.folder);
      // The open note was removed or renamed outside the app.
      if (S.note && !S.noteDirty && !S.files.Catatan.some((f) => f.name === S.note.name)) S.note = null;
    } else {
      S.view = { type: 'home' };
    }
  }
  render(background);
}

const persist = () => api.saveData({ todos: S.todos, schedule: S.schedule });

// ---------- Notes ----------

let noteTimer;

function setNoteStatus(text) {
  const el = $('#note-status');
  if (el) el.textContent = text;
}

async function saveNote() {
  clearTimeout(noteTimer);
  if (!S.noteDirty || !S.note) return;
  const { folder, name, content } = S.note;
  S.noteDirty = false;
  try {
    await api.writeNote({ folder, name, content });
    if (S.note?.name === name) setNoteStatus('Tersimpan');
  } catch (e) {
    S.noteDirty = true;
    setNoteStatus('Gagal menyimpan');
    toast(cleanErr(e), true);
  }
}

const flushNote = saveNote;

function onNoteInput(value) {
  S.note.content = value;
  S.noteDirty = true;
  setNoteStatus('Menyimpan…');
  clearTimeout(noteTimer);
  noteTimer = setTimeout(saveNote, 700);
}

async function openNote(name) {
  await flushNote();
  const folder = S.view.folder;
  S.note = { folder, name, content: await api.readNote({ folder, name }) };
  renderMain();
}

// ---------- Rendering ----------

function render(background = false) {
  renderSidebar();
  const active = document.activeElement;
  // Don't clobber a form the user is typing in when a background refresh fires.
  if (background && active && $('#main').contains(active) && active.matches('input, select, textarea')) return;
  renderMain();
}

function openCount(folder) {
  return S.todos.filter((t) => !t.done && (folder === undefined || t.course === folder)).length;
}

function renderSidebar() {
  const v = S.view;
  const navBtn = (attrs, active, label, badge) =>
    `<button class="nav ${active ? 'active' : ''}" data-act="nav" ${attrs}>
       <span class="label">${label}</span>${badge}</button>`;
  const badge = (n, quiet) => (n ? `<span class="badge ${quiet ? 'quiet' : ''}">${n}</span>` : '');

  $('#sidebar').innerHTML = `
    <div class="brand"><img src="logo.png" alt="">Asisten Kuliah</div>
    ${navBtn('data-view="home"', v.type === 'home', '🏠 Dashboard', badge(openCount(), true))}
    ${navBtn('data-view="schedule"', v.type === 'schedule', '📅 Jadwal', badge(todayClasses().length, true))}
    ${navBtn('data-view="inbox"', v.type === 'inbox', '📥 Inbox', badge(S.inbox.length))}
    <div class="side-title"><span>Mata Kuliah</span>
      <button class="side-btn" data-act="add-course" title="Tambah mata kuliah">＋</button></div>
    ${S.courses
      .map((c) =>
        navBtn(
          `data-view="course" data-folder="${esc(c.folder)}" title="${esc(c.title)}"`,
          v.type === 'course' && v.folder === c.folder,
          esc(c.title),
          badge(openCount(c.folder), true)
        )
      )
      .join('')}
    <div class="side-spacer"></div>
    <button class="nav" data-act="settings"><span class="label">⚙️ Pengaturan</span></button>`;
}

function renderMain() {
  const main = $('#main');
  if (!S.settings) return (main.innerHTML = '');
  if (!S.settings.root) {
    main.innerHTML = `<div class="welcome">
      <img src="logo.png" alt="">
      <h1>Selamat datang di Asisten Kuliah</h1>
      <p>Pilih folder tempat Anda menyimpan file kuliah. Setiap subfolder yang namanya diawali
        <code>[Matkul] </code> akan dikenali sebagai satu mata kuliah. Anda juga bisa menambah mata kuliah baru dari dalam aplikasi.</p>
      <button class="btn primary" data-act="set-root-first">Pilih folder kuliah…</button>
    </div>`;
    return;
  }
  const views = { inbox: viewInbox, course: viewCourse, schedule: viewSchedule, home: viewHome };
  main.innerHTML = views[S.view.type]();
}

// ----- Schedule pieces -----

const todayClasses = () => S.schedule.filter((s) => s.day === new Date().getDay()).sort(byStart);

function classStatus(s) {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const start = toMin(s.start);
  if (mins >= toMin(s.end)) return { text: 'Selesai', cls: 'done' };
  if (mins >= start) return { text: 'Sedang berlangsung', cls: 'live' };
  const left = start - mins;
  return { text: left < 60 ? `Mulai ${left} menit lagi` : `Mulai ${s.start}`, cls: 'soon' };
}

function nextClassText() {
  const today = new Date().getDay();
  for (let i = 1; i <= 7; i++) {
    const day = (today + i) % 7;
    const first = S.schedule.filter((s) => s.day === day).sort(byStart)[0];
    if (first) return `Kuliah berikutnya: ${i === 1 ? 'besok' : DAY_NAMES[day]} ${first.start} · ${courseTitle(first.course) || 'Mata kuliah'}`;
  }
  return 'Belum ada jadwal. Tambahkan di menu Jadwal.';
}

function todayCard() {
  const list = todayClasses();
  const label = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
  const rows = list
    .map((s) => {
      const st = classStatus(s);
      const title = courseTitle(s.course) || 'Mata kuliah';
      return `<li class="class-row ${st.cls}">
          <span class="time">${esc(s.start)}–${esc(s.end)}</span>
          <div class="c-body">
            <button class="name" data-act="goto-course" data-folder="${esc(s.course)}">${esc(title)}</button>
            ${s.room ? `<div class="t-meta">${esc(s.room)}</div>` : ''}
          </div>
          <span class="status ${st.cls}">${esc(st.text)}</span>
          <button class="btn small" data-act="today-note" data-folder="${esc(s.course)}" title="Buka catatan hari ini">📝 Catatan</button>
        </li>`;
    })
    .join('');
  return `<div class="card today">
      <div class="today-head"><b>${esc(label)}</b><span>${list.length ? `${list.length} kuliah` : ''}</span></div>
      ${list.length
        ? `<ul class="class-list">${rows}</ul>`
        : `<div class="today-empty">Tidak ada kuliah hari ini. 🎉<div class="t-meta">${esc(nextClassText())}</div></div>`}
    </div>`;
}

function viewSchedule() {
  const today = new Date().getDay();
  const days = WEEK_ORDER.map((d) => {
    const items = S.schedule.filter((s) => s.day === d).sort(byStart);
    const rows = items
      .map(
        (s) => `<li class="class-row">
          <span class="time">${esc(s.start)}–${esc(s.end)}</span>
          <div class="c-body">
            <button class="name" data-act="goto-course" data-folder="${esc(s.course)}">${esc(courseTitle(s.course) || 'Mata kuliah')}</button>
            ${s.room ? `<div class="t-meta">${esc(s.room)}</div>` : ''}
          </div>
          <button class="btn small" data-act="sched-edit" data-id="${esc(s.id)}">Ubah</button>
          <button class="icon-btn" data-act="sched-del" data-id="${esc(s.id)}" title="Hapus">✕</button>
        </li>`
      )
      .join('');
    return `<div class="group-title ${d === today ? 'today-title' : ''}">${DAY_NAMES[d]}${d === today ? ' · hari ini' : ''}</div>
      ${items.length ? `<ul class="class-list card">${rows}</ul>` : '<div class="no-class">Tidak ada kuliah</div>'}`;
  }).join('');
  return `${breadcrumb([{ label: 'Jadwal' }])}
    <div class="page-head"><h1>Jadwal Kuliah</h1>
      <button class="btn primary" data-act="sched-add">＋ Tambah jadwal</button></div>
    ${days}`;
}

function openScheduleDialog(id) {
  if (!S.courses.length) return toast('Tambahkan mata kuliah dulu.', true);
  const e = S.schedule.find((x) => x.id === id) || { course: '', day: new Date().getDay(), start: '08:00', end: '09:40', room: '' };
  const dlg = $('#dlg');
  dlg.onclose = null;
  dlg.innerHTML = `
    <form data-form="schedule" data-id="${esc(id || '')}">
      <h2>${id ? 'Ubah' : 'Tambah'} jadwal</h2>
      <div class="set-label">Mata kuliah</div>
      <select class="dlg-input" name="course" required>
        ${S.courses.map((c) => `<option value="${esc(c.folder)}" ${c.folder === e.course ? 'selected' : ''}>${esc(c.title)}</option>`).join('')}
      </select>
      <div class="set-label">Hari</div>
      <select class="dlg-input" name="day">
        ${WEEK_ORDER.map((d) => `<option value="${d}" ${d === e.day ? 'selected' : ''}>${DAY_NAMES[d]}</option>`).join('')}
      </select>
      <div class="form-row">
        <label>Mulai<input class="dlg-input time-input" type="text" name="start" value="${esc(e.start)}" data-time inputmode="numeric" maxlength="5" placeholder="08:00" autocomplete="off" required></label>
        <label>Selesai<input class="dlg-input time-input" type="text" name="end" value="${esc(e.end)}" data-time inputmode="numeric" maxlength="5" placeholder="09:40" autocomplete="off" required></label>
      </div>
      <div class="field-hint">Format 24 jam. Cukup ketik angka: <b>1500</b> otomatis menjadi <b>15:00</b>, <b>930</b> menjadi <b>09:30</b>.</div>
      <div class="set-label">Ruang / keterangan (opsional)</div>
      <input class="dlg-input" name="room" value="${esc(e.room)}" autocomplete="off" placeholder="Contoh: Ruang 3.2 atau Zoom">
      <div class="form-error" id="sched-err" hidden></div>
      <div class="dlg-actions">
        <button type="button" class="btn" data-act="dlg-close">Batal</button>
        <button class="btn primary">Simpan</button>
      </div>
    </form>`;
  dlg.showModal();
}

// ----- To-do pieces -----

function todoForm(fixedCourse) {
  const courseField =
    fixedCourse === null
      ? `<select name="course" title="Mata kuliah">
           <option value="">Umum</option>
           ${S.courses.map((c) => `<option value="${esc(c.folder)}">${esc(c.title)}</option>`).join('')}
         </select>`
      : `<input type="hidden" name="course" value="${esc(fixedCourse)}">`;
  return `<form class="card todo-form" data-form="todo">
      <input type="text" name="title" placeholder="Tambah tugas…" autocomplete="off" required>
      ${courseField}
      <input type="date" name="due" title="Tenggat">
      <button class="btn primary">Tambah</button>
    </form>`;
}

function todoItem(t, showCourse) {
  const due = t.due ? dueLabel(t.due) : null;
  const course = showCourse && t.course ? courseTitle(t.course) : '';
  return `<li class="todo ${t.done ? 'done' : ''}">
      <input type="checkbox" data-act="toggle" data-id="${esc(t.id)}" ${t.done ? 'checked' : ''}>
      <div class="t-body">
        <div class="t-title">${esc(t.title)}</div>
        ${due || course
          ? `<div class="t-meta">${course ? `<span class="chip" title="${esc(course)}">${esc(course)}</span>` : ''}
               ${due && !t.done ? `<span class="due ${due.cls}">${esc(due.text)}</span>` : ''}</div>`
          : ''}
      </div>
      <button class="icon-btn" data-act="del-todo" data-id="${esc(t.id)}" title="Hapus">✕</button>
    </li>`;
}

function todoSections(list, showCourse) {
  const open = list.filter((t) => !t.done);
  const done = list.filter((t) => t.done);
  const byDue = (a, b) => (a.due || '9').localeCompare(b.due || '9') || a.created - b.created;
  const groups = [
    ['Terlambat', 'overdue', (t) => t.due && daysUntil(t.due) < 0],
    ['Hari ini', '', (t) => t.due && daysUntil(t.due) === 0],
    ['7 hari ke depan', '', (t) => t.due && daysUntil(t.due) >= 1 && daysUntil(t.due) <= 7],
    ['Nanti', '', (t) => t.due && daysUntil(t.due) > 7],
    ['Tanpa tenggat', '', (t) => !t.due],
  ];
  const html = groups
    .map(([title, cls, test]) => {
      const items = open.filter(test).sort(byDue);
      return items.length
        ? `<div class="group-title ${cls}">${title} · ${items.length}</div>
           <ul class="todo-list card">${items.map((t) => todoItem(t, showCourse)).join('')}</ul>`
        : '';
    })
    .join('');
  const doneHtml = done.length
    ? `<button class="link-btn" data-act="toggle-done">${S.showDone ? '▾' : '▸'} Selesai (${done.length})</button>
       ${S.showDone ? `<ul class="todo-list card">${done.map((t) => todoItem(t, showCourse)).join('')}</ul>` : ''}`
    : '';
  return (html || '<div class="empty">Belum ada tugas. 🎉</div>') + doneHtml;
}

// Flat list for the Tugas group on a course page (no due-date buckets).
function todoFlat(list) {
  const byDue = (a, b) => (a.due || '9').localeCompare(b.due || '9') || a.created - b.created;
  const open = list.filter((t) => !t.done).sort(byDue);
  const done = list.filter((t) => t.done);
  return `${open.length
      ? `<ul class="todo-list">${open.map((t) => todoItem(t, false)).join('')}</ul>`
      : '<div class="group-empty">Belum ada tugas.</div>'}
    ${done.length
      ? `<button class="link-btn pad" data-act="toggle-done">${S.showDone ? '▾' : '▸'} Selesai (${done.length})</button>
         ${S.showDone ? `<ul class="todo-list">${done.map((t) => todoItem(t, false)).join('')}</ul>` : ''}`
      : ''}`;
}

// ----- Dashboard -----

// Next time this course meets: { text } or null.
function nextSession(folder) {
  const entries = S.schedule.filter((s) => s.course === folder);
  if (!entries.length) return null;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  for (let i = 0; i <= 7; i++) {
    const day = (now.getDay() + i) % 7;
    const list = entries.filter((s) => s.day === day && (i > 0 || toMin(s.end) > mins)).sort(byStart);
    if (!list.length) continue;
    const s = list[0];
    const when = i === 0 ? 'Hari ini' : i === 1 ? 'Besok' : DAY_NAMES[day];
    return { text: `${when} · ${s.start}–${s.end}`, today: i === 0 };
  }
  return null;
}

const hueOf = (folder) => [...folder].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 8;

function courseCards() {
  const cards = S.courses
    .map((c) => {
      const next = nextSession(c.folder);
      return `<button class="course-card hue${hueOf(c.folder)}" data-act="nav" data-view="course" data-folder="${esc(c.folder)}">
          <span class="cc-title">${esc(c.title)}</span>
          <span class="cc-next ${next?.today ? 'today' : ''}">${next ? `🕘 ${esc(next.text)}` : 'Belum dijadwalkan'}</span>
          <span class="cc-stats">
            <span>📄 ${c.counts.Materi}</span><span>📝 ${c.counts.Catatan}</span><span>✅ ${openCount(c.folder)}</span>
          </span>
        </button>`;
    })
    .join('');
  return `<div class="course-grid">${cards}
      <button class="course-card add" data-act="add-course"><span class="cc-plus">＋</span><span>Mata kuliah baru</span></button>
    </div>
    <p class="legend">📄 materi · 📝 catatan · ✅ tugas yang belum selesai</p>`;
}

// ----- Views -----

function viewHome() {
  return `<div class="page-head"><h1>Dashboard</h1>
      <button class="btn" data-act="open-root">📂 Buka folder kuliah</button></div>
    <section class="dash"><h2>Kuliah Hari Ini</h2>${todayCard()}</section>
    <section class="dash"><h2>Tugas-Tugas</h2>${todoForm(null)}${todoSections(S.todos, true)}</section>
    <section class="dash"><h2>Mata Kuliah</h2>${courseCards()}</section>`;
}

function fileRow(f, { moves = false } = {}) {
  const meta = [f.isDir ? '' : fmtSize(f.size), fmtDate(f.mtime)].filter(Boolean).join(' · ');
  const p = esc(f.path);
  return `<li class="file">
      <span class="ico">${icon(f)}</span>
      <button class="name" data-act="open" data-path="${p}" title="${esc(f.name)}">${esc(f.name)}</button>
      <span class="meta">${meta}</span>
      <span class="actions">
        ${moves
          ? SECTIONS.map((s) => `<button class="btn small" data-act="move" data-path="${p}" data-section="${s}">→ ${s}</button>`).join('')
          : ''}
        <button class="btn small" data-act="reveal" data-path="${p}" title="Tampilkan di Explorer">Lokasi</button>
        <button class="btn small danger" data-act="trash" data-path="${p}" data-name="${esc(f.name)}" title="Hapus (ke Recycle Bin)">🗑</button>
      </span>
    </li>`;
}

const noteTitle = (name) => name.replace(/\.md$/i, '');

// Dashboard > ... > current page. Every crumb except the last is a link; `act` overrides
// the default "go to the dashboard" so a crumb can e.g. close the open note first.
function breadcrumb(trail) {
  const crumbs = [{ label: 'Dashboard', act: 'nav', view: 'home' }, ...trail];
  return `<nav class="crumbs" aria-label="Breadcrumb">${crumbs
    .map((c, i) => {
      const last = i === crumbs.length - 1;
      const body = last
        ? `<span class="crumb current" aria-current="page" title="${esc(c.label)}">${esc(c.label)}</span>`
        : `<button class="crumb" data-act="${c.act || 'nav'}" ${c.view ? `data-view="${c.view}"` : ''} title="${esc(c.label)}">${esc(c.label)}</button>`;
      return last ? body : `${body}<span class="sep">›</span>`;
    })
    .join('')}</nav>`;
}

function group(title, count, actions, body) {
  return `<section class="group card">
      <div class="group-head"><h2>${title}<span class="count">${count}</span></h2><div class="g-actions">${actions}</div></div>
      ${body}
    </section>`;
}

function noteRow(f) {
  return `<li class="file">
      <span class="ico">📝</span>
      <button class="name" data-act="open-note" data-name="${esc(f.name)}" title="${esc(noteTitle(f.name))}">${esc(noteTitle(f.name))}</button>
      <span class="meta">${fmtDate(f.mtime)}</span>
      <span class="actions">
        <button class="btn small danger" data-act="note-del" data-name="${esc(f.name)}" title="Hapus (ke Recycle Bin)">🗑</button>
      </span>
    </li>`;
}

function viewCourse() {
  const c = S.courses.find((x) => x.folder === S.view.folder);
  if (S.note) return viewNoteEditor(c);
  const files = S.files;
  const todos = S.todos.filter((t) => t.course === c.folder);
  const meets = S.schedule
    .filter((s) => s.course === c.folder)
    .sort((a, b) => WEEK_ORDER.indexOf(a.day) - WEEK_ORDER.indexOf(b.day) || byStart(a, b))
    .map((s) => `<span class="chip meet">🕘 ${DAY_NAMES[s.day]} ${esc(s.start)}–${esc(s.end)}${s.room ? ` · ${esc(s.room)}` : ''}</span>`)
    .join('');
  const addFiles = (section) => `<button class="btn small primary" data-act="add-files" data-section="${section}">＋ Tambah file</button>`;
  const fileList = (list, empty) =>
    list.length ? `<ul class="file-list">${list.map((f) => fileRow(f)).join('')}</ul>` : `<div class="group-empty">${empty}</div>`;

  const materi = group('📄 Materi', files.Materi.length, addFiles('Materi'),
    fileList(files.Materi, 'Belum ada materi. Klik <b>Tambah file</b> atau seret file ke jendela ini.'));

  const tugas = group('✅ Tugas', openCount(c.folder), addFiles('Tugas'),
    `${todoForm(c.folder)}
     ${todoFlat(todos)}
     <div class="subhead">Berkas tugas · ${files.Tugas.length}</div>
     ${fileList(files.Tugas, 'Belum ada berkas tugas.')}`);

  const catatan = group('📝 Catatan', files.Catatan.length,
    `<button class="btn small" data-act="note-today">Catatan hari ini</button>
     <button class="btn small primary" data-act="note-new">＋ Catatan baru</button>`,
    files.Catatan.length
      ? `<ul class="file-list">${files.Catatan.map(noteRow).join('')}</ul>`
      : '<div class="group-empty">Belum ada catatan. Catatan disimpan sebagai file .md di folder Catatan.</div>');

  const lainnya = files.Lainnya.length
    ? group('📁 Lainnya', files.Lainnya.length, '',
        `<div class="subhead">File yang belum dikelompokkan. Pindahkan ke Materi atau Tugas.</div>
         <ul class="file-list">${files.Lainnya.map((f) => fileRow(f, { moves: true })).join('')}</ul>`)
    : '';

  return `${breadcrumb([{ label: c.title }])}
    <div class="page-head">
      <h1>${esc(c.title)}</h1>
      <button class="btn" data-act="open-course">📂 Buka folder</button>
    </div>
    ${meets ? `<div class="meets">${meets}</div>` : ''}
    ${materi}${tugas}${catatan}${lainnya}`;
}

function viewNoteEditor(c) {
  const n = S.note;
  return `${breadcrumb([{ label: c.title, act: 'note-back' }, { label: noteTitle(n.name) }])}
    <div class="page-head">
      <h1>${esc(noteTitle(n.name))}</h1>
      <span id="note-status" class="hint">${S.noteDirty ? 'Menyimpan…' : 'Tersimpan'}</span>
      <button class="btn" data-act="note-rename">Ubah nama</button>
      <button class="btn danger" data-act="note-del" title="Hapus (ke Recycle Bin)">🗑</button>
    </div>
    <div class="card note-pane">
      <textarea id="note-editor" spellcheck="false" placeholder="Tulis catatan di sini…">${esc(n.content)}</textarea>
    </div>`;
}

function viewInbox() {
  const opts = S.courses
    .map((c) => `<option value="${esc(c.folder)}" ${c.folder === S.inboxCourse ? 'selected' : ''}>${esc(c.title)}</option>`)
    .join('');
  return `${breadcrumb([{ label: 'Inbox' }])}
    <div class="page-head"><h1>Inbox</h1></div>
    <p class="sub">File yang tergeletak di ${esc(S.settings.inboxDirs.map((d) => d.split(/[\\/]/).pop() || d).join(', ') || '—')}. Pilih mata kuliah tujuan, lalu pindahkan.</p>
    <div class="card inbox-bar">
      <span>Pindahkan ke:</span>
      <select class="select" data-act="inbox-course">
        <option value="">— pilih mata kuliah —</option>${opts}
      </select>
    </div>
    ${S.inbox.length
      ? `<ul class="file-list card">${S.inbox.map(inboxRow).join('')}</ul>`
      : '<div class="empty">Inbox kosong. Rapi! ✨</div>'}`;
}

function inboxRow(f) {
  const p = esc(f.path);
  return `<li class="file">
      <span class="ico">${icon(f)}</span>
      <button class="name" data-act="open" data-path="${p}" title="${esc(f.name)}">${esc(f.name)}</button>
      <span class="meta">${esc(f.source)} · ${fmtSize(f.size)} · ${fmtDate(f.mtime)}</span>
      <span class="actions">
        ${SECTIONS.map((s) => `<button class="btn small primary" data-act="inbox-move" data-path="${p}" data-section="${s}">→ ${s}</button>`).join('')}
        <button class="btn small danger" data-act="trash" data-path="${p}" data-name="${esc(f.name)}" title="Hapus (ke Recycle Bin)">🗑</button>
      </span>
    </li>`;
}

// ---------- Actions ----------

const run = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (e) {
    toast(cleanErr(e), true);
  }
};

// Leaving the note editor (or the course) always saves pending edits first.
async function closeNote() {
  await flushNote();
  S.note = null;
}

async function goCourse(folder) {
  await closeNote();
  S.view = { type: 'course', folder };
  S.files = await api.courseFiles(folder);
  render();
}

async function newNote(title, reuse) {
  await flushNote();
  const folder = S.view.folder;
  const name = await api.createNote({ folder, title, reuse });
  await refresh();
  S.note = { folder, name, content: await api.readNote({ folder, name }) };
  renderMain();
}

async function addFilesTo(section, paths) {
  if (!paths.length) return;
  await api.addFiles({ folder: S.view.folder, section, paths });
  toast(`${paths.length} item disalin ke ${section}`);
  await refresh();
}

const actions = {
  nav: run(async (el) => {
    const { view, folder } = el.dataset;
    if (view === 'course') return goCourse(folder);
    await closeNote();
    S.view = { type: view };
    render();
  }),

  'goto-course': run((el) => goCourse(el.dataset.folder)),

  // ----- Notes -----
  'open-note': run((el) => openNote(el.dataset.name)),

  'note-new': run(async () => {
    const title = await askText('Catatan baru', 'Judul, mis. Pertemuan 5 - Regresi');
    if (title) await newNote(title, false);
  }),

  'note-today': run(() => newNote(isoToday(), true)),

  'today-note': run(async (el) => {
    const folder = el.dataset.folder;
    const name = await api.createNote({ folder, title: isoToday(), reuse: true });
    await goCourse(folder);
    await openNote(name);
  }),

  'note-back': run(async () => {
    await closeNote();
    await refresh();
  }),

  'note-rename': run(async () => {
    const current = S.note.name.replace(/\.md$/i, '');
    const title = await askText('Ubah nama catatan', 'Judul catatan', current);
    if (!title || title === current) return;
    await flushNote();
    S.note.name = await api.renameNote({ folder: S.note.folder, name: S.note.name, title });
    await refresh();
  }),

  // From a row on the course page (data-name) or from the open editor.
  'note-del': run(async (el) => {
    const name = el.dataset.name || S.note?.name;
    if (!name || !confirm(`Pindahkan catatan "${noteTitle(name)}" ke Recycle Bin?`)) return;
    if (S.note?.name === name) {
      clearTimeout(noteTimer);
      S.noteDirty = false;
      S.note = null;
    }
    await api.trashNote({ folder: S.view.folder, name });
    await refresh();
  }),

  // ----- Schedule -----
  'sched-add': () => openScheduleDialog(),
  'sched-edit': (el) => openScheduleDialog(el.dataset.id),
  'sched-del': run(async (el) => {
    if (!confirm('Hapus jadwal ini?')) return;
    S.schedule = S.schedule.filter((s) => s.id !== el.dataset.id);
    render();
    await persist();
  }),

  open: run((el) => api.openPath(el.dataset.path)),
  reveal: run((el) => api.revealPath(el.dataset.path)),
  'open-root': run(() => api.openRoot()),
  'open-course': run(() => api.openPath(S.files.path)),

  trash: run(async (el) => {
    if (!confirm(`Pindahkan "${el.dataset.name}" ke Recycle Bin?`)) return;
    await api.trashPath(el.dataset.path);
    await refresh();
  }),

  move: run(async (el) => {
    await api.moveFile({ src: el.dataset.path, folder: S.view.folder, section: el.dataset.section });
    toast(`Dipindahkan ke ${el.dataset.section}`);
    await refresh();
  }),

  'inbox-move': run(async (el) => {
    if (!S.inboxCourse) return toast('Pilih mata kuliah tujuan dulu.', true);
    await api.moveFile({ src: el.dataset.path, folder: S.inboxCourse, section: el.dataset.section });
    toast(`Dipindahkan ke ${courseTitle(S.inboxCourse)} / ${el.dataset.section}`);
    await refresh();
  }),

  'add-files': run(async (el) => {
    const paths = await api.pickFiles();
    await addFilesTo(el.dataset.section, paths);
  }),

  'add-course': run(async () => {
    if (!S.settings?.root) return toast('Pilih folder kuliah dulu di Pengaturan.', true);
    const name = await askText('Mata kuliah baru', 'Contoh: Ekonomi Manajerial');
    if (!name) return;
    const folder = await api.createCourse(name);
    await refresh();
    await goCourse(folder);
  }),

  'toggle-done': () => {
    S.showDone = !S.showDone;
    renderMain();
  },

  'del-todo': run(async (el) => {
    S.todos = S.todos.filter((t) => t.id !== el.dataset.id);
    render();
    await persist();
  }),

  settings: openSettings,
  'dlg-close': () => $('#dlg').close('cancel'),
  'set-root': run(async () => {
    S.settings = await api.pickRoot();
    renderSettings();
    await loadAll();
  }),
  'set-root-first': run(async () => {
    S.settings = await api.pickRoot();
    await loadAll();
  }),
  'set-add-inbox': run(async () => {
    S.settings = await api.addInboxDir();
    renderSettings();
    await refresh();
  }),
  'set-rm-inbox': run(async (el) => {
    S.settings = await api.removeInboxDir(el.dataset.dir);
    renderSettings();
    await refresh();
  }),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && el.tagName !== 'INPUT' && el.tagName !== 'SELECT') actions[el.dataset.act]?.(el, e);
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.act === 'toggle') {
    const t = S.todos.find((x) => x.id === el.dataset.id);
    if (!t) return;
    t.done = el.checked;
    render();
    run(persist)();
  } else if (el.dataset.act === 'inbox-course') {
    S.inboxCourse = el.value;
    store('inboxCourse', el.value);
  }
});

// ---------- 24-hour time entry: typing "1500" gives "15:00" ----------

// Live formatting while typing. A first digit of 3-9 (or 2 followed by 4-9) can only be a one-digit
// hour, so "930" reads as 9:30 rather than 93:0.
function formatTimeTyping(raw) {
  const d = String(raw).replace(/\D/g, '').slice(0, 4);
  if (!d) return '';
  const twoDigitHour = d[0] <= '1' || (d[0] === '2' && (d[1] === undefined || d[1] <= '3'));
  const hourLen = twoDigitHour ? 2 : 1;
  const hour = d.slice(0, hourLen);
  const minute = d.slice(hourLen, hourLen + 2);
  return d.length > hourLen ? `${hour}:${minute}` : hour;
}

// Final "HH:MM" (zero-padded), or null if it is not a valid 24-hour time.
function parseTime(raw) {
  const typed = formatTimeTyping(raw);
  if (!typed) return null;
  const [h, m = '0'] = typed.split(':');
  const hh = Number(h);
  const mm = Number(m.padStart(2, '0'));
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'note-editor' && S.note) onNoteInput(e.target.value);
  if (e.target.matches('[data-time]')) {
    const formatted = formatTimeTyping(e.target.value);
    if (formatted !== e.target.value) e.target.value = formatted;
    const err = $('#sched-err');
    if (err) err.hidden = true;
  }
});

// Select the whole time on focus so it can simply be retyped.
document.addEventListener('focusin', (e) => {
  if (e.target.matches('[data-time]')) e.target.select();
});

document.addEventListener('focusout', (e) => {
  // Don't lose the last keystrokes when focus leaves the editor or the window closes.
  if (e.target.id === 'note-editor') flushNote();
  // Complete a partly typed time on blur: "15" -> "15:00", "9" -> "09:00".
  if (e.target.matches('[data-time]')) {
    const full = parseTime(e.target.value);
    if (full) e.target.value = full;
  }
});
window.addEventListener('beforeunload', () => {
  flushNote();
});

function submitSchedule(form) {
  const f = new FormData(form);
  const start = parseTime(f.get('start'));
  const end = parseTime(f.get('end'));
  const fail = (msg) => {
    const err = $('#sched-err');
    err.textContent = msg;
    err.hidden = false;
  };
  if (!start || !end) return fail('Jam tidak valid. Gunakan format 24 jam, mis. 08:00 atau ketik 0800 (00:00 sampai 23:59).');
  if (toMin(end) <= toMin(start)) return fail('Jam selesai harus setelah jam mulai.');
  const entry = {
    id: form.dataset.id || crypto.randomUUID(),
    course: String(f.get('course')),
    day: Number(f.get('day')),
    start,
    end,
    room: String(f.get('room') || '').trim(),
  };
  S.schedule = form.dataset.id ? S.schedule.map((s) => (s.id === entry.id ? entry : s)) : [...S.schedule, entry];
  $('#dlg').close('ok');
  render();
  run(persist)();
}

document.addEventListener('submit', (e) => {
  const sched = e.target.closest('form[data-form="schedule"]');
  if (sched) {
    e.preventDefault();
    return submitSchedule(sched);
  }
  const form = e.target.closest('form[data-form="todo"]');
  if (!form) return;
  e.preventDefault();
  const f = new FormData(form);
  const title = String(f.get('title')).trim();
  if (!title) return;
  S.todos.push({
    id: crypto.randomUUID(),
    title,
    course: String(f.get('course') || ''),
    due: String(f.get('due') || ''),
    done: false,
    created: Date.now(),
  });
  form.reset();
  render();
  run(persist)();
});

// ---------- Drag & drop (files go straight into Materi / Tugas) ----------

const overlay = $('#overlay');
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
const hideOverlay = () => {
  dragDepth = 0;
  overlay.hidden = true;
  overlay.querySelectorAll('.zone').forEach((z) => z.classList.remove('hot'));
};

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (!hasFiles(e)) return;
  dragDepth++;
  if (S.view.type === 'course') overlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  const zone = e.target instanceof Element ? e.target.closest('.zone') : null;
  overlay.querySelectorAll('.zone').forEach((z) => z.classList.toggle('hot', z === zone));
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) hideOverlay();
});
window.addEventListener(
  'drop',
  run(async (e) => {
    e.preventDefault();
    const zone = e.target instanceof Element ? e.target.closest('.zone') : null;
    hideOverlay();
    if (!hasFiles(e)) return;
    if (S.view.type !== 'course') return toast('Buka salah satu mata kuliah dulu, lalu seret file ke sana.', true);
    const section = zone?.dataset.section || 'Materi';
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    await addFilesTo(section, paths);
  })
);

// ---------- Sidebar toggle (Ctrl+B) ----------

const appEl = $('#app');
const sideToggle = $('#side-toggle');

function setSidebar(collapsed) {
  appEl.classList.toggle('collapsed', collapsed);
  sideToggle.textContent = collapsed ? '☰' : '‹';
  sideToggle.title = `${collapsed ? 'Tampilkan' : 'Sembunyikan'} sidebar (Ctrl+B)`;
  store('sidebarCollapsed', collapsed ? '1' : '0');
}
const toggleSidebar = () => setSidebar(!appEl.classList.contains('collapsed'));

sideToggle.addEventListener('click', toggleSidebar);
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleSidebar();
  }
});
setSidebar(store('sidebarCollapsed') === '1');

// ---------- Boot ----------

api.onChanged(() => refresh(true).catch(() => {}));

// Keep "Hari ini" statuses (sedang berlangsung / selesai) and the date current.
setInterval(() => {
  if (S.view.type === 'home' || S.view.type === 'schedule') render(true);
}, 60000);

run(loadAll)();
