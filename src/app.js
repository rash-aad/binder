import * as pdfjs from '../node_modules/pdfjs-dist/build/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '../node_modules/pdfjs-dist/build/pdf.worker.mjs';

const $ = s => document.querySelector(s);
const COLORS = { yellow: '#ffe45c', green: '#7ee27e', blue: '#7cc4ff', pink: '#ff9ac8', orange: '#ffb35c' };
const uid = () => Math.random().toString(36).slice(2, 10);
const emptyData = () => ({ lastPage: 1, zoom: 1, highlights: [], bookmarks: [], dogears: [], stickies: [], notes: '', notesHtml: null });

let books = [];
let cur = null; // { id, pdf, data, pages: [{div, page, w, h, rendered}] }
let color = 'yellow';
let hlOn = false;
let stickyOn = false;
let saveTimer = null;
let libTab = 'books';

/* ---------- library ---------- */

async function loadLibrary() {
  books = await api.list();
  renderLibrary();
}

async function renderLibrary() {
  if (libTab === 'notes') return renderAllNotes();
  const q = $('#libSearch').value.trim().toLowerCase();
  const grid = $('#grid');
  $('#allNotes').hidden = true;
  grid.hidden = false;
  grid.innerHTML = '';
  const shown = books.filter(b => !b.deleted && b.title.toLowerCase().includes(q));
  if (!shown.length) {
    grid.innerHTML = `<div class="empty">${books.some(b => !b.deleted) ? 'No matches.' : 'Your library is empty. Click “+ Add PDF”.'}</div>`;
    return;
  }
  for (const b of shown) {
    const el = document.createElement('div');
    el.className = 'book';
    el.innerHTML = `<div class="cover"></div><div class="t"></div><button class="x" title="Delete PDF and all its notes">🗑 Delete</button><button class="rn" title="Rename">✎ Rename</button>`;
    el.querySelector('.t').textContent = b.title;
    if (b.complete) el.insertAdjacentHTML('beforeend', '<span class="done">✔ Completed</span>');
    el.onclick = () => openBook(b);
    el.querySelector('.x').onclick = e => { e.stopPropagation(); deleteBook(b); };
    el.querySelector('.rn').onclick = e => { e.stopPropagation(); renameInline(el.querySelector('.t'), b); };
    grid.append(el);
    drawCover(b.id, el.querySelector('.cover'));
  }
}

// Swap a title element for an input; Enter or clicking away saves, Escape cancels.
function renameInline(el, b) {
  const inp = document.createElement('input');
  inp.value = b.title;
  inp.style.width = '100%';
  el.replaceWith(inp);
  inp.focus(); inp.select();
  inp.onclick = e => e.stopPropagation();
  let done = false;
  const finish = async ok => {
    if (done) return;
    done = true;
    const title = inp.value.trim();
    if (ok && title && title !== b.title) books = await api.rename(b.id, title);
    inp.replaceWith(el);
    if (cur?.id === b.id) $('#bookTitle').textContent = books.find(x => x.id === b.id).title;
    if (!$('#library').hidden) renderLibrary();
  };
  inp.onkeydown = e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
}

async function deleteBook(b) {
  if (!confirm(`Delete the PDF “${b.title}”? Your notes, sticky notes and screenshots are kept in Your Notes.`)) return;
  if (cur?.id === b.id) { clearTimeout(saveTimer); closeBook(); }
  books = await api.remove(b.id);
  renderLibrary();
}

async function drawCover(id, box) {
  try {
    const task = pdfjs.getDocument({ data: await api.readPdf(id) });
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 0.5 });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    box.append(c);
    task.destroy();
  } catch { box.textContent = 'PDF'; }
}

