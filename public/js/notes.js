// Notes vault: markdown files in folders, stored in the Worker's D1 (/notes/* routes).
// Plain globals like the rest of the dashboard. Markdown rendering, sanitizing and
// zip handling come from jsDelivr and load the first time the screen opens.

const NOTES_LIBS = {
  marked: 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
  purify: 'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js',
  fflate: 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js',
}

const notesState = {
  tree: { folders: [], notes: [] },
  open: new Set(JSON.parse(localStorage.getItem('sb_notes_open') || '[]')),
  folder: '',
  current: null, // { path, title, content, modified_at, pinned, tags }
  dirty: false,
  saving: null,
  saveTimer: null,
  mode: localStorage.getItem('sb_notes_mode') || 'split',
  loaded: false,
  searchTimer: null,
  conflict: null,
}

// ── Small helpers ───────────────────────────────────────────────────────────

function nEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function nDate(ms) {
  try {
    return new Date(ms).toLocaleString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return new Date(ms).toISOString()
  }
}

function nBase(path) {
  const name = path.split('/').pop() || ''
  return name.replace(/\.md$/i, '')
}

function nFolderOf(path) {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

async function notesApi(method, path, body) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${AUTH_TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  let data = {}
  try {
    data = await res.json()
  } catch {}
  return { ok: res.ok, status: res.status, data }
}

function notesToast(msg) {
  if (typeof showToast === 'function') showToast(msg)
  else console.log(msg)
}

const notesLibPromises = {}
function notesLoadLib(name) {
  if (!notesLibPromises[name]) {
    notesLibPromises[name] = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = NOTES_LIBS[name]
      s.onload = resolve
      s.onerror = () => {
        delete notesLibPromises[name]
        reject(new Error(`${name} yüklenemedi`))
      }
      document.head.appendChild(s)
    })
  }
  return notesLibPromises[name]
}

// ── Loading and the tree ────────────────────────────────────────────────────

async function loadNotes() {
  notesLoadLib('marked').catch(() => {})
  notesLoadLib('purify').catch(() => {})
  notesBindOnce()
  const r = await notesApi('GET', '/notes/tree')
  if (!r.ok) {
    document.getElementById('notes-tree').innerHTML = `<div class="nt-empty">Notlar yüklenemedi (${nEsc(r.data.error || r.status)}).</div>`
    return
  }
  notesState.tree = { folders: r.data.folders || [], notes: r.data.notes || [] }
  notesState.loaded = true
  if (!document.getElementById('notes-search').value.trim()) renderNotesTree()
  renderNotesRecent()
  const fromHash = notesPathFromHash()
  if (fromHash && (!notesState.current || notesState.current.path !== fromHash)) notesOpen(fromHash)
}

function notesPathFromHash() {
  const h = window.location.hash || ''
  if (!h.startsWith('#notes/')) return null
  try {
    return decodeURIComponent(h.slice('#notes/'.length))
  } catch {
    return null
  }
}

function notesSaveOpen() {
  localStorage.setItem('sb_notes_open', JSON.stringify([...notesState.open]))
}

function renderNotesTree() {
  const el = document.getElementById('notes-tree')
  const { folders, notes } = notesState.tree
  if (!folders.length && !notes.length) {
    el.innerHTML = '<div class="nt-empty">Henüz not yok. Yeni not oluştur ya da Notion/markdown içe aktar.</div>'
    return
  }
  const children = new Map() // folder -> {folders:[], notes:[]}
  const ensure = (f) => {
    if (!children.has(f)) children.set(f, { folders: [], notes: [] })
    return children.get(f)
  }
  ensure('')
  for (const f of folders) {
    ensure(f)
    ensure(nFolderOf(f)).folders.push(f)
  }
  for (const n of notes) ensure(nFolderOf(n.path)).notes.push(n)
  const countIn = (f) => notes.filter((n) => n.path.toLowerCase().startsWith(f.toLowerCase() + '/')).length

  let html = ''
  const pinned = notes.filter((n) => n.pinned)
  if (pinned.length) {
    html += '<div class="nt-section">Sabitlenenler</div>'
    for (const n of pinned) html += noteRow(n, 0, true)
    html += '<div class="nt-section">Klasörler</div>'
  }
  const walk = (folder, depth) => {
    const c = children.get(folder) || { folders: [], notes: [] }
    const fs = [...c.folders].sort((a, b) => nBase(a).localeCompare(nBase(b), 'tr'))
    for (const f of fs) {
      const open = notesState.open.has(f)
      const active = notesState.folder === f && !notesState.current ? ' active' : ''
      html += `<div class="nt-row nt-folder${active}" role="treeitem" aria-expanded="${open}" style="padding-left:${6 + depth * 14}px"
        data-folder="${nEsc(f)}" draggable="true">
        <i class="ti ti-chevron-${open ? 'down' : 'right'}"></i><i class="ti ti-folder${open ? '-open' : ''}"></i>
        <span class="nt-name">${nEsc(nBase(f))}</span><span class="nt-count">${countIn(f) || ''}</span>
        <button type="button" class="nt-more" data-folder-menu="${nEsc(f)}" title="Klasör işlemleri"><i class="ti ti-dots"></i></button></div>`
      if (open) walk(f, depth + 1)
    }
    const ns = [...c.notes].sort((a, b) => a.title.localeCompare(b.title, 'tr'))
    for (const n of ns) html += noteRow(n, depth)
  }
  walk('', 0)
  el.innerHTML = html
}

function noteRow(n, depth, showFolder) {
  const active = notesState.current && notesState.current.path === n.path ? ' active' : ''
  const icon = n.path.startsWith('Günlük/') ? 'ti-calendar' : 'ti-file-text'
  const sub = showFolder && nFolderOf(n.path) ? ` <span class="nt-count">${nEsc(nFolderOf(n.path))}</span>` : ''
  return `<div class="nt-row nt-note${active}" role="treeitem" style="padding-left:${6 + depth * 14 + 18}px" data-path="${nEsc(n.path)}" draggable="true" title="${nEsc(n.path)}">
    <i class="ti ${icon}"></i><span class="nt-name">${nEsc(n.title || nBase(n.path))}</span>${sub}</div>`
}

