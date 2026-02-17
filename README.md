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
