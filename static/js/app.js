const state = { q: '', years: new Set(), categories: new Set(), types: new Set(), tags: new Set(), duplicates: false, demo: false, selected: null, requestedDocument: '', preview: false };
let files = [], timer, availableYears = [], availableCategories = [], visibleTags = [], favoriteTags = [], recentTags = [], tagAliases = {}, activeSettingsTab = 'tags';
// Ctrl/Shift-click builds a multi-selection that can be dragged onto a category or tag; `dragging` pauses background refreshes.
const multi = new Set(), DRAG_TYPE = 'application/x-doggs-documents';
let anchorId = null, dragging = false, toastTimer;
const $ = id => document.getElementById(id);
const root = document.documentElement;
const THEME_KEY = 'doggs-theme', SIDEBAR_KEY = 'doggs-sidebar', LIST_WIDTH_KEY = 'doggs-list-width';
const store = { get: key => { try { return localStorage.getItem(key) } catch { return null } }, set: (key, value) => { try { localStorage.setItem(key, value) } catch {} } };

// 'auto' follows the OS color scheme; 'light'/'dark' force one. Older theme names fall back to auto (midnight -> dark).
function currentTheme() {
  const stored = store.get(THEME_KEY);
  return stored === 'midnight' ? 'dark' : ['light', 'dark'].includes(stored) ? stored : 'auto';
}

function applyTheme(name) {
  if (name === 'auto') delete root.dataset.theme; else root.dataset.theme = name;
  store.set(THEME_KEY, name);
  document.querySelectorAll('[data-theme-choice]').forEach(card => card.classList.toggle('selected', card.dataset.themeChoice === name));
}

function setSidebar(open) {
  root.classList.toggle('sidebar-closed', !open);
  $('sidebarToggle').setAttribute('aria-expanded', String(open));
  // On narrow screens the sidebar is a temporary drawer, so only the desktop preference is remembered.
  if (!isNarrow()) store.set(SIDEBAR_KEY, open ? 'open' : 'closed');
}

const isNarrow = () => matchMedia('(max-width: 1000px)').matches;
if (isNarrow()) root.classList.add('sidebar-closed');

// The preview panel and the full-width thumbnail grid are two states of the same workspace.
function setPreview(open, updateUrl = true) {
  state.preview = open;
  root.classList.toggle('preview-open', open);
  $('previewToggle').setAttribute('aria-pressed', String(open));
  if (open) loadFrame();
  else { $('frame').removeAttribute('src'); closeDuplicates(false) }
  if (!open && state.selected) requestAnimationFrame(() => document.querySelector('#files .file.active')?.scrollIntoView({ block: 'nearest' }));
  if (updateUrl) syncUrl(true);
}

function loadFrame() {
  const f = state.selected;
  if (!state.preview || !f || $('duplicatesView').classList.contains('open')) return;
  if ($('frame').getAttribute('src') !== f.url) $('frame').src = f.url;
}

function syncUrl(push = false) {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.years.size) p.set('years', [...state.years].join(','));
  if (state.categories.size) p.set('categories', [...state.categories].join(','));
  if (state.types.size) p.set('types', [...state.types].join(','));
  if (state.tags.size) p.set('tags', [...state.tags].join(','));
  if (state.duplicates) p.set('duplicates', '1');
  if (state.demo) p.set('demo', 'true');
  const documentId = state.selected?.id || state.requestedDocument;
  if (documentId) p.set('document', documentId);
  if (documentId && !state.preview) p.set('preview', '0');
  if ($('settingsDialog').open) { p.set('settings', '1'); p.set('settings-tab', activeSettingsTab); }
  history[push ? 'pushState' : 'replaceState']({}, '', location.pathname + (p.size ? '?' + p.toString() : ''));
}

function restoreUrlState() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') || '';
  state.years = new Set((p.get('years') || '').split(',').filter(Boolean));
  state.categories = new Set((p.get('categories') || '').split(',').filter(Boolean));
  state.types = new Set((p.get('types') || '').split(',').filter(Boolean));
  state.tags = new Set((p.get('tags') || '').split(',').filter(Boolean));
  state.duplicates = p.get('duplicates') === '1';
  state.demo = p.get('demo') === 'true';
  state.selected = null;
  state.requestedDocument = p.get('document') || '';
  state.preview = !!state.requestedDocument && p.get('preview') !== '0';
  root.classList.toggle('preview-open', state.preview);
  $('previewToggle').setAttribute('aria-pressed', String(state.preview));
  $('query').value = state.q;
  $('duplicates').checked = state.duplicates;
  $('cleanDuplicatesButton').hidden = !state.duplicates;
  const settings = p.get('settings') === '1';
  activeSettingsTab = p.get('settings-tab') || 'tags';
  if (settings && !$('settingsDialog').open) openSettings(false);
  if (!settings && $('settingsDialog').open) $('settingsDialog').close();
}

async function refresh() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.years.size) p.set('years', [...state.years].join(','));
  if (state.categories.size) p.set('categories', [...state.categories].join(','));
  if (state.types.size) p.set('types', [...state.types].join(','));
  if (state.tags.size) p.set('tokens', [...state.tags].join(','));
  if (state.duplicates) p.set('duplicates', '1');
  if (state.demo) p.set('demo', 'true');
  const selectedId = state.selected?.id || state.requestedDocument;
  if (selectedId) p.set('document', selectedId);
  const r = await fetch('/api/index?' + p);
  if (!r.ok) return;
  const d = await r.json();
  availableYears = (d.years || []).map(i => i.value);
  availableCategories = (d.categories || []).map(i => i.value);
  favoriteTags = d.favorite_tags || [];
  recentTags = d.recent_tags || [];
  renderFacet('years', d.years || [], state.years, 'All years');
  renderFacet('categories', d.categories || [], state.categories, 'All categories', value => value, (ids, category) => bulkUpdate(ids, { category }, category));
  renderFacet('types', d.types || [], state.types, 'All', value => value.toUpperCase());
  renderTags(d.tags || []);
  $('duplicateCount').textContent = d.duplicates_count || 0;
  renderFiles(d.files || []);
  if (selectedId && $('duplicatesView').classList.contains('open') && !state.requestedDocument) return;
  if (selectedId) {
    const f = files.find(x => x.id === selectedId) || d.selected_file;
    if (f) {
      const load = !!state.requestedDocument;
      state.requestedDocument = '';
      selectFile(f, load, false);
    } else if (!selectFirstFile()) {
      clearSelection(false);
      syncUrl();
    }
  } else if (!selectFirstFile()) {
    syncUrl();
  }
}

// Nothing (or something that vanished, like a deleted duplicate) is selected: fall back to the first document in the list.
function selectFirstFile() {
  const first = document.querySelector('#files .file');
  const f = first && files.find(x => x.id === first.dataset.fileId);
  if (!f) return false;
  selectFile(f, true, false);
  syncUrl();
  return true;
}