async function renderAllNotes() {
  const q = $('#libSearch').value.trim().toLowerCase();
  const box = $('#allNotes');
  $('#grid').hidden = true;
  box.hidden = false;
  box.replaceChildren();
  let any = false;
  for (const b of books) {
    const d = await api.loadData(b.id);
    if (!d) continue;
    const notes = [];
    if (d.notes?.trim() || d.notesHtml?.includes('<img')) notes.push({ label: 'Notes', text: d.notes, html: d.notesHtml, page: null });
    for (const s of d.stickies || []) if (s.text.trim()) notes.push({ label: `Sticky note · page ${s.page}`, text: s.text, page: s.page });
    const shown = notes.filter(n => !q || n.text.toLowerCase().includes(q) || b.title.toLowerCase().includes(q));
    if (!shown.length) continue;
    any = true;
    const h = document.createElement('h3');
    h.textContent = b.title + (b.deleted ? ' (PDF deleted)' : '');
    h.onclick = () => openNotesOnly(b);
    box.append(h);
    for (const n of shown) {
      const el = document.createElement('div');
      el.className = 'note';
      el.innerHTML = '<small></small><span></span>';
      el.querySelector('small').textContent = n.label;
      if (n.html) el.querySelector('span').innerHTML = sanitize(n.html); else el.querySelector('span').textContent = n.text;
      el.onclick = () => openNotesOnly(b);
      box.append(el);
    }
  }
  if (!any) box.innerHTML = '<div class="empty">No notes yet. Notes and sticky notes you write in a PDF show up here.</div>';
}

// Full-page notes reader/editor for one PDF; works even after the PDF itself is deleted.
async function openNotesOnly(b) {
  const d = Object.assign(emptyData(), await api.loadData(b.id));
  const body = $('#npBody');
  body.replaceChildren();
  let timer;
  const persist = () => { clearTimeout(timer); timer = setTimeout(() => api.saveData(b.id, d), 300); };
  const flush = () => { clearTimeout(timer); return api.saveData(b.id, d); };

  $('#npTitle').textContent = b.title + (b.deleted ? ' (PDF deleted)' : '');
  $('#npOpen').hidden = !!b.deleted;
  $('#library').hidden = true;
  $('#notesPage').hidden = false;
  $('#npScroll').scrollTop = 0;

  const close = () => { $('#notesPage').hidden = true; $('#library').hidden = false; renderAllNotes(); };
  $('#npBack').onclick = async () => { await flush(); close(); };
  $('#npOpen').onclick = async () => { await flush(); $('#notesPage').hidden = true; openBook(b); };
  $('#npDel').onclick = async () => {
    if (!confirm(`Permanently delete the notes for “${b.title}”?${b.deleted ? '' : ' The PDF itself is kept.'}`)) return;
    clearTimeout(timer);
    books = await api.purge(b.id);
    close();
  };

  const h1 = document.createElement('h1');
  h1.textContent = b.title;
  body.append(h1);

  const ed = document.createElement('div');
  ed.id = 'notesOnly';
  ed.contentEditable = 'true';
  ed.dataset.ph = 'Notes… (paste images with Ctrl+V)';
  ed.innerHTML = sanitize(d.notesHtml ?? esc(d.notes));
  ed.oninput = () => { d.notesHtml = ed.innerHTML; d.notes = ed.innerText; persist(); };
  allowPaste(ed);
  body.append(ed);

  if (d.stickies.length) body.insertAdjacentHTML('beforeend', '<h4>STICKY NOTES</h4>');
  for (const s of d.stickies) {
    const row = document.createElement('div');
    row.className = 'stickyRow';
    row.innerHTML = '<small></small><textarea></textarea>';
    row.querySelector('small').textContent = `Page ${s.page}`;
    const ta = row.querySelector('textarea');
    ta.value = s.text;
    ta.oninput = () => { s.text = ta.value; persist(); };
    body.append(row);
  }
}

function setLibTab(t) {
  libTab = t;
  $('#tabBooks').classList.toggle('on', t === 'books');
  $('#tabNotes').classList.toggle('on', t === 'notes');
  renderLibrary();
}
$('#tabBooks').onclick = () => setLibTab('books');
$('#tabNotes').onclick = () => setLibTab('notes');

$('#addBtn').onclick = async () => { books = await api.add(); renderLibrary(); };
$('#libSearch').oninput = renderLibrary;

/* ---------- reader ---------- */

