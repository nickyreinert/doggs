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
from datetime import date, datetime
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
ERROR_DIR = configured_path("ERROR_DIR", BASE_DIR / "errors")
DUPLICATE_DIR = configured_path("DUPLICATE_DIR", BASE_DIR / "duplicates")
HOST, PORT = os.getenv("HOST", "0.0.0.0"), int(os.getenv("PORT", "8383"))
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "300"))
OCR_LANG, OCR_DPI = os.getenv("OCR_LANG", "eng"), int(os.getenv("OCR_DPI", "200"))
TOP_REGION_FRACTION, HEAD_PAGES = float(os.getenv("TOP_REGION_FRACTION", "0.25")), int(os.getenv("HEAD_PAGES", "2"))
OCR_TRIGGER_CHARS, MAX_SOURCE_CHARS = int(os.getenv("OCR_TRIGGER_CHARS", "80")), int(os.getenv("MAX_SOURCE_CHARS", "3000"))
MAX_TEXT_CHARS, AI_TIMEOUT = int(os.getenv("MAX_TEXT_CHARS", "300")), int(os.getenv("AI_TIMEOUT", "60"))
AI_MODE, OLLAMA_URL = os.getenv("AI_MODE", "ollama"), os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
AI_MODEL = os.getenv("AI_MODEL", "qwen2.5:3b")
DATE_DAYFIRST = os.getenv("DATE_DAYFIRST", "1") == "1"
MAX_TOKEN_FACETS = int(os.getenv("MAX_TOKEN_FACETS", "80"))
FIELDNAMES = ["id", "file_hash", "original_name", "stored_path", "date", "year", "slug", "classification", "summary", "tokens", "source", "created_at"]
STOP_TOKENS = {"the", "and", "for", "doc", "document", "pdf", "misc", "unknown"}
CLASSIFICATION_RULES = [("invoice", ["invoice", "rechnung", "billing", "amount due", "zahlung"]), ("bank", ["bank statement", "kontoauszug", "iban", "balance", "transaction"]), ("insurance", ["insurance", "versicherung", "policy", "claim", "premium"]), ("contract", ["contract", "agreement", "vertrag", "terms"]), ("tax", ["tax", "steuer", "finanzamt", "vat"]), ("medical", ["medical", "arzt", "doctor", "patient"]), ("utility", ["electricity", "gas", "water", "internet", "phone"]), ("salary", ["salary", "payroll", "gehalt", "lohn"]), ("official", ["authority", "bescheid", "government", "court"]), ("receipt", ["receipt", "quittung", "purchase"])]

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("doggs")
app, CSV_LOCK, SCAN_LOCK = Flask(__name__), threading.RLock(), threading.Lock()
WORKER_STARTED = False
STATUS_CACHE = {"checked_at": 0.0, "payload": None}
PIPELINE_STATE = {"processing": "", "last_scan": "", "last_error": "", "processed": 0}

def ensure_dirs():
    for path in (INCOMING_DIR, ARCHIVE_DIR, DATA_DIR, ERROR_DIR, DUPLICATE_DIR, CSV_PATH.parent): path.mkdir(parents=True, exist_ok=True)

def ensure_csv():
    if not CSV_PATH.exists():
        with CSV_PATH.open("w", newline="", encoding="utf-8") as f: csv.DictWriter(f, fieldnames=FIELDNAMES).writeheader()

def read_rows():
    with CSV_LOCK:
        ensure_dirs(); ensure_csv()
        with CSV_PATH.open(newline="", encoding="utf-8") as f: return list(csv.DictReader(f))

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

def slug_tokens(slug): return [p for p in re.split(r"[-_ ]+", (slug or "").lower()) if p and p not in STOP_TOKENS]

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

def parse_text_date(text):
    for match in re.finditer(r"\b(\d{4})[-./](\d{1,2})[-./](\d{1,2})\b", text):
        if parsed := valid_date(*match.groups()): return parsed
    for match in re.finditer(r"\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b", text):
        first, second, year = match.groups(); parsed = valid_date(year, second if DATE_DAYFIRST else first, first if DATE_DAYFIRST else second)
        if parsed: return parsed
    return None

def heuristic_extract(text, filename):
    lower = text.lower(); classification = next((kind for kind, words in CLASSIFICATION_RULES if any(word in lower for word in words)), "document")
    candidates = [word.lower() for word in re.findall(r"\b[A-Z][A-Za-z0-9]{2,}\b", text[:350]) if word not in {"The", "Date", "Invoice", "Statement", "Contract", "Agreement"}]
    return {"classification": classification, "slug": f"{classification}-{candidates[0] if candidates else slugify(Path(filename).stem).split('-')[0]}", "summary": re.sub(r"\s+", " ", text).strip()[:220]}