// Clickable facet list replacing the old multi-select boxes: click toggles a value, "All" clears the facet.
function renderFacet(id, items, selected, allLabel, format = value => value, onDrop = null) {
  const e = $(id), focusedValue = e.contains(document.activeElement) ? document.activeElement.dataset.value : null;
  e.innerHTML = '';
  const make = (value, label, count, active) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'facet-item' + (active ? ' selected' : '') + (count === 0 ? ' zero' : '');
    b.dataset.value = value;
    b.setAttribute('aria-pressed', String(active));
    b.innerHTML = '<span class="facet-label"></span>' + (count == null ? '' : '<span class="count"></span>');
    b.querySelector('.facet-label').textContent = label;
    if (count != null) b.querySelector('.count').textContent = count;
    b.onclick = () => {
      if (!value) selected.clear();
      else if (selected.has(value)) selected.delete(value);
      else selected.add(value);
      syncUrl(true);
      refresh();
    };
    e.append(b);
    return b;
  };
  make('', allLabel, null, !selected.size);
  items.forEach(i => {
    const b = make(i.value, format(i.value), i.count, selected.has(i.value));
    if (onDrop) dropTarget(b, ids => onDrop(ids, i.value));
  });
  if (focusedValue != null) e.querySelector('[data-value="' + CSS.escape(focusedValue) + '"]')?.focus();
}

function renderTags(items) {
  visibleTags = items;
  const e = $('tags'), needle = $('tagSearch').value.trim().toLowerCase();
  e.innerHTML = '';
  const rank = value => favoriteTags.includes(value) ? 0 : 1;
  items.filter(i => !needle || i.value.includes(needle)).sort((a, b) => rank(a.value) - rank(b.value)).forEach(i => {
    const wrap = document.createElement('span');
    wrap.className = 'tag-facet';
    dropTarget(wrap, ids => bulkUpdate(ids, { tag: i.value }, '#' + i.value));
    const filter = document.createElement('button');
    filter.className = 'chip' + (state.tags.has(i.value) ? ' selected' : '');
    filter.textContent = i.value;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = i.count;
    filter.append(count);
    filter.title = 'Filter by ' + i.value;
    filter.onclick = () => { state.tags.has(i.value) ? state.tags.delete(i.value) : state.tags.add(i.value); syncUrl(true); refresh() };
    const edit = document.createElement('button');
    edit.className = 'tag-edit';
    edit.textContent = '✎';
    edit.title = 'Rename ' + i.value + ' everywhere';
    edit.setAttribute('aria-label', 'Rename ' + i.value + ' everywhere');
    edit.onclick = () => renameTag(i.value);
    const ignore = document.createElement('button');
    ignore.className = 'tag-ignore';
    ignore.textContent = '−';
    ignore.title = 'Ignore ' + i.value + ' everywhere';
    ignore.setAttribute('aria-label', 'Ignore ' + i.value + ' everywhere');
    ignore.onclick = () => ignoreTag(i.value);
    const star = document.createElement('button');
    const favorite = favoriteTags.includes(i.value);
    star.className = 'tag-star' + (favorite ? ' on' : '');
    star.textContent = favorite ? '★' : '☆';
    star.title = (favorite ? 'Remove ' : 'Add ') + i.value + (favorite ? ' from' : ' to') + ' favorite tags';
    star.setAttribute('aria-label', star.title);
    star.setAttribute('aria-pressed', String(favorite));
    star.onclick = () => setFavoriteTag(i.value, !favorite);
    wrap.append(filter, star, edit, ignore);
    e.append(wrap);
  });
  if (!e.children.length) e.innerHTML = '<div class="empty">No matching tags.</div>';
}

// Duplicate copies are grouped onto their original's list entry with a count badge instead of listed separately.
// f.duplicate_count comes from the server and is filter-independent, so it stays correct even when the
// original (or a sibling copy) is hidden by the current year/tag/search filters.
// Rendered as a thumbnail grid while the preview is closed and as a compact list next to the open preview.
let renderedSignature = '';
function renderFiles(list) {
  files = list;
  const e = $('files');
  // Skip identical re-renders (periodic refresh) so thumbnails and scroll position stay put.
  const signature = JSON.stringify(list.map(f => [f.id, f.name, f.pdf_title, f.date, f.year, f.category, f.classification, f.summary, f.duplicate_count, f.thumb_url]));
  if (signature === renderedSignature && e.childElementCount) { markActiveFile(); return }
  renderedSignature = signature;
  const byId = new Map(list.map(f => [f.id, f]));
  const visible = list.filter(f => !(f.is_duplicate && f.duplicate_of && byId.has(f.duplicate_of)));
  $('resultCount').textContent = visible.length === 1 ? '1 document' : visible.length + ' documents';
  e.innerHTML = '';
  if (!visible.length) { e.innerHTML = '<div class="empty">No documents match these filters.</div>'; return }
  const groups = {};
  visible.forEach(f => (groups[f.year || 'unknown'] ??= []).push(f));
  Object.keys(groups).sort().reverse().forEach(y => {
    const g = document.createElement('section');
    g.className = 'year-group';
    const heading = document.createElement('h3');
    heading.innerHTML = '<span></span><span class="count"></span>';
    heading.firstChild.textContent = y;
    heading.lastChild.textContent = groups[y].length;
    const items = document.createElement('div');
    items.className = 'year-items';
    groups[y].forEach(f => items.append(fileCard(f)));
    g.append(heading, items);
    e.append(g);
  });
}

function fileCard(f) {
  const dupeCount = f.duplicate_count || 0;
  const b = document.createElement('div');
  b.setAttribute('role', 'button');
  b.tabIndex = 0;
  b.draggable = true;
  b.className = 'file' + (state.selected?.id === f.id ? ' active' : '') + (multi.has(f.id) ? ' multi' : '');
  b.dataset.fileId = f.id;
  b.innerHTML = '<div class="thumb"><span class="type-label"></span></div><div class="body"><div class="title"></div><div class="meta"></div><div class="summary"></div></div>';
  b.querySelector('.type-label').textContent = f.type || 'file';
  if (f.thumb_url) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.onload = () => img.classList.add('loaded');
    img.onerror = () => img.remove();
    img.src = f.thumb_url;
    if (img.complete && img.naturalWidth) img.classList.add('loaded');
    b.querySelector('.thumb').prepend(img);
  }
  b.querySelector('.title').textContent = f.pdf_title || f.name;
  b.title = f.name;
  b.querySelector('.meta').textContent = [f.date || 'no date', f.category || f.classification].filter(Boolean).join(' · ');
  b.querySelector('.summary').textContent = f.summary || '';
  if (dupeCount) {
    const badge = document.createElement('span');
    badge.className = 'dupe-badge';
    const total = dupeCount + 1;
    badge.textContent = String(total);
    badge.title = total + ' copies of this document (' + dupeCount + ' duplicate' + (dupeCount > 1 ? 's' : '') + ')';
    b.append(badge);
  }
  b.onclick = e => {
    if (e.ctrlKey || e.metaKey) { toggleMulti(f.id); return }
    if (e.shiftKey && anchorId) { selectRange(anchorId, f.id); return }
    clearMulti();
    anchorId = f.id;
    dupeCount ? openDuplicates(f) : openFile(f);
  };
  b.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click() } };
  b.ondragstart = e => {
    const ids = multi.has(f.id) ? [...multi] : [f.id];
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    e.dataTransfer.setData('text/plain', ids.length + ' document' + (ids.length > 1 ? 's' : ''));
    e.dataTransfer.effectAllowed = 'copy';
    dragging = true;
    document.querySelectorAll('#files .file').forEach(card => card.classList.toggle('dragging', ids.includes(card.dataset.fileId)));
  };
  b.ondragend = () => { dragging = false; document.querySelectorAll('.dragging').forEach(card => card.classList.remove('dragging')) };
  return b;
}

