const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const COURSE_PREFIX = '[Matkul] ';
const SECTIONS = ['Materi', 'Tugas'];
const NOTES_DIR = 'Catatan';
const RESERVED = [...SECTIONS, NOTES_DIR]; // subfolders the app owns inside a course folder
const DATA_DIR = '.asisten-kuliah';
const DATA_FILE = 'data.json';
const IGNORED = /^(\.|~\$|desktop\.ini$|thumbs\.db$)|\.(lnk|tmp|crdownload|part|ini)$/i;

// Indonesian locale so native controls (e.g. the date picker) use dd/mm/yyyy.
app.commandLine.appendSwitch('lang', 'id');

let win = null;
let settings = { root: null, inboxDirs: [] };
let watchers = [];

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

// ---------- Settings ----------

// There is no default course folder: on first run the user picks one (see "set-root-first" in the UI).
function loadSettings() {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {}
  settings = {
    root: saved?.root && fs.existsSync(saved.root) ? saved.root : null,
    inboxDirs: Array.isArray(saved?.inboxDirs) ? saved.inboxDirs : [app.getPath('desktop')],
  };
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// ---------- Path helpers ----------

function within(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function allowedPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  return [settings.root, ...settings.inboxDirs].filter(Boolean).some((d) => within(d, p));
}

function assertAllowed(p) {
  if (!allowedPath(p)) throw new Error('Path di luar folder yang dikelola aplikasi.');
  return p;
}

function requireRoot() {
  if (!settings.root) throw new Error('Folder kuliah belum dipilih. Buka Pengaturan.');
  return settings.root;
}

function courseDir(folder) {
  if (typeof folder !== 'string' || folder !== path.basename(folder) || folder === '.' || folder === '..') {
    throw new Error('Nama mata kuliah tidak valid.');
  }
  const dir = path.join(requireRoot(), folder);
  if (!fs.existsSync(dir)) throw new Error('Folder mata kuliah tidak ditemukan.');
  return dir;
}

function sectionDir(folder, section) {
  const base = courseDir(folder);
  if (!section) return base;
  if (!SECTIONS.includes(section)) throw new Error('Bagian tidak valid.');
  return path.join(base, section);
}

async function uniquePath(dir, name) {
  const { name: stem, ext } = path.parse(name);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

async function moveEntry(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(src, dest, { recursive: true, errorOnExist: true });
    await fsp.rm(src, { recursive: true, force: true });
  }
}

// ---------- Listing ----------

async function describe(dir, dirent) {
  const full = path.join(dir, dirent.name);
  let st;
  try {
    st = await fsp.stat(full);
  } catch {
    return null;
  }
  return { name: dirent.name, path: full, isDir: dirent.isDirectory(), size: st.size, mtime: st.mtimeMs };
}

async function listEntries(dir, { filesOnly = false, exclude = [] } = {}) {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const wanted = dirents.filter(
    (d) => !IGNORED.test(d.name) && !exclude.includes(d.name) && (!filesOnly || d.isFile())
  );
  const items = (await Promise.all(wanted.map((d) => describe(dir, d)))).filter(Boolean);
  return items.sort((a, b) => b.mtime - a.mtime);
}

async function listCourses() {
  const root = requireRoot();
  const dirents = await fsp.readdir(root, { withFileTypes: true });
  const courses = await Promise.all(
    dirents
      .filter((d) => d.isDirectory() && d.name.startsWith(COURSE_PREFIX))
      .map(async (d) => {
        const base = path.join(root, d.name);
        const [Materi, Tugas, Catatan, Lainnya] = await Promise.all([
          listEntries(path.join(base, 'Materi')),
          listEntries(path.join(base, 'Tugas')),
          listEntries(path.join(base, NOTES_DIR), { filesOnly: true }).then((l) => l.filter((n) => /\.md$/i.test(n.name))),
          listEntries(base, { exclude: RESERVED }),
        ]);
        return {
          folder: d.name,
          title: d.name.slice(COURSE_PREFIX.length),
          path: base,
          counts: { Materi: Materi.length, Tugas: Tugas.length, Catatan: Catatan.length, Lainnya: Lainnya.length },
        };
      })
  );
  return courses.sort((a, b) => a.title.localeCompare(b.title, 'id'));
}

async function listCourseFiles(folder) {
  const base = courseDir(folder);
  const [Materi, Tugas, Catatan, Lainnya] = await Promise.all([
    listEntries(path.join(base, 'Materi')),
    listEntries(path.join(base, 'Tugas')),
    listEntries(path.join(base, NOTES_DIR), { filesOnly: true }).then((l) => l.filter((n) => /\.md$/i.test(n.name))),
    listEntries(base, { exclude: RESERVED }),
  ]);
  return { path: base, Materi, Tugas, Catatan, Lainnya };
}

// ---------- Notes (Markdown files in <course>/Catatan) ----------

const BAD_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

function cleanTitle(title) {
  const t = String(title ?? '')
    .replace(BAD_NAME_CHARS, '')
    .trim()
    .replace(/[. ]+$/, '');
  if (!t) throw new Error('Judul catatan kosong.');
  return t;
}

function notePath(folder, name) {
  if (typeof name !== 'string' || name !== path.basename(name) || !/\.md$/i.test(name) || /[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw new Error('Nama catatan tidak valid.');
  }
  return path.join(courseDir(folder), NOTES_DIR, name);
}

async function listInbox() {
  const seen = new Set();
  const groups = await Promise.all(
    settings.inboxDirs.map(async (dir) => {
      const items = await listEntries(dir, { filesOnly: true });
      return items.map((i) => ({ ...i, source: path.basename(dir) || dir }));
    })
  );
  return groups
    .flat()
    .filter((i) => (seen.has(i.path) ? false : seen.add(i.path)))
    .sort((a, b) => b.mtime - a.mtime);
}

// ---------- Data (to-do + class schedule) ----------

const dataPath = () => path.join(requireRoot(), DATA_DIR, DATA_FILE);

async function loadData() {
  try {
    const parsed = JSON.parse(await fsp.readFile(dataPath(), 'utf8'));
    return {
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      schedule: Array.isArray(parsed.schedule) ? parsed.schedule : [],
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { todos: [], schedule: [] };
    throw e;
  }
}

async function saveData(data) {
  const file = dataPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ todos: data.todos ?? [], schedule: data.schedule ?? [] }, null, 2));
  await fsp.rename(tmp, file);
}

