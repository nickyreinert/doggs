"""Browsing regressions, using temporary storage and no background workers."""
import csv
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch


class BrowsingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.storage = tempfile.TemporaryDirectory(prefix="doggs-tests-")
        root = Path(cls.storage.name)
        env = {key: str(root / key.lower()) for key in (
            "INCOMING_DIR", "ARCHIVE_DIR", "DATA_DIR", "ERROR_DIR",
            "DUPLICATE_DIR", "TRASH_DIR", "THUMB_DIR",
        )}
        env.update(CSV_PATH=str(root / "index.csv"), SETTINGS_PATH=str(root / "settings.json"),
                   SEARCH_DB_PATH=str(root / "search.sqlite"), AI_MODE="heuristic")
        with patch.dict(os.environ, env):
            import app
        cls.doggs = app

    @classmethod
    def tearDownClass(cls):
        cls.storage.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=self.storage.name)
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        paths = patch.multiple(self.doggs, CSV_PATH=root / "index.csv", SETTINGS_PATH=root / "settings.json")
        paths.start()
        self.addCleanup(paths.stop)
        cache = patch.dict(self.doggs.INDEX_CACHE, {"signature": None, "rows": (), "loaded_at": 0.0}, clear=True)
        cache.start()
        self.addCleanup(cache.stop)
        self.client = self.doggs.app.test_client()
        self.doggs.write_settings({"tag_aliases": {"bank": "banking"}, "ignored_tags": ["tax"]})

    def row(self, row_id="a", **values):
        row = dict.fromkeys(self.doggs.FIELDNAMES, "")
        row.update(id=row_id, stored_path="2025/invoice.pdf", location="archive", year="2025",
                   date="2025-01-01", category="invoice", tokens="bank,tax", ocr_text="searchable content")
        row.update(values)
        return row

    def external_write(self, rows, path=None):
        with (path or self.doggs.CSV_PATH).open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=self.doggs.FIELDNAMES)
            writer.writeheader()
            writer.writerows(rows)

    def test_cached_reads_do_not_parse_csv_and_return_independent_rows(self):
        self.doggs.write_rows([self.row()])
        rows = self.doggs.read_rows()
        rows[0]["summary"] = "unsaved edit"
        rows.clear()
        with patch.object(csv, "DictReader", side_effect=AssertionError("unexpected CSV parse")):
            self.assertEqual(self.doggs.read_rows()[0]["summary"], "")

    def test_writes_and_mutations_invalidate_snapshot(self):
        self.doggs.write_rows([self.row()])
        self.doggs.read_rows()
        self.doggs.write_rows([self.row(summary="saved")])
        self.assertEqual(self.doggs.read_rows()[0]["summary"], "saved")
        self.doggs.mutate_row("a", lambda row: row.update(summary="mutated"))
        self.assertEqual(self.doggs.read_rows()[0]["summary"], "mutated")

    def test_external_edits_and_atomic_replacement_invalidate_snapshot(self):
        self.doggs.write_rows([self.row(summary="before")])
        self.doggs.read_rows()
        previous = self.doggs.CSV_PATH.stat()
        self.external_write([self.row(summary="edited")])
        os.utime(self.doggs.CSV_PATH, ns=(previous.st_atime_ns, previous.st_mtime_ns + 1_000_000_000))
        self.assertEqual(self.doggs.read_rows()[0]["summary"], "edited")
        stat = self.doggs.CSV_PATH.stat()
        replacement = self.doggs.CSV_PATH.with_suffix(".replacement")
        self.external_write([self.row(summary="newest")], replacement)
        os.utime(replacement, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        replacement.replace(self.doggs.CSV_PATH)
        self.assertEqual(self.doggs.read_rows()[0]["summary"], "newest")

    def test_cache_expires_when_filesystem_timestamps_hide_an_edit(self):
        self.doggs.write_rows([self.row(summary="before")])
        self.doggs.read_rows()
        signature = self.doggs.index_signature()
        self.external_write([self.row(summary="edited")])
        expired = self.doggs.INDEX_CACHE["loaded_at"] + self.doggs.INDEX_CACHE_SECONDS + 1
        with patch.object(self.doggs, "index_signature", return_value=signature), patch.object(self.doggs.time, "monotonic", return_value=expired):
            self.assertEqual(self.doggs.read_rows()[0]["summary"], "edited")

    def test_deleted_index_is_recreated_without_cached_documents(self):
        self.doggs.write_rows([self.row()])
        self.doggs.read_rows()
        self.doggs.CSV_PATH.unlink()
        self.assertEqual(self.doggs.read_rows(), [])

    def test_mutations_preserve_external_edits_even_with_unchanged_signature(self):
        self.doggs.write_rows([self.row(summary="before")])
        self.doggs.read_rows()
        signature = self.doggs.index_signature()
        self.external_write([self.row(summary="edited")])
        with patch.object(self.doggs, "index_signature", return_value=signature):
            self.doggs.mutate_row("a", lambda row: row.update(category="contract"))
        row = self.doggs.read_rows()[0]
        self.assertEqual(row["summary"], "edited")
        self.assertEqual(row["category"], "contract")

    def test_ui_transactions_preserve_external_edits_with_unchanged_signature(self):
        self.doggs.write_rows([self.row(summary="before")])
        self.doggs.read_rows()
        signature = self.doggs.index_signature()
        self.external_write([self.row(summary="edited")])
        with patch.object(self.doggs, "index_signature", return_value=signature):
            response = self.client.post("/api/file/a/details", json={"ocr_text": "new OCR"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.doggs.read_rows()[0]["summary"], "edited")

    def test_storage_path_change_does_not_reuse_snapshot(self):
        self.doggs.write_rows([self.row()])
        self.doggs.read_rows()
        with patch.object(self.doggs, "CSV_PATH", Path(self.tmp.name) / "other.csv"):
            self.assertEqual(self.doggs.read_rows(), [])
        self.assertEqual(self.doggs.read_rows()[0]["id"], "a")

    def test_old_csv_schema_is_migrated(self):
        self.doggs.CSV_PATH.write_text("id,summary\na,old value\n", encoding="utf-8")
        self.assertEqual(self.doggs.read_rows()[0], dict.fromkeys(self.doggs.FIELDNAMES, "") | {"id": "a", "summary": "old value"})
        with self.doggs.CSV_PATH.open() as stream:
            self.assertEqual(next(csv.reader(stream)), self.doggs.FIELDNAMES)

    def test_concurrent_mutations_preserve_all_updates(self):
        self.doggs.write_rows([self.row(summary="0")])
        def increment(_):
            self.doggs.mutate_row("a", lambda row: row.update(summary=str(int(row["summary"]) + 1)))
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(increment, range(20)))
        self.assertEqual(self.doggs.read_rows()[0]["summary"], "20")

    def test_facets_exclude_their_own_filter_and_resolve_aliases(self):
        self.doggs.write_rows([
            self.row("a"), self.row("b", year="2024", category="contract", stored_path="2024/contract.txt"),
            self.row("c", category="contract", stored_path="2025/contract.txt"),
            self.row("d", year="2024", stored_path="2024/invoice.pdf"),
        ])
        data = self.client.get("/api/index?years=2025&categories=invoice&types=pdf&tokens=bank&document=b").json
        self.assertEqual([row["id"] for row in data["files"]], ["a"])
        self.assertEqual({item["value"]: item["count"] for item in data["years"]}, {"2025": 1, "2024": 1})
        self.assertEqual({item["value"]: item["count"] for item in data["categories"]}["contract"], 0)
        self.assertEqual(data["types"], [{"value": "pdf", "count": 1, "selected": True}])
        self.assertEqual(data["tags"], [{"value": "banking", "count": 1, "selected": True}])
        self.assertEqual(data["selected_file"]["id"], "b")

    def test_browse_omits_ocr_payload_but_search_and_details_keep_text(self):
        self.doggs.write_rows([self.row()])
        with patch.object(self.doggs, "read_settings", wraps=self.doggs.read_settings) as settings:
            data = self.client.get("/api/index?q=searchable%20content&document=a").json
        self.assertEqual(settings.call_count, 1)
        self.assertEqual(len(data["files"]), 1)
        self.assertNotIn("ocr_text", data["files"][0])
        self.assertNotIn("ocr_text", data["selected_file"])
        self.assertEqual(self.client.get("/api/file/a/details").json["ocr_text"], "searchable content")
        self.assertEqual(self.client.get("/api/index?q=absent").json["files"], [])

    def test_settings_edits_apply_on_next_request(self):
        self.doggs.write_rows([self.row(tags="tax")])
        before = self.client.get("/api/index").json["files"][0]["document_tags"]
        self.assertEqual(before, [{"value": "banking", "kind": "inferred"}, {"value": "tax", "kind": "custom"}])
        self.doggs.write_settings({"tag_aliases": {"bank": "finance"}, "ignored_tags": ["tax"]})
        after = self.client.get("/api/index").json["files"][0]["document_tags"]
        self.assertEqual(after, [{"value": "finance", "kind": "inferred"}, {"value": "tax", "kind": "custom"}])

    def test_duplicate_counts_include_copies_hidden_by_filters(self):
        self.doggs.write_rows([
            self.row("a", file_hash="same"),
            self.row("b", file_hash="same", year="2024", is_duplicate="1", duplicate_of="a"),
            self.row("c", file_hash="other"),
        ])
        data = self.client.get("/api/index?duplicates=1&years=2025").json
        self.assertEqual([row["id"] for row in data["files"]], ["a"])
        self.assertEqual(data["duplicates_count"], 1)
        self.assertEqual(data["files"][0]["duplicate_count"], 1)

    def test_pagination_bounds_payload_and_covers_all_documents(self):
        self.doggs.write_rows([self.row(str(i), stored_path=f"2025/doc-{i:04}.txt") for i in range(145)])
        first = self.client.get("/api/index").json
        self.assertEqual(len(first["files"]), 60)
        self.assertEqual(first["pagination"]["total"], 145)
        self.assertEqual(first["pagination"]["year_counts"], {"2025": 145})
        self.assertEqual(first["pagination"]["next_offset"], 60)
        all_ids = [row["id"] for row in first["files"]]
        offset = first["pagination"]["next_offset"]
        while offset is not None:
            page = self.client.get("/api/index", query_string={"offset": offset, "revision": first["revision"]}).json
            self.assertEqual(page["years"], first["years"])
            all_ids.extend(row["id"] for row in page["files"])
            offset = page["pagination"]["next_offset"]
        self.assertEqual(len(all_ids), 145)
        self.assertEqual(len(set(all_ids)), 145)
        self.assertEqual(all_ids[0], "144")
        self.assertEqual(all_ids[-1], "0")

    def test_pagination_collapses_duplicates_before_slicing(self):
        self.doggs.write_rows([
            self.row("copy", stored_path="2025/z-copy.pdf", file_hash="same", is_duplicate="1", duplicate_of="original"),
            self.row("other", stored_path="2025/m-other.pdf", file_hash="other"),
            self.row("original", stored_path="2025/a-original.pdf", file_hash="same"),
        ])
        first = self.client.get("/api/index?limit=1").json
        second = self.client.get("/api/index?limit=1&offset=1").json
        self.assertEqual(first["pagination"]["total"], 2)
        self.assertEqual(first["files"][0]["id"], "other")
        self.assertEqual(second["files"][0]["id"], "original")
        self.assertEqual(second["files"][0]["duplicate_count"], 1)
        self.assertIsNone(second["pagination"]["next_offset"])

    def test_selected_document_remains_available_outside_page(self):
        self.doggs.write_rows([self.row(str(i), stored_path=f"2025/doc-{i:04}.txt") for i in range(70)])
        data = self.client.get("/api/index?document=0").json
        self.assertNotIn("0", [row["id"] for row in data["files"]])
        self.assertEqual(data["selected_file"]["id"], "0")

    def test_unchanged_poll_avoids_filtering_and_response_payload(self):
        self.doggs.write_rows([self.row()])
        first = self.client.get("/api/index")
        with patch.object(self.doggs, "search_rows", side_effect=AssertionError("unexpected filtering")):
            poll = self.client.get("/api/index", headers={"If-None-Match": first.headers["ETag"]})
        self.assertEqual(poll.status_code, 304)
        self.assertEqual(poll.data, b"")
        self.doggs.write_rows([self.row(summary="changed")])
        changed = self.client.get("/api/index", headers={"If-None-Match": first.headers["ETag"]})
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed.headers["ETag"], first.headers["ETag"])

    def test_revision_rejects_paging_after_archive_or_settings_change(self):
        self.doggs.write_rows([self.row()])
        revision = self.client.get("/api/index").json["revision"]
        self.doggs.write_settings({"ignored_tags": ["bank"]})
        self.assertEqual(self.client.get("/api/index", query_string={"revision": revision, "offset": 60}).status_code, 409)

    def test_invalid_page_parameters_are_rejected(self):
        self.doggs.write_rows([])
        for query in ("limit=0", "limit=201", "limit=bad", "offset=-1", "offset=bad"):
            with self.subTest(query=query):
                self.assertEqual(self.client.get("/api/index?" + query).status_code, 400)
        data = self.client.get("/api/index?offset=100").json
        self.assertEqual(data["files"], [])
        self.assertIsNone(data["pagination"]["next_offset"])

    def test_display_title_is_independent_of_filename_and_pdf_metadata(self):
        original = self.row(pdf_title="Embedded PDF title", summary="Existing summary")
        self.doggs.write_rows([original])
        response = self.client.post("/api/file/a", json={"display_title": "  Household\n electricity   bill  "})
        self.assertEqual(response.status_code, 200)
        saved = self.doggs.read_rows()[0]
        self.assertEqual(saved["display_title"], "Household electricity bill")
        for key in ("stored_path", "original_name", "file_hash", "pdf_title", "summary"):
            self.assertEqual(saved[key], original[key])
        document = self.client.get("/api/index?q=household").json["files"][0]
        self.assertEqual(document["title"], "Household electricity bill")
        self.assertEqual(document["name"], "invoice.pdf")
        self.assertIn("Household electricity bill", self.doggs.search_description(saved)[0])

    def test_clear_display_title_restores_automatic_title(self):
        self.doggs.write_rows([self.row(display_title="My title", pdf_title="Original title")])
        self.assertEqual(self.client.post("/api/file/a", json={"display_title": ""}).status_code, 200)
        self.assertEqual(self.client.get("/api/index").json["files"][0]["title"], "Original title")

    def test_automatic_title_uses_summary_before_unhelpful_filename(self):
        row = self.row(pdf_title="Untitled", stored_path="2025/scan-0001.pdf", summary="Electricity bill for February. Pay by March 1.")
        self.assertEqual(self.doggs.document_title(row), "Electricity bill for February.")
        row["summary"] = "A useful description " * 30
        self.assertLessEqual(len(self.doggs.document_title(row)), 100)
        row["summary"] = ""
        self.assertEqual(self.doggs.document_title(row), "scan 0001")

    def test_reextraction_preserves_custom_title(self):
        row = self.row(display_title="My permanent title", pdf_title="Embedded title")
        heuristic = {"classification": "document", "summary": "New extracted summary", "slug": "new", "tags": []}
        with patch.object(self.doggs, "choose_category", return_value=("invoice", "manual")), patch.object(self.doggs, "match_rule", return_value=(None, [])):
            self.doggs.replace_extracted_result(row, heuristic, {}, "Document content", "scan.pdf")
        self.assertEqual(row["display_title"], "My permanent title")
        self.assertEqual(row["pdf_title"], "Embedded title")
        self.assertEqual(row["summary"], "New extracted summary")

    def test_title_schema_migration_keeps_existing_metadata(self):
        original = self.row(pdf_title="Original PDF title", summary="Original summary")
        fields = [key for key in self.doggs.FIELDNAMES if key != "display_title"]
        with self.doggs.CSV_PATH.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            writer.writerow(original)
        saved = self.doggs.read_rows()[0]
        self.assertEqual(saved, original)
        self.assertEqual(saved["display_title"], "")

    def test_remove_quick_tag_keeps_document_tags_and_other_shortcuts(self):
        self.doggs.write_rows([self.row(tags="household")])
        self.doggs.write_settings({"favorite_tags": ["household", "bank"], "recent_tags": ["household", "tax"]})
        self.assertEqual(self.client.delete("/api/tags/household/quick").status_code, 200)
        settings = self.doggs.read_settings()
        self.assertEqual(settings["favorite_tags"], ["bank"])
        self.assertEqual(settings["recent_tags"], ["tax"])
        self.assertEqual(self.doggs.read_rows()[0]["tags"], "household")

    def test_renaming_quick_tag_updates_favorites_and_recent_aliases(self):
        self.doggs.write_settings({"favorite_tags": ["bank"], "recent_tags": ["bank", "tax"]})
        self.assertEqual(self.client.post("/api/tags/bank/rename", json={"canonical": "banking"}).status_code, 200)
        settings = self.doggs.read_settings()
        self.assertEqual(settings["favorite_tags"], ["banking"])
        self.assertEqual(settings["recent_tags"], ["banking", "tax"])
        self.assertEqual(self.client.delete("/api/tags/bank/quick").status_code, 200)
        self.assertEqual(self.doggs.read_settings()["favorite_tags"], [])

    def test_office_preview_returns_loading_then_pdf(self):
        root = Path(self.tmp.name)
        (root / "slide.pptx").write_bytes(b"synthetic Office document")
        self.doggs.write_rows([self.row(stored_path="slide.pptx")])
        with patch.object(self.doggs, "ARCHIVE_DIR", root), patch.object(self.doggs.OFFICE_PREVIEWS, "request", return_value=("rendering", None)):
            response = self.client.get("/preview?id=a")
            self.assertIn(b"Preparing document preview", response.data)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
        pdf = root / "converted.pdf"
        with self.doggs.fitz.open() as doc:
            doc.new_page()
            doc.save(pdf)
        with patch.object(self.doggs, "ARCHIVE_DIR", root), patch.object(self.doggs.OFFICE_PREVIEWS, "request", return_value=("ready", pdf)):
            response = self.client.get("/preview?id=a")
            self.assertEqual(response.mimetype, "application/pdf")
            response.close()

    def test_office_thumbnail_never_starts_background_conversion(self):
        root = Path(self.tmp.name)
        (root / "slide.pptx").write_bytes(b"synthetic Office document")
        self.doggs.write_rows([self.row(stored_path="slide.pptx")])
        with patch.object(self.doggs, "ARCHIVE_DIR", root), patch.object(self.doggs, "THUMB_DIR", root / "thumbs"), patch.object(self.doggs.OFFICE_PREVIEWS, "cached", return_value=None), patch.object(self.doggs.OFFICE_PREVIEWS, "request", side_effect=AssertionError("Conversion must be on demand")):
            self.assertEqual(self.client.get("/thumb?id=a").status_code, 404)

    def test_office_conversion_failure_keeps_text_preview(self):
        root = Path(self.tmp.name)
        (root / "slide.pptx").write_bytes(b"synthetic Office document")
        self.doggs.write_rows([self.row(stored_path="slide.pptx")])
        with patch.object(self.doggs, "ARCHIVE_DIR", root), patch.object(self.doggs.OFFICE_PREVIEWS, "request", return_value=("failed", None)), patch.object(self.doggs, "read_document_text", return_value=("Fallback slide text", "")):
            response = self.client.get("/preview?id=a")
            self.assertIn(b"Fallback slide text", response.data)
            self.assertIn(b"Visual preview is unavailable", response.data)

    def test_remove_quick_tag_from_document_removes_custom_and_inferred_copies(self):
        self.doggs.write_rows([self.row(tokens="household bank", tags="household")])
        response = self.client.delete("/api/file/a/tags/household?kind=all")
        self.assertEqual(response.status_code, 200)
        tags = response.json["tags"]
        self.assertNotIn("household", [entry["value"] for entry in tags])
        self.assertIn("banking", [entry["value"] for entry in tags])


if __name__ == "__main__":
    unittest.main()