function markActiveFile() {
  document.querySelectorAll('#files .file').forEach(card => {
    card.classList.toggle('active', card.dataset.fileId === state.selected?.id);
    card.classList.toggle('multi', multi.has(card.dataset.fileId));
  });
  $('selectionBar').hidden = multi.size < 2;
  $('selectionCount').textContent = multi.size + ' documents selected';
}

function toggleMulti(id) {
  if (!multi.size && state.selected) multi.add(state.selected.id);
  multi.has(id) ? multi.delete(id) : multi.add(id);
  anchorId = id;
  markActiveFile();
  if (state.selected) renderQuickTags(state.selected);
}

function selectRange(fromId, toId) {
  const ids = [...document.querySelectorAll('#files .file')].map(card => card.dataset.fileId);
  const a = ids.indexOf(fromId), b = ids.indexOf(toId);
  if (a < 0 || b < 0) return;
  ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(id => multi.add(id));
  markActiveFile();
  if (state.selected) renderQuickTags(state.selected);
}

function clearMulti() {
  if (!multi.size) return;
  multi.clear();
  markActiveFile();
  if (state.selected) renderQuickTags(state.selected);
}

function showToast(message) {
  const e = $('toast');
  e.textContent = message;
  e.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { e.hidden = true }, 3500);
}

function dropTarget(el, onDrop) {
  el.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-over');
  });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-over') });
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('drop-over');
    dragging = false;
    try { onDrop(JSON.parse(e.dataTransfer.getData(DRAG_TYPE))) } catch {}
  });
}

// One request for any number of documents: used by drag and drop and by the quick tags.
async function bulkUpdate(ids, change, label) {
  if (!ids.length) return false;
  const r = await fetch('/api/files/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, ...change }) });
  const noun = ids.length === 1 ? '1 document' : ids.length + ' documents';
  showToast(r.ok ? (change.tag ? 'Tagged ' + noun + ' with ' + label : 'Moved ' + noun + ' to ' + label) : 'Could not update ' + noun + '.');
  if (r.ok) await refresh();
  return r.ok;
}

async function setFavoriteTag(tag, favorite) {
  const r = await fetch('/api/tags/' + encodeURIComponent(tag) + '/favorite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite }) });
  if (r.ok) refresh();
}

// Favorites first, then the most recently assigned tags; clicking one adds it to the open document (or the whole multi-selection).
function renderQuickTags(f) {
  const e = $('quickTags'), assigned = new Set((f.document_tags || []).map(entry => entry.value));
  const targets = multi.size > 1 ? [...multi] : [f.id];
  e.innerHTML = '';
  const groups = [['Favorites', favoriteTags], ['Latest', recentTags.filter(tag => !favoriteTags.includes(tag))]];
  groups.forEach(([label, tags]) => {
    if (!tags.length) return;
    const group = document.createElement('div');
    group.className = 'quick-tag-group';
    const heading = document.createElement('span');
    heading.className = 'document-tag-group-label';
    heading.textContent = label + (multi.size > 1 ? ' · apply to ' + targets.length : '');
    group.append(heading);
    tags.forEach(tag => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'quick-tag';
      b.textContent = (label === 'Favorites' ? '★ ' : '+ ') + tag;
      const done = targets.length === 1 && assigned.has(tag);
      b.disabled = done;
      b.title = done ? 'Already on this document' : 'Add ' + tag + (targets.length > 1 ? ' to ' + targets.length + ' documents' : ' to this document');
      b.onclick = () => bulkUpdate(targets, { tag }, '#' + tag);
      group.append(b);
    });
    e.append(group);
  });
  if (!e.children.length) e.innerHTML = '<span class="meta">Star a tag in the sidebar to keep it here for one-click tagging.</span>';
  e.hidden = false;
}

async function moveDocumentCategory() {
  if (!state.selected) return;
  const category = $('categoryInput').value;
  const r = await fetch('/api/file/' + encodeURIComponent(state.selected.id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category }) });
  $('editorStatus').textContent = r.ok ? 'Category set to ' + (category || 'none') + '.' : 'Could not change the category.';
  if (r.ok) refresh();
}

function openFile(f) {
  selectFile(f, true, false);
  if (!state.preview) setPreview(true, false);
  syncUrl(true);
}

// Arrow keys move through the list; in the grid they also move by row/column using the cards' on-screen positions.
function selectAdjacentFile(key) {
  const cards = [...document.querySelectorAll('#files .file')];
  if (!cards.length) return;
  const current = cards.findIndex(card => card.dataset.fileId === state.selected?.id);
  let next;
  if (current < 0) next = ['arrowup', 'arrowleft'].includes(key) ? cards.length - 1 : 0;
  else if (state.preview || key === 'arrowleft' || key === 'arrowright') next = Math.max(0, Math.min(cards.length - 1, current + (['arrowdown', 'arrowright'].includes(key) ? 1 : -1)));
  else {
    const from = cards[current].getBoundingClientRect(), down = key === 'arrowdown';
    const candidates = cards.map((card, index) => ({ index, rect: card.getBoundingClientRect() })).filter(({ rect }) => down ? rect.top > from.top + 4 : rect.top < from.top - 4);
    if (!candidates.length) return;
    const rowTop = down ? Math.min(...candidates.map(c => c.rect.top)) : Math.max(...candidates.map(c => c.rect.top));
    next = candidates.filter(c => Math.abs(c.rect.top - rowTop) < 4).sort((a, b) => Math.abs(a.rect.left - from.left) - Math.abs(b.rect.left - from.left))[0].index;
  }
  const f = files.find(x => x.id === cards[next].dataset.fileId);
  if (!f) return;
  selectFile(f);
  document.querySelector('#files .file.active')?.scrollIntoView({ block: 'nearest' });
}