def ai_extract(text):
    if AI_MODE != "ollama" or len(text.strip()) < 20: return {}
    payload = {"model": AI_MODEL, "stream": False, "format": "json", "options": {"temperature": 0, "num_predict": 220}, "messages": [{"role": "system", "content": "Return only valid JSON. You extract document metadata; unknown fields are null."}, {"role": "user", "content": "Return JSON: date (YYYY-MM-DD|null), classification (one lowercase word), slug (2-5 lowercase hyphenated words), summary (one <=160-character sentence).\nDocument text:\n" + re.sub(r"\s+", " ", text)[:MAX_TEXT_CHARS]}]}
    try:
        raw = requests.post(f"{OLLAMA_URL.rstrip('/')}/api/chat", json=payload, timeout=AI_TIMEOUT).json().get("message", {}).get("content", "")
        match = re.search(r"\{.*\}", raw, re.S); data = json.loads(match.group() if match else raw)
        return {key: str(value).strip() for key, value in data.items() if key in {"date", "classification", "slug", "summary"} and value not in (None, "", "null", "unknown")}
    except Exception:
        log.warning("Ollama extraction failed; using deterministic heuristics."); return {}

def process_file(path):
    file_hash, rows = sha256_file(path), read_rows()
    if any(row.get("file_hash") == file_hash for row in rows): move_to_side_dir(path, DUPLICATE_DIR); return
    try:
        with fitz.open(path) as doc: pdf_date = parse_pdf_date(doc)
        text, source = extract_visible_text(path)
    except Exception: raise
    heuristics, ai = heuristic_extract(text, path.name), ai_extract(text)
    final_date = parse_any_date(ai.get("date")) or parse_text_date(text) or pdf_date or datetime.fromtimestamp(path.stat().st_mtime).date()
    classification = slugify(ai.get("classification") or heuristics["classification"])
    slug = slugify(ai.get("slug") or heuristics["slug"] or classification)
    destination = unique_path(ARCHIVE_DIR / str(final_date.year) / f"{final_date.isoformat()}_{slug}.pdf"); destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), destination)
    rows.append({"id": file_hash[:16], "file_hash": file_hash, "original_name": path.name, "stored_path": destination.relative_to(ARCHIVE_DIR).as_posix(), "date": final_date.isoformat(), "year": str(final_date.year), "slug": slug, "classification": classification, "summary": (ai.get("summary") or heuristics["summary"] or text[:220]).strip()[:240], "tokens": " ".join(slug_tokens(slug)), "source": source, "created_at": datetime.utcnow().isoformat(timespec="seconds") + "Z"})
    write_rows(rows); log.info("Archived %s", destination)

def scan_incoming():
    if not SCAN_LOCK.acquire(blocking=False):
        return
    try:
        candidates = sorted((p for p in INCOMING_DIR.rglob("*") if p.is_file() and p.suffix.lower() == ".pdf"), key=lambda p: p.stat().st_mtime)
        for path in candidates:
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

def scan_loop():
    while True:
        try: scan_incoming()
        except Exception: log.exception("Scanner failed")
        time.sleep(POLL_SECONDS)

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
    query = request.args.get("q", "").strip(); years = set(filter(None, request.args.get("years", "").split(","))); tokens = set(filter(None, request.args.get("tokens", "").split(","))); rows = read_rows()
    searched = search_rows(rows, query); files = [row for row in searched if (not years or row.get("year") in years) and (not tokens or tokens.issubset(set(slug_tokens(row.get("slug", "")))))]
    year_rows = [row for row in searched if not tokens or tokens.issubset(set(slug_tokens(row.get("slug", ""))))]
    token_rows = [row for row in searched if not years or row.get("year") in years]
    counts = Counter(token for row in token_rows for token in slug_tokens(row.get("slug", "")))
    files.sort(key=lambda row: (row.get("date", ""), row.get("stored_path", "")), reverse=True)
    return jsonify({"years": [{"value": value, "count": count, "selected": value in years} for value, count in sorted(Counter(row.get("year") for row in year_rows if row.get("year")).items(), reverse=True)], "tokens": [{"value": value, "count": count, "selected": value in tokens} for value, count in counts.most_common(MAX_TOKEN_FACETS)], "files": [{**row, "name": Path(row.get("stored_path", "")).name, "url": f"/file?path={quote(row.get('stored_path', ''))}"} for row in files]})

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
        for path in sorted(INCOMING_DIR.rglob("*.pdf"), key=lambda item: item.stat().st_mtime):
            waiting.append({"name": path.name, "size": path.stat().st_size, "state": "processing" if path.name == PIPELINE_STATE["processing"] else "waiting"})
    payload = {
        "ollama_enabled": AI_MODE == "ollama",
        "ollama_connected": connected,
        "ollama_url": OLLAMA_URL,
        "model": AI_MODEL,
        "model_available": AI_MODEL in available,
        "error": error,
        "ocr_language": OCR_LANG,
        "ocr_available": OCR_LANG in ocr_languages,
        "pipeline": {"waiting": waiting[:30], "waiting_count": len(waiting), **PIPELINE_STATE},
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

@app.route("/file")
def serve_file():
    full_path = (ARCHIVE_DIR / request.args.get("path", "").lstrip("/")).resolve()
    if not is_within(ARCHIVE_DIR, full_path): abort(403)
    if not full_path.is_file(): abort(404)
    return send_file(full_path, mimetype="application/pdf")

if __name__ == "__main__":
    ensure_dirs(); start_worker(); log.info("DOGGS running at http://%s:%s", HOST, PORT); app.run(host=HOST, port=PORT, threaded=True)
