const state = { q: '', years: new Set(), categories: new Set(), types: new Set(), tags: new Set(), duplicates: false, demo: false, selected: null, requestedDocument: '', preview: false };
let files = [], timer, availableYears = [], availableCategories = [], visibleTags = [], favoriteTags = [], recentTags = [], tagAliases = {}, activeSettingsTab = 'storage';
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
  const src = f.preview_url || f.url;
  if ($('frame').getAttribute('src') !== src) $('frame').src = src;
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
  activeSettingsTab = settingsTabName(p.get('settings-tab'));
  if (settings && !$('settingsDialog').open) openSettings(false);
  if (!settings && $('settingsDialog').open) $('settingsDialog').close();
}

const PAGE_SIZE = 60;
let refreshRequest = 0, refreshController, refreshBusy = false;
const browse = { key: '', revision: '', etag: '', pagination: null, loading: false };
function browseParams() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.years.size) p.set('years', [...state.years].join(','));
  if (state.categories.size) p.set('categories', [...state.categories].join(','));
  if (state.types.size) p.set('types', [...state.types].join(','));
  if (state.tags.size) p.set('tokens', [...state.tags].join(','));
  if (state.duplicates) p.set('duplicates', '1');
  if (state.demo) p.set('demo', 'true');
  p.set('limit', PAGE_SIZE);
  return p;
}
async function refresh({ background = false } = {}) {
  if (background && (refreshBusy || browse.loading || document.hidden)) return;
  const p = browseParams(), filterKey = p.toString();
  const sameFilters = filterKey === browse.key;
  const targetCount = sameFilters ? Math.max(PAGE_SIZE, files.length) : PAGE_SIZE;
  const selectedId = state.selected?.id || state.requestedDocument;
  if (selectedId) p.set('document', selectedId);
  const request = ++refreshRequest;
  refreshController?.abort();
  refreshController = new AbortController();
  const signal = refreshController.signal;
  refreshBusy = true;
  browse.loading = false;
  updateLoadMore();
  try {
    const headers = background && sameFilters && browse.etag ? { 'If-None-Match': browse.etag } : {};
    const r = await fetch('/api/index?' + p, { signal, headers });
    if (r.status === 304 || !r.ok || request !== refreshRequest) return;
    const d = await r.json();
    if (request !== refreshRequest) return;
    const list = [...d.files];
    let pagination = d.pagination;
    // Keep the user's loaded range when real archive changes arrive in the background.
    while (pagination.next_offset != null && list.length < targetCount) {
      const next = new URLSearchParams(p);
      next.set('offset', pagination.next_offset);
      next.set('revision', d.revision);
      const pageResponse = await fetch('/api/index?' + next, { signal });
      if (!pageResponse.ok) break;
      const page = await pageResponse.json();
      if (request !== refreshRequest) return;
      list.push(...page.files);
      pagination = page.pagination;
    }
    browse.key = filterKey;
    browse.revision = d.revision;
    browse.etag = r.headers.get('ETag');
    browse.pagination = pagination;
    availableYears = (d.years || []).map(i => i.value);
    availableCategories = (d.categories || []).map(i => i.value);
    favoriteTags = d.favorite_tags || [];
    recentTags = d.recent_tags || [];
    renderFacet('years', d.years || [], state.years, 'All years');
    renderFacet('categories', d.categories || [], state.categories, 'All categories', value => value, (ids, category) => bulkUpdate(ids, { category }, category));
    renderFacet('types', d.types || [], state.types, 'All', value => value.toUpperCase());
    renderTags(d.tags || []);
    $('duplicateCount').textContent = d.duplicates_count || 0;
    renderFiles(list);
    if (!sameFilters) $('files').scrollTop = 0;
    if (selectedId && $('duplicatesView').classList.contains('open') && !state.requestedDocument) return;
    if (selectedId) {
      const f = files.find(x => x.id === selectedId) || (d.selected_file?.id === selectedId ? d.selected_file : null);
      if (f) {
        const load = !!state.requestedDocument;
        state.requestedDocument = '';
        selectFile(f, load, false);
      } else if (!selectFirstFile()) {
        clearSelection(false);
        syncUrl();
      }
    } else if (!selectFirstFile()) syncUrl();
  } catch (error) {
    if (error.name !== 'AbortError') showToast('Could not load documents. Try again.');
  } finally {
    if (request === refreshRequest) { refreshBusy = false; updateLoadMore() }
  }
}