function renderNotesRecent() {
  const el = document.getElementById('notes-recent')
  if (!el) return
  const recent = [...notesState.tree.notes].sort((a, b) => b.modified_at - a.modified_at).slice(0, 8)
  if (!recent.length) {
    el.innerHTML = ''
    return
  }
  el.innerHTML =
    '<div class="nt-section">Son değişenler</div>' +
    recent
      .map(
        (n) => `<div class="nt-hit" data-path="${nEsc(n.path)}"><div class="nt-hit-title">${nEsc(n.title)}</div>
        <div class="nt-hit-path">${nEsc(n.path)} · ${nEsc(nDate(n.modified_at))}</div></div>`,
      )
      .join('')
}

// ── Search ──────────────────────────────────────────────────────────────────

async function notesRunSearch(q) {
  const el = document.getElementById('notes-tree')
  const query = q.trim()
  if (!query) {
    renderNotesTree()
    return
  }
  const params = new URLSearchParams({ limit: '40' })
  const tagOnly = /^#[\p{L}\p{N}_\-/]+$/u.test(query)
  if (tagOnly) params.set('tag', query.slice(1))
  else params.set('q', query)
  const r = await notesApi('GET', `/notes/search?${params}`)
  if (document.getElementById('notes-search').value.trim() !== query) return
  const hits = (r.data && r.data.hits) || []
  if (!hits.length) {
    el.innerHTML = `<div class="nt-empty">“${nEsc(query)}” için sonuç yok.</div>`
    return
  }
  el.innerHTML = hits
    .map((h) => {
      const snip = nEsc(h.snippet || '').replace(/«/g, '<mark>').replace(/»/g, '</mark>')
      return `<div class="nt-hit" data-path="${nEsc(h.path)}"><div class="nt-hit-title">${nEsc(h.title)}</div>
        <div class="nt-hit-path">${nEsc(h.path)}</div><div class="nt-hit-snip">${snip}</div></div>`
    })
    .join('')
}

// ── Opening, editing, saving ────────────────────────────────────────────────

async function notesOpen(path, { focusEditor = false } = {}) {
  if (notesState.dirty) await notesSaveNow()
  const r = await notesApi('GET', `/notes/file?path=${encodeURIComponent(path)}`)
  if (!r.ok) {
    notesToast(r.status === 404 ? 'Not bulunamadı.' : `Not açılamadı: ${r.data.error || r.status}`)
    if (notesPathFromHash() === path) history.replaceState(null, '', window.location.pathname + window.location.search)
    return
  }
  notesState.current = r.data.note
  notesState.folder = nFolderOf(r.data.note.path)
  notesState.dirty = false
  notesState.conflict = null
  // Expand the folders leading to this note.
  const parts = notesState.folder ? notesState.folder.split('/') : []
  for (let i = 1; i <= parts.length; i++) notesState.open.add(parts.slice(0, i).join('/'))
  notesSaveOpen()

  document.getElementById('notes-welcome').hidden = true
  document.getElementById('notes-doc').hidden = false
  document.getElementById('notes-conflict').hidden = true
  document.getElementById('notes-layout').classList.add('doc-open')
  const ed = document.getElementById('notes-editor')
  ed.value = r.data.note.content
  notesRenderCrumbs()
  notesSetSaveState('')
  notesSetMode(notesState.mode, { keep: true })
  notesRenderPreview()
  notesRenderLinks(r.data.backlinks || [], r.data.links || [])
  document.getElementById('notes-pin-btn').classList.toggle('on', !!r.data.note.pinned)
  const hash = '#notes/' + encodeURIComponent(r.data.note.path)
  if (window.location.hash !== hash) history.replaceState(null, '', window.location.pathname + window.location.search + hash)
  if (!document.getElementById('notes-search').value.trim()) renderNotesTree()
  if (focusEditor && notesState.mode !== 'preview') ed.focus()
}

function notesCloseDoc() {
  document.getElementById('notes-layout').classList.remove('doc-open')
}

function notesRenderCrumbs() {
  const n = notesState.current
  if (!n) return
  const folder = nFolderOf(n.path)
  document.getElementById('notes-crumbs').innerHTML =
    (folder ? `${nEsc(folder.split('/').join(' / '))} / ` : '') + `<b>${nEsc(nBase(n.path))}</b>`
}

function notesSetSaveState(text, isErr) {
  const el = document.getElementById('notes-save-state')
  el.textContent = text
  el.classList.toggle('err', !!isErr)
}

function notesSetMode(mode, { keep } = {}) {
  if (window.matchMedia('(max-width: 767px)').matches && mode === 'split') mode = 'preview'
  notesState.mode = mode
  if (!keep) localStorage.setItem('sb_notes_mode', mode)
  const body = document.getElementById('notes-doc-body')
  body.classList.remove('mode-edit', 'mode-split', 'mode-preview')
  body.classList.add('mode-' + mode)
  document.querySelectorAll('.notes-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode))
  if (mode !== 'edit') notesRenderPreview()
}

function notesOnInput() {
  if (!notesState.current) return
  notesState.dirty = true
  notesSetSaveState('Kaydedilmedi')
  clearTimeout(notesState.saveTimer)
  notesState.saveTimer = setTimeout(notesSaveNow, 1200)
  clearTimeout(notesState.previewTimer)
  notesState.previewTimer = setTimeout(notesRenderPreview, 250)
}

async function notesSaveNow({ force = false } = {}) {
  clearTimeout(notesState.saveTimer)
  const n = notesState.current
  if (!n || (!notesState.dirty && !force)) return
  if (notesState.saving) {
    await notesState.saving
    if (!notesState.dirty && !force) return
  }
  const content = document.getElementById('notes-editor').value
  notesSetSaveState('Kaydediliyor…')
  notesState.saving = (async () => {
    const body = { path: n.path, content, mode: 'replace' }
    if (!force) body.expected_modified_at = n.modified_at
    const r = await notesApi('PUT', '/notes/file', body)
    if (r.ok) {
      notesState.current = { ...n, ...r.data.note }
      if (document.getElementById('notes-editor').value === content) notesState.dirty = false
      notesSetSaveState(notesState.dirty ? 'Kaydedilmedi' : 'Kaydedildi')
      const meta = notesState.tree.notes.find((x) => x.path === n.path)
      const titleChanged = meta && meta.title !== r.data.note.title
      if (meta) Object.assign(meta, { title: r.data.note.title, modified_at: r.data.note.modified_at, tags: r.data.note.tags })
      if (titleChanged && !document.getElementById('notes-search').value.trim()) renderNotesTree()
    } else if (r.status === 409 && r.data.code === 'conflict') {
      notesState.conflict = r.data.current
      document.getElementById('notes-conflict').hidden = false
      notesSetSaveState('Çakışma', true)
    } else {
      notesSetSaveState(`Kaydedilemedi: ${r.data.error || r.status}`, true)
    }
  })()
  try {
    await notesState.saving
  } catch {
    notesSetSaveState('Kaydedilemedi (bağlantı)', true)
  } finally {
    notesState.saving = null
  }
}

function notesConflictReload() {
  const c = notesState.conflict
  if (!c) return
  notesState.current = c
  notesState.dirty = false
  notesState.conflict = null
  document.getElementById('notes-editor').value = c.content
  document.getElementById('notes-conflict').hidden = true
  notesSetSaveState('Sunucudaki sürüm yüklendi')
  notesRenderPreview()
}

async function notesConflictOverwrite() {
  document.getElementById('notes-conflict').hidden = true
  notesState.conflict = null
  notesState.dirty = true
  await notesSaveNow({ force: true })
}

// ── Markdown rendering ──────────────────────────────────────────────────────

function notesSplitFrontmatter(md) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md)
  if (!m) return { fm: null, body: md }
  return { fm: m[1], body: md.slice(m[0].length) }
}