async function openBook(b, page) {
  const pdf = await pdfjs.getDocument({ data: await api.readPdf(b.id) }).promise;
  const data = Object.assign(emptyData(), await api.loadData(b.id));
  cur = { id: b.id, pdf, data, pages: [], scale: data.zoom };
  $('#library').hidden = true;
  $('#reader').hidden = false;
  $('#bookTitle').textContent = b.title;
  $('#pageTotal').textContent = pdf.numPages;
  $('#notesText').innerHTML = sanitize(data.notesHtml ?? esc(data.notes));
  showDone();
  $('#findResults').innerHTML = '';
  $('#findInput').value = '';

  const host = $('#pages');
  host.innerHTML = '';
  // Pages are created at the first page's size; the real page loads when scrolled near.
  const [, , w, h] = (await pdf.getPage(1)).view;
  for (let i = 1; i <= pdf.numPages; i++) {
    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.n = i;
    div.innerHTML = `<div class="hlLayer"></div><div class="stickyLayer"></div><div class="ear" title="Fold corner"></div>`;
    div.querySelector('.ear').onclick = () => toggleDogear(i);
    div.querySelector('.stickyLayer').onclick = e => { if (e.target.classList.contains('stickyLayer')) addSticky(i, e); };
    div.oncontextmenu = e => hlMenu(e, i);
    host.append(div);
    cur.pages.push({ n: i, div, page: null, w, h, rendered: false });
    io.observe(div);
  }
  layout();
  refreshOverlays();
  renderSide();
  goTo(page ?? data.lastPage, false);
}

function closeBook() {
  flushSave();
  $('#reader').hidden = true;
  $('#library').hidden = false;
  renderLibrary();
  cur.pages.forEach(p => io.unobserve(p.div));
  cur = null;
}
function showDone() {
  const done = !!books.find(b => b.id === cur.id)?.complete;
  $('#doneBtn').classList.toggle('on', done);
  $('#doneBtn').textContent = done ? '✔ Completed' : '☐ Mark complete';
}
$('#doneBtn').onclick = async () => {
  const done = !!books.find(b => b.id === cur.id)?.complete;
  books = await api.update(cur.id, { complete: !done });
  showDone();
};
$('#backBtn').onclick = closeBook;
$('#renBtn').onclick = () => renameInline($('#bookTitle'), books.find(b => b.id === cur.id));
$('#delBtn').onclick = () => deleteBook(books.find(b => b.id === cur.id));

const io = new IntersectionObserver(entries => {
  for (const e of entries) {
    const p = cur?.pages[e.target.dataset.n - 1];
    if (!p) continue;
    if (e.isIntersecting) renderPage(p);
    else unrenderPage(p);
  }
}, { root: $('#pages'), rootMargin: '800px 0px' });

function layout() {
  $('#zoomLbl').textContent = Math.round(cur.scale * 100) + '%';
  for (const p of cur.pages) {
    sizePage(p);
    unrenderPage(p);
    io.unobserve(p.div); io.observe(p.div);
  }
}

function sizePage(p) {
  p.div.style.width = p.w * cur.scale * 1.33 + 'px';
  p.div.style.height = p.h * cur.scale * 1.33 + 'px';
  p.div.style.setProperty('--total-scale-factor', cur.scale * 1.33);
}

async function renderPage(p) {
  if (p.rendered) return;
  p.rendered = true;
  if (!p.page) {
    const pdf = cur.pdf;
    const page = await pdf.getPage(p.n);
    if (cur?.pdf !== pdf) return;
    p.page = page;
    const [, , w, h] = page.view;
    if (w !== p.w || h !== p.h) { p.w = w; p.h = h; sizePage(p); }
    if (!p.rendered) return;
  }
  const vp = p.page.getViewport({ scale: cur.scale * 1.33 });
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = vp.width * dpr; canvas.height = vp.height * dpr;
  const tl = document.createElement('div');
  tl.className = 'textLayer';
  p.div.prepend(canvas);
  p.div.insertBefore(tl, p.div.querySelector('.stickyLayer'));
  p.canvas = canvas; p.tl = tl;
  const task = p.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: [dpr, 0, 0, dpr, 0, 0] });
  p.task = task;
  try {
    await task.promise;
    if (!p.rendered) return;
    await new pdfjs.TextLayer({ textContentSource: p.page.streamTextContent(), container: tl, viewport: vp }).render();
  } catch { /* cancelled by unrender */ }
}