function clearSelection(updateUrl = true) {
  state.selected = null;
  state.requestedDocument = '';
  $('detailsEditor').hidden = true;
  $('editorActions').hidden = true;
  $('documentTitle').textContent = 'Select a document';
  $('documentMeta').textContent = 'Its details and preview will appear here.';
  $('frame').removeAttribute('src');
  closeDuplicates(false);
  if (state.preview) setPreview(false, false);
  markActiveFile();
  if (updateUrl) syncUrl(true);
}

function renderDocumentTags(tags) {
  const e = $('documentTags');
  e.innerHTML = '';
  if (!tags.length) { e.innerHTML = '<span class="meta">No document tags yet. Use Rerun pipeline to improve this document.</span>'; return }
  [['inferred', 'Extracted'], ['custom', 'Custom']].forEach(([kind, label]) => {
    const entries = tags.filter(entry => entry.kind === kind);
    if (!entries.length) return;
    const group = document.createElement('div');
    group.className = 'document-tag-group';
    const heading = document.createElement('span');
    heading.className = 'document-tag-group-label';
    heading.textContent = label;
    group.append(heading);
    entries.forEach(entry => {
      const tag = entry.value;
      const chip = document.createElement('span');
      chip.className = 'tag-chip ' + (kind === 'custom' ? 'custom-tag' : 'extracted-tag');
      const filter = document.createElement('button');
      filter.className = 'document-tag-filter';
      filter.textContent = tag;
      filter.title = 'Filter documents by ' + tag;
      filter.onclick = () => filterByDocumentTag(tag);
      chip.append(filter);
      const remove = document.createElement('button');
      remove.textContent = '−';
      remove.title = 'Remove ' + tag + ' from this document';
      remove.onclick = () => removeDocumentTag(tag, kind);
      chip.append(remove);
      group.append(chip);
    });
    e.append(group);
  });
}

function selectFile(f, load = true, updateUrl = true) {
  closeDuplicates(false);
  state.selected = f;
  state.requestedDocument = '';
  $('detailsEditor').hidden = false;
  $('editorActions').hidden = false;
  const isPdf = /\.(pdf|png|jpe?g|tiff?|bmp|webp|gif)$/i.test(f.name);  // formats the OCR button can read
  $('openOriginal').href = f.url;
  $('runOcr').hidden = !isPdf;
  $('allPages').closest('label').hidden = !isPdf;
  $('documentTitle').textContent = f.pdf_title || f.name;
  $('documentMeta').textContent = [f.name, f.pdf_author, f.date, f.category, f.classification, f.is_duplicate ? 'Duplicate content' : ''].filter(Boolean).join(' · ');
  const ruleBadge = $('ruleMatchBadge');
  if (f.rule_name) {
    ruleBadge.hidden = false;
    ruleBadge.textContent = 'Matched rule: ' + f.rule_name;
    ruleBadge.title = f.rule_reason ? 'Why: ' + f.rule_reason : '';
  } else {
    ruleBadge.hidden = true;
    ruleBadge.textContent = '';
    ruleBadge.title = '';
  }
  $('tagInput').value = '';
  $('filenameInput').value = f.name;
  $('summaryInput').value = f.summary || '';
  const ys = [...new Set([...availableYears, f.year])].sort().reverse();
  $('yearInput').innerHTML = ys.map(y => '<option value="' + y + '">' + y + '</option>').join('');
  $('yearInput').value = f.year;
  $('yearInput').disabled = !!f.is_duplicate;
  $('yearInput').title = f.is_duplicate ? 'Duplicate copies are stored together and are not organized by year. Edit the original document to move it.' : '';
  const categories = [...new Set([...availableCategories, f.category].filter(Boolean))];
  $('categoryInput').replaceChildren(new Option('None', ''), ...categories.map(c => new Option(c, c)));
  $('categoryInput').value = f.category || '';
  renderDocumentTags(f.document_tags || []);
  renderQuickTags(f);
  $('editorStatus').textContent = ['queued', 'running'].includes(f.normal_scan?.state) ? 'LLM extraction is running…' : f.normal_scan?.state === 'error' ? f.normal_scan.error : '';
  if (load) loadFrame();
  loadMetadata(f.id);
  markActiveFile();
  if (updateUrl) syncUrl(true);
}

async function saveDetails() {
  if (!state.selected) return;
  const r = await fetch('/api/file/' + encodeURIComponent(state.selected.id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: $('documentTitle').textContent.trim(), summary: $('summaryInput').value, year: $('yearInput').value, filename: $('filenameInput').value }) });
  $('editorStatus').textContent = r.ok ? 'Saved.' : 'Could not save details.';
  if (r.ok) refresh();
}

async function moveDocumentYear() {
  if (!state.selected) return;
  const r = await fetch('/api/file/' + encodeURIComponent(state.selected.id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ year: $('yearInput').value }) });
  $('editorStatus').textContent = r.ok ? 'Moved to ' + $('yearInput').value + '.' : 'Could not move this document.';
  if (r.ok) await refresh();
}