function notesWikilinksToHtml(md) {
  // Leave fenced and inline code alone.
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part
      return part.replace(/\[\[([^\]\n|#]+)(#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/g, (_, target, _h, alias) => {
        const t = target.trim()
        const exists = notesFindByRef(t)
        return `<a class="wikilink${exists ? '' : ' missing'}" data-target="${nEsc(t)}">${nEsc((alias || t).trim())}</a>`
      })
    })
    .join('')
}

function notesFindByRef(ref) {
  const r = ref.replace(/\.md$/i, '').toLocaleLowerCase('tr')
  return notesState.tree.notes.find(
    (n) =>
      n.title.toLocaleLowerCase('tr') === r ||
      nBase(n.path).toLocaleLowerCase('tr') === r ||
      n.path.replace(/\.md$/i, '').toLocaleLowerCase('tr') === r,
  )
}

function notesRenderPreview() {
  const out = document.getElementById('notes-preview')
  if (!out || notesState.mode === 'edit') return
  const md = document.getElementById('notes-editor').value
  if (!window.marked || !window.DOMPurify) {
    out.innerHTML = `<pre style="white-space:pre-wrap">${nEsc(md)}</pre>`
    Promise.all([notesLoadLib('marked'), notesLoadLib('purify')])
      .then(notesRenderPreview)
      .catch(() => {})
    return
  }
  const { fm, body } = notesSplitFrontmatter(md)
  let html = window.marked.parse(notesWikilinksToHtml(body), { gfm: true, breaks: false })
  html = window.DOMPurify.sanitize(html, { ADD_ATTR: ['data-target', 'target'] })
  let fmHtml = ''
  if (fm) {
    fmHtml =
      '<div class="md-frontmatter">' +
      fm
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => `<span>${nEsc(l)}</span>`)
        .join('') +
      '</div>'
  }
  out.innerHTML = fmHtml + html
  // Task list checkboxes: make them clickable and remember which source line each is.
  const boxes = out.querySelectorAll('li > input[type="checkbox"]')
  boxes.forEach((box, idx) => {
    box.disabled = false
    box.dataset.taskIndex = String(idx)
    const li = box.parentElement
    li.classList.add('task-item')
    if (box.checked) li.classList.add('done')
  })
  out.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || ''
    if (/^https?:/i.test(href)) {
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
    }
  })
}

/** Toggle the idx-th task checkbox in the markdown source (code fences skipped). */
function notesToggleTask(idx) {
  const ed = document.getElementById('notes-editor')
  const lines = ed.value.split('\n')
  let count = -1
  let fence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) fence = !fence
    if (fence) continue
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/.exec(lines[i])
    if (!m) continue
    count++
    if (count === idx) {
      const mark = m[2] === ' ' ? 'x' : ' '
      lines[i] = lines[i].slice(0, m[1].length) + `[${mark}]` + lines[i].slice(m[0].length)
      ed.value = lines.join('\n')
      notesOnInput()
      notesRenderPreview()
      return
    }
  }
}

function notesRenderLinks(back, out) {
  const el = document.getElementById('notes-links')
  const parts = []
  if (back.length) {
    parts.push('<span>Bu nota bağlananlar:</span>')
    for (const b of back) parts.push(`<a data-path="${nEsc(b.path)}">${nEsc(b.title)}</a>`)
  }
  const missing = out.filter((l) => !l.path)
  if (missing.length) {
    parts.push('<span style="margin-left:8px">Henüz olmayan bağlantılar:</span>')
    for (const l of missing) parts.push(`<a class="notes-chip" data-create="${nEsc(l.target)}">+ ${nEsc(l.target)}</a>`)
  }
  el.innerHTML = parts.join(' ')
}

async function notesFollowLink(target) {
  const hit = notesFindByRef(target)
  if (hit) return notesOpen(hit.path)
  const r = await notesApi('GET', `/notes/resolve?ref=${encodeURIComponent(target)}`)
  if (r.ok) return notesOpen(r.data.path)
  const ok = await notesConfirm('Not yok', `“${target}” adında bir not yok. Oluşturulsun mu?`, 'Oluştur')
  if (ok) await notesCreate(target.includes('/') ? target : (notesState.folder ? notesState.folder + '/' : '') + target, `# ${nBase(target)}\n\n`)
}

// ── Create / folders / move / delete ────────────────────────────────────────

async function notesCreate(path, content) {
  const r = await notesApi('PUT', '/notes/file', { path, content, mode: 'create' })
  if (!r.ok) {
    notesToast(r.data.error || 'Not oluşturulamadı.')
    return null
  }
  await loadNotes()
  await notesOpen(r.data.note.path, { focusEditor: true })
  return r.data.note
}