function unrenderPage(p) {
  if (!p.rendered) return;
  p.rendered = false;
  p.task?.cancel();
  p.canvas?.remove(); p.tl?.remove();
  p.canvas = p.tl = null;
}

function currentPage() {
  const host = $('#pages');
  const y = host.getBoundingClientRect().top + host.clientHeight / 3;
  let n = 1;
  for (const p of cur.pages) {
    if (p.div.getBoundingClientRect().top <= y) n = +p.div.dataset.n; else break;
  }
  return n;
}

function goTo(n, smooth = true) {
  n = Math.max(1, Math.min(cur.pdf.numPages, n));
  const div = cur.pages[n - 1].div;
  const host = $('#pages');
  const top = host.scrollTop + div.getBoundingClientRect().top - host.getBoundingClientRect().top - 12;
  host.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  $('#pageNum').value = n;
}

$('#pages').addEventListener('scroll', () => {
  if (!cur) return;
  const n = currentPage();
  $('#pageNum').value = n;
  if (cur.data.lastPage !== n) { cur.data.lastPage = n; save(); }
});
$('#pageNum').onchange = e => goTo(+e.target.value);

function setZoom(z) {
  const n = currentPage();
  cur.scale = Math.max(0.4, Math.min(3, z));
  cur.data.zoom = cur.scale;
  layout();
  goTo(n, false);
  save();
}
$('#zoomIn').onclick = () => setZoom(cur.scale + 0.15);
$('#zoomOut').onclick = () => setZoom(cur.scale - 0.15);

/* ---------- persistence ---------- */

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}
function flushSave() {
  clearTimeout(saveTimer);
  if (cur) api.saveData(cur.id, cur.data);
}

/* ---------- highlights (mouse only) ---------- */

for (const [name, hex] of Object.entries(COLORS)) {
  const s = document.createElement('button');
  s.className = 'sw' + (name === color ? ' on' : '');
  s.style.background = hex;
  s.title = name;
  s.onclick = () => {
    color = name;
    document.querySelectorAll('.sw').forEach(x => x.classList.toggle('on', x === s));
    setHl(true);
  };
  $('#colors').append(s);
}

function setHl(on) {
  hlOn = on;
  $('#hlTool').classList.toggle('on', on);
  if (on) setSticky(false);
}
function setSticky(on) {
  stickyOn = on;
  $('#stickyTool').classList.toggle('on', on);
  document.body.classList.toggle('stickyMode', on);
  if (on) setHl(false);
}
$('#hlTool').onclick = () => setHl(!hlOn);
$('#stickyTool').onclick = () => setSticky(!stickyOn);

// Releasing the mouse after dragging over words turns the selection into highlights.
$('#pages').addEventListener('mouseup', () => {
  if (!hlOn || !cur) return;
  setTimeout(makeHighlightFromSelection, 0);
});

function makeHighlightFromSelection() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  for (const p of cur.pages) {
    if (!p.tl || !range.intersectsNode(p.tl)) continue;
    const box = p.div.getBoundingClientRect();
    const rects = [];
    const walker = document.createTreeWalker(p.tl, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      if (!range.intersectsNode(node)) continue;
      const r = document.createRange();
      r.selectNodeContents(node);
      if (node === range.startContainer) r.setStart(node, range.startOffset);
      if (node === range.endContainer) r.setEnd(node, range.endOffset);
      for (const c of r.getClientRects()) {
        if (c.width < 1 || c.height < 1) continue;
        rects.push([(c.left - box.left) / box.width, (c.top - box.top) / box.height, c.width / box.width, c.height / box.height]);
      }
    }
    if (!rects.length) continue;
    const text = range.toString().replace(/\s+/g, ' ').trim().slice(0, 300);
    cur.data.highlights.push({ id: uid(), page: +p.div.dataset.n, color, rects, text });
  }
  sel.removeAllRanges();
  save();
  refreshOverlays();
  renderSide();
}