function updateLoadMore() {
  let button = $('loadMore');
  if (!button) {
    button = document.createElement('button');
    button.id = 'loadMore';
    button.type = 'button';
    button.className = 'load-more';
    button.onclick = () => loadMore();
    $('files').append(button);
  }
  button.hidden = browse.pagination?.next_offset == null;
  button.disabled = refreshBusy || browse.loading;
  button.textContent = browse.loading ? 'Loading…' : 'Load more documents';
  button.setAttribute('aria-label', button.textContent);
}
let moreRequest;
function loadMore() {
  // Scrolling and keyboard navigation can request the same batch at once.
  if (moreRequest?.generation === refreshRequest) return moreRequest.promise;
  const pending = { generation: refreshRequest };
  pending.promise = fetchMore().finally(() => { if (moreRequest === pending) moreRequest = null });
  moreRequest = pending;
  return pending.promise;
}
async function fetchMore() {
  if (refreshBusy || browse.loading || browse.pagination?.next_offset == null || browse.key !== browseParams().toString()) return;
  const request = refreshRequest;
  browse.loading = true;
  updateLoadMore();
  try {
    const p = browseParams();
    p.set('offset', browse.pagination.next_offset);
    p.set('revision', browse.revision);
    const response = await fetch('/api/index?' + p, { signal: refreshController?.signal });
    if (request !== refreshRequest) return;
    if (response.status === 409) { await refresh(); return }
    if (!response.ok) throw new Error('Loading failed');
    const d = await response.json();
    if (request !== refreshRequest) return;
    browse.pagination = d.pagination;
    renderFiles(d.files, true);
  } catch (error) {
    if (error.name !== 'AbortError') showToast('Could not load more documents. Use Load more to retry.');
  } finally {
    if (request === refreshRequest) { browse.loading = false; updateLoadMore() }
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
  closeTagMenu();
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
    wrap.append(filter, tagMenuButton(i.value, 'sidebar'));
    e.append(wrap);
  });
  if (!e.children.length) e.innerHTML = '<div class="empty">No matching tags.</div>';
}