async function fullScan() {
  if (!state.selected) return;
  const r = await fetch('/api/file/' + encodeURIComponent(state.selected.id) + '/full-scan', { method: 'POST' });
  $('editorStatus').textContent = r.ok ? 'Full OCR scan started.' : 'Could not start the full scan.';
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function rerunPipeline() {
  if (!state.selected) return;
  const id = state.selected.id, button = $('runLlm');
  button.disabled = true;
  const r = await fetch('/api/file/' + encodeURIComponent(id) + '/rerun-pipeline', { method: 'POST' });
  if (!r.ok) { button.disabled = false; $('editorStatus').textContent = 'Could not start the extraction.'; return }
  $('editorStatus').textContent = 'LLM extraction queued…';
  for (let attempt = 0; attempt < 120; attempt++) {
    await delay(1000);
    const details = await fetch('/api/file/' + encodeURIComponent(id) + '/details').then(response => response.ok ? response.json() : null);
    const job = details?.normal_scan || {};
    if (['queued', 'running'].includes(job.state)) { $('editorStatus').textContent = 'LLM extraction is running…'; continue }
    button.disabled = false;
    if (job.state === 'complete') { await refresh(); $('editorStatus').textContent = 'Extracted fields and archive filename updated; custom tags kept.'; return }
    $('editorStatus').textContent = job.error || 'LLM extraction did not complete.';
    return;
  }
  button.disabled = false;
  $('editorStatus').textContent = 'LLM extraction is still running; refresh shortly.';
}

async function ignoreTag(tag) {
  await fetch('/api/tags/' + encodeURIComponent(tag) + '/ignore', { method: 'POST' });
  $('editorStatus').textContent = 'Tag ignored everywhere.';
  refresh();
}

// Renaming a tag to a canonical value merges it into that tag everywhere (e.g. two spellings can both become one tag).
async function renameTag(tag) {
  const canonical = prompt('Rename "' + tag + '" to (this renames/merges it everywhere):', tag);
  if (!canonical || !canonical.trim() || canonical.trim() === tag) return;
  const target = canonical.trim();
  const r = await fetch('/api/tags/' + encodeURIComponent(tag) + '/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canonical: target }) });
  if (r.ok) {
    // Keep an active filter on this tag pointed at its new name instead of the now-renamed value.
    if (state.tags.has(tag)) { state.tags.delete(tag); state.tags.add(target); syncUrl(true) }
    $('editorStatus').textContent = 'Tag renamed everywhere.';
    refresh();
  } else {
    $('editorStatus').textContent = 'Could not rename tag.';
  }
}

function filterByDocumentTag(tag) {
  state.tags.add(tag);
  $('tagSearch').value = '';
  syncUrl(true);
  refresh();
}

async function addDocumentTag() {
  if (!state.selected) return;
  const tag = $('tagInput').value.trim();
  if (!tag) return;
  const r = await fetch('/api/file/' + encodeURIComponent(state.selected.id) + '/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag }) });
  if (r.ok) { $('tagInput').value = ''; $('editorStatus').textContent = 'Tag added.'; refresh() }
  else $('editorStatus').textContent = 'Could not add tag.';
}

async function removeDocumentTag(tag, kind) {
  if (!state.selected) return;
  const r = await fetch('/api/file/' + encodeURIComponent(state.selected.id) + '/tags/' + encodeURIComponent(tag) + '?kind=' + encodeURIComponent(kind), { method: 'DELETE' });
  if (r.ok) { $('editorStatus').textContent = 'Tag removed from this document.'; refresh() }
  else $('editorStatus').textContent = 'Could not remove tag.';
}

async function loadMetadata(id) {
  const r = await fetch('/api/file/' + encodeURIComponent(id) + '/details');
  if (!r.ok || state.selected?.id !== id) return;
  const d = await r.json();
  $('ocrText').value = d.ocr_text || '';
  const values = $('metaValues');
  values.innerHTML = '';
  if (d.full_path) { const path = document.createElement('span'); path.className = 'full-path'; path.textContent = 'Path: ' + d.full_path; values.append(path) }
  if (d.rule_name) {
    const chip = document.createElement('span');
    chip.className = 'rule-chip';
    chip.textContent = 'Matched rule: ' + d.rule_name + (d.rule_reason ? ' — ' + d.rule_reason : '');
    values.append(chip);
  }
  Object.entries(d.metadata || {}).forEach(([key, value]) => { const chip = document.createElement('span'); chip.textContent = key + ': ' + value; values.append(chip) });
}

async function saveOcr() {
  if (!state.selected) return;
  const r = await fetch('/api/file/' + encodeURIComponent(state.selected.id) + '/details', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ocr_text: $('ocrText').value }) });
  $('editorStatus').textContent = r.ok ? 'OCR text saved.' : 'Could not save OCR text.';
}

