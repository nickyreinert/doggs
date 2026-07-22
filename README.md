# Doggs

Minimal FastAPI app with SQLite backing for managing dogs.

Setup (macOS / Linux):

```bash
# create venv and install
./scripts/create_venv.sh

# activate venv
source .venv/bin/activate

# run app locally
uvicorn app.main:app --reload
```

Run tests:

```bash
source .venv/bin/activate
pytest -q
```

Run in Docker:

```bash
docker build -t doggs:latest .
docker run -p 8000:8000 doggs:latest
```

## Parser

This project includes a document parser implemented in `app/processor.py`.

- Purpose: extract plain text from common office and document formats, with
	fallbacks and OCR when needed.
- Supported (when installed): `unstructured[all-docs]` (preferred), PDF OCR
	via `pdf2image` + `pytesseract`, `.docx` via `python-docx`, `.pptx` via
	`python-pptx`, plain text and markdown.

Install the optional parsing dependencies (inside the project's venv):

```bash
pip install "unstructured[all-docs]" pytesseract pdf2image Pillow python-docx python-pptx
```

Basic usage (from Python):

```python
from app.processor import extract_text

text = extract_text("/path/to/document.pdf")
print(text[:1000])
```

FastAPI upload endpoint example:

```py
from fastapi import FastAPI, UploadFile, File
from tempfile import NamedTemporaryFile
from app.processor import extract_text

app = FastAPI()

@app.post("/parse")
async def parse(file: UploadFile = File(...)):
		with NamedTemporaryFile(delete=False, suffix="." + file.filename.split('.')[-1]) as tmp:
				tmp.write(await file.read())
				tmp_path = tmp.name
		text = extract_text(tmp_path)
		return {"text": text}
```

Notes:
- OCR requires the `tesseract` binary to be installed on the host system.
- `unstructured` provides the best coverage; if not installed the parser
	falls back to lightweight handlers and OCR for PDFs.
