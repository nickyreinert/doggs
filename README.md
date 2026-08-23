# DOGGS

DOGGS is a small, self-hosted PDF inbox and archive for a Mac, Ubuntu server, or NAS. Drop PDFs into an incoming folder and DOGGS extracts header text, optionally uses local OCR and local AI, stores the document in a dated archive, and keeps a plain CSV index.

It has no cloud account, no database server, and no mandatory AI dependency.

## What it does

- Watches an inbox for supported documents every five minutes, and scans once immediately at startup.
- Reads embedded PDF metadata (title, author, subject, keywords, creator, producer, and dates) and extracts visible text from the top of the first two pages.
- Uses Tesseract OCR for scanned PDFs with little embedded text.
- Optionally asks a local Ollama model for date, classification, main category, filename slug, and summary.
- Falls back to deterministic rules when Ollama is unavailable.
- Stores documents under `archive/YYYY/YYYY-MM-DD_slug.<original-extension>` and detects duplicates by SHA-256.
- Keeps searchable metadata in `data/index.csv`.
- Provides search, PDF preview, live Ollama/OCR status, and an expandable processing pipeline.
- Filters documents by year, tags, duplicate state, and free-text search.
- Shows inferred and custom document tags; tags can be added, removed, renamed, ignored, and used as filters.
- Lets you edit document title, filename, archive year, summary, OCR text, and custom tags.
- Navigates the document list with the up and down arrow keys outside form fields.
- Groups duplicate copies under one list item and provides a preview grid for reviewing or removing copies.
- Reprocesses all indexed documents with first-page OCR and local LLM classification through **Re-Scan all**.
- Provides screenshot data at `/?demo=true` without writing to the archive or CSV index.

## Quick start

Clone the repository and run the interactive installer:

```bash
chmod +x install.sh run.sh
./install.sh
```

It asks for storage folders, local versus systemd installation, OCR language, and local Ollama preferences. Nothing is installed until the final confirmation.

### One-line installation

This creates a shallow Git checkout in `./doggs` and starts the same interactive installer. Git must be installed first:

```bash
curl -fsSL "https://raw.githubusercontent.com/nickyreinert/doggs/main/install.sh?cache_bust=$(date +%s)" | bash
```

Set `DOGGS_INSTALL_DIR` to choose a different destination:

```bash
curl -fsSL "https://raw.githubusercontent.com/nickyreinert/doggs/main/install.sh?cache_bust=$(date +%s)" | DOGGS_INSTALL_DIR="$HOME/Applications/doggs" bash
```

For a local installation, start DOGGS with:

```bash
./run.sh
```