async function runOcr() {
  if (!state.selected) return;
  const r = await fetch('/api/file/' + encodeURIComponent(state.selected.id) + '/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all_pages: $('allPages').checked }) });
  $('editorStatus').textContent = r.ok ? 'OCR started.' : 'Could not start OCR.';
  if (r.ok) setTimeout(() => { refresh(); loadMetadata(state.selected.id) }, 1000);
}

// Duplicate cleanup: badge click loads every copy of the group into a grid preview.
async function openDuplicates(f) {
  const r = await fetch('/api/file/' + encodeURIComponent(f.id) + '/duplicates');
  if (!r.ok) return;
  const d = await r.json();
  state.selected = f;
  state.requestedDocument = '';
  if (!state.preview) setPreview(true, false);
  syncUrl(true);
  renderDuplicatesGrid(d.documents || []);
}

function renderDuplicatesGrid(list) {
  $('detailsEditor').hidden = true;
  $('editorActions').hidden = true;
  $('duplicatesView').classList.add('open');
  $('frame').removeAttribute('src');
  $('documentTitle').textContent = 'Duplicate documents (' + list.length + ')';
  $('documentMeta').textContent = 'Review each copy and remove the ones you no longer need.';
  markActiveFile();
  const grid = $('duplicatesGrid');
  grid.innerHTML = '';
  list.forEach(f => {
    const cell = document.createElement('div');
    cell.className = 'dupe-cell';
    const remove = document.createElement('button');
    remove.className = 'dupe-remove';
    remove.textContent = '🗑';
    remove.title = 'Remove this document';
    remove.setAttribute('aria-label', 'Remove this document');
    remove.onclick = () => removeDuplicate(f.id, list);
    const frame = document.createElement('iframe');
    frame.title = f.name;
    frame.src = f.url;
    const name = document.createElement('div');
    name.className = 'dupe-name';
    name.textContent = f.name + (f.is_duplicate ? '' : ' (original)');
    cell.append(remove, frame, name);
    grid.append(cell);
  });
}

function closeDuplicates(reset = true) {
  $('duplicatesView').classList.remove('open');
  $('duplicatesGrid').innerHTML = '';
  if (reset) clearSelection(true);
}

async function removeDuplicate(id, list) {
  if (!confirm('Remove this document permanently?')) return;
  const r = await fetch('/api/file/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!r.ok) { alert('Could not remove this document.'); return }
  await refresh();
  const sibling = list.find(f => f.id !== id);
  if (!sibling) { closeDuplicates(false); return }
  const check = await fetch('/api/file/' + encodeURIComponent(sibling.id) + '/duplicates');
  const d = check.ok ? await check.json() : { documents: [] };
  if ((d.documents || []).length > 1) renderDuplicatesGrid(d.documents);
  else closeDuplicates(false);
}

async function refreshStatus() {
  try {
    const s = await (await fetch('/api/status')).json(), p = s.pipeline;
    $('ollamaDot').className = 'dot ' + (s.ollama_connected ? 'ok' : 'warn');
    $('ollamaStatus').textContent = s.ollama_connected ? 'Ollama connected' : s.error || 'Ollama unavailable';
    $('ollamaDot').title = $('ollamaStatus').textContent;
    $('modelStatus').textContent = 'Model: ' + s.model;
    const rescan = s.rescan || {};
    const rescanActive = ['queued', 'running'].includes(rescan.state);
    const rescanProgress = rescanActive ? ' · re-scanning ' + rescan.current + '/' + rescan.total : '';
    const pauseState = p.paused ? (p.processing || rescan.processing ? ' · finishing current file' : ' · paused') : '';
    $('pipelineCount').textContent = 'Pipeline · ' + p.waiting_count + ' waiting' + pauseState + (!p.paused && p.processing ? ' · processing ' + p.processing : '') + rescanProgress;
    $('pausePipeline').textContent = p.paused ? 'Resume pipeline' : 'Pause pipeline';
    $('stopScan').hidden = !rescanActive;
    $('ocrStatus').textContent = 'OCR ' + s.ocr_language + ': ' + (s.ocr_available ? 'available' : 'missing');
    const entries = p.waiting.map(x => '<li>' + x.name + ' · ' + Math.ceil(x.size / 1024) + ' KB · ' + x.state + '</li>');
    if (rescanActive) {
      const rescanEntries = (rescan.queue || []).slice(rescan.current + (rescan.processing ? 1 : 0), rescan.current + 31).map(name => '<li>' + name + ' · queued for quick OCR and classification</li>');
      rescanEntries.unshift('<li>' + (p.paused && !rescan.processing ? 'Re-scan paused' : 'Re-scanning ' + (rescan.processing || 'documents')) + ' · ' + rescan.current + '/' + rescan.total + ' · quick OCR and classification</li>');
      entries.unshift(...rescanEntries);
    }
    $('pipelineList').innerHTML = entries.length ? entries.join('') : '<li>No PDFs waiting in the inbox.</li>';
    const unsupported = p.unsupported || [];
    $('pipelineError').textContent = rescan.error || p.last_error || (unsupported.length ? 'Unsupported files left in the incoming folder: ' + unsupported.slice(0, 5).join(', ') + (unsupported.length > 5 ? ' …' : '') : '');
  } catch {
    $('ollamaStatus').textContent = 'Status unavailable';
  }
}

function showSettingsTab(name, updateUrl = true) {
  activeSettingsTab = name;
  document.querySelectorAll('.settings-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === name));
  document.querySelectorAll('.settings-pane').forEach(pane => pane.hidden = pane.dataset.pane !== name);
  if (updateUrl && $('settingsDialog').open) syncUrl(true);
}

document.querySelectorAll('[data-theme-choice]').forEach(card => card.onclick = () => applyTheme(card.dataset.themeChoice));

$('addRuleButton').onclick = addRule;

function updateScheduleFields() {
  const daily = $('scheduleMode').value === 'daily';
  $('intervalSchedule').hidden = daily;
  $('dailySchedule').hidden = !daily;
}

const GENERAL_FIELDS = { generalIncoming: 'incoming_dir', generalArchive: 'archive_dir', generalError: 'error_dir', generalDuplicate: 'duplicate_dir', generalTrash: 'trash_dir', generalOcrLang: 'ocr_lang', generalAiMode: 'ai_mode', generalOllamaUrl: 'ollama_url', generalAiModel: 'ai_model' };

let ruleCategories = [];

function createRuleRow(rule) {
  const row = document.createElement('div');
  row.className = 'rule-card';
  row.dataset.ruleId = rule.id || '';

  const head = document.createElement('div');
  head.className = 'rule-card-head';
  const name = document.createElement('input');
  name.className = 'rule-name';
  name.placeholder = 'Rule name';
  name.value = rule.name || '';
  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'rule-enabled';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.checked = rule.enabled !== false;
  enabledLabel.append(enabled, document.createTextNode(' Enabled'));
  const up = document.createElement('button');
  up.type = 'button'; up.className = 'icon-button rule-up'; up.textContent = '↑'; up.title = 'Move up'; up.setAttribute('aria-label', 'Move rule up');
  up.onclick = () => { const prev = row.previousElementSibling; if (prev) row.parentElement.insertBefore(row, prev) };
  const down = document.createElement('button');
  down.type = 'button'; down.className = 'icon-button rule-down'; down.textContent = '↓'; down.title = 'Move down'; down.setAttribute('aria-label', 'Move rule down');
  down.onclick = () => { const next = row.nextElementSibling; if (next) row.parentElement.insertBefore(next, row) };
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'icon-button rule-remove'; remove.textContent = '✕'; remove.title = 'Remove rule'; remove.setAttribute('aria-label', 'Remove rule');
  remove.onclick = () => row.remove();
  const test = document.createElement('button');
  test.type = 'button'; test.className = 'action rule-test'; test.textContent = 'Test';
  test.onclick = () => testRule(row);
  head.append(name, enabledLabel, up, down, test, remove);

  const grid = document.createElement('div');
  grid.className = 'rule-card-grid';
  const field = (labelText, input) => {
    const label = document.createElement('label');
    label.className = 'editor';
    const span = document.createElement('span');
    span.textContent = labelText;
    label.append(span, input);
    return label;
  };
  const extension = document.createElement('input');
  extension.className = 'rule-extension'; extension.placeholder = 'csv'; extension.value = rule.conditions?.extension || '';
  const nameContains = document.createElement('input');
  nameContains.className = 'rule-name-contains'; nameContains.placeholder = 'kontoauszug'; nameContains.value = rule.conditions?.name_contains || '';
  const contentContains = document.createElement('input');
  contentContains.className = 'rule-content-contains'; contentContains.placeholder = 'IBAN'; contentContains.value = rule.conditions?.content_contains || '';
  const contentChars = document.createElement('input');
  contentChars.className = 'rule-content-chars'; contentChars.type = 'number'; contentChars.min = '1'; contentChars.max = '5000'; contentChars.value = rule.content_chars || 500;
  const category = document.createElement('select');
  category.className = 'rule-category';
  category.innerHTML = '<option value="">Don\'t change</option>' + ruleCategories.map(value => '<option value="' + value + '">' + value + '</option>').join('');
  category.value = rule.category || '';
  const tags = document.createElement('input');
  tags.className = 'rule-tags'; tags.placeholder = 'bank, kontoauszug'; tags.value = (rule.tags || []).join(', ');
  grid.append(
    field('Extension', extension),
    field('Filename contains', nameContains),
    field('First N characters contain', contentContains),
    field('Characters to check', contentChars),
    field('Set category', category),
    field('Add tags', tags),
  );

  row.append(head, grid);
  const results = document.createElement('div');
  results.className = 'rule-test-results';
  results.hidden = true;
  row.append(results);
  return row;
}

function renderRules(rules, categories) {
  ruleCategories = categories || [];
  const list = $('ruleList');
  list.innerHTML = '';
  (rules || []).forEach(rule => list.append(createRuleRow(rule)));
}

function addRule() {
  $('ruleList').append(createRuleRow({ name: '', enabled: true, conditions: {}, content_chars: 500, category: '', tags: [] }));
}

function collectRules() {
  return [...$('ruleList').querySelectorAll('.rule-card')].map(ruleFromRow);
}

function ruleFromRow(row) {
  return {
    id: row.dataset.ruleId || undefined,
    name: row.querySelector('.rule-name').value.trim(),
    enabled: row.querySelector('.rule-enabled input').checked,
    conditions: {
      extension: row.querySelector('.rule-extension').value.trim(),
      name_contains: row.querySelector('.rule-name-contains').value.trim(),
      content_contains: row.querySelector('.rule-content-contains').value.trim(),
    },
    content_chars: Number(row.querySelector('.rule-content-chars').value) || 500,
    category: row.querySelector('.rule-category').value,
    tags: row.querySelector('.rule-tags').value.split(/[\s,]+/).map(value => value.trim()).filter(Boolean),
  };
}

async function testRule(row) {
  const button = row.querySelector('.rule-test');
  const results = row.querySelector('.rule-test-results');
  button.disabled = true;
  results.hidden = false;
  results.innerHTML = '<div class="meta">Testing against indexed documents…</div>';
  try {
    const r = await fetch('/api/rules/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rule: ruleFromRow(row) }) });
    const d = r.ok ? await r.json() : { matches: [], truncated: false };
    results.innerHTML = '';
    if (!d.matches.length) {
      results.innerHTML = '<div class="meta">No matching documents yet.</div>';
    } else {
      const list = document.createElement('ul');
      list.className = 'rule-test-list';
      d.matches.forEach(match => {
        const item = document.createElement('li');
        const title = document.createElement('span');
        title.className = 'rule-test-name';
        title.textContent = [match.name, match.date, match.category].filter(Boolean).join(' · ');
        const reason = document.createElement('span');
        reason.className = 'rule-test-reason';
        reason.textContent = match.reasons.join('; ');
        item.append(title, reason);
        list.append(item);
      });
      results.append(list);
      if (d.truncated) {
        const more = document.createElement('div');
        more.className = 'meta';
        more.textContent = 'Showing the first ' + d.matches.length + ' matches; more may exist.';
        results.append(more);
      }
    }
  } catch {
    results.innerHTML = '<div class="meta">Could not test this rule.</div>';
  } finally {
    button.disabled = false;
  }
}

function populateGeneralSettings(general, locked) {
  Object.entries(GENERAL_FIELDS).forEach(([id, key]) => {
    const field = $(id);
    field.value = general[key] ?? '';
    field.disabled = !!locked[key];
    field.title = locked[key] ? 'Set via the ' + key.toUpperCase() + ' environment variable' : '';
  });
  $('generalRecursive').checked = !!general.recursive_scan;
  $('generalRecursive').disabled = !!locked.recursive_scan;
}

async function openSettings(updateUrl = true) {
  const s = await (await fetch('/api/settings')).json();
  $('ignoredTags').value = s.ignored_tags.join(', ');
  $('categoriesInput').value = (s.categories || []).join('\n');
  renderRules(s.rules || [], s.categories || []);
  $('externalApiPort').value = s.external_api?.port ?? '';
  $('externalApiTokenStatus').value = s.external_api?.token_configured ? 'Configured via EXTERNAL_API_TOKEN' : 'Not configured; external API is disabled';
  $('smbShareUrl').value = s.external_api?.smb_share_url || '';
  tagAliases = s.tag_aliases || {};
  $('tagAliasSearch').value = '';
  renderTagAliases();
  populateGeneralSettings(s.general || {}, s.general_locked || {});
  $('metadataPrompt').value = s.prompts.metadata;
  $('summaryPrompt').value = s.prompts.summary;
  $('scheduleMode').value = s.schedule.mode;
  $('intervalMinutes').value = s.schedule.interval_minutes;
  $('dailyTimes').value = s.schedule.daily_times.join(', ');
  updateScheduleFields();
  applyTheme(currentTheme());
  showSettingsTab(activeSettingsTab, false);
  if (!$('settingsDialog').open) $('settingsDialog').showModal();
  if (updateUrl) syncUrl(true);
}

async function saveSettings(event) {
  event.preventDefault();
  const payload = {
    ignored_tags: $('ignoredTags').value.split(/[\s,]+/).filter(Boolean),
    categories: $('categoriesInput').value.split(/[\n,]+/).map(value => value.trim()).filter(Boolean),
    rules: collectRules(),
    external_api: { smb_share_url: $('smbShareUrl').value.trim() },
    prompts: { metadata: $('metadataPrompt').value, summary: $('summaryPrompt').value },
    schedule: { mode: $('scheduleMode').value, interval_minutes: $('intervalMinutes').value, daily_times: $('dailyTimes').value.split(/[\s,]+/).filter(Boolean) },
    general: { ...Object.fromEntries(Object.entries(GENERAL_FIELDS).map(([id, key]) => [key, $(id).value.trim()])), recursive_scan: $('generalRecursive').checked }
  };
  const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (r.ok) { $('settingsDialog').close(); refresh(); refreshStatus() }
}

// First run: nudge the user to set up storage folders before they start scanning documents.
async function checkFirstRunSetup() {
  if ($('settingsDialog').open) return;
  const s = await (await fetch('/api/settings')).json();
  if (!s.general_configured) { await openSettings(true); showSettingsTab('general') }
}

// Canonical tags: shows every rename/merge as "original -> target" so the user can undo one if needed.
function renderTagAliases() {
  const needle = $('tagAliasSearch').value.trim().toLowerCase();
  const entries = Object.entries(tagAliases).filter(([from, to]) => !needle || from.includes(needle) || to.includes(needle)).sort(([a], [b]) => a.localeCompare(b));
  const list = $('tagAliasList');
  list.innerHTML = '';
  if (!entries.length) { list.innerHTML = '<div class="empty">No renamed tags yet.</div>'; return }
  entries.forEach(([from, to]) => {
    const row = document.createElement('div');
    row.className = 'tag-alias-row';
    const fromEl = document.createElement('span');
    fromEl.className = 'tag-alias-from';
    fromEl.textContent = from;
    const arrow = document.createElement('span');
    arrow.className = 'tag-alias-arrow';
    arrow.textContent = '→';
    const toEl = document.createElement('span');
    toEl.className = 'tag-alias-to';
    toEl.textContent = to;
    const remove = document.createElement('button');
    remove.className = 'tag-alias-remove';
    remove.textContent = '×';
    remove.title = 'Undo this rename';
    remove.setAttribute('aria-label', 'Undo renaming ' + from + ' to ' + to);
    remove.onclick = () => removeTagAlias(from);
    row.append(fromEl, arrow, toEl, remove);
    list.append(row);
  });
}

async function removeTagAlias(tag) {
  const r = await fetch('/api/tags/' + encodeURIComponent(tag) + '/alias', { method: 'DELETE' });
  if (!r.ok) return;
  const d = await r.json();
  tagAliases = d.tag_aliases || {};
  renderTagAliases();
  refresh();
}

function togglePipeline() {
  const open = $('pipeline').classList.toggle('open'), b = $('pipelineToggle');
  root.classList.toggle('pipeline-open', open);
  b.title = open ? 'Collapse pipeline (Ctrl+Space)' : 'Expand pipeline (Ctrl+Space)';
  b.setAttribute('aria-label', open ? 'Collapse pipeline' : 'Expand pipeline');
}

$('sidebarToggle').onclick = () => setSidebar(root.classList.contains('sidebar-closed'));
$('sidebarScrim').onclick = () => setSidebar(false);
$('previewToggle').onclick = () => {
  if (state.preview) { setPreview(false); return }
  const f = state.selected || files.find(x => !(x.is_duplicate && files.some(o => o.id === x.duplicate_of)));
  if (f) openFile(f);
};
$('closePreview').onclick = () => setPreview(false);
$('pipelineSummary').onclick = togglePipeline;
$('query').oninput = e => { state.q = e.target.value.trim(); syncUrl(); clearTimeout(timer); timer = setTimeout(refresh, 250) };
$('tagSearch').oninput = () => renderTags(visibleTags);
$('tagAliasSearch').oninput = renderTagAliases;
$('tagInput').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addDocumentTag() } };
$('documentTitle').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } };
$('duplicates').onchange = e => { state.duplicates = e.target.checked; $('cleanDuplicatesButton').hidden = !state.duplicates; syncUrl(true); refresh() };
$('resetFilters').onclick = () => {
  state.q = ''; state.years = new Set(); state.categories = new Set(); state.types = new Set(); state.tags = new Set(); state.duplicates = false;
  $('query').value = ''; $('duplicates').checked = false; $('tagSearch').value = ''; $('cleanDuplicatesButton').hidden = true;
  syncUrl(true);
  refresh();
};
$('cleanDuplicatesButton').onclick = async () => {
  if (!confirm('Remove every duplicate copy and keep only one original of each document? This cannot be undone.')) return;
  const r = await fetch('/api/duplicates/clean', { method: 'POST' });
  if (!r.ok) { alert('Could not clean duplicates.'); return }
  await refresh();
};
$('saveDetails').onclick = saveDetails;
$('yearInput').onchange = moveDocumentYear;
$('categoryInput').onchange = moveDocumentCategory;
$('clearMulti').onclick = clearMulti;
$('runOcr').onclick = runOcr;
$('runLlm').onclick = rerunPipeline;
$('saveOcr').onclick = saveOcr;
$('closeDuplicatesButton').onclick = () => closeDuplicates(true);
$('pipelineToggle').onclick = togglePipeline;
$('scanNow').onclick = async () => {
  if (!confirm('Re-scan every indexed document? This runs quick OCR and LLM classification, then corrects generated archive filenames.')) return;
  const button = $('scanNow');
  button.disabled = true;
  const r = await fetch('/api/rescan', { method: 'POST' });
  button.disabled = false;
  if (!r.ok) { alert('Could not start the re-scan.'); return }
  if (!$('pipeline').classList.contains('open')) togglePipeline();
  refreshStatus();
};
$('stopScan').onclick = async () => {
  const button = $('stopScan');
  button.disabled = true;
  const r = await fetch('/api/rescan/stop', { method: 'POST' });
  if (!r.ok) { button.disabled = false; alert('Could not stop the re-scan.'); }
  refreshStatus();
};
$('pausePipeline').onclick = async () => { await fetch('/api/pipeline/pause', { method: 'POST' }); refreshStatus() };
$('settingsButton').onclick = () => openSettings(true);
$('cancelSettings').onclick = () => $('settingsDialog').close();
$('settingsDialog').addEventListener('close', () => syncUrl());
$('settingsForm').onsubmit = saveSettings;
$('scheduleMode').onchange = updateScheduleFields;
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || $('settingsDialog').open) return;
  const key = event.key.toLowerCase();
  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    if (key === 't' && state.selected && !$('detailsEditor').hidden) {
      event.preventDefault();
      $('tagInput').focus();
    } else if (key === 'd' && event.shiftKey) {
      event.preventDefault();
      $('duplicates').click();
    } else if (key === 'd') {
      event.preventDefault();
      $('detailsSection').open = !$('detailsSection').open;
    } else if (key === 'm') {
      event.preventDefault();
      $('metaSection').open = !$('metaSection').open;
    } else if (key === 'q') {
      event.preventDefault();
      $('query').focus();
    } else if (key === 'f') {
      event.preventDefault();
      if (root.classList.contains('sidebar-closed')) setSidebar(true);
      $('tagSearch').focus();
    } else if (key === 'y' || key === 'w') {
      event.preventDefault();
      if (root.classList.contains('sidebar-closed')) setSidebar(true);
      $(key === 'y' ? 'years' : 'categories').querySelector('.facet-item')?.focus();
    } else if (key === 'b') {
      event.preventDefault();
      $('sidebarToggle').click();
    } else if (key === 'e') {
      event.preventDefault();
      $('previewToggle').click();
    } else if (key === 's' && event.shiftKey) {
      event.preventDefault();
      if (!$('stopScan').hidden) $('stopScan').click();
    } else if (key === 's') {
      event.preventDefault();
      $('settingsButton').click();
    } else if (key === 'r') {
      event.preventDefault();
      $('scanNow').click();
    } else if (key === 'p') {
      event.preventDefault();
      $('pausePipeline').click();
    } else if (key === ' ') {
      event.preventDefault();
      togglePipeline();
    }
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const typing = event.target.closest('input, textarea, select, [contenteditable="true"]');
  if (key === 'escape' && !typing) {
    if (multi.size) { clearMulti(); return }
    if (isNarrow() && !root.classList.contains('sidebar-closed')) setSidebar(false);
    else if (state.preview) setPreview(false);
    return;
  }
  if (key === 'enter' && !typing && !state.preview && state.selected && !event.target.closest('button, a, [role="button"]')) {
    event.preventDefault();
    openFile(state.selected);
    return;
  }
  if (!['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key) || typing) return;
  if (event.target.closest('button') && !event.target.closest('#files')) return;
  if (state.preview && ['arrowleft', 'arrowright'].includes(key)) return;
  event.preventDefault();
  selectAdjacentFile(key);
});
document.querySelectorAll('.settings-tab').forEach(button => button.onclick = () => showSettingsTab(button.dataset.tab));

