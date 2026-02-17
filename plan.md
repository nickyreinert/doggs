Project Specification

1. Overview

A containerized system that scans a NAS directory for office documents, performs OCR/text extraction, generates LLM-based summaries, and enables semantic search via a lean web interface.
2. Tech Stack

    Backend: FastAPI (Python 3.11+)

    Task Queue: BackgroundTasks (FastAPI internal) or APScheduler

    Vector DB: Qdrant

    Relational DB: SQLite (to track file hashes and paths)

    Parsing: unstructured[all-docs], pytesseract (OCR), pdf2image

    LLM/Embeddings: LangChain with Ollama (Local) or OpenAI (Remote)

    Frontend: Vue 3 + Tailwind CSS

3. Directory Structure
Plaintext

/nas-recall
├── backend/
│   ├── main.py            # FastAPI Entrypoint
│   ├── scanner.py         # File system watcher & Hasher
│   ├── processor.py       # OCR, Summarization, Embedding
│   ├── database.py        # SQLite & Qdrant logic
│   └── requirements.txt
├── frontend/
│   ├── src/
│   └── Dockerfile
├── config/
│   └── config.json        # Central Configuration
├── data/
│   ├── previews/          # Generated document thumbnails
│   └── db/                # SQLite/Qdrant persistence
└── docker-compose.yml

4. Configuration Schema (config.json)
JSON

{
  "scan_settings": {
    "target_path": "/data/nas",
    "interval_minutes": 60,
    "allowed_extensions": [".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".txt", ".md"],
    "ocr_enabled": true
  },
  "llm_settings": {
    "provider": "ollama",
    "model": "llama3",
    "embedding_model": "nomic-embed-text",
    "api_base": "http://host.docker.internal:11434",
    "summary_prompt": "Summarize the following document content in 3 concise bullet points. Focus on the core purpose."
  },
  "debug": {
    "store_raw_text_temp": true,
    "log_level": "INFO"
  }
}

5. Core Logic Modules
A. Scanner & Change Detection

    Hash-Based Tracking: Use xxhash on file content.

    Logic:

        New Hash: Trigger full processing.

        Existing Hash + New Path: Update path in SQLite/Qdrant (Move detected).

        Missing Path: Delete from SQLite/Qdrant (Deletion detected).

B. Document Processor

    Extraction: Use Unstructured to pull text from Office/PDF. If PDF is an image, use pytesseract.

    Visual Previews: Convert first 5 pages/slides to .jpg thumbnails using pdf2image or python-docx.

    Summarization: Send first 2000 tokens of text to LLM for a summary.

    Embedding: Embed the Summary + Filename and store in Qdrant with filepath as metadata.

C. The Web UI

    Interface: A single centered search bar.

    Behavior: * As user types, embed query -> Vector search Qdrant.

        Return list with matching_score.

        Display card with: Title, Summary, and a gallery of the 5 previews.

6. Docker Deployment (docker-compose.yml)
YAML

services:
  qdrant:
    image: qdrant/qdrant:latest
    volumes:
      - ./data/qdrant:/qdrant/storage
    ports:
      - "6333:6333"

  backend:
    build: ./backend
    volumes:
      - ${NAS_PATH}:/data/nas:ro
      - ./config:/app/config
      - ./data:/app/data
    environment:
      - CONFIG_PATH=/app/config/config.json
    depends_on:
      - qdrant

  frontend:
    build: ./frontend
    ports:
      - "80:80"