async function notesNewNote() {
  notesCloseMenu()
  const templates = notesState.tree.notes.filter((n) => /^(şablonlar|sablonlar|templates)\//i.test(n.path))
  const folderOpts = ['', ...notesState.tree.folders]
    .map((f) => `<option value="${nEsc(f)}"${f === notesState.folder ? ' selected' : ''}>${f ? nEsc(f) : '(kök)'}</option>`)
    .join('')
  const tplOpts = templates.length
    ? `<label>Şablon</label><select id="nd-tpl"><option value="">Boş not</option>${templates.map((t) => `<option value="${nEsc(t.path)}">${nEsc(t.title)}</option>`).join('')}</select>`
    : ''
  const vals = await notesForm('Yeni not', `<label>Ad</label><input type="text" id="nd-name" placeholder="Toplantı notları" />
    <label>Klasör</label><select id="nd-folder">${folderOpts}</select>${tplOpts}`, 'Oluştur', ['nd-name', 'nd-folder', 'nd-tpl'])
  if (!vals || !vals['nd-name'].trim()) return
  const name = vals['nd-name'].trim()
  const folder = vals['nd-folder'] || ''
  let content = `# ${name.replace(/\.md$/i, '')}\n\n`
  if (vals['nd-tpl']) {
    const t = await notesApi('GET', `/notes/file?path=${encodeURIComponent(vals['nd-tpl'])}`)
    if (t.ok) {
      const today = new Date().toISOString().slice(0, 10)
      content = t.data.note.content.replace(/\{\{\s*(başlık|title)\s*\}\}/gi, name).replace(/\{\{\s*(tarih|date)\s*\}\}/gi, today)
      if (!/^#\s|^---/m.test(content.slice(0, 200))) content = `# ${name}\n\n${content}`
    }
  }
  await notesCreate((folder ? folder + '/' : '') + name, content)
}

async function notesNewFolder(parent) {
  notesCloseMenu()
  const base = parent ?? notesState.folder
  const vals = await notesForm('Yeni klasör', `<label>Klasör adı</label><input type="text" id="nd-name" placeholder="Proje X" />
    <label>Üst klasör</label><input type="text" id="nd-parent" value="${nEsc(base)}" placeholder="(kök)" />`, 'Oluştur', ['nd-name', 'nd-parent'])
  if (!vals || !vals['nd-name'].trim()) return
  const path = (vals['nd-parent'].trim() ? vals['nd-parent'].trim().replace(/\/+$/, '') + '/' : '') + vals['nd-name'].trim()
  const r = await notesApi('POST', '/notes/folder', { path })
  if (!r.ok) return notesToast(r.data.error || 'Klasör oluşturulamadı.')
  notesState.open.add(r.data.folder)
  notesState.folder = r.data.folder
  notesSaveOpen()
  await loadNotes()
}

async function notesOpenDaily() {
  notesCloseMenu()
  const r = await notesApi('POST', '/notes/daily', {})
  if (!r.ok) return notesToast(r.data.error || 'Günlük açılamadı.')
  await loadNotes()
  await notesOpen(r.data.note.path, { focusEditor: true })
  const ed = document.getElementById('notes-editor')
  ed.selectionStart = ed.selectionEnd = ed.value.length
}

async function notesMoveCurrent() {
  const n = notesState.current
  if (!n) return
  await notesSaveNow()
  const vals = await notesForm('Taşı / yeniden adlandır', `<label>Yeni yol</label><input type="text" id="nd-path" value="${nEsc(n.path.replace(/\.md$/i, ''))}" />
    <p class="notes-progress">Klasörü değiştirmek için yolun başını değiştir, ör. <code>Arşiv/${nEsc(nBase(n.path))}</code></p>`, 'Taşı', ['nd-path'])
  if (!vals || !vals['nd-path'].trim()) return
  const r = await notesApi('POST', '/notes/move', { from: n.path, to: vals['nd-path'].trim(), kind: 'note' })
  if (!r.ok) return notesToast(r.data.error || 'Taşınamadı.')
  await loadNotes()
  await notesOpen(r.data.note.path)
}

async function notesMoveTo(path, folder) {
  const r = await notesApi('POST', '/notes/move', { from: path, to: (folder ? folder + '/' : '') + nBase(path), kind: 'note' })
  if (!r.ok) return notesToast(r.data.error || 'Taşınamadı.')
  if (notesState.current && notesState.current.path === path) notesState.current.path = r.data.note.path
  await loadNotes()
  if (notesState.current && notesState.current.path === r.data.note.path) {
    notesRenderCrumbs()
    history.replaceState(null, '', window.location.pathname + window.location.search + '#notes/' + encodeURIComponent(r.data.note.path))
  }
}

async function notesMoveFolderTo(from, toParent) {
  const to = (toParent ? toParent + '/' : '') + nBase(from)
  if (to === from) return
  const r = await notesApi('POST', '/notes/move', { from, to, kind: 'folder' })
  if (!r.ok) return notesToast(r.data.error || 'Taşınamadı.')
  notesState.open.add(r.data.folder)
  notesSaveOpen()
  if (notesState.current && notesState.current.path.startsWith(from + '/')) {
    const np = r.data.folder + notesState.current.path.slice(from.length)
    await loadNotes()
    return notesOpen(np)
  }
  await loadNotes()
}

async function notesDeleteCurrent() {
  const n = notesState.current
  if (!n) return
  const ok = await notesConfirm('Çöpe at', `“${n.title}” çöp kutusuna taşınsın mı? 30 gün içinde geri alabilirsin.`, 'Çöpe at')
  if (!ok) return
  notesState.dirty = false
  const r = await notesApi('DELETE', `/notes/file?path=${encodeURIComponent(n.path)}`)
  if (!r.ok) return notesToast(r.data.error || 'Silinemedi.')
  notesState.current = null
  document.getElementById('notes-doc').hidden = true
  document.getElementById('notes-welcome').hidden = false
  notesCloseDoc()
  history.replaceState(null, '', window.location.pathname + window.location.search)
  await loadNotes()
}

async function notesTogglePin() {
  const n = notesState.current
  if (!n) return
  const r = await notesApi('PATCH', '/notes/file', { path: n.path, pinned: !n.pinned })
  if (!r.ok) return notesToast(r.data.error || 'Değiştirilemedi.')
  n.pinned = r.data.note.pinned
  document.getElementById('notes-pin-btn').classList.toggle('on', !!n.pinned)
  await loadNotes()
}

async function notesFolderMenu(folder) {
  const html = `<div class="notes-list-row"><button class="btn btn-sm" data-act="new">Bu klasörde yeni not</button></div>
    <div class="notes-list-row"><button class="btn btn-sm" data-act="sub">Alt klasör oluştur</button></div>
    <div class="notes-list-row"><button class="btn btn-sm" data-act="rename">Yeniden adlandır / taşı</button></div>
    <div class="notes-list-row"><button class="btn btn-sm" data-act="delete">Klasörü çöpe at</button></div>`
  const act = await notesChoice(`Klasör: ${folder}`, html)
  if (act === 'new') {
    notesState.folder = folder
    return notesNewNote()
  }
  if (act === 'sub') return notesNewFolder(folder)
  if (act === 'rename') {
    const vals = await notesForm('Klasörü taşı / yeniden adlandır', `<label>Yeni yol</label><input type="text" id="nd-path" value="${nEsc(folder)}" />`, 'Taşı', ['nd-path'])
    if (!vals || !vals['nd-path'].trim() || vals['nd-path'].trim() === folder) return
    const r = await notesApi('POST', '/notes/move', { from: folder, to: vals['nd-path'].trim(), kind: 'folder' })
    if (!r.ok) return notesToast(r.data.error || 'Taşınamadı.')
    notesState.open.add(r.data.folder)
    notesSaveOpen()
    return loadNotes()
  }
  if (act === 'delete') {
    const ok = await notesConfirm('Klasörü çöpe at', `“${folder}” ve içindeki tüm notlar çöp kutusuna taşınsın mı?`, 'Çöpe at')
    if (!ok) return
    const r = await notesApi('DELETE', `/notes/folder?path=${encodeURIComponent(folder)}`)
    if (!r.ok) return notesToast(r.data.error || 'Silinemedi.')
    notesToast(`${r.data.trashed} not çöp kutusuna taşındı.`)
    if (notesState.current && notesState.current.path.startsWith(folder + '/')) {
      notesState.current = null
      document.getElementById('notes-doc').hidden = true
      document.getElementById('notes-welcome').hidden = false
    }
    return loadNotes()
  }
}

// ── History and trash ───────────────────────────────────────────────────────

async function notesOpenHistory() {
  const n = notesState.current
  if (!n) return
  await notesSaveNow()
  const r = await notesApi('GET', `/notes/versions?path=${encodeURIComponent(n.path)}`)
  if (!r.ok) return notesToast(r.data.error || 'Geçmiş alınamadı.')
  const vs = r.data.versions || []
  const body = vs.length
    ? vs
        .map(
          (v) => `<div class="notes-list-row"><span class="grow">${nEsc(nDate(v.created_at))} <small>· ${nEsc(v.channel === 'mcp' ? 'AI aracı' : v.channel === 'import' ? 'içe aktarma' : 'web')} · ${Math.ceil(v.size / 1024)} KB</small></span>
          <button class="btn btn-sm" data-version="${nEsc(v.id)}">Göster</button></div>`,
        )
        .join('')
    : '<p class="notes-progress">Bu notun önceki sürümü yok. Her kayıtta eski içerik burada saklanır (web düzenlemeleri 10 dakikada bir).</p>'
  const id = await notesChoice('Sürüm geçmişi', body, true)
  if (!id) return
  const v = await notesApi('GET', `/notes/version?id=${encodeURIComponent(id)}`)
  if (!v.ok) return notesToast('Sürüm okunamadı.')
  const restore = await notesConfirm(
    `Sürüm: ${nDate(v.data.version.created_at)}`,
    `<div class="notes-version-view">${nEsc(v.data.version.content)}</div>`,
    'Bu sürümü geri yükle',
    true,
  )
  if (!restore) return
  const rr = await notesApi('POST', '/notes/version/restore', { id })
  if (!rr.ok) return notesToast(rr.data.error || 'Geri yüklenemedi.')
  await notesOpen(rr.data.note.path)
  notesToast('Sürüm geri yüklendi; önceki içerik de geçmişte duruyor.')
}

async function notesOpenTrash() {
  notesCloseMenu()
  const r = await notesApi('GET', '/notes/trash')
  if (!r.ok) return notesToast(r.data.error || 'Çöp kutusu alınamadı.')
  const list = r.data.notes || []
  const body = list.length
    ? list
        .map(
          (n) => `<div class="notes-list-row"><span class="grow">${nEsc(n.path)} <small>· ${nEsc(nDate(n.deleted_at))}</small></span>
          <button class="btn btn-sm" data-restore="${nEsc(n.id)}">Geri al</button>
          <button class="btn btn-sm" data-purge="${nEsc(n.id)}">Kalıcı sil</button></div>`,
        )
        .join('') + '<div class="notes-list-row"><span class="grow"></span><button class="btn btn-sm" data-purge="__all">Çöpü boşalt</button></div>'
    : '<p class="notes-progress">Çöp kutusu boş. Silinen notlar 30 gün burada kalır.</p>'
  const act = await notesChoice('Çöp kutusu', body, true)
  if (!act) return
  if (act.startsWith('restore:')) {
    const rr = await notesApi('POST', '/notes/trash/restore', { id: act.slice(8) })
    if (!rr.ok) return notesToast(rr.data.error || 'Geri alınamadı.')
    await loadNotes()
    await notesOpen(rr.data.note.path)
  } else if (act.startsWith('purge:')) {
    const id = act.slice(6)
    const ok = await notesConfirm('Kalıcı sil', id === '__all' ? 'Çöp kutusundaki tüm notlar kalıcı olarak silinsin mi? Bu geri alınamaz.' : 'Bu not kalıcı olarak silinsin mi? Bu geri alınamaz.', 'Kalıcı sil')
    if (!ok) return
    await notesApi('DELETE', `/notes/trash${id === '__all' ? '' : `?id=${encodeURIComponent(id)}`}`)
    notesOpenTrash()
  }
}

// ── Import / export ─────────────────────────────────────────────────────────

function notesPickImport(kind) {
  notesCloseMenu()
  document.getElementById(kind === 'zip' ? 'notes-import-zip' : kind === 'folder' ? 'notes-import-folder' : 'notes-import-files').click()
}

/** Notion appends a 32-hex id to every file and folder name: "Proje 1a2b…ef.md". */
function notesCleanNotionName(seg) {
  return seg
    .replace(/\s+[0-9a-f]{32}(?=(\.[a-z0-9]+)?$)/i, '')
    .replace(/\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=(\.[a-z0-9]+)?$)/i, '')
    .replace(/[<>:"|?*]/g, '-')
    .trim()
}

function notesCleanPath(p) {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .map(notesCleanNotionName)
    .join('/')
}

function notesCsvToMarkdown(csv, title) {
  const rows = []
  let row = []
  let cell = ''
  let q = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]
    if (q) {
      if (c === '"' && csv[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && csv[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  const clean = rows.filter((r) => r.some((c) => c.trim()))
  if (!clean.length) return `# ${title}\n`
  const width = Math.max(...clean.map((r) => r.length))
  const fmt = (r) => '| ' + Array.from({ length: width }, (_, i) => (r[i] || '').replace(/\|/g, '\\|').replace(/\n/g, '<br>')).join(' | ') + ' |'
  return `# ${title}\n\n${fmt(clean[0])}\n|${' --- |'.repeat(width)}\n${clean.slice(1).map(fmt).join('\n')}\n`
}

/** Relative "[text](Other%20Page%20<id>.md)" links become [[vault/path|text]] so they keep working. */
function notesRewriteRelativeLinks(content, notePath) {
  const dir = nFolderOf(notePath)
  return content.replace(/\[([^\]\n]*)\]\(([^)\s]+\.md)\)/gi, (whole, text, href) => {
    if (/^[a-z]+:/i.test(href)) return whole
    let decoded
    try {
      decoded = decodeURIComponent(href)
    } catch {
      decoded = href
    }
    const parts = (dir ? dir.split('/') : []).concat(decoded.split('/'))
    const out = []
    for (const p of parts) {
      if (!p || p === '.') continue
      if (p === '..') out.pop()
      else out.push(p)
    }
    const target = notesCleanPath(out.join('/')).replace(/\.md$/i, '')
    return `[[${target}|${text || nBase(target)}]]`
  })
}

async function notesImportItems(items, label) {
  if (!items.length) return notesToast('İçe aktarılacak markdown bulunamadı.')
  const vals = await notesForm(
    `${label}: ${items.length} not`,
    `<label>Hedef klasör</label><input type="text" id="nd-target" value="${nEsc(label === 'Notion' ? 'Notion' : notesState.folder)}" placeholder="(kök)" />
     <label>Aynı adda not varsa</label><select id="nd-conflict"><option value="rename">Yeni adla ekle</option><option value="skip">Atla</option><option value="overwrite">Üzerine yaz (eski sürüm geçmişte kalır)</option></select>`,
    'İçe aktar',
    ['nd-target', 'nd-conflict'],
  )
  if (!vals) return
  const target = vals['nd-target'].trim().replace(/^\/+|\/+$/g, '')
  const prefixed = items.map((it) => ({ path: (target ? target + '/' : '') + it.path, content: it.content }))
  // Links were rewritten relative to the import root; re-root them under the target folder.
  if (target) {
    for (const it of prefixed) it.content = it.content.replace(/\[\[([^\]|]+\/[^\]|]*)(\|[^\]]*)?\]\]/g, (m, t, a) => (t.startsWith(target + '/') ? m : `[[${target}/${t}${a || ''}]]`))
  }
  const stats = { created: 0, updated: 0, skipped: 0, errors: [] }
  const chunk = 25
  notesShowProgress('İçe aktarılıyor…')
  for (let i = 0; i < prefixed.length; i += chunk) {
    notesShowProgress(`İçe aktarılıyor… ${Math.min(i + chunk, prefixed.length)} / ${prefixed.length}`)
    const r = await notesApi('POST', '/notes/import', { notes: prefixed.slice(i, i + chunk), on_conflict: vals['nd-conflict'] })
    if (!r.ok) {
      stats.errors.push({ path: `${i}. parti`, error: r.data.error || String(r.status) })
      continue
    }
    stats.created += r.data.created
    stats.updated += r.data.updated
    stats.skipped += r.data.skipped
    stats.errors.push(...(r.data.errors || []))
  }
  notesHideDialog()
  await loadNotes()
  const errs = stats.errors.length ? ` ${stats.errors.length} hata: ${stats.errors.slice(0, 3).map((e) => e.path + ' (' + e.error + ')').join(', ')}` : ''
  notesToast(`${stats.created} yeni, ${stats.updated} güncellendi, ${stats.skipped} atlandı.${errs}`)
  if (target) {
    notesState.open.add(target)
    notesSaveOpen()
    renderNotesTree()
  }
}

async function notesImportFileList(files, label) {
  const items = []
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name
    if (!/\.(md|markdown|txt|csv)$/i.test(rel)) continue
    const text = await f.text()
    let path = notesCleanPath(rel).replace(/\.(markdown|txt)$/i, '.md')
    if (/\.csv$/i.test(path)) {
      path = path.replace(/\.csv$/i, '.md')
      items.push({ path, content: notesCsvToMarkdown(text, nBase(path)) })
    } else {
      items.push({ path, content: notesRewriteRelativeLinks(text, path) })
    }
  }
  await notesImportItems(items, label)
}

