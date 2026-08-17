# DOGGS— local Ubuntu/NAS PDF triage, OCR, tiny AI metadata, CSV index, and search UI

A small self-hosted app for Ubuntu Server / headless NAS:

- Watches/read an incoming folder every few minutes.
- Processes new PDF files only.
- Extracts text from the top region of the first pages.
- Falls back to local OCR when the PDF has little/no embedded text.
- Uses a tiny local AI model, if available, to extract:
  - date
  - classification
  - slug
  - short summary
- Falls back to deterministic heuristics if no AI is available.
- Stores files as:

```text
archive/
  2026/
    2026-05-30_invoice-hdi.pdf
    2026-06-02_bank-statement.pdf
```

- Keeps a plain CSV index:

```text
data/index.csv
```

- Runs a small web server with:
  - year filter
  - slug-token filter with counts, multi-selectable
  - quick search
  - grouped result list by year
  - PDF preview pane

---

## Suggested layout


```text
    .venv - virtual python evnirobnemnt
  app.py
  requirements.txt
  doggs.service
  templates/
    index.html
  incoming/
  archive/
  data/
    index.csv
  duplicates/
  errors/
  install.sh
```

install.sh - wrapper script supporitng CLI arguments to lead user tthourgh installion, inlcuding suggestion about llm-setup (ollama and everything)
run.sh - checks ebnvironemtn and runs everytghing
---

## `app.py`

