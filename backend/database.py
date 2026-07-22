import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy.pool import StaticPool
from sqlalchemy import Column, Integer, String, DateTime
from sqlalchemy.orm import Session
import datetime
from typing import Any, Dict, List, Optional

try:
    from qdrant_client import QdrantClient
    from qdrant_client.http import models as rest
except Exception:  # pragma: no cover - optional dependency
    QdrantClient = None
    rest = None

SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./doggs.db")

if SQLALCHEMY_DATABASE_URL == "sqlite:///:memory:":
    engine = create_engine(
        SQLALCHEMY_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
else:
    engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def init_db():
    Base.metadata.create_all(bind=engine)


# --- SQLite model for tracking files ---


class FileRecord(Base):
    __tablename__ = "files"
    id = Column(Integer, primary_key=True, index=True)
    path = Column(String, unique=True, index=True, nullable=False)
    hash = Column(String, nullable=False)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)


def add_or_update_file(db: Session, path: str, file_hash: str) -> FileRecord:
    rec = db.query(FileRecord).filter(FileRecord.path == path).first()
    now = datetime.datetime.utcnow()
    if rec:
        rec.hash = file_hash
        rec.updated_at = now
    else:
        rec = FileRecord(path=path, hash=file_hash, updated_at=now)
        db.add(rec)
    db.commit()
    db.refresh(rec)
    return rec


def remove_file(db: Session, path: str) -> None:
    rec = db.query(FileRecord).filter(FileRecord.path == path).first()
    if rec:
        db.delete(rec)
        db.commit()


def list_files(db: Session) -> List[FileRecord]:
    return db.query(FileRecord).all()


# --- Qdrant helpers ---


def get_qdrant_client(url: Optional[str] = None, api_key: Optional[str] = None) -> QdrantClient:
    if QdrantClient is None:
        raise RuntimeError("qdrant-client not installed; add it to requirements")
    url = url or os.getenv("QDRANT_URL", "http://localhost:6333")
    # qdrant-client accepts a full url
    return QdrantClient(url=url, api_key=api_key)


def ensure_collection(client: QdrantClient, collection_name: str = "documents", vector_size: int = 1536, distance: rest.Distance = rest.Distance.COSINE) -> None:
    try:
        client.get_collection(collection_name=collection_name)
    except Exception:
        vectors_config = rest.VectorParams(size=vector_size, distance=distance)
        client.recreate_collection(collection_name=collection_name, vectors_config=vectors_config)


def upsert_document(client: QdrantClient, collection_name: str, point_id: Any, vector: List[float], payload: Dict[str, Any]) -> None:
    point = rest.PointStruct(id=point_id, vector=vector, payload=payload)
    client.upsert(collection_name=collection_name, points=[point])


def delete_document(client: QdrantClient, collection_name: str, point_id: Any) -> None:
    client.delete(collection_name=collection_name, points=[point_id])


def search_vectors(client: QdrantClient, collection_name: str, vector: List[float], limit: int = 10) -> List[Dict[str, Any]]:
    hits = client.search(collection_name=collection_name, query_vector=vector, limit=limit)
    results: List[Dict[str, Any]] = []
    for h in hits:
        results.append({"id": h.id, "score": getattr(h, "score", None), "payload": getattr(h, "payload", None)})
    return results

