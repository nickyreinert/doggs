const state = { q: '', years: new Set(), tags: new Set(), duplicates: false, selected: null, requestedDocument: '' };
let files = [], timer, availableYears = [], visibleTags = [];
const $ = id => document.getElementById(id);

function syncUrl(push = false) {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.years.size) p.set('years', [...state.years].join(','));
  if (state.tags.size) p.set('tags', [...state.tags].join(','));
  if (state.duplicates) p.set('duplicates', '1');
  const documentId = state.selected?.id || state.requestedDocument;
  if (documentId) p.set('document', documentId);
  if ($('settingsDialog').open) p.set('settings', '1');
  history[push ? 'pushState' : 'replaceState']({}, '', location.pathname + (p.size ? '?' + p.toString() : ''));
}

function restoreUrlState() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') || '';
  state.years = new Set((p.get('years') || '').split(',').filter(Boolean));
  state.tags = new Set((p.get('tags') || '').split(',').filter(Boolean));
  state.duplicates = p.get('duplicates') === '1';
  state.selected = null;
  state.requestedDocument = p.get('document') || '';
  $('query').value = state.q;
  $('duplicates').checked = state.duplicates;
  const settings = p.get('settings') === '1';
  if (settings && !$('settingsDialog').open) openSettings(false);
  if (!settings && $('settingsDialog').open) $('settingsDialog').close();
}

async function refresh() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.years.size) p.set('years', [...state.years].join(','));
  if (state.tags.size) p.set('tokens', [...state.tags].join(','));
  if (state.duplicates) p.set('duplicates', '1');
  const selectedId = state.selected?.id || state.requestedDocument;
  if (selectedId) p.set('document', selectedId);
  const r = await fetch('/api/index?' + p);
  if (!r.ok) return;
  const d = await r.json();
  availableYears = (d.years || []).map(i => i.value);
  $('years').innerHTML = '<option value="">All years</option>' + (d.years || []).map(i => '<option value="' + i.value + '">' + i.value + ' (' + i.count + ')</option>').join('');
  [...$('years').options].forEach(o => o.selected = state.years.size ? state.years.has(o.value) : o.value === '');
  renderTags(d.tags || []);
  $('duplicateCount').textContent = d.duplicates_count || 0;
  renderFiles(d.files || []);
  if (selectedId) {
    const f = files.find(x => x.id === selectedId) || d.selected_file;
    if (f) {
      const load = !!state.requestedDocument;
      state.requestedDocument = '';
      selectFile(f, load, false);
    } else {
      clearSelection(false);
      syncUrl();
    }
  }
}

function renderTags(items) {
  visibleTags = items;
  const e = $('tags'), needle = $('tagSearch').value.trim().toLowerCase();
  e.innerHTML = '';
  items.filter(i => !needle || i.value.includes(needle)).forEach(i => {
    const wrap = document.createElement('span');
    wrap.className = 'tag-facet';
    const filter = document.createElement('button');
    filter.className = 'chip' + (state.tags.has(i.value) ? ' selected' : '');
    filter.textContent = i.value + ' (' + i.count + ')';
    filter.title = 'Filter by ' + i.value;
    filter.onclick = () => { state.tags.has(i.value) ? state.tags.delete(i.value) : state.tags.add(i.value); syncUrl(true); refresh() };
    const ignore = document.createElement('button');
    ignore.className = 'tag-ignore';
    ignore.textContent = '−';
    ignore.title = 'Ignore ' + i.value + ' everywhere';
    ignore.setAttribute('aria-label', 'Ignore ' + i.value + ' everywhere');
    ignore.onclick = () => ignoreTag(i.value);
    wrap.append(filter, ignore);
    e.append(wrap);
  });
  if (!e.children.length) e.innerHTML = '<div class="empty">No matching tags.</div>';
}