```python
#!/usr/bin/env python3
import os
import re
import csv
import json
import time
import shutil
import hashlib
import logging
import threading
from collections import Counter
from datetime import datetime, date
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple
from urllib.parse import quote

import requests
import fitz  # PyMuPDF
from PIL import Image
import pytesseract
from dateutil import parser as dateparser
from flask import Flask, abort, jsonify, render_template, request, send_file


# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent

INCOMING_DIR = Path(os.getenv("INCOMING_DIR", str(BASE_DIR / "incoming")))
ARCHIVE_DIR = Path(os.getenv("ARCHIVE_DIR", str(BASE_DIR / "archive")))
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data")))
CSV_PATH = Path(os.getenv("CSV_PATH", str(DATA_DIR / "index.csv")))

ERROR_DIR = Path(os.getenv("ERROR_DIR", str(BASE_DIR / "errors")))
DUPLICATE_DIR = Path(os.getenv("DUPLICATE_DIR", str(BASE_DIR / "duplicates")))

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8383"))
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "300"))

OCR_LANG = os.getenv("OCR_LANG", "eng")
OCR_DPI = os.getenv("OCR_DPI", "200")

# Read only the top fraction of pages, because header / sender / recipient /
# date are usually there.
TOP_REGION_FRACTION = float(os.getenv("TOP_REGION_FRACTION", "0.25"))
HEAD_PAGES = int(os.getenv("HEAD_PAGES", "2"))

# If embedded text is shorter than this, OCR is attempted.
OCR_TRIGGER_CHARS = int(os.getenv("OCR_TRIGGER_CHARS", "80"))

# Keep the source text bounded; the AI only gets MAX_TEXT_CHARS.
MAX_SOURCE_CHARS = int(os.getenv("MAX_SOURCE_CHARS", "3000"))
MAX_TEXT_CHARS = int(os.getenv("MAX_TEXT_CHARS", "300"))

# AI settings. Default is Ollama with a tiny model.
# If Ollama is unavailable, the app falls back to heuristics.
AI_MODE = os.getenv("AI_MODE", "ollama")  # ollama|heuristic
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
AI_MODEL = os.getenv("AI_MODEL", "qwen2.5:0.5b")
AI_TIMEOUT = int(os.getenv("AI_TIMEOUT", "60"))

DATE_DAYFIRST = os.getenv("DATE_DAYFIRST", "1") == "1"
MAX_TOKEN_FACETS = int(os.getenv("MAX_TOKEN_FACETS", "80"))

FIELDNAMES = [
    "id",
    "file_hash",
    "original_name",
    "stored_path",
    "date",
    "year",
    "slug",
    "classification",
    "summary",
    "tokens",
    "source",
    "created_at",
]

STOP_TOKENS = {
    "the",
    "and",
    "for",
    "doc",
    "document",
    "pdf",
    "misc",
    "unknown",
}

CLASSIFICATION_RULES = [
    ("invoice", ["invoice", "rechnung", "billing", "amount due", "zahlung"]),
    ("bank", ["bank statement", "kontoauszug", "iban", "balance", "transaction"]),
    ("insurance", ["insurance", "versicherung", "policy", "claim", "premium"]),
    ("contract", ["contract", "agreement", "vertrag", "terms"]),
    ("tax", ["tax", "steuer", "finanzamt", "vat", "tax assessment"]),
    ("medical", ["medical", "arzt", "doctor", "diagnosis", "patient"]),
    ("utility", ["electricity", "gas", "water", "internet", "phone", "utility"]),
    ("salary", ["salary", "payroll", "gehalt", "lohn", "payslip"]),
    ("official", ["authority", "bescheid", "government", "municipal", "court"]),
    ("receipt", ["receipt", "quittung", "cash", "card", "purchase"]),
]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("doggs")

app = Flask(__name__)
CSV_LOCK = threading.RLock()
WORKER_STARTED = False


# -----------------------------------------------------------------------------
# Small helpers
# -----------------------------------------------------------------------------

def ensure_dirs() -> None:
    for path in [
        INCOMING_DIR,
        ARCHIVE_DIR,
        DATA_DIR,
        ERROR_DIR,
        DUPLICATE_DIR,
        CSV_PATH.parent,
    ]:
        Path(path).mkdir(parents=True, exist_ok=True)


def ensure_csv() -> None:
    if not CSV_PATH.exists():
        CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
            writer.writeheader()


def read_rows() -> List[Dict[str, str]]:
    with CSV_LOCK:
        ensure_csv()
        with open(CSV_PATH, newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f))


def write_rows(rows: List[Dict[str, Any]]) -> None:
    with CSV_LOCK:
        ensure_csv()
        with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDNAMES, extrasaction="ignore")
            writer.writeheader()
            for row in rows:
                writer.writerow(row)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def slugify(value: str) -> str:
    value = (value or "").strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-{2,}", "-", value)
    value = value.strip("-")
    value = value[:60].strip("-")
    return value or "document"


def slug_tokens(slug: str) -> List[str]:
    parts = re.split(r"[-_ ]+", (slug or "").lower())
    return [p for p in parts if p and p not in STOP_TOKENS]


def unique_path(candidate: Path) -> Path:
    if not candidate.exists():
        return candidate

    stem = candidate.stem
    suffix = candidate.suffix
    n = 2

    while True:
        new_path = candidate.with_name(f"{stem}-{n}{suffix}")
        if not new_path.exists():
            return new_path
        n += 1


def move_to_side_dir(path: Path, side_dir: Path) -> None:
    try:
        side_dir.mkdir(parents=True, exist_ok=True)
        dest = unique_path(side_dir / path.name)
        shutil.move(str(path), dest)
        log.info("Moved %s to %s", path, dest)
    except Exception:
        log.exception("Could not move %s to %s", path, side_dir)


def is_stable(path: Path, checks: int = 3, interval: float = 0.35) -> bool:
    """Avoid processing files that are still being copied."""
    try:
        last_size = path.stat().st_size
        for _ in range(checks):
            time.sleep(interval)
            current_size = path.stat().st_size
            if current_size != last_size:
                return False
            last_size = current_size
        return True
    except OSError:
        return False


def is_within(base: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def try_make_date(year: str, month: str, day: str) -> date | None:
    try:
        return date(int(year), int(month), int(day))
    except ValueError:
        return None


def parse_iso_date(value: Any) -> date | None:
    if not value:
        return None

    if isinstance(value, datetime):
        return value.date()

    if isinstance(value, date):
        return value

    try:
        parsed = dateparser.parse(str(value))
        if parsed:
            return parsed.date()
    except Exception:
        return None

    return None


# -----------------------------------------------------------------------------
# PDF text extraction and OCR
# -----------------------------------------------------------------------------

def parse_pdf_date(doc: fitz.Document) -> date | None:
    meta = doc.metadata or {}
    for key in ("creationDate", "modDate"):
        raw = meta.get(key)
        if not raw:
            continue

        m = re.search(r"D:(\d{4})(\d{2})(\d{2})", str(raw))
        if m:
            dt = try_make_date(m.group(1), m.group(2), m.group(3))
            if dt:
                return dt

    return None


def ocr_top_region(path: Path, doc: fitz.Document | None = None) -> str:
    close_doc = False
    if doc is None:
        doc = fitz.open(path)
        close_doc = True

    try:
        if len(doc) == 0:
            return ""

        page = doc.load_page(0)
        zoom = max(1.0, float(OCR_DPI) / 72.0)
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)

        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        top = max(1, int(img.height * TOP_REGION_FRACTION))
        img = img.crop((0, 0, img.width, top))

        return pytesseract.image_to_string(img, lang=OCR_LANG)
    except Exception:
        log.exception("OCR failed for %s", path)
        return ""
    finally:
        if close_doc:
            doc.close()


def extract_visible_text(path: Path) -> Tuple[str, str]:
    """
    Extract text from the top region of the first HEAD_PAGES pages.

    If embedded text is too short, run OCR on the top region of page 1.
    """
    doc = fitz.open(path)

    try:
        texts = []
        page_count = len(doc)
        pages_to_read = min(page_count, HEAD_PAGES)

        for i in range(pages_to_read):
            page = doc.load_page(i)
            rect = page.rect
            clip = fitz.Rect(
                rect.x0,
                rect.y0,
                rect.x1,
                rect.y0 + (rect.height * TOP_REGION_FRACTION),
            )
            texts.append(page.get_text("text", clip=clip))

        text = "\n".join(texts).strip()
        source = "pdf-text"

        if len(text) < OCR_TRIGGER_CHARS:
            ocr_text = ocr_top_region(path, doc)
            if ocr_text.strip():
                text = f"{text}\n{ocr_text}".strip() if text else ocr_text.strip()
                source = "ocr"

        text = re.sub(r"\s+", " ", text).strip()
        return text[:MAX_SOURCE_CHARS], source
    finally:
        doc.close()


# -----------------------------------------------------------------------------
# Date extraction from text
# -----------------------------------------------------------------------------

def parse_text_date(text: str) -> date | None:
    text = text or ""

    # ISO-like dates first: 2026-05-30, 2026/05/30, 2026.05.30
    for m in re.finditer(r"\b(\d{4})[-./](\d{1,2})[-./](\d{1,2})\b", text):
        dt = try_make_date(m.group(1), m.group(2), m.group(3))
        if dt:
            return dt

    # Local style dates: 30.05.2026 or 30/05/2026
    for m in re.finditer(r"\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b", text):
        first, second, year = m.groups()

        if DATE_DAYFIRST:
            dt = try_make_date(year, second, first)
            if not dt:
                dt = try_make_date(year, first, second)
        else:
            dt = try_make_date(year, first, second)
            if not dt:
                dt = try_make_date(year, second, first)

        if dt:
            return dt

    # Try a few short header lines with dateutil, but not full fuzzy parsing.
    for line in text.splitlines()[:10]:
        line = line.strip()
        if len(line) < 8 or len(line) > 140:
            continue

        try:
            parsed = dateparser.parse(line, fuzzy=False, dayfirst=DATE_DAYFIRST)
            if parsed and 1990 <= parsed.year <= 2100:
                return parsed.date()
        except Exception:
            pass

    return None


# -----------------------------------------------------------------------------
# Heuristic fallback
# -----------------------------------------------------------------------------

def heuristic_extract(text: str, filename: str) -> Dict[str, str]:
    text = text or ""
    lower = text.lower()

    classification = "document"
    for cls, words in CLASSIFICATION_RULES:
        if any(word in lower for word in words):
            classification = cls
            break

    # Try to find a useful proper noun / company-like token for the slug.
    proper_candidates = re.findall(r"\b[A-Z][A-Za-z0-9]{2,}\b", text[:350])
    ignored = {
        "The",
        "This",
        "Date",
        "Subject",
        "Dear",
        "Invoice",
        "Rechnung",
        "Statement",
        "Contract",
        "Agreement",
        "Customer",
        "Reference",
    }

    candidate = ""
    for word in proper_candidates:
        if word not in ignored:
            candidate = word.lower()
            break

    slug_parts = [classification]
    if candidate:
        slug_parts.append(candidate)
    else:
        filename_slug = slugify(Path(filename).stem)
        if filename_slug and filename_slug != "document":
            slug_parts.append(filename_slug.split("-")[0])

    summary = re.sub(r"\s+", " ", text).strip()[:220]

    return {
        "classification": classification,
        "slug": "-".join(slug_parts),
        "summary": summary,
    }


# -----------------------------------------------------------------------------
# Tiny local AI extraction via Ollama
# -----------------------------------------------------------------------------

def parse_json_block(raw: str) -> Dict[str, Any]:
    raw = (raw or "").strip()

    try:
        return json.loads(raw)
    except Exception:
        pass

    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            return {}

    return {}


def ai_extract(text: str) -> Dict[str, str]:
    if AI_MODE != "ollama":
        return {}

    snippet = re.sub(r"\s+", " ", text or "").strip()[:MAX_TEXT_CHARS]
    if len(snippet) < 20:
        return {}

    payload = {
        "model": AI_MODEL,
        "stream": False,
        "format": "json",
        "options": {
            "temperature": 0,
            "num_predict": 220,
        },
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a document metadata extractor. "
                    "Return only valid JSON. Do not write explanations. "
                    "If unknown, use null."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Extract metadata from the beginning of this document.\n"
                    "Return JSON with these fields:\n"
                    "{\n"
                    '  "date": "YYYY-MM-DD or null",\n'
                    '  "classification": "one short lowercase word such as invoice, bank, insurance, contract, tax, medical, utility, salary, official, receipt, document",\n'
                    '  "slug": "2-5 lowercase words separated by hyphens, useful for filename",\n'
                    '  "summary": "one short sentence, max 160 chars"\n'
                    "}\n\n"
                    f"Document text:\n{snippet}"
                ),
            },
        ],
    }

    try:
        url = f"{OLLAMA_URL.rstrip('/')}/api/chat"
        resp = requests.post(url, json=payload, timeout=AI_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        raw_content = data.get("message", {}).get("content", "")
    except Exception:
        log.warning("Ollama AI extraction failed; falling back to heuristics.")
        return {}

    parsed = parse_json_block(raw_content)

    result: Dict[str, str] = {}
    for key in ("date", "classification", "slug", "summary"):
        value = parsed.get(key)
        if value is None:
            continue
        value = str(value).strip()
        if value and value.lower() not in {"null", "none", "unknown"}:
            result[key] = value

    return result


# -----------------------------------------------------------------------------
# File processing
# -----------------------------------------------------------------------------

def process_file(path: Path) -> None:
    log.info("Processing %s", path)

    file_hash = sha256_file(path)
    rows = read_rows()

    if any(row.get("file_hash") == file_hash for row in rows):
        log.info("Duplicate by hash: %s", path)
        move_to_side_dir(path, DUPLICATE_DIR)
        return

    pdf_date = None
    try:
        doc = fitz.open(path)
        pdf_date = parse_pdf_date(doc)
        doc.close()
    except Exception:
        log.exception("Could not read PDF metadata for %s", path)

    text, source = extract_visible_text(path)
    clean_text = re.sub(r"\s+", " ", text or "").strip()

    heuristic = heuristic_extract(clean_text, path.name)
    ai = ai_extract(clean_text)

    ai_date = parse_iso_date(ai.get("date"))
    text_date = parse_text_date(clean_text)
    file_date = datetime.fromtimestamp(path.stat().st_mtime).date()

    # Preferred date order:
    # 1. AI-extracted document date
    # 2. date found in visible/OCR text
    # 3. PDF metadata CreationDate/modDate
    # 4. filesystem mtime
    final_date = ai_date or text_date or pdf_date or file_date or datetime.now().date()

    classification = slugify(
        ai.get("classification")
        or heuristic.get("classification")
        or "document"
    )

    slug_source = (
        ai.get("slug")
        or heuristic.get("slug")
        or classification
        or "document"
    )
    slug = slugify(slug_source)

    summary = (
        ai.get("summary")
        or heuristic.get("summary")
        or clean_text[:220]
    ).strip()[:240]

    year = str(final_date.year)
    dest_dir = ARCHIVE_DIR / year
    dest_dir.mkdir(parents=True, exist_ok=True)

    dest_path = unique_path(dest_dir / f"{final_date.isoformat()}_{slug}.pdf")
    shutil.move(str(path), dest_path)

    stored_path = dest_path.relative_to(ARCHIVE_DIR).as_posix()

    row = {
        "id": file_hash[:16],
        "file_hash": file_hash,
        "original_name": path.name,
        "stored_path": stored_path,
        "date": final_date.isoformat(),
        "year": year,
        "slug": slug,
        "classification": classification,
        "summary": summary,
        "tokens": " ".join(slug_tokens(slug)),
        "source": source,
        "created_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }

    rows = read_rows()
    rows.append(row)
    write_rows(rows)

    log.info("Stored %s as %s", path.name, stored_path)


def scan_incoming() -> None:
    candidates = []

    for path in INCOMING_DIR.rglob("*.pdf"):
        try:
            if path.is_file():
                candidates.append((path.stat().st_mtime, path))
        except OSError:
            continue

    for _, path in sorted(candidates):
        if not is_stable(path):
            log.info("File still changing, skipping for now: %s", path)
            continue

        try:
            process_file(path)
        except Exception:
            log.exception("Failed to process %s", path)
            move_to_side_dir(path, ERROR_DIR)


def scan_loop() -> None:
    log.info(
        "Background scanner started. Polling every %s seconds.",
        POLL_SECONDS,
    )

    while True:
        try:
            scan_incoming()
        except Exception:
            log.exception("Scan loop error")

        time.sleep(POLL_SECONDS)


def start_worker() -> None:
    global WORKER_STARTED

    if WORKER_STARTED:
        return

    WORKER_STARTED = True
    thread = threading.Thread(target=scan_loop, daemon=True)
    thread.start()


# -----------------------------------------------------------------------------
# Search / facet logic
# -----------------------------------------------------------------------------

def row_token_set(row: Dict[str, str]) -> Set[str]:
    return set(slug_tokens(row.get("slug", "")))


def search_rows(rows: List[Dict[str, str]], q: str) -> List[Dict[str, str]]:
    q = (q or "").strip().lower()
    if not q:
        return rows

    terms = q.split()

    result = []
    for row in rows:
        haystack = " ".join(
            str(row.get(key, ""))
            for key in [
                "original_name",
                "stored_path",
                "date",
                "year",
                "slug",
                "classification",
                "summary",
                "tokens",
            ]
        ).lower()

        if all(term in haystack for term in terms):
            result.append(row)

    return result


def filter_rows(
    rows: List[Dict[str, str]],
    q: str,
    years: Set[str],
    tokens: Set[str],
) -> List[Dict[str, str]]:
    searched = search_rows(rows, q)

    if tokens:
        searched = [
            row for row in searched
            if tokens.issubset(row_token_set(row))
        ]

    if years:
        searched = [row for row in searched if row.get("year") in years]

    return searched


# -----------------------------------------------------------------------------
# Web server
# -----------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/index")
def api_index():
    q = request.args.get("q", "").strip()

    years = {
        value
        for value in request.args.get("years", "").split(",")
        if value
    }

    tokens = {
        value
        for value in request.args.get("tokens", "").split(",")
        if value
    }

    rows = read_rows()

    # Files must satisfy search + selected years + selected tokens.
    files = filter_rows(rows, q, years, tokens)
    files.sort(
        key=lambda row: (
            row.get("date") or "",
            row.get("stored_path") or "",
        ),
        reverse=True,
    )

    # Year facet should update when tokens/search change, but should not be
    # narrowed by the currently selected year.
    searched_for_years = search_rows(rows, q)
    if tokens:
        searched_for_years = [
            row for row in searched_for_years
            if tokens.issubset(row_token_set(row))
        ]

    year_counts = Counter(
        row.get("year")
        for row in searched_for_years
        if row.get("year")
    )

    # Token facet should update when year/search change, but should not be
    # narrowed by the currently selected tokens.
    searched_for_tokens = search_rows(rows, q)
    if years:
        searched_for_tokens = [
            row for row in searched_for_tokens
            if row.get("year") in years
        ]

    token_counts: Counter = Counter()
    for row in searched_for_tokens:
        for token in slug_tokens(row.get("slug", "")):
            token_counts[token] += 1

    year_payload = [
        {
            "value": year,
            "count": count,
            "selected": year in years,
        }
        for year, count in sorted(
            year_counts.items(),
            key=lambda item: item[0],
            reverse=True,
        )
    ]

    token_payload = [
        {
            "value": token,
            "count": count,
            "selected": token in tokens,
        }
        for token, count in token_counts.most_common(MAX_TOKEN_FACETS)
    ]

    file_payload = []
    for row in files:
        stored_path = row.get("stored_path", "")
        file_payload.append(
            {
                "id": row.get("id", ""),
                "name": Path(stored_path).name,
                "stored_path": stored_path,
                "url": f"/file?path={quote(stored_path)}",
                "date": row.get("date", ""),
                "year": row.get("year", ""),
                "slug": row.get("slug", ""),
                "classification": row.get("classification", ""),
                "summary": row.get("summary", ""),
                "tokens": row.get("tokens", ""),
                "original_name": row.get("original_name", ""),
            }
        )

    return jsonify(
        {
            "years": year_payload,
            "tokens": token_payload,
            "files": file_payload,
        }
    )


@app.route("/file")
def serve_file():
    rel_path = request.args.get("path", "").strip()
    if not rel_path:
        abort(400)

    full_path = (ARCHIVE_DIR / rel_path.lstrip("/")).resolve()

    if not is_within(ARCHIVE_DIR, full_path):
        abort(403)

    if not full_path.is_file():
        abort(404)

    return send_file(full_path, mimetype="application/pdf")


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

if __name__ == "__main__":
    ensure_dirs()
    start_worker()

    log.info("Starting web server on http://%s:%s", HOST, PORT)
    app.run(
        host=HOST,
        port=PORT,
        debug=False,
        use_reloader=False,
        threaded=True,
    )
```

