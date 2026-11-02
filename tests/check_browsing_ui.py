"""Optional Playwright integration check; uses synthetic documents in temporary storage."""
import sys
import threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_browsing
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server, WSGIRequestHandler

class QuietHandler(WSGIRequestHandler):
    def log(self, *args, **kwargs): pass

test_browsing.BrowsingTests.setUpClass()
fixture = test_browsing.BrowsingTests('test_pagination_bounds_payload_and_covers_all_documents')
fixture.setUp()
app = fixture.doggs
app.write_settings({'general': {}, 'tag_aliases': {}, 'ignored_tags': [], 'favorite_tags':['household'], 'recent_tags':['tax','bank']})
rows = [fixture.row(str(i), stored_path=f'2025/doc-{i:04}.txt', original_name=f'document {i}', file_hash=str(i), pdf_title='Electricity statement' if i % 2 == 0 else 'Home insurance renewal', summary='Monthly household electricity bill. Payment is due at the end of the month.' if i % 2 == 0 else 'Annual insurance policy renewal with updated coverage and payment details.', tags='household', category='invoice' if i % 2 == 0 else 'contract') for i in range(250)]
app.write_rows(rows)
for row in rows:
    path = app.ARCHIVE_DIR / row['stored_path']
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('Synthetic document for browser checks.')
server = make_server('127.0.0.1', 0, app.app, threaded=True, request_handler=QuietHandler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        responses = []
        page.on('response', lambda response: responses.append((response.url, response.status)) if '/api/index?' in response.url else None)
        page.goto(f'http://127.0.0.1:{server.server_port}/')
        page.wait_for_function('document.querySelectorAll("#files .file").length === 60 && !refreshBusy')
        assert page.locator('#resultCount').inner_text() == '250 documents'
        page.evaluate('window.firstCard = document.querySelector("#files .file")')
        page.evaluate('document.getElementById("files").scrollTop = document.getElementById("files").scrollHeight')
        page.wait_for_function('files.length === 120 && !browse.loading')
        assert page.evaluate('firstCard === document.querySelector("#files .file")')
        print('PASS: initial render 60/250; scrolling appends 60 without replacing existing cards')
        page.evaluate('async () => { setPreview(true, false); selectFile(files[119], false, false); }')
        page.locator('#files .file').nth(119).focus()
        page.keyboard.press('ArrowDown')
        try:
            page.wait_for_function('files.length >= 180 && state.selected.id === "129"', timeout=5000)
        except Exception:
            print('Keyboard debug:', page.evaluate('({loaded:files.length, selected:state.selected?.id, preview:state.preview, loading:browse.loading, busy:refreshBusy, focused:document.activeElement.outerHTML.slice(0,300)})'), errors, flush=True)
            raise
        print('PASS: keyboard navigation loads and crosses a batch boundary')
        page.keyboard.press('Control+y')
        assert page.evaluate('document.activeElement.dataset.value') == ''
        page.keyboard.press('ArrowDown')
        assert page.evaluate('document.activeElement.dataset.value') == '2025'
        print('PASS: filter shortcut and arrow navigation')
        page.locator('#categories .facet-item[data-value="invoice"]').click()
        page.wait_for_function('!refreshBusy && browse.pagination.total === 125 && files.length === 60')
        assert page.evaluate('files.every(f => f.category === "invoice")')
        print('PASS: filters reset paging and retain global result counts')
        page.evaluate('async () => { await refresh({background:true}); }')
        page.evaluate('window.heldCard = document.querySelector("#files .file"); window.heldFacet = document.querySelector("#years .facet-item");')
        with page.expect_response(lambda r: '/api/index?' in r.url and r.status == 304):
            page.evaluate('async () => { await refresh({background:true}); }')
        assert page.evaluate('heldCard === document.querySelector("#files .file") && heldFacet === document.querySelector("#years .facet-item")')
        print('PASS: unchanged background poll returns 304 and preserves card/facet DOM')
        page.evaluate('async () => { state.q = "no-match"; refresh(); state.q = ""; await refresh(); }')
        page.wait_for_function('!refreshBusy && files.length === 60')
        assert page.evaluate('browse.pagination.total') == 125
        print('PASS: rapid filter changes cancel stale requests')
        page.evaluate('async () => { await loadMore(); await loadMore(); }')
        page.wait_for_function('files.length === 125 && !browse.loading')
        assert page.locator('#loadMore').is_hidden()
        print('PASS: final page stops at 125 unique documents with no extra requests')
        page.locator('#files .file').first.click()
        first = page.locator('#files .file').first
        assert first.locator('.summary').is_visible()
        assert first.locator('.card-category').inner_text() == 'invoice'
        assert first.locator('.card-tags').inner_text().startswith('#household')
        original_name = page.locator('#filenameInput').input_value()
        page.locator('#titleInput').fill('Household electricity — February 2025')
        page.locator('#saveDetails').click()
        page.wait_for_function('!refreshBusy && state.selected.title === "Household electricity — February 2025"')
        assert page.locator('#documentTitle').inner_text() == 'Household electricity — February 2025'
        assert page.locator('#filenameInput').input_value() == original_name
        assert page.locator('#files .file.active .title').inner_text() == 'Household electricity — February 2025'
        selected_id = page.evaluate('state.selected.id')
        assert next(row for row in app.read_rows() if row['id'] == selected_id)['pdf_title'] == 'Electricity statement'
        page.screenshot(path='/tmp/doggs-details-check.png', full_page=True)
        page.evaluate('setPreview(false, false)')
        page.screenshot(path='/tmp/doggs-grid-check.png', full_page=True)
        print('PASS: custom display title saves in list and details, summary/category/tags are visible, filename and PDF metadata stay intact')
        page.evaluate('setPreview(true, false)')
        page.locator('#titleInput').fill('')
        page.locator('#saveDetails').click()
        page.wait_for_function('!refreshBusy && state.selected.title === "Electricity statement"')
        print('PASS: clearing a custom title restores the automatic title')
        def tag_positions():
            return page.evaluate('Array.from(document.querySelectorAll("#tags .tag-facet"), e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })')
        positions = tag_positions()
        page.locator('#tags .tag-menu-button[data-tag="bank"]').hover()
        assert tag_positions() == positions
        page.locator('#tags .tag-menu-button[data-tag="bank"]').click()
        assert tag_positions() == positions
        page.keyboard.press('ArrowDown')
        assert page.get_by_role('menuitem', name='Rename everywhere…').evaluate('e => e === document.activeElement')
        page.keyboard.press('Escape')
        assert page.locator('#tagActions').is_hidden()
        print('PASS: hovering/opening tag actions does not move chips; menu supports keyboard navigation')
        page.locator('#quickTags .tag-menu-button[data-tag="tax"]').click()
        page.get_by_role('menuitem', name='Add to favorites', exact=True).click()
        page.wait_for_function('favoriteTags.includes("tax") && !refreshBusy')
        page.locator('#quickTags .tag-menu-button[data-tag="tax"]').click()
        page.once('dialog', lambda dialog: dialog.accept('fiscal'))
        page.get_by_role('menuitem', name='Rename everywhere…').click()
        page.wait_for_function('favoriteTags.includes("fiscal") && !favoriteTags.includes("tax") && !refreshBusy')
        page.locator('#quickTags .tag-menu-button[data-tag="fiscal"]').click()
        page.get_by_role('menuitem', name='Remove from quick tags', exact=True).click()
        page.wait_for_function('!favoriteTags.includes("fiscal") && !recentTags.includes("fiscal") && !refreshBusy')
        assert page.evaluate('state.selected.document_tags.some(t => t.value === "fiscal")')
        page.locator('#quickTags .tag-menu-button[data-tag="household"]').click()
        page.get_by_role('menuitem', name='Remove from this document', exact=True).click()
        page.wait_for_function('!refreshBusy && !state.selected.document_tags.some(t => t.value === "household")')
        assert page.locator('#quickTags .tag-menu-button[data-tag="household"]').is_visible()
        print('PASS: quick tags support favorite, rename, removal from shortcuts, and removal from a document')
        assert not errors, errors
        print('PASS: no JavaScript runtime errors')
        browser.close()
finally:
    server.shutdown()
    fixture.doCleanups()
    test_browsing.BrowsingTests.tearDownClass()
