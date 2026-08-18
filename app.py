#!/usr/bin/env python3
"""DOGGS: local PDF intake, metadata extraction, and searchable archive."""
import csv
import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
from collections import Counter
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

import pymupdf as fitz
import pytesseract
import requests
from dateutil import parser as dateparser
from flask import Flask, abort, jsonify, render_template, request, send_file
from PIL import Image
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
# Local configuration is optional. Real process environment values take priority.
load_dotenv(BASE_DIR / ".env")
def configured_path(name, default):
    path = Path(os.getenv(name, str(default)))
    return path if path.is_absolute() else BASE_DIR / path

INCOMING_DIR = configured_path("INCOMING_DIR", BASE_DIR / "incoming")
ARCHIVE_DIR = configured_path("ARCHIVE_DIR", BASE_DIR / "archive")
DATA_DIR = configured_path("DATA_DIR", BASE_DIR / "data")
CSV_PATH = configured_path("CSV_PATH", DATA_DIR / "index.csv")
SETTINGS_PATH = configured_path("SETTINGS_PATH", DATA_DIR / "settings.json")
ERROR_DIR = configured_path("ERROR_DIR", BASE_DIR / "errors")
DUPLICATE_DIR = configured_path("DUPLICATE_DIR", BASE_DIR / "duplicates")
HOST, PORT = os.getenv("HOST", "0.0.0.0"), int(os.getenv("PORT", "8383"))
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "300"))
RECURSIVE_SCAN = os.getenv("RECURSIVE_SCAN", "0") == "1"
OCR_LANG = re.sub(r"[,\s]+", "+", os.getenv("OCR_LANG", "eng").strip()).strip("+") or "eng"
OCR_LANGS = tuple(language for language in OCR_LANG.split("+") if language)
OCR_DPI = int(os.getenv("OCR_DPI", "200"))
TOP_REGION_FRACTION, HEAD_PAGES = float(os.getenv("TOP_REGION_FRACTION", "0.25")), int(os.getenv("HEAD_PAGES", "2"))
OCR_TRIGGER_CHARS, MAX_SOURCE_CHARS = int(os.getenv("OCR_TRIGGER_CHARS", "80")), int(os.getenv("MAX_SOURCE_CHARS", "3000"))
MAX_TEXT_CHARS, MAX_FULL_TEXT_CHARS, AI_TIMEOUT = int(os.getenv("MAX_TEXT_CHARS", "300")), int(os.getenv("MAX_FULL_TEXT_CHARS", "12000")), int(os.getenv("AI_TIMEOUT", "60"))
AI_MODE, OLLAMA_URL = os.getenv("AI_MODE", "ollama"), os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
AI_MODEL = os.getenv("AI_MODEL", "qwen2.5:3b")
DATE_DAYFIRST = os.getenv("DATE_DAYFIRST", "1") == "1"
MAX_TOKEN_FACETS = int(os.getenv("MAX_TOKEN_FACETS", "80"))
FIELDNAMES = ["id", "file_hash", "original_name", "stored_path", "location", "date", "year", "slug", "classification", "summary", "tokens", "removed_tags", "tags", "ocr_text", "is_duplicate", "duplicate_of", "pdf_title", "pdf_author", "pdf_subject", "pdf_keywords", "pdf_creator", "pdf_producer", "source", "created_at"]
STOP_TAGS = {"the", "and", "for", "doc", "document", "pdf", "misc", "unknown", "fpdf", "pdflib", "printer", "linux", "php", "kunde", "page", "pages", "creator", "producer"}
PROMPT_STOP_WORDS = STOP_TAGS | {"a", "an", "are", "as", "at", "be", "by", "from", "in", "is", "it", "of", "on", "or", "that", "this", "to", "with", "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "einem", "einen", "und", "oder", "ist", "im", "in", "am", "an", "auf", "von", "für", "mit", "zu", "bei", "als", "auch", "nicht", "wie", "dass"}
CLASSIFICATION_RULES = [("invoice", ["invoice", "rechnung", "billing", "amount due", "zahlung"]), ("bank", ["bank statement", "kontoauszug", "iban", "balance", "transaction"]), ("insurance", ["insurance", "versicherung", "policy", "claim", "premium"]), ("contract", ["contract", "agreement", "vertrag", "terms"]), ("tax", ["tax", "steuer", "finanzamt", "vat"]), ("medical", ["medical", "arzt", "doctor", "patient"]), ("utility", ["electricity", "gas", "water", "internet", "phone"]), ("salary", ["salary", "payroll", "gehalt", "lohn"]), ("official", ["authority", "bescheid", "government", "court"]), ("receipt", ["receipt", "quittung", "purchase"])]

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("doggs")
if CSV_PATH.exists() and CSV_PATH.is_dir():
    log.warning("CSV_PATH points to a directory; using %s/index.csv", CSV_PATH)
    CSV_PATH = CSV_PATH / "index.csv"
app, CSV_LOCK, SCAN_LOCK = Flask(__name__), threading.RLock(), threading.Lock()
WORKER_STARTED = False
STATUS_CACHE = {"checked_at": 0.0, "payload": None}
PIPELINE_STATE = {"processing": "", "last_scan": "", "last_error": "", "processed": 0, "paused": False}
FULL_SCAN_STATE = {}
OCR_SCAN_STATE = {}
NORMAL_SCAN_STATE = {}
LLM_RERUN_STATE = {"state": "idle", "current": 0, "total": 0, "error": ""}
SCHEDULE_STATE = {"last_interval": 0.0, "daily_runs": set()}
LEGACY_METADATA_PROMPT = "Return JSON: date (YYYY-MM-DD|null), classification (one lowercase word such as invoice), tags (array of 2-5 short lowercase hyphenated tags), slug (2-5 lowercase hyphenated words based on the useful tags), summary (one accurate <=160-character sentence). For a German invoice, tags should resemble rechnung, firma-sattig, darmstadt, rechnungsdatum — never fpdf, pdflib, printer, php, or linux."
DEFAULT_METADATA_PROMPT = """Extract metadata only from the supplied document text. Return one JSON object and nothing else:
{"date":"YYYY-MM-DD or null","classification":"one lowercase category","tags":["2 to 5 lowercase-hyphenated tags"],"slug":"2 to 5 lowercase-hyphenated words","summary":"one accurate sentence, at most 160 characters"}.

Tags must be specific facts visibly present in this document: its document type, the actual sender/company/person, actual city, or a meaningful labelled date. Do not use examples, defaults, guesses, or facts from another document. If a fact is not present, omit it; fewer tags are better than invented tags. Never use PDF generator, software, printer, operating-system, web-browser, or OCR artefact names. For an invoice, include the document-type tag only when the text says it is an invoice; use the real company and real place only when they occur in the text."""
DEFAULT_SUMMARY_PROMPT = "Summarize documents accurately in one concise paragraph. Return only the summary."

def ensure_dirs():
    for path in (INCOMING_DIR, ARCHIVE_DIR, DATA_DIR, ERROR_DIR, DUPLICATE_DIR, CSV_PATH.parent): path.mkdir(parents=True, exist_ok=True)

def ensure_csv():
    global CSV_PATH
    if CSV_PATH.exists() and CSV_PATH.is_dir():
        log.warning("CSV_PATH points to a directory; using %s/index.csv", CSV_PATH)
        CSV_PATH = CSV_PATH / "index.csv"
    if not CSV_PATH.exists():
        with CSV_PATH.open("w", newline="", encoding="utf-8") as f: csv.DictWriter(f, fieldnames=FIELDNAMES).writeheader()
        return
    with CSV_PATH.open(newline="", encoding="utf-8") as f:
        existing = list(csv.DictReader(f)); existing_fields = f.seek(0) or next(csv.reader(f), [])
    if existing_fields != FIELDNAMES:
        with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDNAMES, extrasaction="ignore")
            writer.writeheader(); writer.writerows(existing)

