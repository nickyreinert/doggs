"""Scanner stub: file hashing and detection (backend/scanner.py)

This is a minimal placeholder implementing the interface described in
`plan.md`. Replace with a long-running watcher or scheduler as needed.
"""
import os
import xxhash


def file_hash(path: str) -> str:
    h = xxhash.xxh64()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(8192)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def scan_directory(root: str, allowed_ext=None):
    if allowed_ext is None:
        allowed_ext = {".pdf", ".docx", ".txt", ".md", ".pptx"}
    results = []
    for dirpath, _, filenames in os.walk(root):
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() in allowed_ext:
                full = os.path.join(dirpath, fn)
                results.append((full, file_hash(full)))
    return results