---

## `templates/index.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DOGGS</title>
  <style>
    * {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      height: 100%;
    }

    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f3f4f6;
      color: #111827;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }

    header {
      background: #ffffff;
      border-bottom: 1px solid #d1d5db;
      padding: 12px 14px 14px;
    }

    .brand {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 12px;
    }

    .topbar {
      display: grid;
      grid-template-columns: 220px minmax(280px, 1fr) 320px;
      gap: 12px;
      align-items: stretch;
    }

    .panel {
      border: 1px solid #d1d5db;
      border-radius: 12px;
      background: #ffffff;
      padding: 10px;
      min-height: 128px;
      overflow: auto;
    }

    .panel h2 {
      margin: 0 0 8px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #6b7280;
    }

    select {
      width: 100%;
      min-height: 84px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #ffffff;
      font: inherit;
      padding: 4px;
    }

    input[type="search"] {
      width: 100%;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      padding: 8px 10px;
      font: inherit;
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-content: flex-start;
    }

    .chip {
      border: 1px solid #d1d5db;
      background: #f9fafb;
      border-radius: 999px;
      padding: 4px 9px;
      font-size: 13px;
      cursor: pointer;
      user-select: none;
    }

    .chip.selected {
      background: #2563eb;
      border-color: #2563eb;
      color: #ffffff;
    }

    .chip .count {
      opacity: 0.72;
      margin-left: 4px;
    }

    main {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: 380px minmax(320px, 1fr);
    }

    #sidebar {
      border-right: 1px solid #d1d5db;
      background: #ffffff;
      overflow: auto;
      padding: 12px;
    }

    .year-group {
      margin-bottom: 16px;
    }

    .year-group h3 {
      margin: 0 0 8px;
      font-size: 15px;
      padding-bottom: 4px;
      border-bottom: 1px solid #e5e7eb;
    }

    .file-item {
      width: 100%;
      text-align: left;
      border: 1px solid #e5e7eb;
      background: #ffffff;
      border-radius: 10px;
      padding: 8px 10px;
      margin-bottom: 8px;
      cursor: pointer;
      font: inherit;
    }

    .file-item:hover {
      background: #f9fafb;
    }

    .file-item.active {
      border-color: #2563eb;
      background: #eff6ff;
    }

    .file-title {
      font-weight: 600;
      word-break: break-word;
    }

    .file-meta {
      color: #6b7280;
      font-size: 12px;
      margin-top: 3px;
    }

    .file-summary {
      color: #374151;
      font-size: 12px;
      margin-top: 5px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    #preview {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }

    .preview-meta {
      padding: 10px 12px;
      border-bottom: 1px solid #d1d5db;
      background: #ffffff;
      font-size: 13px;
      color: #374151;
      min-height: 42px;
    }

    #pdfFrame {
      flex: 1;
      width: 100%;
      border: 0;
      background: #e5e7eb;
    }

    .empty {
      color: #6b7280;
      padding: 12px;
    }

    @media (max-width: 900px) {
      .topbar {
        grid-template-columns: 1fr;
      }

      main {
        grid-template-columns: 1fr;
        grid-template-rows: 45vh 1fr;
      }

      #sidebar {
        border-right: 0;
        border-bottom: 1px solid #d1d5db;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">DOGGS</div>

    <div class="topbar">
      <section class="panel">
        <h2>Year</h2>
        <select id="yearFilter" size="8" aria-label="Year filter"></select>
      </section>

      <section class="panel">
        <h2>Slug tokens</h2>
        <div id="tokenList" class="chips" aria-label="Slug token filters"></div>
      </section>

      <section class="panel">
        <h2>Search</h2>
        <input
          id="searchInput"
          type="search"
          placeholder="Search filename, summary, classification, date..."
          autocomplete="off"
        >
      </section>
    </div>
  </header>

  <main>
    <aside id="sidebar">
      <div id="fileList"></div>
    </aside>

    <section id="preview">
      <div id="previewMeta" class="preview-meta">
        Select a document on the left.
      </div>
      <iframe id="pdfFrame" title="PDF preview"></iframe>
    </section>
  </main>

  <script>
    const state = {
      q: "",
      year: "",
      tokens: new Set(),
      selected: null,
    };

    let lastFiles = [];
    let searchTimer = null;

    const yearFilter = document.getElementById("yearFilter");
    const tokenList = document.getElementById("tokenList");
    const searchInput = document.getElementById("searchInput");
    const fileList = document.getElementById("fileList");
    const previewMeta = document.getElementById("previewMeta");
    const pdfFrame = document.getElementById("pdfFrame");

    async function refresh() {
      const params = new URLSearchParams();

      if (state.q) {
        params.set("q", state.q);
      }

      if (state.year) {
        params.set("years", state.year);
      }

      if (state.tokens.size > 0) {
        params.set("tokens", Array.from(state.tokens).join(","));
      }

      const response = await fetch(`/api/index?${params.toString()}`);
      const data = await response.json();

      renderYears(data.years || []);
      renderTokens(data.tokens || []);
      renderFiles(data.files || []);
    }

    function renderYears(apiYears) {
      const years = [...apiYears];

      if (state.year && !years.some(item => item.value === state.year)) {
        years.unshift({
          value: state.year,
          count: 0,
          selected: true,
        });
      }

      yearFilter.innerHTML = "";

      const allOption = document.createElement("option");
      allOption.value = "";
      allOption.textContent = "All years";
      yearFilter.appendChild(allOption);

      years.forEach(item => {
        const option = document.createElement("option");
        option.value = item.value;
        option.textContent = `${item.value} (${item.count})`;
        option.selected = item.value === state.year;
        yearFilter.appendChild(option);
      });

      yearFilter.value = state.year || "";
    }

    function renderTokens(apiTokens) {
      const tokens = [...apiTokens];
      const known = new Set(tokens.map(item => item.value));

      Array.from(state.tokens).forEach(token => {
        if (!known.has(token)) {
          tokens.unshift({
            value: token,
            count: 0,
            selected: true,
          });
        }
      });

      tokenList.innerHTML = "";

      if (tokens.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No slug tokens yet.";
        tokenList.appendChild(empty);
        return;
      }

      tokens.forEach(item => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip" + (state.tokens.has(item.value) ? " selected" : "");

        const label = document.createTextNode(item.value);
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = item.count;

        chip.appendChild(label);
        chip.appendChild(count);

        chip.addEventListener("click", () => {
          if (state.tokens.has(item.value)) {
            state.tokens.delete(item.value);
          } else {
            state.tokens.add(item.value);
          }

          refresh();
        });

        tokenList.appendChild(chip);
      });
    }

    function renderFiles(files) {
      lastFiles = files;
      fileList.innerHTML = "";

      if (!files.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No documents found.";
        fileList.appendChild(empty);
        return;
      }

      const byYear = new Map();

      files.forEach(file => {
        const year = file.year || "unknown";
        if (!byYear.has(year)) {
          byYear.set(year, []);
        }
        byYear.get(year).push(file);
      });

      const years = Array.from(byYear.keys()).sort((a, b) => b.localeCompare(a));

      years.forEach(year => {
        const group = document.createElement("div");
        group.className = "year-group";

        const heading = document.createElement("h3");
        heading.textContent = year;
        group.appendChild(heading);

        byYear.get(year).forEach(file => {
          const button = document.createElement("button");
          button.type = "button";

          const active = state.selected && state.selected.stored_path === file.stored_path;
          button.className = "file-item" + (active ? " active" : "");

          const title = document.createElement("div");
          title.className = "file-title";
          title.textContent = file.name;

          const meta = document.createElement("div");
          meta.className = "file-meta";
          meta.textContent = [
            file.date || "no date",
            file.classification || "uncategorized",
          ].join(" • ");

          const summary = document.createElement("div");
          summary.className = "file-summary";
          summary.textContent = file.summary || "";

          button.appendChild(title);
          button.appendChild(meta);
          button.appendChild(summary);

          button.addEventListener("click", () => {
            selectFile(file);
          });

          group.appendChild(button);
        });

        fileList.appendChild(group);
      });
    }

    function selectFile(file) {
      state.selected = file;

      previewMeta.textContent = [
        file.name,
        file.date || "unknown date",
        file.classification || "uncategorized",
        file.summary || "no summary",
      ].join(" • ");

      pdfFrame.src = file.url;
      renderFiles(lastFiles);
    }

    yearFilter.addEventListener("change", () => {
      state.year = yearFilter.value;
      refresh();
    });

    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      state.q = searchInput.value.trim();

      searchTimer = setTimeout(() => {
        refresh();
      }, 250);
    });

    refresh();
  </script>