let tagMenuTrigger;
function tagMenuButton(tag, source, documentFile = null) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tag-menu-button' + (favoriteTags.includes(tag) ? ' favorite' : '');
  button.textContent = favoriteTags.includes(tag) ? '★' : '⋯';
  button.title = 'Actions for ' + tag;
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.dataset.tag = tag;
  button.onclick = event => { event.stopPropagation(); openTagMenu(tag, button, source, documentFile) };
  return button;
}
function closeTagMenu(restoreFocus = false) {
  const menu = $('tagActions');
  if (menu) menu.hidden = true;
  tagMenuTrigger?.setAttribute('aria-expanded', 'false');
  if (restoreFocus && tagMenuTrigger?.isConnected) tagMenuTrigger.focus({ preventScroll: true });
  tagMenuTrigger = null;
}
function openTagMenu(tag, trigger, source, documentFile) {
  if (tagMenuTrigger === trigger && !$('tagActions')?.hidden) { closeTagMenu(true); return }
  closeTagMenu();
  let menu = $('tagActions');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'tagActions';
    menu.className = 'tag-actions';
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
  }
  menu.replaceChildren();
  menu.setAttribute('aria-label', 'Actions for ' + tag);
  const action = (label, callback, danger = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    if (danger) button.className = 'danger';
    button.onclick = () => { closeTagMenu(true); callback() };
    menu.append(button);
  };
  const favorite = favoriteTags.includes(tag);
  action(favorite ? 'Remove from favorites' : 'Add to favorites', () => setFavoriteTag(tag, !favorite));
  action('Rename everywhere…', () => renameTag(tag));
  if (source === 'quick') {
    const assigned = documentFile?.document_tags?.find(entry => entry.value === tag);
    if (assigned) action('Remove from this document', () => removeDocumentTag(tag, 'all'));
    action('Remove from quick tags', () => removeQuickTag(tag), true);
  } else {
    action('Ignore inferred tag everywhere', () => ignoreTag(tag), true);
  }
  tagMenuTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  menu.hidden = false;
  const rect = trigger.getBoundingClientRect();
  const left = Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, rect.right - menu.offsetWidth));
  const top = rect.bottom + menu.offsetHeight + 8 < innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - menu.offsetHeight - 4);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.firstElementChild?.focus({ preventScroll: true });
}
async function removeQuickTag(tag) {
  const response = await fetch('/api/tags/' + encodeURIComponent(tag) + '/quick', { method: 'DELETE' });
  if (response.ok) { await refresh(); showToast('Removed from quick tags. Document tags are unchanged.') }
  else showToast('Could not remove this quick tag.');
}
document.addEventListener('click', event => { if (!event.target.closest('#tagActions, .tag-menu-button')) closeTagMenu() });
document.addEventListener('focusin', event => { if (tagMenuTrigger && !event.target.closest('#tagActions') && event.target !== tagMenuTrigger) closeTagMenu() });
document.addEventListener('scroll', () => closeTagMenu(), true);
document.addEventListener('keydown', event => {
  const menu = $('tagActions');
  if (!menu || menu.hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closeTagMenu(true); return }
  if (event.key === 'Tab') { closeTagMenu(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = [...menu.querySelectorAll('button')], current = items.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next].focus();
});

// Duplicate copies are grouped onto their original's list entry with a count badge instead of listed separately.
// f.duplicate_count comes from the server and is filter-independent, so it stays correct even when the
// original (or a sibling copy) is hidden by the current year/tag/search filters.
// Rendered as a thumbnail grid while the preview is closed and as a compact list next to the open preview.
let renderedSignature = '';
function renderFiles(list, append = false) {
  const e = $('files');
  files = append ? [...files, ...list] : list;
  const signature = JSON.stringify(files.map(f => [f.id, f.name, f.title, f.date, f.year, f.category, f.classification, f.summary, f.document_tags, f.duplicate_count, f.thumb_url]));
  const total = browse.pagination?.total ?? files.length;
  $('resultCount').textContent = total === 1 ? '1 document' : total + ' documents';
  if (!append && signature === renderedSignature && e.childElementCount) { markActiveFile(); return }
  renderedSignature = signature;
  if (!append) e.replaceChildren();
  if (!files.length) { e.innerHTML = '<div class="empty">No documents match these filters.</div>'; return }
  const groups = new Map([...e.querySelectorAll('.year-group')].map(group => [group.dataset.year, group]));
  const batches = new Map();
  list.forEach(f => {
    const year = f.year || 'unknown';
    let group = groups.get(year);
    if (!group) {
      group = document.createElement('section');
      group.className = 'year-group';
      group.dataset.year = year;
      const heading = document.createElement('h3');
      heading.innerHTML = '<span></span><span class="count"></span>';
      heading.firstChild.textContent = year;
      heading.lastChild.textContent = browse.pagination?.year_counts[year] ?? '';
      const items = document.createElement('div');
      items.className = 'year-items';
      group.append(heading, items);
      e.insertBefore(group, $('loadMore'));
      groups.set(year, group);
    }
    if (!batches.has(year)) batches.set(year, document.createDocumentFragment());
    batches.get(year).append(fileCard(f));
  });
  batches.forEach((fragment, year) => groups.get(year).querySelector('.year-items').append(fragment));
  updateLoadMore();
}

function fileCard(f) {
  const dupeCount = f.duplicate_count || 0;
  const b = document.createElement('div');
  b.setAttribute('role', 'button');
  b.tabIndex = 0;
  b.draggable = true;
  b.className = 'file' + (state.selected?.id === f.id ? ' active' : '') + (multi.has(f.id) ? ' multi' : '');
  b.dataset.fileId = f.id;
  b.innerHTML = '<div class="thumb"><span class="type-label"></span></div><div class="body"><div class="meta"><span class="card-category"></span><span class="card-date"></span></div><div class="title"></div><div class="summary"></div><div class="card-tags"></div></div>';
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
  b.querySelector('.title').textContent = f.title || f.name;
  b.title = (f.title || f.name) + '\nFile: ' + f.name;
  const category = b.querySelector('.card-category');
  category.textContent = (f.category || f.classification || '').replace(/-/g, ' ');
  category.hidden = !category.textContent;
  b.querySelector('.card-date').textContent = f.date || 'No date';
  const summary = b.querySelector('.summary');
  summary.textContent = f.summary || '';
  summary.hidden = !f.summary || f.summary.trim() === f.title;
  const tags = [...(f.document_tags || [])].sort((a, b) => (a.kind !== 'custom') - (b.kind !== 'custom'));
  const tagList = b.querySelector('.card-tags');
  tags.slice(0, 3).forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'card-tag' + (tag.kind === 'custom' ? ' custom' : '');
    chip.textContent = '#' + tag.value;
    tagList.append(chip);
  });
  if (tags.length > 3) {
    const more = document.createElement('span');
    more.className = 'card-tag-more';
    more.textContent = '+' + (tags.length - 3);
    more.title = tags.slice(3).map(tag => tag.value).join(', ');
    tagList.append(more);
  }
  tagList.hidden = !tags.length;
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
  if (r.ok) await refresh();
}