function hlMenu(e, n) {
  const box = cur.pages[n - 1].div.getBoundingClientRect();
  const x = (e.clientX - box.left) / box.width, y = (e.clientY - box.top) / box.height;
  const h = cur.data.highlights.find(h => h.page === n && h.rects.some(([rx, ry, rw, rh]) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh));
  if (!h) return;
  e.preventDefault();
  document.querySelector('.hlmenu')?.remove();
  const m = document.createElement('div');
  m.className = 'hlmenu';
  m.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;background:#1e1f22;padding:6px;border-radius:6px;display:flex;gap:4px;z-index:99;box-shadow:0 3px 10px #000a`;
  for (const [name, hex] of Object.entries(COLORS)) {
    const s = document.createElement('button');
    s.className = 'sw'; s.style.background = hex;
    s.onclick = () => { h.color = name; save(); refreshOverlays(); renderSide(); m.remove(); };
    m.append(s);
  }
  const d = document.createElement('button');
  d.textContent = 'Delete';
  d.onclick = () => deleteHighlight(h.id);
  m.append(d);
  document.body.append(m);
}
addEventListener('mousedown', e => { if (!e.target.closest('.hlmenu')) document.querySelector('.hlmenu')?.remove(); });

function deleteHighlight(id) {
  cur.data.highlights = cur.data.highlights.filter(h => h.id !== id);
  document.querySelector('.hlmenu')?.remove();
  save(); refreshOverlays(); renderSide();
}

/* ---------- overlays: highlights, stickies, dog-ears ---------- */

function refreshOverlays() {
  const d = cur.data;
  cur.pages.forEach((p, i) => {
    const n = i + 1;
    p.div.querySelector('.hlLayer').replaceChildren(...d.highlights.filter(h => h.page === n).flatMap(h =>
      h.rects.map(([x, y, w, hh]) => {
        const el = document.createElement('div');
        el.className = 'hl';
        el.style.cssText = `left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${hh * 100}%;background:${COLORS[h.color]}`;
        return el;
      })));
    p.div.querySelector('.ear').classList.toggle('on', d.dogears.includes(n));
    const layer = p.div.querySelector('.stickyLayer');
    layer.replaceChildren(...d.stickies.filter(s => s.page === n).map(stickyEl));
  });
}

function stickyEl(s) {
  const el = document.createElement('div');
  el.className = 'sticky';
  el.style.cssText = `left:${s.x * 100}%;top:${s.y * 100}%;background:${s.color}`;
  el.innerHTML = `<div class="h"><span title="Delete">✕</span></div><textarea placeholder="Note…"></textarea>`;
  const ta = el.querySelector('textarea');
  ta.value = s.text;
  ta.oninput = () => { s.text = ta.value; save(); renderSide(); };
  el.querySelector('span').onclick = () => {
    cur.data.stickies = cur.data.stickies.filter(x => x.id !== s.id);
    save(); refreshOverlays(); renderSide();
  };
  el.querySelector('.h').onmousedown = e => {
    if (e.target.tagName === 'SPAN') return;
    const page = el.closest('.page').getBoundingClientRect();
    const ox = e.clientX - el.getBoundingClientRect().left, oy = e.clientY - el.getBoundingClientRect().top;
    const move = ev => {
      s.x = Math.max(0, Math.min(0.95, (ev.clientX - ox - page.left) / page.width));
      s.y = Math.max(0, Math.min(0.97, (ev.clientY - oy - page.top) / page.height));
      el.style.left = s.x * 100 + '%'; el.style.top = s.y * 100 + '%';
    };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); save(); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  };
  return el;
}

function addSticky(n, e) {
  const box = cur.pages[n - 1].div.getBoundingClientRect();
  const s = { id: uid(), page: n, x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height, text: '', color: '#fff176' };
  cur.data.stickies.push(s);
  setSticky(false);
  save(); refreshOverlays(); renderSide();
  cur.pages[n - 1].div.querySelectorAll('.sticky textarea')[cur.data.stickies.filter(x => x.page === n).length - 1]?.focus();
}

function toggleDogear(n) {
  const a = cur.data.dogears;
  const i = a.indexOf(n);
  if (i >= 0) a.splice(i, 1); else a.push(n);
  save(); refreshOverlays(); renderSide();
}
$('#earBtn').onclick = () => toggleDogear(currentPage());