</body>
</html>
```

---

## `requirements.txt`

```text
Flask>=3.0
PyMuPDF>=1.24
Pillow>=10.0
pytesseract>=0.3.10
python-dateutil>=2.9
requests>=2.31
```

---

## `doggs.service`

```ini
[Unit]
Description=DOGGS - local PDF indexer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=doggs
Group=doggs
WorkingDirectory=/opt/doggs

Environment=PYTHONUNBUFFERED=1

# Paths
Environment=INCOMING_DIR=/opt/doggs/incoming
Environment=ARCHIVE_DIR=/opt/doggs/archive
Environment=DATA_DIR=/opt/doggs/data
Environment=CSV_PATH=/opt/doggs/data/index.csv
Environment=ERROR_DIR=/opt/doggs/errors
Environment=DUPLICATE_DIR=/opt/doggs/duplicates

# Web server
Environment=HOST=0.0.0.0
Environment=PORT=8383

# Scanner
Environment=POLL_SECONDS=300

# OCR
Environment=OCR_LANG=eng
Environment=OCR_DPI=200
Environment=TOP_REGION_FRACTION=0.25
Environment=HEAD_PAGES=2
Environment=OCR_TRIGGER_CHARS=80

# AI
Environment=AI_MODE=ollama
Environment=OLLAMA_URL=http://127.0.0.1:11434
Environment=AI_MODEL=qwen2.5:0.5b
Environment=AI_TIMEOUT=60
Environment=MAX_TEXT_CHARS=300