// Favorites first, then the most recently assigned tags; clicking one adds it to the open document (or the whole multi-selection).
function renderQuickTags(f) {
  closeTagMenu();
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
      const chip = document.createElement('span');
      chip.className = 'quick-tag-wrap';
      chip.append(b, tagMenuButton(tag, 'quick', f));
      group.append(chip);
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
async function selectAdjacentFile(key) {
  const cards = [...document.querySelectorAll('#files .file')];
  if (!cards.length) return;
  const current = cards.findIndex(card => card.dataset.fileId === state.selected?.id);
  const forward = ['arrowdown', 'arrowright'].includes(key);
  if (current === cards.length - 1 && forward && browse.pagination?.next_offset != null) {
    await loadMore();
    if (document.querySelectorAll('#files .file').length > cards.length) return selectAdjacentFile(key);
  }
  let next;
  if (current < 0) next = ['arrowup', 'arrowleft'].includes(key) ? cards.length - 1 : 0;
  else if (state.preview || key === 'arrowleft' || key === 'arrowright') next = Math.max(0, Math.min(cards.length - 1, current + (['arrowdown', 'arrowright'].includes(key) ? 1 : -1)));
  else {
    const from = cards[current].getBoundingClientRect(), down = key === 'arrowdown';
    const candidates = cards.map((card, index) => ({ index, rect: card.getBoundingClientRect() })).filter(({ rect }) => down ? rect.top > from.top + 4 : rect.top < from.top - 4);
    if (!candidates.length) {
      if (down && browse.pagination?.next_offset != null) {
        await loadMore();
        if (document.querySelectorAll('#files .file').length > cards.length) return selectAdjacentFile(key);
      }
      return;
    }
    const rowTop = down ? Math.min(...candidates.map(c => c.rect.top)) : Math.max(...candidates.map(c => c.rect.top));
    next = candidates.filter(c => Math.abs(c.rect.top - rowTop) < 4).sort((a, b) => Math.abs(a.rect.left - from.left) - Math.abs(b.rect.left - from.left))[0].index;
  }
  const f = files.find(x => x.id === cards[next].dataset.fileId);
  if (!f) return;
  if (state.preview && f.duplicate_count) openDuplicates(f);
  else selectFile(f);
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
      chip.dataset.tag = tag;
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
  const sameDocument = state.selected?.id === f.id;
  state.selected = f;
  state.requestedDocument = '';
  $('detailsEditor').hidden = false;
  $('editorActions').hidden = false;
  const isPdf = /\.(pdf|png|jpe?g|tiff?|bmp|webp|gif)$/i.test(f.name);  // formats the OCR button can read
  $('openOriginal').href = f.url;
  $('runOcr').hidden = !isPdf;
  $('allPages').closest('label').hidden = !isPdf;
  $('documentTitle').textContent = f.title || f.name;
  $('documentMeta').textContent = [f.date, (f.category || f.classification || '').replace(/-/g, ' '), f.pdf_author, f.type?.toUpperCase(), f.is_duplicate ? 'Duplicate content' : ''].filter(Boolean).join(' · ');
  $('documentMeta').title = 'File: ' + f.name;
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
  if (!sameDocument) { $('tagInput').value = ''; hideTagSuggestions() }
  $('filenameInput').value = f.name;
  $('titleInput').value = f.display_title || '';
  $('titleInput').placeholder = f.title || 'Give this document a useful name';
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
  const id = state.selected.id;
  const change = { display_title: $('titleInput').value, summary: $('summaryInput').value };
  if ($('filenameInput').value !== state.selected.name) change.filename = $('filenameInput').value;
  if ($('yearInput').value !== state.selected.year) change.year = $('yearInput').value;
  const r = await fetch('/api/file/' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) });
  if (r.ok) await refresh();
  if (state.selected?.id === id) $('editorStatus').textContent = r.ok ? 'Saved.' : 'Could not save details.';
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

// Tag input autocomplete: live suggestions from all archive tags, ↑/↓ to choose, Enter/Tab to apply, Esc to close.
const tagSuggest = { items: [], index: -1, request: 0, timer: 0 };

function hideTagSuggestions() {
  tagSuggest.items = []; tagSuggest.index = -1;
  $('tagSuggestions').hidden = true;
  $('tagInput').setAttribute('aria-expanded', 'false');
  $('tagInput').removeAttribute('aria-activedescendant');
}

function renderTagSuggestions() {
  const list = $('tagSuggestions'), typed = $('tagInput').value.trim().toLowerCase();
  list.innerHTML = '';
  if (!tagSuggest.items.length) { hideTagSuggestions(); return }
  tagSuggest.items.forEach((item, index) => {
    const li = document.createElement('li');
    li.id = 'tagSuggestion-' + index;
    li.role = 'option';
    li.className = 'tag-suggestion' + (index === tagSuggest.index ? ' active' : '');
    li.setAttribute('aria-selected', index === tagSuggest.index ? 'true' : 'false');
    const name = document.createElement('span');
    name.className = 'tag-suggestion-name';
    const at = typed ? item.value.toLowerCase().indexOf(typed) : -1;
    if (at >= 0) {
      const mark = document.createElement('mark');
      mark.textContent = item.value.slice(at, at + typed.length);
      name.append(item.value.slice(0, at), mark, item.value.slice(at + typed.length));
    } else name.textContent = item.value;
    if (item.isNew) name.prepend('Create ');
    li.append(name);
    if (!item.isNew) {
      const count = document.createElement('span');
      count.className = 'tag-suggestion-count';
      count.textContent = (item.favorite ? '★ ' : '') + item.count;
      li.append(count);
    }
    li.onmousedown = e => { e.preventDefault(); tagSuggest.index = index; applyTagSuggestion() };
    list.append(li);
  });
  list.hidden = false;
  $('tagInput').setAttribute('aria-expanded', 'true');
  if (tagSuggest.index >= 0) {
    $('tagInput').setAttribute('aria-activedescendant', 'tagSuggestion-' + tagSuggest.index);
    list.children[tagSuggest.index]?.scrollIntoView({ block: 'nearest' });
  } else $('tagInput').removeAttribute('aria-activedescendant');
}

