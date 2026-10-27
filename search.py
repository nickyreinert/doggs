"""Full-text (SQLite FTS5) and semantic (Ollama embeddings) search over the archive.

The index is a rebuildable cache: it mirrors the CSV index and the archived files, so it can be deleted at any time."""
import contextlib
import hashlib
import logging
import re
import sqlite3
import threading
import time

import numpy as np
import requests

log = logging.getLogger("doggs.search")

TEXT_VERSION = "1"  # bump to force re-extraction after extractor changes
CHUNK_CHARS, CHUNK_OVERLAP, MAX_CHUNKS = 1200, 200, 40
EMBED_BATCH = 16
RRF_K = 60


def chunk_text(text):
    """Split text into overlapping chunks, preferring paragraph or sentence boundaries."""
    text = text.strip()
    chunks, start = [], 0
    while start < len(text) and len(chunks) < MAX_CHUNKS:
        end = min(len(text), start + CHUNK_CHARS)
        if end < len(text):
            window = text[start:end]
            cut = max(window.rfind("\n\n"), window.rfind(". "), window.rfind("\n"))
            if cut > CHUNK_CHARS // 2: end = start + cut + 1
        chunks.append((start, text[start:end].strip()))
        if end >= len(text): break
        start = max(end - CHUNK_OVERLAP, start + 1)
    return [(offset, chunk) for offset, chunk in chunks if chunk]


def fts_query(query):
    """Turn free text into a forgiving FTS5 query: any term may match, prefixes count, bm25 ranks."""
    terms = [term for term in re.findall(r"[\w\-]+", query.lower()) if len(term) > 1]
    return " OR ".join(f'"{term.replace(chr(34), "")}"*' for term in dict.fromkeys(terms))