async function notesImportZip(file) {
  try {
    await notesLoadLib('fflate')
  } catch {
    return notesToast('ZIP kütüphanesi yüklenemedi.')
  }
  notesShowProgress('ZIP açılıyor…')
  const items = []
  let skippedFiles = 0
  let fromNotion = false
  const seen = new Set()
  const walkZip = (bytes, prefix) => {
    const files = window.fflate.unzipSync(bytes)
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue
      if (/\.zip$/i.test(name)) {
        walkZip(data, prefix)
        continue
      }
      if (!/\.(md|markdown|csv|txt)$/i.test(name)) {
        skippedFiles++
        continue
      }
      // Notion's CSV export ships "X.csv" and "X_all.csv"; keep the full one.
      if (/_all\.csv$/i.test(name) === false && /\.csv$/i.test(name) && files[name.replace(/\.csv$/i, '_all.csv')]) continue
      if (/\s[0-9a-f]{32}(\.[a-z]+)?$/i.test(name.replace(/\/$/, ''))) fromNotion = true
      const text = window.fflate.strFromU8(data)
      let path = notesCleanPath((prefix + name).replace(/_all\.csv$/i, '.csv')).replace(/\.(markdown|txt)$/i, '.md')
      if (/\.csv$/i.test(path)) {
        path = path.replace(/\.csv$/i, ' (tablo).md')
        items.push({ path, content: notesCsvToMarkdown(text, nBase(path).replace(/ \(tablo\)$/, '')) })
      } else {
        items.push({ path, content: notesRewriteRelativeLinks(text, path) })
      }
    }
  }
  try {
    walkZip(new Uint8Array(await file.arrayBuffer()), '')
  } catch (e) {
    notesHideDialog()
    return notesToast('ZIP okunamadı: ' + e.message)
  }
  // Notion wraps everything in one export folder ("Export-<uuid>"); drop a single shared top folder.
  const tops = new Set(items.map((i) => i.path.split('/')[0]))
  if (tops.size === 1 && items.every((i) => i.path.includes('/'))) {
    const top = [...tops][0]
    for (const i of items) {
      i.path = i.path.slice(top.length + 1)
      i.content = i.content.split(`[[${top}/`).join('[[')
    }
  }
  for (const i of items) {
    let p = i.path
    for (let n = 1; seen.has(p.toLowerCase()); n++) p = i.path.replace(/\.md$/i, ` (${n}).md`)
    seen.add(p.toLowerCase())
    i.path = p
  }
  notesHideDialog()
  if (skippedFiles) notesToast(`${skippedFiles} ek dosya (resim, PDF vb.) atlandı; sadece metin aktarılır.`)
  await notesImportItems(items, fromNotion || /notion|export-/i.test(file.name) ? 'Notion' : 'ZIP')
}