def read_rows():
    with CSV_LOCK:
        ensure_dirs(); ensure_csv()
        with CSV_PATH.open(newline="", encoding="utf-8") as f:
            return [{field: row.get(field, "") for field in FIELDNAMES} for row in csv.DictReader(f)]

def write_rows(rows):
    with CSV_LOCK:
        ensure_dirs(); ensure_csv()
        with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDNAMES, extrasaction="ignore"); writer.writeheader(); writer.writerows(rows)

def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""): digest.update(chunk)
    return digest.hexdigest()

def slugify(value):
    value = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower())
    return re.sub(r"-{2,}", "-", value).strip("-")[:60].strip("-") or "document"

def tag_values(value):
    values = value if isinstance(value, (list, tuple, set)) else re.split(r"[\s,]+", str(value or ""))
    return [slugify(tag) for tag in values if str(tag).strip() and slugify(tag) != "document"]

def compact_prompt_text(text):
    words = re.findall(r"[\wÄÖÜäöüß.-]+", text)
    return " ".join(word for word in words if word.lower().strip(".-") not in PROMPT_STOP_WORDS)[:MAX_TEXT_CHARS]

def read_settings():
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, AttributeError):
        data = {}
    prompts, schedule = data.get("prompts", {}), data.get("schedule", {})
    metadata_prompt = str(prompts.get("metadata") or DEFAULT_METADATA_PROMPT)
    # Upgrade the former prompt: its literal invoice example made small models copy
    # those company/city values into unrelated documents.
    if metadata_prompt == LEGACY_METADATA_PROMPT:
        metadata_prompt = DEFAULT_METADATA_PROMPT
    times = [value for value in schedule.get("daily_times", []) if re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", str(value))]
    return {"ignored_tags": sorted(set(tag_values(data.get("ignored_tags", []))),), "prompts": {"metadata": metadata_prompt, "summary": str(prompts.get("summary") or DEFAULT_SUMMARY_PROMPT)}, "schedule": {"mode": "daily" if schedule.get("mode") == "daily" else "interval", "interval_minutes": max(1, min(10080, int(schedule.get("interval_minutes", max(1, POLL_SECONDS // 60)) or 1))), "daily_times": sorted(set(times))}}

def write_settings(settings):
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")

def ignored_tags(): return set(read_settings()["ignored_tags"])

def save_ignored_tags(tags):
    settings = read_settings(); settings["ignored_tags"] = sorted(set(tag_values(tags))); write_settings(settings)

def inferred_tags(row):
    stored = tag_values(row.get("tokens", ""))
    removed = set(tag_values(row.get("removed_tags", "")))
    return [tag for tag in (stored or tag_values(row.get("slug", ""))) if tag not in STOP_TAGS and tag not in ignored_tags() and tag not in removed]

def custom_tags(row): return tag_values(row.get("tags", ""))
def row_tags(row): return set(inferred_tags(row) + custom_tags(row))
def document_tags(row):
    inferred, custom = inferred_tags(row), custom_tags(row)
    return [{"value": tag, "kind": "inferred"} for tag in inferred if tag not in custom] + [{"value": tag, "kind": "custom"} for tag in custom]

def unique_path(path):
    if not path.exists(): return path
    for number in range(2, 10000):
        candidate = path.with_name(f"{path.stem}-{number}{path.suffix}")
        if not candidate.exists(): return candidate
    raise RuntimeError(f"Could not create a unique path for {path}")

def move_to_side_dir(path, directory):
    directory.mkdir(parents=True, exist_ok=True); shutil.move(str(path), unique_path(directory / path.name))

def is_stable(path, checks=3, interval=.35):
    try:
        size = path.stat().st_size
        for _ in range(checks):
            time.sleep(interval)
            if path.stat().st_size != size: return False
        return True
    except OSError: return False

def is_within(base, target):
    try: target.resolve().relative_to(base.resolve()); return True
    except ValueError: return False

def valid_date(year, month, day):
    try: return date(int(year), int(month), int(day))
    except ValueError: return None

def parse_any_date(value):
    try: return dateparser.parse(str(value)).date() if value else None
    except Exception: return None

def parse_pdf_date(doc):
    for raw in (doc.metadata or {}).values():
        match = re.search(r"D:(\d{4})(\d{2})(\d{2})", str(raw or ""))
        if match:
            parsed = valid_date(*match.groups())
            if parsed: return parsed
    return None

def extract_pdf_metadata(doc):
    metadata = doc.metadata or {}
    names = {"pdf_title": "title", "pdf_author": "author", "pdf_subject": "subject", "pdf_keywords": "keywords", "pdf_creator": "creator", "pdf_producer": "producer"}
    return {field: re.sub(r"\s+", " ", str(metadata.get(name) or "")).strip()[:500] for field, name in names.items()}

def ocr_top_region(path, doc=None):
    own_doc = doc is None
    try:
        doc = doc or fitz.open(path)
        if not len(doc): return ""
        pix = doc.load_page(0).get_pixmap(matrix=fitz.Matrix(max(1, OCR_DPI / 72), max(1, OCR_DPI / 72)), alpha=False)
        image = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        return pytesseract.image_to_string(image.crop((0, 0, image.width, max(1, int(image.height * TOP_REGION_FRACTION)))), lang=OCR_LANG)
    except Exception:
        log.exception("OCR failed for %s", path); return ""
    finally:
        if own_doc and doc: doc.close()

def extract_visible_text(path):
    doc = fitz.open(path)
    try:
        parts = []
        for index in range(min(len(doc), HEAD_PAGES)):
            page = doc.load_page(index); rect = page.rect
            parts.append(page.get_text("text", clip=fitz.Rect(rect.x0, rect.y0, rect.x1, rect.y0 + rect.height * TOP_REGION_FRACTION)))
        text, source = "\n".join(parts).strip(), "pdf-text"
        if len(text) < OCR_TRIGGER_CHARS:
            ocr = ocr_top_region(path, doc)
            if ocr.strip(): text, source = f"{text}\n{ocr}".strip(), "ocr"
        return re.sub(r"\s+", " ", text).strip()[:MAX_SOURCE_CHARS], source
    finally: doc.close()

def extract_normal_text(path):
    """Read complete native text from the first pages; OCR only when the PDF has no text layer."""
    doc = fitz.open(path)
    try:
        text = "\n".join(doc.load_page(index).get_text("text") for index in range(min(len(doc), HEAD_PAGES))).strip()
        source = "pdf-text"
        if len(text) < OCR_TRIGGER_CHARS:
            ocr = ocr_top_region(path, doc)
            if ocr.strip(): text, source = f"{text}\n{ocr}".strip(), "ocr"
        return re.sub(r"\s+", " ", text).strip()[:MAX_SOURCE_CHARS], source
    finally: doc.close()

def parse_text_date(text):
    for match in re.finditer(r"\b(\d{4})[-./](\d{1,2})[-./](\d{1,2})\b", text):
        if parsed := valid_date(*match.groups()): return parsed
    for match in re.finditer(r"\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b", text):
        first, second, year = match.groups(); parsed = valid_date(year, second if DATE_DAYFIRST else first, first if DATE_DAYFIRST else second)
        if parsed: return parsed
    return None

def heuristic_extract(text, filename):
    lower = text.lower(); classification = next((kind for kind, words in CLASSIFICATION_RULES if any(word in lower for word in words)), "document")
    tags = {"invoice": ["rechnung"], "contract": ["vertrag"], "receipt": ["beleg"], "bank": ["konto"], "insurance": ["versicherung"]}.get(classification, [classification])
    company = re.search(r"\b(?:firma|fa\.?)[\s:]+([A-ZÄÖÜ][\wÄÖÜäöüß.& -]{2,60})", text, re.I)
    if company:
        name = re.sub(r"\s+(?:inh\.?|herr|frau)\b.*", "", company.group(1), flags=re.I).strip(" ,.")
        if name: tags.append(f"firma-{name}")
    city = re.search(r"\b(?:D-)?\d{5}\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß-]{2,})", text)
    if city: tags.append(city.group(1))
    date_match = re.search(r"\brechnungsdatum\s*:\s*(\d{1,2}[./]\d{1,2}[./]\d{4})", text, re.I)
    if date_match: tags.append("rechnungsdatum")
    tags = list(dict.fromkeys(tag_values(tags)))
    company_label = company.group(1).split(" Inh.")[0].strip() if company else ""
    city_label = city.group(1) if city else ""
    if classification == "invoice":
        details = ", ".join(value for value in (company_label, city_label, f"Rechnungsdatum {date_match.group(1)}" if date_match else "") if value)
        summary = f"Rechnung{(' von ' + details) if details else ''}."
    else: summary = re.sub(r"\s+", " ", text).strip()[:220]
    return {"classification": classification, "slug": "-".join(tags[:3]) or slugify(Path(filename).stem).split("-")[0], "tags": tags, "summary": summary}

def relevant_ai_tags(tags, text):
    words = set(re.findall(r"[a-z0-9äöüß]+", text.lower()))
    relevant = []
    for tag in tag_values(tags):
        parts = [part for part in tag.split("-") if part]
        if parts and all(part in words for part in parts): relevant.append(tag)
    return relevant

def combined_tags(heuristic, extracted, text):
    base = heuristic["tags"]
    extra = relevant_ai_tags(extracted.get("tags", []), text)
    return list(dict.fromkeys(base + extra))

def ai_extract(text):
    if AI_MODE != "ollama" or len(text.strip()) < 20: return {}
    prompt = read_settings()["prompts"]["metadata"]
    payload = {"model": AI_MODEL, "stream": False, "format": "json", "options": {"temperature": 0, "num_predict": 260}, "messages": [{"role": "system", "content": "Return only valid JSON. Every extracted tag must be grounded in the supplied document text. Never copy names, places, or tag values from instructions. Omit uncertain data instead of guessing. Ignore PDF generators, software names, headers/footers, and OCR garbage. Write the summary in the document language."}, {"role": "user", "content": prompt + "\n\nDocument evidence (common stop words removed):\n" + compact_prompt_text(text)}]}
    try:
        raw = requests.post(f"{OLLAMA_URL.rstrip('/')}/api/chat", json=payload, timeout=AI_TIMEOUT).json().get("message", {}).get("content", "")
        match = re.search(r"\{.*\}", raw, re.S); data = json.loads(match.group() if match else raw)
        extracted = {key: str(value).strip() for key, value in data.items() if key in {"date", "classification", "slug", "summary"} and value not in (None, "", "null", "unknown")}
        extracted["tags"] = tag_values(data.get("tags", []))
        return extracted
    except Exception:
        log.warning("Ollama extraction failed; using deterministic heuristics."); return {}

def ai_summary(text):
    if AI_MODE != "ollama" or not text.strip(): return ""
    payload = {"model": AI_MODEL, "stream": False, "options": {"temperature": 0, "num_predict": 260}, "messages": [{"role": "system", "content": read_settings()["prompts"]["summary"]}, {"role": "user", "content": re.sub(r"\s+", " ", text)[:MAX_FULL_TEXT_CHARS]}]}
    try:
        response = requests.post(f"{OLLAMA_URL.rstrip('/')}/api/chat", json=payload, timeout=max(AI_TIMEOUT, 180)); response.raise_for_status()
        return response.json().get("message", {}).get("content", "").strip()[:1000]
    except requests.RequestException:
        log.warning("Ollama full-document summary failed."); return ""

def ocr_text(path, all_pages=False):
    parts = []
    with fitz.open(path) as doc:
        for index in range(len(doc) if all_pages else min(len(doc), 1)):
            page = doc.load_page(index); zoom = max(1, OCR_DPI / 72); pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            image = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            parts.append(pytesseract.image_to_string(image, lang=OCR_LANG))
    return re.sub(r"\s+", " ", "\n".join(parts)).strip()[:MAX_FULL_TEXT_CHARS]

def full_ocr_text(path): return ocr_text(path, all_pages=True)

def file_path_for_row(row):
    base = DUPLICATE_DIR if row.get("location") == "duplicates" else ARCHIVE_DIR
    return (base / row.get("stored_path", "")).resolve()

def run_full_scan(row_id):
    FULL_SCAN_STATE[row_id] = {"state": "running", "error": ""}
    try:
        rows = read_rows(); row = next((item for item in rows if item.get("id") == row_id), None)
        if not row: raise ValueError("Document no longer exists in the index.")
        text = full_ocr_text(file_path_for_row(row))
        if not text: raise ValueError("OCR returned no text. Check the configured OCR language.")
        summary = ai_summary(text) or re.sub(r"\s+", " ", text)[:1000]
        rows = read_rows()
        for item in rows:
            if item.get("id") == row_id:
                item["summary"] = summary; item["ocr_text"] = text; item["source"] = "full-ocr"; break
        write_rows(rows)
        FULL_SCAN_STATE[row_id] = {"state": "complete", "error": ""}
    except Exception as exc:
        log.exception("Full scan failed for %s", row_id)
        FULL_SCAN_STATE[row_id] = {"state": "error", "error": str(exc)}

def run_ocr(row_id, all_pages):
    OCR_SCAN_STATE[row_id] = {"state": "running", "error": ""}
    try:
        rows = read_rows(); row = next((item for item in rows if item.get("id") == row_id), None)
        if not row: raise ValueError("Document no longer exists in the index.")
        text = ocr_text(file_path_for_row(row), all_pages=all_pages)
        if not text: raise ValueError("OCR returned no text. Check the configured OCR language.")
        for item in rows:
            if item.get("id") == row_id: item["ocr_text"] = text; break
        write_rows(rows); OCR_SCAN_STATE[row_id] = {"state": "complete", "error": ""}
    except Exception as exc:
        log.exception("OCR failed for %s", row_id); OCR_SCAN_STATE[row_id] = {"state": "error", "error": str(exc)}

def run_normal_pipeline(row_id):
    NORMAL_SCAN_STATE[row_id] = {"state": "running", "error": ""}
    try:
        rows = read_rows(); row = next((item for item in rows if item.get("id") == row_id), None)
        if not row: raise ValueError("Document no longer exists in the index.")
        path = file_path_for_row(row)
        with fitz.open(path) as doc:
            pdf_metadata = extract_pdf_metadata(doc)
        metadata = " ".join(pdf_metadata[key] for key in ("pdf_title", "pdf_author", "pdf_subject", "pdf_keywords") if pdf_metadata.get(key))
        text, source = (row.get("ocr_text", ""), "saved-ocr") if row.get("ocr_text", "").strip() else extract_normal_text(path)
        analysis = f"{metadata} {text}".strip()
        heuristic, extracted = heuristic_extract(analysis, path.name), ai_extract(analysis)
        tags = combined_tags(heuristic, extracted, analysis)
        rows = read_rows()
        for item in rows:
            if item.get("id") != row_id: continue
            item["classification"] = slugify(heuristic["classification"] if heuristic["classification"] != "document" else extracted.get("classification") or "document")
            item["summary"] = (heuristic["summary"] if heuristic["classification"] == "invoice" else extracted.get("summary") or heuristic["summary"]).strip()[:240]
            item["tokens"] = " ".join(tags)
            item["removed_tags"] = ""
            item["slug"] = slugify("-".join(tags[:3]) or heuristic["slug"])
            item["source"] = source
            break
        write_rows(rows)
        NORMAL_SCAN_STATE[row_id] = {"state": "complete", "error": ""}
    except Exception as exc:
        log.exception("Normal pipeline rerun failed for %s", row_id)
        NORMAL_SCAN_STATE[row_id] = {"state": "error", "error": str(exc)}

def run_llm_rerun(row_ids):
    LLM_RERUN_STATE.update(state="running", current=0, total=len(row_ids), error="")
    try:
        for row_id in row_ids:
            rows = read_rows(); row = next((item for item in rows if item.get("id") == row_id), None)
            if row:
                with fitz.open(file_path_for_row(row)) as doc:
                    pdf_metadata = extract_pdf_metadata(doc)
                    metadata = " ".join(pdf_metadata[key] for key in ("pdf_title", "pdf_author", "pdf_subject", "pdf_keywords") if pdf_metadata.get(key))
                text, _ = extract_normal_text(file_path_for_row(row)); analysis = f"{metadata} {text}".strip()
                heuristic, extracted = heuristic_extract(analysis, Path(row["stored_path"]).name), ai_extract(analysis)
                tags = combined_tags(heuristic, extracted, analysis)
                row["classification"] = slugify(heuristic["classification"] if heuristic["classification"] != "document" else extracted.get("classification") or row["classification"])
                row["summary"] = heuristic["summary"] if heuristic["classification"] == "invoice" else extracted.get("summary") or heuristic["summary"] or row["summary"]
                row["tokens"] = " ".join(tags); row["removed_tags"] = ""; row["slug"] = slugify("-".join(tags[:3]) or heuristic["slug"])
                write_rows(rows)
            LLM_RERUN_STATE["current"] += 1
        LLM_RERUN_STATE["state"] = "complete"
    except Exception as exc:
        log.exception("LLM rerun failed"); LLM_RERUN_STATE.update(state="error", error=str(exc))

def process_file(path):
    file_hash, rows = sha256_file(path), read_rows()
    original = next((row for row in rows if row.get("file_hash") == file_hash and row.get("location") != "duplicates"), None)
    if original:
        destination = unique_path(DUPLICATE_DIR / path.name); shutil.move(str(path), destination)
        rows.append({**original, "id": f"{file_hash[:12]}-{int(time.time() * 1000)}", "original_name": path.name, "stored_path": destination.relative_to(DUPLICATE_DIR).as_posix(), "location": "duplicates", "is_duplicate": "1", "duplicate_of": original.get("id", ""), "created_at": datetime.now(UTC).isoformat(timespec="seconds")})
        write_rows(rows); log.info("Stored duplicate %s", destination); return
    try:
        with fitz.open(path) as doc:
            pdf_date = parse_pdf_date(doc)
            pdf_metadata = extract_pdf_metadata(doc)
        text, source = extract_normal_text(path)
    except Exception: raise
    metadata_text = " ".join(pdf_metadata[key] for key in ("pdf_title", "pdf_author", "pdf_subject", "pdf_keywords") if pdf_metadata.get(key))
    analysis_text = f"{metadata_text} {text}".strip()
    heuristics, ai = heuristic_extract(analysis_text, path.name), ai_extract(analysis_text)
    final_date = parse_any_date(ai.get("date")) or parse_text_date(analysis_text) or pdf_date or datetime.fromtimestamp(path.stat().st_mtime).date()
    classification = slugify(ai.get("classification") or heuristics["classification"])
    inferred = combined_tags(heuristics, ai, analysis_text)
    slug = slugify("-".join(inferred[:3]) or heuristics["slug"] or classification)
    destination = unique_path(ARCHIVE_DIR / str(final_date.year) / f"{final_date.isoformat()}_{slug}.pdf"); destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), destination)
    rows.append({"id": file_hash[:16], "file_hash": file_hash, "original_name": path.name, "stored_path": destination.relative_to(ARCHIVE_DIR).as_posix(), "location": "archive", "date": final_date.isoformat(), "year": str(final_date.year), "slug": slug, "classification": classification, "summary": (heuristics["summary"] if heuristics["classification"] == "invoice" else ai.get("summary") or heuristics["summary"] or text[:220]).strip()[:240], "tokens": " ".join(inferred), "removed_tags": "", "tags": "", "is_duplicate": "", "duplicate_of": "", **pdf_metadata, "source": source, "created_at": datetime.now(UTC).isoformat(timespec="seconds")})
    write_rows(rows); log.info("Archived %s", destination)

def scan_incoming():
    if not SCAN_LOCK.acquire(blocking=False):
        return
    try:
        managed_dirs = (ARCHIVE_DIR, ERROR_DIR, DUPLICATE_DIR)
        source_paths = INCOMING_DIR.rglob("*") if RECURSIVE_SCAN else INCOMING_DIR.iterdir()
        candidates = sorted((p for p in source_paths if p.is_file() and p.suffix.lower() == ".pdf" and not any(is_within(directory, p) for directory in managed_dirs)), key=lambda p: p.stat().st_mtime)
        for path in candidates:
            if PIPELINE_STATE["paused"]:
                break
            if not is_stable(path):
                continue
            PIPELINE_STATE["processing"] = path.name
            try:
                process_file(path)
                PIPELINE_STATE["processed"] += 1
            except Exception as exc:
                PIPELINE_STATE["last_error"] = f"{path.name}: {exc}"
                log.exception("Could not process %s", path)
                move_to_side_dir(path, ERROR_DIR)
            finally:
                PIPELINE_STATE["processing"] = ""
        PIPELINE_STATE["last_scan"] = datetime.now().isoformat(timespec="seconds")
        STATUS_CACHE["payload"] = None
    finally:
        SCAN_LOCK.release()

def due_for_background_scan():
    schedule = read_settings()["schedule"]
    if schedule["mode"] == "daily":
        now = datetime.now(); key = f"{now.date().isoformat()}-{now.strftime('%H:%M')}"
        SCHEDULE_STATE["daily_runs"] = {value for value in SCHEDULE_STATE["daily_runs"] if value.startswith(now.date().isoformat())}
        if now.strftime("%H:%M") in schedule["daily_times"] and key not in SCHEDULE_STATE["daily_runs"]:
            SCHEDULE_STATE["daily_runs"].add(key); return True
        return False
    now = time.monotonic()
    if now - SCHEDULE_STATE["last_interval"] >= schedule["interval_minutes"] * 60:
        SCHEDULE_STATE["last_interval"] = now; return True
    return False

def scan_loop():
    while True:
        try:
            if not PIPELINE_STATE["paused"] and due_for_background_scan(): scan_incoming()
        except Exception: log.exception("Scanner failed")
        time.sleep(15)

def start_worker():
    global WORKER_STARTED
    if not WORKER_STARTED: WORKER_STARTED = True; threading.Thread(target=scan_loop, daemon=True).start()

def search_rows(rows, query):
    terms = query.lower().split()
    return [row for row in rows if all(term in " ".join(row.get(key, "") for key in FIELDNAMES).lower() for term in terms)]

@app.route("/")
def index(): return render_template("index.html")

@app.route("/api/index")
def api_index():
    query = request.args.get("q", "").strip(); years = set(filter(None, request.args.get("years", "").split(","))); tokens = set(filter(None, request.args.get("tokens", "").split(","))); duplicates = request.args.get("duplicates") == "1"; rows = read_rows()
    duplicate_hashes = {value for value, count in Counter(row.get("file_hash") for row in rows if row.get("file_hash")).items() if count > 1}
    searched = search_rows(rows, query); files = [row for row in searched if (not years or row.get("year") in years) and (not tokens or tokens.issubset(row_tags(row))) and (not duplicates or row.get("file_hash") in duplicate_hashes)]
    year_rows = [row for row in searched if (not tokens or tokens.issubset(row_tags(row))) and (not duplicates or row.get("file_hash") in duplicate_hashes)]
    tag_rows = [row for row in searched if (not years or row.get("year") in years) and (not tokens or tokens.issubset(row_tags(row))) and (not duplicates or row.get("file_hash") in duplicate_hashes)]
    counts = Counter(tag for row in tag_rows for tag in row_tags(row))
    files.sort(key=lambda row: (row.get("date", ""), row.get("stored_path", "")), reverse=True)
    return jsonify({"years": [{"value": value, "count": count, "selected": value in years} for value, count in sorted(Counter(row.get("year") for row in year_rows if row.get("year")).items(), reverse=True)], "tags": [{"value": value, "count": count, "selected": value in tokens} for value, count in counts.most_common(MAX_TOKEN_FACETS)], "duplicates_count": len(duplicate_hashes), "files": [{**row, "name": Path(row.get("stored_path", "")).name, "document_tags": document_tags(row), "url": f"/file?id={quote(row.get('id', ''))}", "full_scan": FULL_SCAN_STATE.get(row.get("id"), {}), "ocr_scan": OCR_SCAN_STATE.get(row.get("id"), {}), "normal_scan": NORMAL_SCAN_STATE.get(row.get("id"), {})} for row in files]})

@app.post("/api/file/<row_id>")
def update_file(row_id):
    payload = request.get_json(silent=True) or {}; rows = read_rows(); row = next((item for item in rows if item.get("id") == row_id), None)
    if not row: abort(404)
    if "tags" in payload:
        row["tags"] = " ".join(dict.fromkeys(slugify(tag) for tag in re.split(r"[\s,]+", str(payload["tags"])) if tag and slugify(tag) != "document"))
    if "summary" in payload: row["summary"] = str(payload["summary"]).strip()[:4000]
    if "year" in payload or "filename" in payload:
        current_path = file_path_for_row(row)
        filename = Path(str(payload.get("filename", current_path.name))).name.strip()
        if not filename or filename in {".", ".."}: abort(400, "Filename cannot be empty.")
        if not filename.lower().endswith(".pdf"): filename += ".pdf"
        if row.get("location") == "duplicates":
            destination = DUPLICATE_DIR / filename
        else:
            year = str(payload.get("year", row.get("year", ""))).strip()
            if not re.fullmatch(r"\d{4}", year): abort(400, "Year must contain four digits.")
            destination = ARCHIVE_DIR / year / filename
            row["year"] = year
        if current_path != destination.resolve():
            destination = unique_path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if current_path != destination.resolve():
            shutil.move(str(current_path), destination)
        base = DUPLICATE_DIR if row.get("location") == "duplicates" else ARCHIVE_DIR
        row["stored_path"] = destination.relative_to(base).as_posix()
    write_rows(rows)
    return jsonify({"ok": True, "tags": row["tags"], "summary": row["summary"], "year": row["year"], "name": Path(row["stored_path"]).name})

@app.route("/api/file/<row_id>/details", methods=["GET", "POST"])
def file_details(row_id):
    rows = read_rows(); row = next((item for item in rows if item.get("id") == row_id), None)
    if not row: abort(404)
    if request.method == "POST":
        row["ocr_text"] = str((request.get_json(silent=True) or {}).get("ocr_text", ""))[:MAX_FULL_TEXT_CHARS]
        write_rows(rows)
    metadata = {key.removeprefix("pdf_"): row.get(key, "") for key in ("pdf_title", "pdf_author", "pdf_subject", "pdf_keywords", "pdf_creator", "pdf_producer") if row.get(key)}
    return jsonify({"ocr_text": row.get("ocr_text", ""), "metadata": metadata, "ocr_scan": OCR_SCAN_STATE.get(row_id, {}), "normal_scan": NORMAL_SCAN_STATE.get(row_id, {})})

@app.post("/api/file/<row_id>/ocr")
def ocr_file(row_id):
    if OCR_SCAN_STATE.get(row_id, {}).get("state") == "running": return jsonify({"started": False, "message": "OCR is already running."}), 409
    if not any(row.get("id") == row_id for row in read_rows()): abort(404)
    all_pages = bool((request.get_json(silent=True) or {}).get("all_pages", False))
    threading.Thread(target=run_ocr, args=(row_id, all_pages), daemon=True).start()
    return jsonify({"started": True})

@app.post("/api/file/<row_id>/tags")
def add_file_tag(row_id):
    tag = slugify(str((request.get_json(silent=True) or {}).get("tag", "")))
    if tag == "document": abort(400, "Enter a tag.")
    rows = read_rows(); row = next((item for item in rows if item.get("id") == row_id), None)
    if not row: abort(404)
    row["tags"] = " ".join(dict.fromkeys(custom_tags(row) + [tag]))
    write_rows(rows)
    return jsonify({"ok": True, "tags": document_tags(row)})

@app.delete("/api/file/<row_id>/tags/<tag>")
def remove_file_tag(row_id, tag):
    tag = slugify(tag); rows = read_rows(); row = next((item for item in rows if item.get("id") == row_id), None)
    if not row: abort(404)
    row["tags"] = " ".join(value for value in custom_tags(row) if value != tag)
    row["removed_tags"] = " ".join(dict.fromkeys(tag_values(row.get("removed_tags", "")) + [tag]))
    write_rows(rows)
    return jsonify({"ok": True, "tags": document_tags(row)})

@app.post("/api/file/<row_id>/full-scan")
def full_scan_file(row_id):
    if FULL_SCAN_STATE.get(row_id, {}).get("state") == "running": return jsonify({"started": False, "message": "Full scan already running."}), 409
    if not any(row.get("id") == row_id for row in read_rows()): abort(404)
    threading.Thread(target=run_full_scan, args=(row_id,), daemon=True).start()
    return jsonify({"started": True})

@app.post("/api/file/<row_id>/rerun-pipeline")
def rerun_file_pipeline(row_id):
    if NORMAL_SCAN_STATE.get(row_id, {}).get("state") == "running": return jsonify({"started": False, "message": "Pipeline is already running."}), 409
    if not any(row.get("id") == row_id for row in read_rows()): abort(404)
    threading.Thread(target=run_normal_pipeline, args=(row_id,), daemon=True).start()
    return jsonify({"started": True})

@app.route("/api/status")
def api_status():
    """Report local service configuration without making Ollama a dependency."""
    now = time.monotonic()
    if STATUS_CACHE["payload"] and now - STATUS_CACHE["checked_at"] < 15:
        return jsonify(STATUS_CACHE["payload"])

    available, error = [], ""
    connected = False
    if AI_MODE == "ollama":
        try:
            response = requests.get(f"{OLLAMA_URL.rstrip('/')}/api/tags", timeout=2)
            response.raise_for_status()
            available = [model.get("name", "") for model in response.json().get("models", [])]
            connected = True
        except requests.RequestException:
            error = "Ollama unavailable"
    else:
        error = "Heuristic mode enabled"

    try:
        ocr_languages = pytesseract.get_languages(config="")
    except Exception:
        ocr_languages = []
    waiting = []
    if INCOMING_DIR.exists():
        source_paths = INCOMING_DIR.rglob("*.pdf") if RECURSIVE_SCAN else INCOMING_DIR.glob("*.pdf")
        for path in sorted(source_paths, key=lambda item: item.stat().st_mtime):
            waiting.append({"name": path.name, "size": path.stat().st_size, "state": "processing" if path.name == PIPELINE_STATE["processing"] else "waiting"})
    payload = {
        "ollama_enabled": AI_MODE == "ollama",
        "ollama_connected": connected,
        "ollama_url": OLLAMA_URL,
        "model": AI_MODEL,
        "model_available": AI_MODEL in available,
        "error": error,
        "ocr_language": OCR_LANG,
        "ocr_available": all(language in ocr_languages for language in OCR_LANGS),
        "pipeline": {"waiting": waiting[:30], "waiting_count": len(waiting), "schedule": read_settings()["schedule"], **PIPELINE_STATE},
        "llm_rerun": LLM_RERUN_STATE,
    }
    STATUS_CACHE.update(checked_at=now, payload=payload)
    return jsonify(payload)

@app.post("/api/scan")
def api_scan():
    if SCAN_LOCK.locked():
        return jsonify({"started": False, "message": "A scan is already in progress."}), 409
    STATUS_CACHE["payload"] = None
    threading.Thread(target=scan_incoming, daemon=True).start()
    return jsonify({"started": True})

@app.post("/api/pipeline/pause")
def toggle_pipeline_pause():
    PIPELINE_STATE["paused"] = not PIPELINE_STATE["paused"]
    STATUS_CACHE["payload"] = None
    return jsonify({"paused": PIPELINE_STATE["paused"]})

@app.route("/api/settings", methods=["GET", "POST"])
def settings():
    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        current = read_settings(); current["ignored_tags"] = sorted(set(tag_values(payload.get("ignored_tags", current["ignored_tags"]))))
        prompts = payload.get("prompts", {})
        if isinstance(prompts, dict):
            for key in ("metadata", "summary"):
                if key in prompts: current["prompts"][key] = str(prompts[key]).strip() or (DEFAULT_METADATA_PROMPT if key == "metadata" else DEFAULT_SUMMARY_PROMPT)
        schedule = payload.get("schedule", {})
        if isinstance(schedule, dict):
            current["schedule"]["mode"] = "daily" if schedule.get("mode") == "daily" else "interval"
            try: current["schedule"]["interval_minutes"] = max(1, min(10080, int(schedule.get("interval_minutes", current["schedule"]["interval_minutes"]))))
            except (TypeError, ValueError): pass
            values = schedule.get("daily_times", current["schedule"]["daily_times"])
            if isinstance(values, str): values = re.split(r"[\s,]+", values)
            if isinstance(values, list): current["schedule"]["daily_times"] = sorted(set(value for value in values if re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", str(value))))
        write_settings(current); STATUS_CACHE["payload"] = None
    return jsonify(read_settings())

@app.post("/api/tags/<tag>/ignore")
def ignore_tag(tag):
    save_ignored_tags(list(ignored_tags()) + [tag])
    return jsonify({"ignored_tags": sorted(ignored_tags())})

@app.post("/api/rerun-llm")
def api_rerun_llm():
    row_ids = [str(value) for value in (request.get_json(silent=True) or {}).get("ids", []) if value]
    if not row_ids: return jsonify({"started": False, "message": "No matching documents."}), 400
    if LLM_RERUN_STATE.get("state") == "running": return jsonify({"started": False, "message": "LLM rerun already in progress."}), 409
    threading.Thread(target=run_llm_rerun, args=(row_ids,), daemon=True).start()
    return jsonify({"started": True, "count": len(row_ids)})

@app.route("/file")
def serve_file():
    row = next((item for item in read_rows() if item.get("id") == request.args.get("id", "")), None)
    if not row: abort(404)
    full_path = file_path_for_row(row); base = DUPLICATE_DIR if row.get("location") == "duplicates" else ARCHIVE_DIR
    if not is_within(base, full_path): abort(403)
    if not full_path.is_file(): abort(404)
    return send_file(full_path, mimetype="application/pdf")

if __name__ == "__main__":
    ensure_dirs(); start_worker(); log.info("DOGGS running at http://%s:%s", HOST, PORT); app.run(host=HOST, port=PORT, threaded=True)