$('#bmBtn').onclick = () => {
  const n = currentPage();
  cur.data.bookmarks.push({ id: uid(), page: n, label: `Page ${n}` });
  save(); renderSide();
  switchTab('marks');
};

/* ---------- sidebar ---------- */

function switchTab(t) {
  document.querySelectorAll('#side nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach(x => x.hidden = x.id !== 'tab-' + t);
}
document.querySelectorAll('#side nav button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

function item(html, onclick) {
  const el = document.createElement('div');
  el.className = 'item';
  el.innerHTML = html;
  el.onclick = onclick;
  return el;
}

function renderSide() {
  const d = cur.data;
  const marks = $('#tab-marks');
  marks.replaceChildren();

  marks.insertAdjacentHTML('beforeend', '<h4>Bookmarks</h4>');
  if (!d.bookmarks.length) marks.insertAdjacentHTML('beforeend', '<small>None yet. Use “Bookmark”.</small>');
  for (const b of [...d.bookmarks].sort((a, c) => a.page - c.page)) {
    const el = item(`<div class="main"><input value=""><small>p. ${b.page}</small></div><button class="x">✕</button>`, () => goTo(b.page));
    const inp = el.querySelector('input');
    inp.value = b.label;
    inp.onclick = e => e.stopPropagation();
    inp.oninput = () => { b.label = inp.value; save(); };
    el.querySelector('.x').onclick = e => { e.stopPropagation(); d.bookmarks = d.bookmarks.filter(x => x.id !== b.id); save(); renderSide(); };
    marks.append(el);
  }

  marks.insertAdjacentHTML('beforeend', '<h4>Folded pages</h4>');
  if (!d.dogears.length) marks.insertAdjacentHTML('beforeend', '<small>Click a page’s top-right corner to fold it.</small>');
  for (const n of [...d.dogears].sort((a, b) => a - b)) {
    const el = item(`<div class="main">Page ${n}</div><button class="x">✕</button>`, () => goTo(n));
    el.querySelector('.x').onclick = e => { e.stopPropagation(); toggleDogear(n); };
    marks.append(el);
  }

  marks.insertAdjacentHTML('beforeend', '<h4>Sticky notes</h4>');
  if (!d.stickies.length) marks.insertAdjacentHTML('beforeend', '<small>Use “Sticky”, then click on a page.</small>');
  for (const s of [...d.stickies].sort((a, b) => a.page - b.page)) {
    const el = item(`<div class="main"><span class="t"></span><small>p. ${s.page}</small></div>`, () => goTo(s.page));
    el.querySelector('.t').textContent = s.text || '(empty)';
    marks.append(el);
  }

  const hls = $('#tab-hls');
  hls.replaceChildren();
  if (!d.highlights.length) hls.textContent = 'No highlights yet. Turn on 🖍 Highlight and drag over words.';
  for (const h of [...d.highlights].sort((a, b) => a.page - b.page)) {
    const el = item(`<div class="bar" style="background:${COLORS[h.color]}"></div><div class="main"><span class="t"></span><small>p. ${h.page}</small></div><button class="x">✕</button>`, () => goTo(h.page));
    el.querySelector('.t').textContent = h.text;
    el.querySelector('.x').onclick = e => { e.stopPropagation(); deleteHighlight(h.id); };
    hls.append(el);
  }
}

const notesEl = $('#notesText');
notesEl.oninput = () => { cur.data.notesHtml = notesEl.innerHTML; cur.data.notes = notesEl.innerText; save(); };

// Paste plain text or images only, so notes never hold foreign markup.
function allowPaste(el) {
  el.addEventListener('paste', ev => {
    ev.preventDefault();
    const img = [...ev.clipboardData.items].find(i => i.type.startsWith('image/'));
    if (img) {
      const r = new FileReader();
      r.onload = () => { document.execCommand('insertImage', false, r.result); el.oninput(); };
      r.readAsDataURL(img.getAsFile());
    } else {
      document.execCommand('insertText', false, ev.clipboardData.getData('text/plain'));
    }
  });
}
allowPaste(notesEl);

/* ---------- screenshots ---------- */

let snipOn = false;
function setSnip(on) {
  snipOn = on;
  $('#snipTool').classList.toggle('on', on);
  document.body.classList.toggle('snipMode', on);
  if (on) { setHl(false); setSticky(false); }
}
$('#snipTool').onclick = () => setSnip(!snipOn);

$('#pages').addEventListener('mousedown', e => {
  if (!snipOn || !cur) return;
  const p = cur.pages.find(p => p.div.contains(e.target) || p.div === e.target);
  if (!p || !p.canvas) return;
  e.preventDefault();
  const box = p.div.getBoundingClientRect();
  const x0 = e.clientX, y0 = e.clientY;
  const sel = document.createElement('div');
  sel.className = 'snipBox';
  p.div.append(sel);
  const rect = ev => {
    const l = Math.max(box.left, Math.min(x0, ev.clientX)), t = Math.max(box.top, Math.min(y0, ev.clientY));
    const r = Math.min(box.right, Math.max(x0, ev.clientX)), b = Math.min(box.bottom, Math.max(y0, ev.clientY));
    return { l, t, w: r - l, h: b - t };
  };
  const move = ev => {
    const r = rect(ev);
    Object.assign(sel.style, { left: r.l - box.left + 'px', top: r.t - box.top + 'px', width: r.w + 'px', height: r.h + 'px' });
  };
  const up = ev => {
    removeEventListener('mousemove', move); removeEventListener('mouseup', up);
    sel.remove();
    const r = rect(ev);
    if (r.w < 5 || r.h < 5) return;
    const k = p.canvas.width / box.width;
    const out = document.createElement('canvas');
    out.width = r.w * k; out.height = r.h * k;
    out.getContext('2d').drawImage(p.canvas, (r.l - box.left) * k, (r.t - box.top) * k, out.width, out.height, 0, 0, out.width, out.height);
    addScreenshot(out.toDataURL('image/png'), +p.div.dataset.n);
  };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
});

function addScreenshot(url, n) {
  switchTab('notes');
  const cap = document.createElement('div');
  cap.textContent = `Page ${n}`;
  const img = document.createElement('img');
  img.src = url;
  notesEl.append(cap, img, document.createElement('br'));
  notesEl.scrollTop = notesEl.scrollHeight;
  notesEl.oninput();
  setSnip(false);
}

const esc = t => (t || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Keep only text structure and data-URL images from stored note HTML.
function sanitize(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const walk = n => {
    for (const c of [...n.childNodes]) {
      if (c.nodeType === 3) continue;
      if (c.nodeType !== 1) { c.remove(); continue; }
      const tag = c.tagName;
      if (tag === 'IMG') {
        const src = c.getAttribute('src') || '';
        if (!src.startsWith('data:image/')) { c.remove(); continue; }
        for (const a of [...c.attributes]) if (a.name !== 'src') c.removeAttribute(a.name);
      } else if (['DIV', 'BR', 'P', 'SPAN'].includes(tag)) {
        for (const a of [...c.attributes]) c.removeAttribute(a.name);
        walk(c);
      } else c.replaceWith(...c.childNodes);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

/* ---------- search inside PDF ---------- */

let findToken = 0;
$('#findInput').onkeydown = async e => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim().toLowerCase();
  const out = $('#findResults');
  out.replaceChildren();
  if (!q) return;
  const token = ++findToken;
  let count = 0;
  for (const p of cur.pages) {
    const n = +p.div.dataset.n;
    p.page ??= await cur.pdf.getPage(n);
    const tc = await p.page.getTextContent();
    if (token !== findToken) return;
    const text = tc.items.map(i => i.str).join(' ').replace(/\s+/g, ' ');
    const low = text.toLowerCase();
    for (let i = low.indexOf(q); i >= 0 && count < 200; i = low.indexOf(q, i + q.length), count++) {
      const el = item(`<div class="main"><span class="t"></span><small>p. ${n}</small></div>`, () => goTo(n));
      el.querySelector('.t').textContent = '…' + text.slice(Math.max(0, i - 30), i + q.length + 40) + '…';
      out.append(el);
    }
  }
  if (!count) out.textContent = 'No results.';
};

/* ---------- init ---------- */

loadLibrary();