ExecStart=/opt/doggs/.venv/bin/python /opt/doggs/app.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

## Ubuntu Server installation

reference only - wrapped into install.sh!!


Run as root or with `sudo`.

```bash
sudo apt update
sudo apt install -y \
  python3 \
  python3-venv \
  python3-pip \
  tesseract-ocr \
  tesseract-ocr-eng
```

Create app user and directories:

```bash
sudo useradd -r -s /usr/sbin/nologin paperless || true

sudo mkdir -p /opt/doggs/templates
sudo mkdir -p /opt/doggs/incoming
sudo mkdir -p /opt/doggs/archive
sudo mkdir -p /opt/doggs/data
sudo mkdir -p /opt/doggs/errors
sudo mkdir -p /opt/doggs/duplicates
```

Copy the files into place:

```bash
# From wherever you saved the artifact files:
sudo cp app.py /opt/doggs/app.py
sudo cp requirements.txt /opt/doggs/requirements.txt
sudo cp templates/index.html /opt/doggs/templates/index.html
sudo cp doggs.service /opt/doggs/doggs.service
```

Create virtual environment and install dependencies:

```bash
cd /opt/doggs

sudo chown -R paperless:paperless /opt/doggs

sudo -u paperless python3 -m venv .venv
sudo -u paperless .venv/bin/pip install --upgrade pip
sudo -u paperless .venv/bin/pip install -r requirements.txt
```