// ---------- Watching ----------

function startWatching() {
  stopWatching();
  let timer = null;
  const notify = (_evt, filename) => {
    if (filename && String(filename).startsWith(DATA_DIR)) return;
    clearTimeout(timer);
    timer = setTimeout(() => win?.webContents.send('fs:changed'), 400);
  };
  const watch = (dir, recursive) => {
    try {
      const w = fs.watch(dir, { recursive }, notify);
      w.on('error', () => {});
      watchers.push(w);
    } catch {}
  };
  if (settings.root) watch(settings.root, true);
  settings.inboxDirs.forEach((d) => watch(d, false));
}

function stopWatching() {
  watchers.forEach((w) => w.close());
  watchers = [];
}

// ---------- IPC ----------

function registerIpc() {
  const h = (name, fn) => ipcMain.handle(name, (_e, ...args) => fn(...args));

  h('settings:get', () => ({ ...settings }));

  h('settings:pickRoot', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Pilih folder kuliah',
      properties: ['openDirectory'],
      defaultPath: settings.root || app.getPath('desktop'),
    });
    if (r.canceled || !r.filePaths[0]) return { ...settings };
    settings.root = r.filePaths[0];
    saveSettings();
    startWatching();
    return { ...settings };
  });

  h('settings:addInbox', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Tambah folder Inbox',
      properties: ['openDirectory'],
      defaultPath: app.getPath('desktop'),
    });
    if (!r.canceled && r.filePaths[0] && !settings.inboxDirs.includes(r.filePaths[0])) {
      settings.inboxDirs.push(r.filePaths[0]);
      saveSettings();
      startWatching();
    }
    return { ...settings };
  });

  h('settings:removeInbox', (dir) => {
    settings.inboxDirs = settings.inboxDirs.filter((d) => d !== dir);
    saveSettings();
    startWatching();
    return { ...settings };
  });

  h('courses:list', listCourses);

  h('courses:create', async (name) => {
    const clean = String(name ?? '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .trim();
    if (!clean) throw new Error('Nama mata kuliah kosong.');
    const dir = path.join(requireRoot(), COURSE_PREFIX + clean);
    if (fs.existsSync(dir)) throw new Error('Mata kuliah itu sudah ada.');
    await fsp.mkdir(dir);
    return COURSE_PREFIX + clean;
  });

  h('course:files', listCourseFiles);

  h('notes:read', ({ folder, name }) => fsp.readFile(notePath(folder, name), 'utf8'));

  h('notes:write', async ({ folder, name, content }) => {
    const file = notePath(folder, name);
    if (typeof content !== 'string') throw new Error('Isi catatan tidak valid.');
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, file);
  });

  // reuse: if a note with that title exists, return it instead of creating "title (1)".
  h('notes:create', async ({ folder, title, reuse }) => {
    const dir = path.join(courseDir(folder), NOTES_DIR);
    await fsp.mkdir(dir, { recursive: true });
    const t = cleanTitle(title);
    let file = path.join(dir, `${t}.md`);
    if (fs.existsSync(file)) {
      if (reuse) return `${t}.md`;
      file = await uniquePath(dir, `${t}.md`);
    }
    await fsp.writeFile(file, `# ${t}\n\n`, { flag: 'wx' });
    return path.basename(file);
  });

  h('notes:rename', async ({ folder, name, title }) => {
    const from = notePath(folder, name);
    const next = `${cleanTitle(title)}.md`;
    const to = notePath(folder, next);
    if (to.toLowerCase() !== from.toLowerCase() && fs.existsSync(to)) throw new Error('Sudah ada catatan dengan judul itu.');
    await fsp.rename(from, to);
    return next;
  });

  h('notes:trash', ({ folder, name }) => shell.trashItem(path.resolve(notePath(folder, name))));

  h('files:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Pilih file', properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });

  h('files:add', async ({ folder, section, paths }) => {
    const destDir = sectionDir(folder, section);
    await fsp.mkdir(destDir, { recursive: true });
    for (const src of paths) {
      if (typeof src !== 'string' || !path.isAbsolute(src)) continue;
      if (within(src, destDir)) throw new Error('Tidak bisa menyalin folder ke dalam dirinya sendiri.');
      await fsp.cp(src, await uniquePath(destDir, path.basename(src)), { recursive: true });
    }
  });

  h('files:move', async ({ src, folder, section }) => {
    assertAllowed(src);
    const destDir = sectionDir(folder, section);
    await fsp.mkdir(destDir, { recursive: true });
    if (path.resolve(path.dirname(src)) === path.resolve(destDir)) return;
    await moveEntry(src, await uniquePath(destDir, path.basename(src)));
  });

  h('files:open', async (p) => {
    const err = await shell.openPath(assertAllowed(p));
    if (err) throw new Error(err);
  });

  h('files:reveal', (p) => shell.showItemInFolder(assertAllowed(p)));

  h('files:trash', (p) => shell.trashItem(path.resolve(assertAllowed(p))));

  h('root:open', async () => {
    const err = await shell.openPath(requireRoot());
    if (err) throw new Error(err);
  });

  h('inbox:list', listInbox);

  h('data:load', loadData);
  h('data:save', saveData);
}

// ---------- Window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 820,
    minHeight: 520,
    show: false,
    backgroundColor: '#f6f7fb',
    title: 'Asisten Kuliah',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    loadSettings();
    registerIpc();
    createWindow();
    startWatching();
  });

  app.on('window-all-closed', () => {
    stopWatching();
    app.quit();
  });
}