async function loadTagSuggestions() {
  const typed = $('tagInput').value.trim().toLowerCase(), request = ++tagSuggest.request;
  const r = await fetch('/api/tags?q=' + encodeURIComponent(typed)).catch(() => null);
  if (!r?.ok || request !== tagSuggest.request || document.activeElement !== $('tagInput')) return;
  const current = new Set([...document.querySelectorAll('#documentTags [data-tag]')].map(e => e.dataset.tag));
  const items = ((await r.json()).tags || []).filter(item => !current.has(item.value));
  if (typed && !items.some(item => item.value.toLowerCase() === typed)) items.push({ value: typed, isNew: true });
  tagSuggest.items = items;
  tagSuggest.index = typed && items.length ? 0 : -1;
  renderTagSuggestions();
}

function applyTagSuggestion() {
  const item = tagSuggest.items[tagSuggest.index];
  if (item) $('tagInput').value = item.value;
  hideTagSuggestions();
  addDocumentTag();
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

let metadataController;
async function loadMetadata(id) {
  metadataController?.abort();
  const controller = metadataController = new AbortController();
  try {
    const r = await fetch('/api/file/' + encodeURIComponent(id) + '/details', { signal: controller.signal });
    if (!r.ok || state.selected?.id !== id) return;
    const d = await r.json();
    if (controller.signal.aborted || state.selected?.id !== id) return;
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
  } catch (error) {
    if (error.name !== 'AbortError') $('editorStatus').textContent = 'Could not load document details.';
  }
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
let duplicatesRequest = 0;
async function openDuplicates(f) {
  const request = ++duplicatesRequest;
  state.selected = f;
  markActiveFile();
  const r = await fetch('/api/file/' + encodeURIComponent(f.id) + '/duplicates');
  if (!r.ok || request !== duplicatesRequest || state.selected?.id !== f.id) return;
  const d = await r.json();
  if (request !== duplicatesRequest || state.selected?.id !== f.id) return;
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
    frame.src = f.preview_url || f.url;
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
  const sibling = list.find(f => f.id !== id);
  const check = sibling ? await fetch('/api/file/' + encodeURIComponent(sibling.id) + '/duplicates') : null;
  const remaining = check?.ok ? (await check.json()).documents || [] : [];
  if (remaining.length > 1) {
    // The group still has copies: keep reviewing it (the original may have changed after a promotion).
    state.selected = remaining.find(f => !f.is_duplicate) || remaining[0];
    await refresh();
    renderDuplicatesGrid(remaining);
    return;
  }
  // Group resolved: in the duplicates filter jump to the next group, otherwise show the surviving copy.
  closeDuplicates(false);
  state.selected = state.duplicates ? null : remaining[0] || null;
  state.requestedDocument = state.selected ? state.selected.id : '';
  await refresh();
  if (state.duplicates) {
    const next = [...document.querySelectorAll('#files .file')].map(el => files.find(x => x.id === el.dataset.fileId)).find(f => f && f.duplicate_count);
    if (next) await openDuplicates(next);
  }
  if (!state.selected && !$('duplicatesView').classList.contains('open')) clearSelection(true);
}

async function removeSelectedDocument() {
  const f = state.selected;
  if (!f || !confirm('Remove "' + f.name + '"?\n\nThe file is moved to the trash folder and removed from the archive index.')) return;
  const cards = [...document.querySelectorAll('#files .file')].map(card => card.dataset.fileId);
  const index = cards.indexOf(f.id);
  const nextId = cards[index + 1] || cards[index - 1] || '';
  const r = await fetch('/api/file/' + encodeURIComponent(f.id), { method: 'DELETE' });
  if (!r.ok) { $('editorStatus').textContent = 'Could not remove this document.'; return }
  // Continue with the neighbouring document so the user can keep working through the list.
  state.selected = null;
  state.requestedDocument = nextId;
  if (!nextId) clearSelection(true);
  await refresh();
  if (nextId) syncUrl(true);
}

async function refreshStatus() {
  try {
    const s = await (await fetch('/api/status')).json(), p = s.pipeline;
    $('ollamaDot').className = 'dot ' + (s.ollama_connected ? 'ok' : 'warn');
    $('ollamaStatus').textContent = s.ollama_connected ? 'Ollama connected' : s.error || 'Ollama unavailable';
    $('ollamaDot').title = $('ollamaStatus').textContent;
    $('modelStatus').textContent = (s.classifier === 'fast' ? 'Fast classifier · LLM on request: ' : 'Model: ') + s.model;
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

const SETTINGS_TAB_ALIASES = { general: 'storage', schedule: 'processing', prompts: 'ai', 'external-api': 'integrations', layout: 'appearance' };
let settingsDirty = false, settingsDefaults = {}, settingsDiagnostics = null;

function settingsTabName(name) {
  name = SETTINGS_TAB_ALIASES[name] || name;
  return document.querySelector('.settings-pane[data-pane="' + name + '"]') ? name : 'storage';
}

function showSettingsTab(name, updateUrl = true) {
  name = settingsTabName(name);
  activeSettingsTab = name;
  document.querySelectorAll('.settings-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === name));
  document.querySelectorAll('.settings-pane').forEach(pane => pane.hidden = pane.dataset.pane !== name);
  $('settingsDialog').querySelector('.settings-content').scrollTop = 0;
  if (updateUrl && $('settingsDialog').open) syncUrl(true);
}

function setSettingsDirty(dirty) {
  settingsDirty = dirty;
  $('settingsDirty').hidden = !dirty;
}

function closeSettings() {
  if (settingsDirty && !confirm('Discard unsaved settings changes?')) return;
  setSettingsDirty(false);
  $('settingsDialog').close();
}

function scheduleMode() {
  return document.querySelector('input[name="scheduleMode"]:checked')?.value || 'interval';
}

function updateSettingsCounts() {
  const categories = $('categoriesInput').value.split(/[\n,]+/).map(value => value.trim()).filter(Boolean);
  $('categoryCount').textContent = categories.length + (categories.length === 1 ? ' category' : ' categories');
  const aliases = Object.keys(tagAliases).length;
  $('tagAliasCount').textContent = aliases ? aliases + ' renamed' : '';
}

function fillModelSelect(select, current, models, kind) {
  const names = models.map(model => model.name);
  const wanted = kind === 'embed' ? names.filter(name => /embed|bge|minilm|e5|gte/i.test(name)) : names.filter(name => !/embed|bge|minilm|e5|gte/i.test(name));
  const tagged = name => name.includes(':') ? name : name + ':latest';
  const options = [current, ...wanted.filter(name => !current || tagged(name) !== tagged(current))].filter(Boolean);
  select.innerHTML = '';
  if (kind === 'embed') select.append(new Option('Off (keyword search only)', ''));
  options.forEach(name => {
    const model = models.find(item => tagged(item.name) === tagged(name));
    const size = model?.size ? ' · ' + (model.size / 1e9).toFixed(1) + ' GB' : '';
    select.append(new Option(name + (model ? size : ' (not installed)'), name));
  });
  select.value = current || '';
}

async function loadSettingsDiagnostics(ollamaUrl) {
  const status = $('ollamaCheck');
  status.className = 'setting-hint connection-status';
  status.textContent = 'Checking Ollama…';
  try {
    const query = ollamaUrl ? '?ollama_url=' + encodeURIComponent(ollamaUrl) : '';
    const d = await (await fetch('/api/settings/diagnostics' + query)).json();
    settingsDiagnostics = d;
    const o = d.ollama;
    status.classList.add(o.connected ? 'ok' : 'bad');
    status.textContent = o.connected ? '● Connected' + (o.version ? ' · Ollama ' + o.version : '') + ' · ' + o.models.length + ' models installed' : '● ' + (o.error || 'Not reachable');
    if (o.connected) {
      fillModelSelect($('generalAiModel'), $('generalAiModel').value, o.models, 'llm');
      fillModelSelect($('generalEmbedModel'), $('generalEmbedModel').value, o.models, 'embed');
    }
    $('ocrLanguageList').innerHTML = d.ocr_languages.map(code => '<option value="' + code + '">').join('');
    $('ocrInstalled').textContent = d.ocr_languages.length ? 'Installed: ' + d.ocr_languages.join(', ') : 'Could not read the installed Tesseract languages.';
    renderIntegrationStatus(d);
  } catch {
    status.classList.add('bad');
    status.textContent = '● Could not run the check.';
  }
}

function renderIntegrationStatus(d) {
  const api = d.external_api, search = d.search;
  const pill = $('apiTokenStatus');
  pill.textContent = api.token_configured ? 'Enabled' : 'Disabled — no token';
  pill.className = 'status-pill ' + (api.token_configured ? 'ok' : 'warn');
  $('externalApiBase').value = api.base_url;
  $('externalMcpUrl').value = api.mcp_url;
  $('claudeCommand').value = 'claude mcp add --transport http doggs ' + api.mcp_url + ' --header "Authorization: Bearer $DOGGS_TOKEN"';
  const busy = search.state === 'running' || search.pending > 0;
  const state = $('searchIndexState');
  state.textContent = search.error && !busy ? 'Error' : busy ? 'Indexing · ' + search.pending + ' left' : 'Up to date';
  state.className = 'status-pill ' + (busy || search.error ? 'warn' : 'ok');
  state.title = search.error || (search.last_sync ? 'Last sync ' + search.last_sync.replace('T', ' ') : '');
  const stat = (label, value) => '<div><dt>' + label + '</dt><dd>' + value + '</dd></div>';
  $('searchIndexStats').innerHTML = stat('Documents', search.documents.toLocaleString()) + stat('With embeddings', search.embedded_documents.toLocaleString()) + stat('Chunks', search.chunks.toLocaleString()) + stat('Model', '<span title="' + (search.model || 'off') + '">' + (search.model ? search.model.split('/').pop().split(':')[0] : 'off') + '</span>');
}

document.querySelectorAll('[data-theme-choice]').forEach(card => card.onclick = () => applyTheme(card.dataset.themeChoice));

$('addRuleButton').onclick = addRule;

function updateScheduleFields() {
  const daily = scheduleMode() === 'daily';
  $('intervalSchedule').hidden = daily;
  $('dailySchedule').hidden = !daily;
}

const GENERAL_FIELDS = { generalIncoming: 'incoming_dir', generalArchive: 'archive_dir', generalError: 'error_dir', generalDuplicate: 'duplicate_dir', generalTrash: 'trash_dir', generalOcrLang: 'ocr_lang', generalAiMode: 'ai_mode', generalOllamaUrl: 'ollama_url', generalAiModel: 'ai_model', generalClassifier: 'classifier', generalEmbedModel: 'embed_model' };

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
  up.onclick = () => { const prev = row.previousElementSibling; if (prev) { row.parentElement.insertBefore(row, prev); setSettingsDirty(true) } };
  const down = document.createElement('button');
  down.type = 'button'; down.className = 'icon-button rule-down'; down.textContent = '↓'; down.title = 'Move down'; down.setAttribute('aria-label', 'Move rule down');
  down.onclick = () => { const next = row.nextElementSibling; if (next) { row.parentElement.insertBefore(next, row); setSettingsDirty(true) } };
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'icon-button rule-remove'; remove.textContent = '✕'; remove.title = 'Remove rule'; remove.setAttribute('aria-label', 'Remove rule');
  remove.onclick = () => { row.remove(); setSettingsDirty(true) };
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
  const row = createRuleRow({ name: '', enabled: true, conditions: {}, content_chars: 500, category: '', tags: [] });
  $('ruleList').append(row);
  setSettingsDirty(true);
  row.scrollIntoView({ block: 'nearest' });
  row.querySelector('.rule-name').focus();
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
    if (field.tagName === 'SELECT' && id !== 'generalAiMode' && id !== 'generalClassifier') fillModelSelect(field, general[key] ?? '', [], id === 'generalEmbedModel' ? 'embed' : 'llm');
    field.value = general[key] ?? '';
    field.disabled = !!locked[key];
    field.title = locked[key] ? 'Set by ' + key.toUpperCase() + ' in the server .env' : '';
    const badge = document.querySelector('label[for="' + id + '"] .lock-badge');
    if (badge) { badge.hidden = !locked[key]; badge.title = field.title }
  });
  $('generalRecursive').checked = !!general.recursive_scan;
  $('generalRecursive').disabled = !!locked.recursive_scan;
  $('testOllama').disabled = !!locked.ollama_url && general.ai_mode === 'heuristic';
}

async function openSettings(updateUrl = true) {
  const s = await (await fetch('/api/settings')).json();
  $('ignoredTags').value = s.ignored_tags.join(', ');
  $('categoriesInput').value = (s.categories || []).join('\n');
  renderRules(s.rules || [], s.categories || []);
  $('smbShareUrl').value = s.external_api?.smb_share_url || '';
  tagAliases = s.tag_aliases || {};
  $('tagAliasSearch').value = '';
  renderTagAliases();
  populateGeneralSettings(s.general || {}, s.general_locked || {});
  $('metadataPrompt').value = s.prompts.metadata;
  $('summaryPrompt').value = s.prompts.summary;
  settingsDefaults = s.prompt_defaults || {};
  document.querySelectorAll('input[name="scheduleMode"]').forEach(radio => radio.checked = radio.value === s.schedule.mode);
  $('intervalMinutes').value = s.schedule.interval_minutes;
  $('dailyTimes').value = s.schedule.daily_times.join(', ');
  updateScheduleFields();
  applyTheme(currentTheme());
  updateSettingsCounts();
  setSettingsDirty(false);
  $('settingsMessage').textContent = '';
  showSettingsTab(activeSettingsTab, false);
  if (!$('settingsDialog').open) $('settingsDialog').showModal();
  if (updateUrl) syncUrl(true);
  loadSettingsDiagnostics();
}

async function saveSettings(event) {
  event.preventDefault();
  const payload = {
    ignored_tags: $('ignoredTags').value.split(/[\s,]+/).filter(Boolean),
    categories: $('categoriesInput').value.split(/[\n,]+/).map(value => value.trim()).filter(Boolean),
    rules: collectRules(),
    external_api: { smb_share_url: $('smbShareUrl').value.trim() },
    prompts: { metadata: $('metadataPrompt').value, summary: $('summaryPrompt').value },
    schedule: { mode: scheduleMode(), interval_minutes: $('intervalMinutes').value, daily_times: $('dailyTimes').value.split(/[\s,]+/).filter(Boolean) },
    general: { ...Object.fromEntries(Object.entries(GENERAL_FIELDS).map(([id, key]) => [key, $(id).value.trim()])), recursive_scan: $('generalRecursive').checked }
  };
  const message = $('settingsMessage'), button = $('saveSettingsButton');
  button.disabled = true;
  message.className = 'settings-message';
  message.textContent = 'Saving…';
  try {
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Saving failed (' + r.status + ')');
    setSettingsDirty(false);
    $('settingsDialog').close();
    showToast('Settings saved');
    refresh(); refreshStatus();
  } catch (error) {
    message.className = 'settings-message error';
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
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
  updateSettingsCounts();
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
$('tagInput').oninput = () => { clearTimeout(tagSuggest.timer); tagSuggest.timer = setTimeout(loadTagSuggestions, 120) };
$('tagInput').onfocus = () => loadTagSuggestions();
$('tagInput').onblur = () => setTimeout(hideTagSuggestions, 100);
$('tagInput').onkeydown = e => {
  const open = !$('tagSuggestions').hidden, count = tagSuggest.items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open) { loadTagSuggestions(); return }
    const step = e.key === 'ArrowDown' ? 1 : -1;
    tagSuggest.index = tagSuggest.index < 0 ? (step > 0 ? 0 : count - 1) : (tagSuggest.index + step + count) % count;
    renderTagSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (open && tagSuggest.index >= 0) applyTagSuggestion(); else { hideTagSuggestions(); addDocumentTag() }
  } else if (e.key === 'Tab' && open && tagSuggest.index >= 0 && $('tagInput').value.trim()) {
    e.preventDefault();
    $('tagInput').value = tagSuggest.items[tagSuggest.index].value;
    loadTagSuggestions();
  } else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); hideTagSuggestions() }
};
$('titleInput').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); saveDetails() } };
$('duplicates').onchange = e => { state.duplicates = e.target.checked; $('cleanDuplicatesButton').hidden = !state.duplicates; syncUrl(true); refresh() };
$('resetFilters').onclick = () => {
  state.q = ''; state.years = new Set(); state.categories = new Set(); state.types = new Set(); state.tags = new Set(); state.duplicates = false;
  $('query').value = ''; $('duplicates').checked = false; $('tagSearch').value = ''; $('cleanDuplicatesButton').hidden = true;
  syncUrl(true);
  refresh();
};
$('cleanDuplicatesButton').onclick = async () => {
  if (!confirm('Remove every duplicate copy and keep only one original of each document? Copies are moved to the trash folder.')) return;
  const r = await fetch('/api/duplicates/clean', { method: 'POST' });
  if (!r.ok) { alert('Could not clean duplicates.'); return }
  await refresh();
};
$('saveDetails').onclick = saveDetails;
$('removeDocument').onclick = removeSelectedDocument;
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
$('cancelSettings').onclick = closeSettings;
$('closeSettings').onclick = closeSettings;
$('settingsDialog').addEventListener('cancel', event => { event.preventDefault(); closeSettings() });
$('settingsForm').addEventListener('input', event => { if (event.target.id !== 'tagAliasSearch') setSettingsDirty(true) });
$('settingsForm').addEventListener('change', event => { if (event.target.id !== 'tagAliasSearch' && !event.target.closest('#themeGrid')) setSettingsDirty(true) });
$('categoriesInput').addEventListener('input', updateSettingsCounts);
$('testOllama').onclick = () => loadSettingsDiagnostics($('generalOllamaUrl').value.trim());
document.querySelectorAll('[data-reset-prompt]').forEach(button => button.onclick = () => {
  const key = button.dataset.resetPrompt, field = $(key + 'Prompt');
  if (!settingsDefaults[key] || field.value === settingsDefaults[key]) return;
  field.value = settingsDefaults[key];
  setSettingsDirty(true);
});
document.querySelectorAll('[data-copy]').forEach(button => button.onclick = async () => {
  const field = $(button.dataset.copy);
  try { await navigator.clipboard.writeText(field.value) } catch { field.select(); document.execCommand('copy') }
  button.textContent = 'Copied';
  setTimeout(() => button.textContent = 'Copy', 1200);
});
$('settingsDialog').addEventListener('close', () => syncUrl());
$('settingsForm').onsubmit = saveSettings;
document.querySelectorAll('input[name="scheduleMode"]').forEach(radio => radio.onchange = updateScheduleFields);
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
  const facet = event.target.closest('.facet-list');
  if (facet && !typing && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'home', 'end'].includes(key)) {
    const items = [...facet.querySelectorAll('.facet-item:not(:disabled)')];
    const current = items.indexOf(event.target.closest('.facet-item'));
    if (current < 0) return;
    event.preventDefault();
    const step = ['arrowup', 'arrowleft'].includes(key) ? -1 : 1;
    const next = key === 'home' ? 0 : key === 'end' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, current + step));
    items[next].focus({ preventScroll: true });
    items[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
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

$('files').addEventListener('scroll', () => {
  const e = $('files');
  if (e.scrollHeight - e.scrollTop - e.clientHeight < 500) loadMore();
}, { passive: true });

$('sidebarToggle').setAttribute('aria-expanded', String(!root.classList.contains('sidebar-closed')));
restoreUrlState();
refresh();
refreshStatus();
checkFirstRunSetup();
window.addEventListener('popstate', () => { restoreUrlState(); refresh() });
setInterval(() => {
  if (document.hidden) return;
  if (!dragging && !document.activeElement?.closest('input, textarea, select, [contenteditable="true"]')) refresh({ background: true });
  refreshStatus();
}, 15000);
