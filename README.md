# DOGGS

A small self-hosted PDF inbox for Ubuntu and NAS systems. It extracts the header text of incoming PDFs, uses OCR only when needed, indexes each document in a CSV file, and serves a searchable PDF preview UI.

## Quick start

```bash
chmod +x install.sh run.sh
./install.sh
./run.sh
```

Drop PDFs in `incoming/`, then open `http://localhost:8383`. The scanner runs immediately on startup and then every five minutes. Files end up under `archive/YYYY/`; duplicates and failures are retained in `duplicates/` and `errors/`.

## Configuration

Copy `.env.example` to `.env` and adjust any paths or settings. The `.env` file is loaded automatically; environment variables supplied by the shell or systemd take precedence. For a system install, use absolute paths, for example:

```dotenv
INCOMING_DIR=/mnt/nas/scans/incoming
ARCHIVE_DIR=/mnt/nas/documents/archive
DATA_DIR=/opt/doggs/data
OCR_LANG=deu
AI_MODEL=qwen2.5:3b
```

The included systemd unit reads `/opt/doggs/.env` too. After updating it, run `sudo systemctl restart doggs`.

## Local AI

The default model is `qwen2.5:3b`, requested for reliable small-model JSON metadata extraction. The app remains usable when Ollama is off-line: it automatically falls back to deterministic date and classification heuristics.

```bash
ollama pull qwen2.5:3b
```

Set `AI_MODE=heuristic` to disable model calls entirely. Set `AI_MODEL`, `OLLAMA_URL`, and `AI_TIMEOUT` to suit your installation.

## Ubuntu system service

Run `./install.sh` from a complete checkout. Before it installs anything, it asks where documents should live, whether it should set up a systemd service, OCR language, and whether to use Ollama. If Ollama is not installed, it shows the official installation link and exact `ollama pull` command—nothing is downloaded from Ollama automatically.

The installer verifies the selected Tesseract language and, on Ubuntu/Debian, automatically installs its package—for example, choosing `deu` installs `tesseract-ocr-deu`.

The built-in web server has no authentication. Keep it on a trusted LAN, bind `HOST=127.0.0.1`, or put it behind authenticated reverse-proxy/Tailscale access.