// Drag the divider between the list and the preview; width is remembered per browser.
(() => {
  const handle = $('splitter'), min = 260, max = 640;
  const saved = Number(store.get(LIST_WIDTH_KEY));
  if (saved >= min && saved <= max) root.style.setProperty('--list-w', saved + 'px');
  let startX = 0, startWidth = 0;
  handle.addEventListener('pointerdown', event => { startX = event.clientX; startWidth = $('files').getBoundingClientRect().width; handle.setPointerCapture(event.pointerId); handle.classList.add('dragging'); event.preventDefault() });
  handle.addEventListener('pointermove', event => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    root.style.setProperty('--list-w', Math.max(min, Math.min(max, startWidth + event.clientX - startX)) + 'px');
  });
  handle.addEventListener('pointerup', event => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    handle.releasePointerCapture(event.pointerId);
    handle.classList.remove('dragging');
    store.set(LIST_WIDTH_KEY, String(Math.round($('files').getBoundingClientRect().width)));
  });
  handle.addEventListener('dblclick', () => { root.style.removeProperty('--list-w'); store.set(LIST_WIDTH_KEY, '') });
})();

$('sidebarToggle').setAttribute('aria-expanded', String(!root.classList.contains('sidebar-closed')));
restoreUrlState();
refresh();
refreshStatus();
checkFirstRunSetup();
window.addEventListener('popstate', () => { restoreUrlState(); refresh() });
setInterval(() => { if (!dragging) refresh(); refreshStatus() }, 15000);