// Duplicate copies are grouped onto their original's list entry with a count badge instead of listed separately.
function renderFiles(list) {
  files = list;
  const e = $('files');
  e.innerHTML = '';
  if (!list.length) { e.innerHTML = '<div class="empty">No documents found.</div>'; return }
  const byId = new Map(list.map(f => [f.id, f]));
  const dupeCounts = new Map();
  list.forEach(f => {
    if (f.is_duplicate && f.duplicate_of && byId.has(f.duplicate_of)) {
      dupeCounts.set(f.duplicate_of, (dupeCounts.get(f.duplicate_of) || 0) + 1);
    }
  });
  const visible = list.filter(f => !(f.is_duplicate && f.duplicate_of && byId.has(f.duplicate_of)));
  const groups = {};
  visible.forEach(f => (groups[f.year || 'unknown'] ??= []).push(f));
  Object.keys(groups).sort().reverse().forEach(y => {
    const g = document.createElement('section');
    g.className = 'year-group';
    g.innerHTML = '<h3>' + y + '</h3>';
    groups[y].forEach(f => {
      const dupeCount = dupeCounts.get(f.id) || 0;
      const b = document.createElement('button');
      b.className = 'file' + (state.selected?.id === f.id ? ' active' : '');
      b.innerHTML = '<div class="title"></div><div class="meta"></div><div class="summary"></div>';
      b.querySelector('.title').textContent = f.name;
      b.querySelector('.meta').textContent = [f.date || 'no date', f.classification || 'document', f.is_duplicate ? 'duplicate' : ''].filter(Boolean).join(' • ');
      b.querySelector('.summary').textContent = f.summary || '';
      if (dupeCount) {
        const badge = document.createElement('span');
        badge.className = 'dupe-badge';
        badge.textContent = String(dupeCount);
        badge.title = dupeCount + ' duplicate' + (dupeCount > 1 ? 's' : '') + ' of this document';
        b.append(badge);
      }
      b.onclick = () => dupeCount ? openDuplicates(f) : selectFile(f);
      g.append(b);
    });
    e.append(g);
  });
}

function clearSelection(updateUrl = true) {
  state.selected = null;
  state.requestedDocument = '';
  $('detailsEditor').hidden = true;
  $('documentTitle').textContent = 'Select a document';
  $('documentMeta').textContent = 'Its details and preview will appear here.';
  $('frame').removeAttribute('src');
  closeDuplicates(false);
  renderFiles(files);
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
  $('documentTitle').textContent = f.pdf_title || f.name;
  $('documentMeta').textContent = [f.name, f.pdf_author, f.date, f.classification, f.is_duplicate ? 'Duplicate content' : ''].filter(Boolean).join(' • ');
  $('tagInput').value = '';
  $('filenameInput').value = f.name;
  $('summaryInput').value = f.summary || '';
  const ys = [...new Set([...availableYears, f.year])].sort().reverse();
  $('yearInput').innerHTML = ys.map(y => '<option value="' + y + '">' + y + '</option>').join('');
  $('yearInput').value = f.year;
  $('yearInput').disabled = !!f.is_duplicate;
  $('yearInput').title = f.is_duplicate ? 'Duplicate copies are stored together and are not organized by year. Edit the original document to move it.' : '';
  renderDocumentTags(f.document_tags || []);
  $('editorStatus').textContent = ['queued', 'running'].includes(f.normal_scan?.state) ? 'LLM extraction is running…' : f.normal_scan?.state === 'error' ? f.normal_scan.error : '';
  if (load) $('frame').src = f.url;
  loadMetadata(f.id);
  renderFiles(files);
  if (updateUrl) syncUrl(true);
}

async function saveDetails() {
  if (!state.selected) return;
  const r = await fetch('/api/file/' + encodeURIComponent(state.selected.id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: $('summaryInput').value, year: $('yearInput').value, filename: $('filenameInput').value }) });
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
    if (job.state === 'complete') { await refresh(); $('editorStatus').textContent = 'Extracted fields updated; custom tags kept.'; return }
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
  renderDuplicatesGrid(d.documents || []);
}

function renderDuplicatesGrid(list) {
  state.selected = null;
  state.requestedDocument = '';
  $('detailsEditor').hidden = true;
  $('frame').removeAttribute('src');
  $('frame').hidden = true;
  $('documentTitle').textContent = 'Duplicate documents (' + list.length + ')';
  $('documentMeta').textContent = 'Review each copy and remove the ones you no longer need.';
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
  $('duplicatesView').classList.add('open');
  renderFiles(files);
}

function closeDuplicates(reset = true) {
  $('duplicatesView').classList.remove('open');
  $('duplicatesGrid').innerHTML = '';
  $('frame').hidden = false;
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
    $('modelStatus').textContent = 'Model: ' + s.model;
    $('pipelineCount').textContent = 'Pipeline · ' + p.waiting_count + ' waiting' + (p.paused ? (p.processing ? ' · finishing current file' : ' · paused') : '') + (!p.paused && p.processing ? ' · processing ' + p.processing : '');
    $('pausePipeline').textContent = p.paused ? 'Resume pipeline' : 'Pause pipeline';
    $('ocrStatus').textContent = 'OCR ' + s.ocr_language + ': ' + (s.ocr_available ? 'available' : 'missing');
    $('pipelineList').innerHTML = p.waiting.length ? p.waiting.map(x => '<li>' + x.name + ' · ' + Math.ceil(x.size / 1024) + ' KB · ' + x.state + '</li>').join('') : '<li>No PDFs waiting in the inbox.</li>';
    $('pipelineError').textContent = p.last_error || '';
  } catch {
    $('ollamaStatus').textContent = 'Status unavailable';
  }
}