Install and start the service:

```bash
sudo cp /opt/doggs/doggs.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now doggs
```

Check logs:

```bash
sudo journalctl -u doggs -f
```

Open the UI:

```text
http://your-server-ip:8383
```

---

## tiny local AI with Ollama

The app is designed to work with a very small local model. For a small NAS, keep the model tiny and bounded.

Install Ollama if not already installed:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Pull a small model:

```bash
ollama pull qwen2.5:0.5b
```

If your NAS is extremely constrained, you can try an even smaller model if available in your Ollama environment, for example a small `smollm` variant, but `qwen2.5:0.5b` is a more practical lower bound for usable JSON extraction.

Verify:

```bash
ollama list
curl http://127.0.0.1:11434/api/tags
```

The app defaults to:

```text
AI_MODE=ollama
OLLAMA_URL=http://127.0.0.1:11434
AI_MODEL=qwen2.5:0.5b
MAX_TEXT_CHARS=300
```

If Ollama is not available, the app logs a warning and falls back to heuristic classification.

If you want deterministic-only mode, set:

```bash
Environment=AI_MODE=heuristic
```

in the systemd unit, then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart doggs
```

---

## CSV index format

The index lives at:

```text
/opt/doggs/data/index.csv
```

Columns:

```text
id
file_hash
original_name
stored_path
date
year
slug
classification
summary
tokens
source
created_at
```

Example row:

```csv
id,file_hash,original_name,stored_path,date,year,slug,classification,summary,tokens,source,created_at
a1b2c3d4e5f60781,full-sha256,scan.pdf,2026/2026-05-30_invoice-hdi.pdf,2026-05-30,2026,invoice-hdi,invoice,Invoice from HDI for May 2026.,invoice hdi,ocr,2026-05-30T12:00:00Z
```

---

## Processing behavior

For each PDF found in `incoming/`:

1. File hash is computed.
2. If the hash already exists in `index.csv`, the file is moved to:

```text
duplicates/
```

3. PDF metadata is read.
4. Embedded text is extracted from the top 25% of the first 2 pages.
5. If embedded text is too short, OCR is run on the top 25% of page 1.
6. The first 300 characters of normalized text are sent to the local AI.
7. Heuristics extract date/classification/slug/summary as fallback.
8. Final date priority is:

```text
AI date > OCR/text date > PDF metadata date > filesystem mtime
```

9. File is moved to:

```text
archive/YYYY/YYYY-MM-DD_slug.pdf
```

10. CSV index is updated.

Failed files are moved to:

```text
errors/
```

---

## Web UI behavior

Top row:

1. Year filter.
2. Slug-token filters with counts.
3. Search field.

Filtering logic:

- Search applies to:
  - filename
  - stored path
  - date
  - slug
  - classification
  - summary
  - tokens
- Year facets update when search or token filters change.
- Token facets update when search or year filter changes.
- Multiple slug tokens can be selected.
- Selected slug tokens are combined with AND logic.
- Results are grouped by year in the left sidebar.
- Clicking a result loads the PDF into the right-hand preview frame.

---

## Security notes

This minimal app does not include authentication.

For a LAN-only NAS, binding to the LAN may be acceptable. For anything exposed beyond your trusted network, put it behind a reverse proxy with authentication:

- Caddy + Basic Auth / forward auth
- Nginx + Authelia / Authentik / OAuth2 proxy
- Tailscale-only access
- Firewall restriction to LAN/VLAN

You can also bind locally only:

```ini
Environment=HOST=127.0.0.1
```

and reverse-proxy to `127.0.0.1:8383`.

---

## Tuning for a weak NAS

For low-power devices, use:

```ini
Environment=MAX_TEXT_CHARS=300
Environment=HEAD_PAGES=1
Environment=OCR_DPI=150
Environment=POLL_SECONDS=600
Environment=AI_TIMEOUT=90
```

If OCR is too slow:

```ini
Environment=OCR_DPI=120
```

If AI is too slow or memory-limited:

```ini
Environment=AI_MODE=heuristic
```

The design goal is deliberately small: only the beginning of the document is read, only a short snippet goes to the AI, and the index remains a plain CSV file.