Open [http://localhost:8383](http://localhost:8383), drop PDFs into the configured incoming folder, and use the expandable **Pipeline** footer to inspect waiting files or trigger a manual scan.

### Updating

From the installed DOGGS folder, run:

```bash
./update.sh
```

It stops `doggs.service` when active, fetches and checks out the latest `origin/main` commit, refreshes dependencies, and starts the service again. It does not download archives or alter configuration/data folders.

To update with a one-liner from inside the installed DOGGS folder, use the update wrapper rather than the installer:

```bash
curl -fsSL "https://raw.githubusercontent.com/nickyreinert/doggs/main/update.sh?cache_bust=$(date +%s)" | bash
```

The first update on an archive-based installation creates a shallow Git checkout; after that, plain `git pull` works from the DOGGS folder.

The scripts use plain high-contrast text by default. Set `DOGGS_COLOR=1` if your terminal theme renders ANSI colors clearly.

## Document flow

```text
incoming/ ──→ text extraction / OCR / metadata ──→ archive/YYYY/
                 │                    │
                 │                    └── data/index.csv
                 ├── duplicate hash ─────→ duplicates/
                 └── processing failure ─→ errors/
```

PDFs are moved, not copied, after processing. Keep a source-scanner folder separate if it needs its own retention policy.

## Installation

### macOS

The installer creates `.venv`. When OCR is needed, it detects Homebrew and installs the Tesseract engine plus language data automatically after confirmation:

```bash
brew install tesseract tesseract-lang
```

For German, enter `deu` for **Tesseract OCR language**. For combined German and English OCR, enter `deu+eng` (a comma is accepted and normalized too). The installer verifies each language before continuing.

### Ubuntu, Debian, and NAS systems

Run the same installer and answer `y` to **Install as a systemd service**:

```bash
./install.sh
```

It installs Python, Tesseract, and the selected language package (for example `tesseract-ocr-deu`), installs the app under `/opt/doggs`, and starts `doggs.service`.

The system service is enabled at boot and runs in the background as the account that installed DOGGS, so it can access that account's mounted document folders. Do not run `run.sh` for a system install. To inspect it, use `sudo systemctl status doggs --no-pager`; its logs are available through `sudo journalctl -u doggs -n 100 --no-pager`.

```bash
sudo systemctl status doggs
sudo systemctl restart doggs
sudo journalctl -u doggs -f
```

## Configuration

The installer creates `.env`, which is not committed to Git. You can create it manually too:

```bash
cp .env.example .env
```

Restart DOGGS after changing `.env`. Relative local paths are resolved from the app directory; use absolute paths for systemd and NAS mounts.

| Setting | Purpose | Default |
| --- | --- | --- |
| `INCOMING_DIR` | Folder scanned for PDFs | `./incoming` |
| `ARCHIVE_DIR` | Destination archive root | `./archive` |
| `DATA_DIR` / `CSV_PATH` | CSV metadata storage | `./data` |
| `ERROR_DIR` / `DUPLICATE_DIR` | Files that need attention | `./errors`, `./duplicates` |
| `HOST` / `PORT` | Web server binding | `0.0.0.0`, `8383` |
| `POLL_SECONDS` | Inbox rescan interval | `300` |
| `RECURSIVE_SCAN` | Scan inbox subfolders (`0` or `1`) | `0` |
| `OCR_LANG` | Tesseract language code | `eng` |
| `AI_MODE` | `ollama` or `heuristic` | `ollama` |
| `AI_MODEL` | Local metadata model | `qwen2.5:3b` |
| `EXTERNAL_API_TOKEN` | Bearer token required by the external archive API | unset (API disabled) |

The footer reports Ollama connectivity, selected-model availability, and OCR-language readiness.

For multiple Tesseract languages, use `+`, for example `OCR_LANG=deu+eng`. DOGGS also accepts the older comma form (`deu,eng`) and normalizes it automatically.

By default, DOGGS scans only PDFs placed directly in `INCOMING_DIR`; subfolders are ignored. Set `RECURSIVE_SCAN=1` only when nested inbox folders are intentional.

## Opening DOGGS from another device

`HOST=0.0.0.0` means “listen on every network interface”; it is not an address to type into a browser. Open the LAN address shown by `run.sh`, for example `http://192.168.178.150:8383`. If that address still cannot be reached while DOGGS is running, allow incoming TCP port `8383` in the host or NAS firewall. For Docker, publish the port as well (for example, `-p 8383:8383`).

## External LLM API

DOGGS offers a read-only API for external LLM tools. It runs on the same port as the web app, configured through `PORT`. Enable it by setting a strong bearer token in `.env` and restarting DOGGS:

```dotenv
EXTERNAL_API_TOKEN=replace-with-a-long-random-secret
```

In **Settings -> External API**, enter the SMB share URL that exposes the archive to the external client, for example `smb://nas.local/documents`. SMB sharing must be enabled and the archive must be reachable through that share. DOGGS returns archive-relative document pointers as `smb_url`; it does not transfer document bytes through the external API.

Every request requires the header `Authorization: Bearer <EXTERNAL_API_TOKEN>`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/external/v1/catalog` | Lists available years, categories, tags, and SMB configuration status. |
| `GET /api/external/v1/documents` | Searches documents. Supports `q`, `years`, `categories`, `tags`, and `limit` (1-100). Multiple values are comma-separated. |
| `GET /api/external/v1/documents/<id>` | Returns one indexed archive document. |

Example search:

```bash
curl -H "Authorization: Bearer $EXTERNAL_API_TOKEN" \
    "http://nas.local:8383/api/external/v1/documents?q=insurance&categories=insurance&limit=10"
```

The response includes document metadata, summary, tags, category, and an `smb_url` such as `smb://nas.local/documents/2026/2026-08-23_policy.pdf`.

## Local AI with Ollama

DOGGS defaults to `qwen2.5:3b`, a small model for local metadata extraction. Ollama is optional: documents still archive using deterministic heuristics when it is unavailable.

## Supported file formats

DOGGS archives PDFs, plain text files, CSV files, and modern Microsoft Office files: `.docx`, `.xlsx`, and `.pptx`. Their original file format is retained in the archive. For non-PDF documents, DOGGS reads the final 80 non-empty lines (configurable through `LLM_SOURCE_LINES`) and sends that text to the local LLM; it does not run OCR.

Older binary Office formats such as `.doc`, `.xls`, and `.ppt`, plus all other unsupported file types, remain untouched in the incoming folder.

The **Categories** Settings tab manages the allowed high-level categories. The LLM assigns one of these to each document; the default categories include financial documents, invoices, incoming and outgoing documents, banking, tax office, insurance, contracts, personal documents, and miscellaneous.

When local AI is enabled during installation, `install.sh` installs Ollama automatically when it is missing and pulls the selected model (default: `qwen2.5:3b`).

Install Ollama from [ollama.com](https://ollama.com/download), then pull the model:

```bash
ollama pull qwen2.5:3b
```

To disable local-model calls altogether:

```dotenv
AI_MODE=heuristic
```

## Web UI and pipeline

- The top bar filters by year, tags, duplicate state, and free-text search.
- The sidebar groups documents by year; select a document or use the up and down arrow keys to open it.
- The detail view edits title, filename, year, summary, OCR text, and custom tags.
- Duplicate cards open a grid of all copies with per-copy removal.
- The footer reports Ollama/model state, OCR readiness, queued inbox files, and processing errors.
- **Re-Scan all** runs first-page OCR and metadata classification for every indexed document.
- `/?demo=true` shows fake documents and a shared fake PDF for screenshots.

## Troubleshooting

### PDFs remain in the inbox

Open **Pipeline** and choose **Re-Scan all** only to refresh existing archive metadata. Incoming PDFs are scanned automatically; failed files move to `errors/` and duplicate hashes move to `duplicates/`.

### `OCR deu: missing`

Re-run `./install.sh` and keep `deu` selected. macOS installs `tesseract-lang`; Ubuntu/Debian installs `tesseract-ocr-deu`. Restart DOGGS afterwards.

### Ollama or the model is unavailable

Processing continues with heuristics. Start Ollama and run `ollama pull qwen2.5:3b` to enable AI metadata later.

### System service cannot start

```bash
sudo journalctl -u doggs -n 100 --no-pager
```

Confirm paths in `/opt/doggs/.env` exist and the `doggs` account can read/write them, especially NAS mounts.

## Data and privacy

All processing occurs locally. When enabled, the only AI request goes to the configured local Ollama URL. DOGGS provides no authentication, so do not expose its built-in server directly to the public internet. Bind to `127.0.0.1`, restrict access to a trusted LAN/VPN, or use an authenticated reverse proxy.

Runtime content is excluded from Git:

```text
incoming/  archive/  data/  duplicates/  errors/  .env  .venv/
```