function showSettingsTab(name) {
  document.querySelectorAll('.settings-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === name));
  document.querySelectorAll('.settings-pane').forEach(pane => pane.hidden = pane.dataset.pane !== name);
}

function updateScheduleFields() {
  const daily = $('scheduleMode').value === 'daily';
  $('intervalSchedule').hidden = daily;
  $('dailySchedule').hidden = !daily;
}

async function openSettings(updateUrl = true) {
  const s = await (await fetch('/api/settings')).json();
  $('ignoredTags').value = s.ignored_tags.join(', ');
  $('metadataPrompt').value = s.prompts.metadata;
  $('summaryPrompt').value = s.prompts.summary;
  $('scheduleMode').value = s.schedule.mode;
  $('intervalMinutes').value = s.schedule.interval_minutes;
  $('dailyTimes').value = s.schedule.daily_times.join(', ');
  updateScheduleFields();
  showSettingsTab('tags');
  if (!$('settingsDialog').open) $('settingsDialog').showModal();
  if (updateUrl) syncUrl(true);
}

async function saveSettings(event) {
  event.preventDefault();
  const payload = { ignored_tags: $('ignoredTags').value.split(/[\s,]+/).filter(Boolean), prompts: { metadata: $('metadataPrompt').value, summary: $('summaryPrompt').value }, schedule: { mode: $('scheduleMode').value, interval_minutes: $('intervalMinutes').value, daily_times: $('dailyTimes').value.split(/[\s,]+/).filter(Boolean) } };
  const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (r.ok) { $('settingsDialog').close(); refresh(); refreshStatus() }
}

function togglePipeline() {
  const open = $('pipeline').classList.toggle('open'), b = $('pipelineToggle');
  b.textContent = open ? '⌄' : '⌃';
  b.title = open ? 'Collapse pipeline' : 'Expand pipeline';
  b.setAttribute('aria-label', b.title);
}

$('years').onchange = e => {
  const all = [...e.target.options].find(option => option.value === '');
  state.years = all?.selected ? new Set() : new Set([...e.target.selectedOptions].map(option => option.value).filter(Boolean));
  if (all) all.selected = !state.years.size;
  syncUrl(true);
  refresh();
};
$('query').oninput = e => { state.q = e.target.value.trim(); syncUrl(); clearTimeout(timer); timer = setTimeout(refresh, 250) };
$('tagSearch').oninput = () => renderTags(visibleTags);
$('tagInput').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addDocumentTag() } };
$('duplicates').onchange = e => { state.duplicates = e.target.checked; syncUrl(true); refresh() };
$('saveDetails').onclick = saveDetails;
$('yearInput').onchange = moveDocumentYear;
$('metaToggle').onclick = () => $('metaPanel').hidden = !$('metaPanel').hidden;
$('runOcr').onclick = runOcr;
$('runLlm').onclick = rerunPipeline;
$('saveOcr').onclick = saveOcr;
$('closeDuplicatesButton').onclick = () => closeDuplicates(true);
$('pipelineToggle').onclick = togglePipeline;
$('scanNow').onclick = async () => { await fetch('/api/scan', { method: 'POST' }); setTimeout(() => { refresh(); refreshStatus() }, 700) };
$('pausePipeline').onclick = async () => { await fetch('/api/pipeline/pause', { method: 'POST' }); refreshStatus() };
$('settingsButton').onclick = () => openSettings(true);
$('cancelSettings').onclick = () => $('settingsDialog').close();
$('settingsDialog').addEventListener('close', () => syncUrl());
$('settingsForm').onsubmit = saveSettings;
$('scheduleMode').onchange = updateScheduleFields;
document.querySelectorAll('.settings-tab').forEach(button => button.onclick = () => showSettingsTab(button.dataset.tab));

(() => {
  const header = $('appHeader'), handle = $('headerResizer'), min = 150, max = 420;
  let startY = 0, startHeight = 0;
  handle.addEventListener('pointerdown', event => { startY = event.clientY; startHeight = header.getBoundingClientRect().height; handle.setPointerCapture(event.pointerId); event.preventDefault() });
  handle.addEventListener('pointermove', event => { if (!handle.hasPointerCapture(event.pointerId)) return; header.style.height = Math.max(min, Math.min(max, startHeight + event.clientY - startY)) + 'px' });
  handle.addEventListener('pointerup', event => { if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId) });
})();

restoreUrlState();
refresh();
refreshStatus();
window.addEventListener('popstate', () => { restoreUrlState(); refresh() });
setInterval(() => { refresh(); refreshStatus() }, 15000);