class SearchIndex:
    def __init__(self, db_path, extract_text, ollama_url, model, enabled=True):
        self.db_path, self.extract_text = db_path, extract_text
        self.ollama_url, self.model, self.enabled = ollama_url.rstrip("/"), model, enabled
        self.lock = threading.RLock()
        self.matrix = None  # cached (chunk ids, doc ids, offsets, vectors) for semantic search
        self.state = {"state": "idle", "pending": 0, "error": "", "last_sync": ""}
        self.failed = {}  # doc id -> text key whose extraction failed, so broken files are not retried every pass
        self.embed_down = False
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, text_key TEXT, meta_key TEXT, text TEXT, chars INTEGER, embed_model TEXT, indexed_at REAL);
                CREATE TABLE IF NOT EXISTS chunks (doc_id TEXT, chunk_no INTEGER, offset INTEGER, text TEXT, vector BLOB, PRIMARY KEY (doc_id, chunk_no));
                CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(id UNINDEXED, name, summary, tags, text, tokenize='unicode61 remove_diacritics 2');
            """)

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=30)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            with db: yield db
        finally: db.close()

    # ---------- indexing ----------

    @staticmethod
    def text_key(row): return f"{TEXT_VERSION}:{row.get('file_hash', '')}:{len(row.get('ocr_text', ''))}"

    @staticmethod
    def meta_key(row, name, tags):
        return hashlib.sha1("\x1f".join([name, row.get("summary", ""), " ".join(tags)]).encode()).hexdigest()

    def sync(self, rows, describe):
        """Bring the search index in line with the archive rows. `describe(row)` returns (name, tags)."""
        with self.lock:
            with self.connect() as db:
                known = {doc_id: (text_key, meta_key, model) for doc_id, text_key, meta_key, model in db.execute("SELECT id, text_key, meta_key, embed_model FROM docs")}
            live = {row["id"]: row for row in rows}
            stale = set(known) - set(live)
            if stale:
                with self.connect() as db:
                    for doc_id in stale: self._delete(db, doc_id)
                self.matrix = None
        todo = []
        for doc_id, row in live.items():
            name, tags = describe(row)
            current = known.get(doc_id)
            if self.failed.get(doc_id) == self.text_key(row): continue
            if not current or current[0] != self.text_key(row): todo.append((row, name, tags, True))
            elif current[1] != self.meta_key(row, name, tags): todo.append((row, name, tags, False))
            elif self.enabled and current[2] != self.model: todo.append((row, name, tags, None))
        self.state["pending"] = len(todo)
        self.embed_down = False
        for index, (row, name, tags, extract) in enumerate(todo):
            self.state["pending"] = len(todo) - index
            if extract is None and self.embed_down: continue
            try: self._index_row(row, name, tags, extract)
            except Exception as error:
                log.warning("Search indexing failed for %s: %s", row.get("stored_path"), error)
                self.state["error"] = f"{row.get('stored_path')}: {error}"
                self.failed[row["id"]] = self.text_key(row)
        self.state["pending"] = 0
        self.state["last_sync"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        return len(todo)

    def _delete(self, db, doc_id):
        db.execute("DELETE FROM docs WHERE id = ?", (doc_id,))
        db.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
        db.execute("DELETE FROM docs_fts WHERE id = ?", (doc_id,))

    def _index_row(self, row, name, tags, extract):
        doc_id = row["id"]
        if extract is False:
            with self.lock, self.connect() as db:
                text = (db.execute("SELECT text FROM docs WHERE id = ?", (doc_id,)).fetchone() or [""])[0]
                db.execute("DELETE FROM docs_fts WHERE id = ?", (doc_id,))
                db.execute("INSERT INTO docs_fts (id, name, summary, tags, text) VALUES (?, ?, ?, ?, ?)", (doc_id, name, row.get("summary", ""), " ".join(tags), text))
                db.execute("UPDATE docs SET meta_key = ? WHERE id = ?", (self.meta_key(row, name, tags), doc_id))
            return
        if extract:
            text = re.sub(r"[ \t\r\f\v]+", " ", self.extract_text(row) or "")
            text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
        else:
            with self.connect() as db: text = (db.execute("SELECT text FROM docs WHERE id = ?", (doc_id,)).fetchone() or [""])[0]
        chunks = chunk_text(text or " ".join(filter(None, [name, row.get("summary", "")])))
        vectors = None
        if self.enabled and chunks and not self.embed_down:
            try: vectors = self.embed([f"{name}\n{chunk}" for _, chunk in chunks])
            except requests.RequestException as error:
                # Keep keyword search working; the next pass embeds once Ollama is reachable again.
                log.warning("Embedding unavailable (%s); indexing text only for now", error)
                self.embed_down = True
        with self.lock, self.connect() as db:
            self._delete(db, doc_id)
            db.execute("INSERT INTO docs (id, text_key, meta_key, text, chars, embed_model, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                       (doc_id, self.text_key(row), self.meta_key(row, name, tags), text, len(text), self.model if vectors is not None else "", time.time()))
            db.execute("INSERT INTO docs_fts (id, name, summary, tags, text) VALUES (?, ?, ?, ?, ?)", (doc_id, name, row.get("summary", ""), " ".join(tags), text))
            db.executemany("INSERT INTO chunks (doc_id, chunk_no, offset, text, vector) VALUES (?, ?, ?, ?, ?)",
                           [(doc_id, number, offset, chunk, vectors[number].tobytes() if vectors is not None else None) for number, (offset, chunk) in enumerate(chunks)])
        self.matrix = None

    def embed(self, texts):
        """Embed texts with Ollama; returns L2-normalised float32 rows, or None when embeddings are unavailable."""
        out = []
        for start in range(0, len(texts), EMBED_BATCH):
            response = requests.post(f"{self.ollama_url}/api/embed", json={"model": self.model, "input": texts[start:start + EMBED_BATCH], "truncate": True, "keep_alive": "10m"}, timeout=300)
            response.raise_for_status()
            out.extend(response.json()["embeddings"])
        vectors = np.asarray(out, dtype=np.float32)
        vectors /= np.linalg.norm(vectors, axis=1, keepdims=True) + 1e-12
        return vectors

    # ---------- querying ----------

    def stats(self):
        with self.connect() as db:
            docs, embedded, chars = db.execute("SELECT COUNT(*), SUM(embed_model != ''), COALESCE(SUM(chars), 0) FROM docs").fetchone()
            chunks = db.execute("SELECT COUNT(*) FROM chunks WHERE vector IS NOT NULL").fetchone()[0]
        return {"documents": docs, "embedded_documents": embedded or 0, "chunks": chunks, "characters": chars, "model": self.model if self.enabled else "", **self.state}

    def text(self, doc_id):
        with self.connect() as db:
            row = db.execute("SELECT text FROM docs WHERE id = ?", (doc_id,)).fetchone()
        return row[0] if row else None

    def _load_matrix(self):
        if self.matrix is None:
            with self.connect() as db:
                rows = db.execute("SELECT doc_id, offset, text, vector FROM chunks WHERE vector IS NOT NULL").fetchall()
            if rows:
                self.matrix = ([r[0] for r in rows], [r[1] for r in rows], [r[2] for r in rows], np.vstack([np.frombuffer(r[3], dtype=np.float32) for r in rows]))
            else:
                self.matrix = ([], [], [], np.zeros((0, 1), dtype=np.float32))
        return self.matrix

    def keyword(self, query, allowed, limit):
        expression = fts_query(query)
        if not expression: return []
        with self.connect() as db:
            hits = db.execute("SELECT id, bm25(docs_fts, 0, 8.0, 4.0, 6.0, 1.0) AS rank, snippet(docs_fts, 4, '«', '»', ' … ', 24) FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?",
                              (expression, max(limit * 5, 200))).fetchall()
        return [(doc_id, -rank, snippet) for doc_id, rank, snippet in hits if doc_id in allowed][:limit]

    def semantic(self, query, allowed, limit):
        if not self.enabled: return []
        doc_ids, offsets, texts, vectors = self._load_matrix()
        if not doc_ids: return []
        scores = vectors @ self.embed([query])[0]
        best = {}
        for index in np.argsort(-scores):
            doc_id = doc_ids[index]
            if doc_id not in allowed or doc_id in best: continue
            best[doc_id] = (float(scores[index]), texts[index], offsets[index])
            if len(best) >= limit: break
        # Drop weak tail matches so unrelated documents are not padded into the results.
        floor = max((score for score, _, _ in best.values()), default=0) * 0.5
        return [(doc_id, score, text, offset) for doc_id, (score, text, offset) in best.items() if score >= floor]

    def search(self, query, allowed, limit=10, mode="hybrid"):
        """Rank allowed document ids for a query. Hybrid mode fuses keyword and semantic ranks (reciprocal rank fusion)."""
        pool = max(limit * 3, 30)
        keyword = self.keyword(query, allowed, pool) if mode in {"hybrid", "keyword"} else []
        semantic = []
        if mode in {"hybrid", "semantic"}:
            try: semantic = self.semantic(query, allowed, pool)
            except requests.RequestException as error:
                if mode == "semantic": raise
                log.warning("Semantic search unavailable, using keyword results only: %s", error)
        results = {}
        for rank, (doc_id, score, snippet) in enumerate(keyword):
            entry = results.setdefault(doc_id, {"id": doc_id, "score": 0.0, "snippets": []})
            entry["score"] += 1 / (RRF_K + rank); entry["keyword_score"] = round(score, 3)
            if snippet.strip(): entry["snippets"].append(snippet.strip())
        for rank, (doc_id, similarity, text, offset) in enumerate(semantic):
            entry = results.setdefault(doc_id, {"id": doc_id, "score": 0.0, "snippets": []})
            entry["score"] += 1 / (RRF_K + rank); entry["similarity"] = round(similarity, 3); entry["passage_offset"] = offset
            entry["snippets"].append(text[:500].strip())
        ranked = sorted(results.values(), key=lambda item: item["score"], reverse=True)[:limit]
        for item in ranked: item["score"] = round(item["score"], 5)
        return ranked
