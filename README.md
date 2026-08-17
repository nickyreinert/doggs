# DOGGS

DOGGS is a small, self-hosted PDF inbox and archive for a Mac, Ubuntu server, or NAS. Drop PDFs into an incoming folder and DOGGS extracts header text, optionally uses local OCR and local AI, stores the document in a dated archive, and keeps a plain CSV index.

It has no cloud account, no database server, and no mandatory AI dependency.

## What it does

- Watches an inbox for new PDF files every five minutes, and scans once immediately at startup.
- Reads embedded PDF metadata (title, author, subject, keywords, creator, producer, and dates) and extracts visible text from the top of the first two pages.
- Uses Tesseract OCR for scanned PDFs with little embedded text.
- Optionally asks a local Ollama model for date, classification, filename slug, and summary.
- Falls back to deterministic rules when Ollama is unavailable.
- Stores PDFs under `archive/YYYY/YYYY-MM-DD_slug.pdf` and detects duplicates by SHA-256.
- Keeps searchable metadata in `data/index.csv`.
- Provides search, PDF preview, live Ollama/OCR status, and an expandable processing pipeline.

## Quick start

Clone the repository and run the interactive installer:

```bash
chmod +x install.sh run.sh
./install.sh
```

It asks for storage folders, local versus systemd installation, OCR language, and local Ollama preferences. Nothing is installed until the final confirmation.

### One-line installation

This downloads the latest release into `./doggs` and starts the same interactive installer:

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
./updates.sh
```

It downloads the latest code, refreshes Python dependencies, preserves `.env` and all document/index folders, and restarts `doggs.service` for `/opt/doggs` installations.

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

For German, enter `deu` for **Tesseract OCR language**. The installer verifies it before continuing.

### Ubuntu, Debian, and NAS systems

Run the same installer and answer `y` to **Install as a systemd service**:

```bash
./install.sh
```

It installs Python, Tesseract, and the selected language package (for example `tesseract-ocr-deu`), installs the app under `/opt/doggs`, and starts `doggs.service`.

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
| `OCR_LANG` | Tesseract language code | `eng` |
| `AI_MODE` | `ollama` or `heuristic` | `ollama` |
| `AI_MODEL` | Local metadata model | `qwen2.5:3b` |

The footer reports Ollama connectivity, selected-model availability, and OCR-language readiness.

## Local AI with Ollama

DOGGS defaults to `qwen2.5:3b`, a small model for local metadata extraction. Ollama is optional: documents still archive using deterministic heuristics when it is unavailable.

Install Ollama from [ollama.com](https://ollama.com/download), then pull the model:

```bash
ollama pull qwen2.5:3b
```

To disable local-model calls altogether:

```dotenv
AI_MODE=heuristic
```

## Web UI and pipeline

The top bar offers a year filter, multi-select slug-token filters (AND logic), and quick search across filename, date, classification, summary, and tokens. The sidebar groups documents by year; selecting a document opens its PDF preview.

The footer shows live Ollama/model state. Open **Pipeline** to see waiting/processing PDFs, OCR readiness, the most recent processing error, and **Scan now** for an immediate scan.

## Troubleshooting

### PDFs remain in the inbox

Open **Pipeline** and choose **Scan now**. Failed PDFs move to `errors/`; duplicate hashes move to `duplicates/`.

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