async function notesExportZip() {
  notesCloseMenu()
  try {
    await notesLoadLib('fflate')
  } catch {
    return notesToast('ZIP kütüphanesi yüklenemedi.')
  }
  const r = await notesApi('GET', '/notes/export')
  if (!r.ok) return notesToast(r.data.error || 'Dışa aktarılamadı.')
  const files = {}
  for (const n of r.data.notes) files[n.path] = [window.fflate.strToU8(n.content), { mtime: new Date(n.modified_at) }]
  const zip = window.fflate.zipSync(files, { level: 6 })
  // One download mechanism for the whole dashboard (utils.js); a Uint8Array is a valid Blob part.
  downloadTextFile(document, zip, `second-brain-notlar-${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip')
  notesToast(`${r.data.notes.length} not indirildi.`)
}

// ── Dialog primitives ───────────────────────────────────────────────────────

let notesDialogResolve = null

function notesShowDialog(title, bodyHtml, actionsHtml, wide) {
  document.getElementById('notes-dialog-title').textContent = title
  document.getElementById('notes-dialog-body').innerHTML = bodyHtml
  document.getElementById('notes-dialog-actions').innerHTML = actionsHtml
  document.querySelector('.notes-dialog-card').classList.toggle('wide', !!wide)
  document.getElementById('notes-dialog').hidden = false
}

function notesHideDialog(value) {
  document.getElementById('notes-dialog').hidden = true
  const r = notesDialogResolve
  notesDialogResolve = null
  if (r) r(value)
}

function notesShowProgress(text) {
  notesShowDialog('Lütfen bekle', `<p class="notes-progress">${nEsc(text)}</p>`, '')
}

function notesForm(title, bodyHtml, okLabel, ids) {
  return new Promise((resolve) => {
    if (notesDialogResolve) notesDialogResolve(null)
    notesShowDialog(title, bodyHtml, `<button class="btn btn-sm" data-dlg="cancel">Vazgeç</button><button class="btn btn-primary btn-sm" data-dlg="ok">${nEsc(okLabel)}</button>`)
    notesDialogResolve = (v) => resolve(v ?? null)
    const collect = () => {
      const out = {}
      for (const id of ids) {
        const el = document.getElementById(id)
        if (el) out[id] = el.value
        else out[id] = ''
      }
      return out
    }
    notesState.dialogCollect = collect
    const first = document.querySelector('#notes-dialog-body input, #notes-dialog-body select')
    if (first) setTimeout(() => first.focus(), 30)
  })
}

function notesConfirm(title, message, okLabel, html) {
  return new Promise((resolve) => {
    if (notesDialogResolve) notesDialogResolve(null)
    notesShowDialog(title, html ? message : `<p>${nEsc(message)}</p>`, `<button class="btn btn-sm" data-dlg="cancel">Vazgeç</button><button class="btn btn-primary btn-sm" data-dlg="ok">${nEsc(okLabel)}</button>`, html)
    notesState.dialogCollect = () => true
    notesDialogResolve = (v) => resolve(!!v)
  })
}

/** A dialog whose body buttons carry data-act / data-version / data-restore / data-purge; resolves to that value. */
function notesChoice(title, bodyHtml, wide) {
  return new Promise((resolve) => {
    if (notesDialogResolve) notesDialogResolve(null)
    notesShowDialog(title, bodyHtml, '<button class="btn btn-sm" data-dlg="cancel">Kapat</button>', wide)
    notesState.dialogCollect = null
    notesDialogResolve = (v) => resolve(v ?? null)
  })
}

function notesToggleMenu(e) {
  e.stopPropagation()
  const m = document.getElementById('notes-menu')
  m.hidden = !m.hidden
}
function notesCloseMenu() {
  const m = document.getElementById('notes-menu')
  if (m) m.hidden = true
}

// ── Event wiring ────────────────────────────────────────────────────────────

let notesBound = false
function notesBindOnce() {
  if (notesBound) return
  notesBound = true

  const tree = document.getElementById('notes-tree')
  tree.addEventListener('click', (e) => {
    const more = e.target.closest('[data-folder-menu]')
    if (more) {
      e.stopPropagation()
      return notesFolderMenu(more.dataset.folderMenu)
    }
    const f = e.target.closest('.nt-folder')
    if (f) {
      const p = f.dataset.folder
      if (notesState.open.has(p)) notesState.open.delete(p)
      else notesState.open.add(p)
      notesState.folder = p
      notesSaveOpen()
      return renderNotesTree()
    }
    const n = e.target.closest('[data-path]')
    if (n) notesOpen(n.dataset.path)
  })
  document.getElementById('notes-recent').addEventListener('click', (e) => {
    const n = e.target.closest('[data-path]')
    if (n) notesOpen(n.dataset.path)
  })

  // Drag a note or folder onto a folder (or the empty tree area for the root).
  tree.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.nt-row')
    if (!row) return
    e.dataTransfer.setData('text/plain', JSON.stringify(row.dataset.path ? { note: row.dataset.path } : { folder: row.dataset.folder }))
    e.dataTransfer.effectAllowed = 'move'
  })
  tree.addEventListener('dragover', (e) => {
    const row = e.target.closest('.nt-folder')
    e.preventDefault()
    tree.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop'))
    if (row) row.classList.add('drop')
  })
  tree.addEventListener('dragleave', () => tree.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')))
  tree.addEventListener('drop', async (e) => {
    e.preventDefault()
    tree.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop'))
    let payload
    try {
      payload = JSON.parse(e.dataTransfer.getData('text/plain'))
    } catch {
      return
    }
    const row = e.target.closest('.nt-folder')
    const dest = row ? row.dataset.folder : ''
    if (payload.note && nFolderOf(payload.note) !== dest) await notesMoveTo(payload.note, dest)
    if (payload.folder && payload.folder !== dest && !dest.startsWith(payload.folder + '/')) await notesMoveFolderTo(payload.folder, dest)
  })

  const search = document.getElementById('notes-search')
  search.addEventListener('input', () => {
    clearTimeout(notesState.searchTimer)
    notesState.searchTimer = setTimeout(() => notesRunSearch(search.value), 250)
  })
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = ''
      renderNotesTree()
    }
  })

  const ed = document.getElementById('notes-editor')
  ed.addEventListener('input', notesOnInput)
  ed.addEventListener('blur', () => notesSaveNow())
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const s = ed.selectionStart
      const end = ed.selectionEnd
      ed.setRangeText('  ', s, end, 'end')
      notesOnInput()
    }
    // Enter inside a list continues the list (and "- [ ] " for tasks).
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && ed.selectionStart === ed.selectionEnd) {
      const pos = ed.selectionStart
      const lineStart = ed.value.lastIndexOf('\n', pos - 1) + 1
      const line = ed.value.slice(lineStart, pos)
      const m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/.exec(line)
      if (m) {
        e.preventDefault()
        if (line.trim() === m[0].trim()) {
          ed.setRangeText('', lineStart, pos, 'end')
        } else {
          let bullet = m[2]
          if (/^\d+/.test(bullet)) bullet = String(parseInt(bullet, 10) + 1) + bullet.slice(-1)
          ed.setRangeText('\n' + m[1] + bullet + ' ' + (m[3] ? '[ ] ' : ''), pos, pos, 'end')
        }
        notesOnInput()
      }
    }
  })

  document.getElementById('notes-preview').addEventListener('click', (e) => {
    const box = e.target.closest('input[type="checkbox"][data-task-index]')
    if (box) {
      e.preventDefault()
      return notesToggleTask(Number(box.dataset.taskIndex))
    }
    const wl = e.target.closest('a.wikilink')
    if (wl) {
      e.preventDefault()
      return notesFollowLink(wl.dataset.target)
    }
    const a = e.target.closest('a[href]')
    if (a) {
      const href = a.getAttribute('href') || ''
      if (!/^[a-z]+:/i.test(href) && /\.md$/i.test(href.split('#')[0])) {
        e.preventDefault()
        const dir = notesState.current ? nFolderOf(notesState.current.path) : ''
        let decoded = href.split('#')[0]
        try {
          decoded = decodeURIComponent(decoded)
        } catch {}
        const parts = (dir ? dir.split('/') : []).concat(decoded.split('/'))
        const out = []
        for (const p of parts) {
          if (!p || p === '.') continue
          if (p === '..') out.pop()
          else out.push(p)
        }
        notesFollowLink(out.join('/'))
      }
    }
  })
  document.getElementById('notes-links').addEventListener('click', (e) => {
    const a = e.target.closest('[data-path]')
    if (a) return notesOpen(a.dataset.path)
    const c = e.target.closest('[data-create]')
    if (c) notesFollowLink(c.dataset.create)
  })

  document.getElementById('notes-dialog').addEventListener('click', (e) => {
    if (e.target.id === 'notes-dialog') return notesHideDialog(null)
    const btn = e.target.closest('button')
    if (!btn) return
    if (btn.dataset.dlg === 'cancel') return notesHideDialog(null)
    if (btn.dataset.dlg === 'ok') return notesHideDialog(notesState.dialogCollect ? notesState.dialogCollect() : true)
    if (btn.dataset.act) return notesHideDialog(btn.dataset.act)
    if (btn.dataset.version) return notesHideDialog(btn.dataset.version)
    if (btn.dataset.restore) return notesHideDialog('restore:' + btn.dataset.restore)
    if (btn.dataset.purge) return notesHideDialog('purge:' + btn.dataset.purge)
  })
  document.getElementById('notes-dialog').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') notesHideDialog(null)
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && notesState.dialogCollect) {
      e.preventDefault()
      notesHideDialog(notesState.dialogCollect())
    }
  })

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#notes-menu')) notesCloseMenu()
  })
  document.addEventListener('keydown', (e) => {
    if (typeof currentTab !== 'undefined' && currentTab !== 'notes') return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      notesSaveNow()
    } else if (mod && e.key.toLowerCase() === 'e' && notesState.current) {
      e.preventDefault()
      notesSetMode(notesState.mode === 'edit' ? 'preview' : 'edit')
    } else if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      search.focus()
      search.select()
    }
  })

  document.getElementById('notes-import-files').addEventListener('change', async (e) => {
    const files = [...e.target.files]
    e.target.value = ''
    await notesImportFileList(files, 'Markdown')
  })
  document.getElementById('notes-import-folder').addEventListener('change', async (e) => {
    const files = [...e.target.files]
    e.target.value = ''
    await notesImportFileList(files, 'Klasör')
  })
  document.getElementById('notes-import-zip').addEventListener('change', async (e) => {
    const f = e.target.files[0]
    e.target.value = ''
    if (f) await notesImportZip(f)
  })

  window.addEventListener('beforeunload', (e) => {
    if (notesState.dirty) {
      notesSaveNow()
      e.preventDefault()
    }
  })
  window.addEventListener('hashchange', () => {
    const p = notesPathFromHash()
    if (!p) return
    if (typeof switchTab === 'function' && currentTab !== 'notes') switchTab('notes')
    else if (!notesState.current || notesState.current.path !== p) notesOpen(p)
  })
}

// A "#notes/<path>" link opened in a fresh tab lands on the Notes screen once the app is up.
;(function notesBootDeepLink() {
  if (!(window.location.hash || '').startsWith('#notes')) return
  const tryOpen = () => {
    if (typeof AUTH_TOKEN === 'undefined' || !AUTH_TOKEN || typeof switchTab !== 'function') return false
    switchTab('notes')
    return true
  }
  if (!tryOpen()) {
    let tries = 0
    const t = setInterval(() => {
      if (tryOpen() || ++tries > 40) clearInterval(t)
    }, 250)
  }
})()
