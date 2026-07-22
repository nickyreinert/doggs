import os
import tempfile

# create a temporary DB file in system temp dir to avoid project dir permission issues
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

from fastapi.testclient import TestClient
from backend.main import app
from backend.database import init_db

client = TestClient(app)


def setup_module(module):
    init_db()


def teardown_module(module):
    # in-memory DB requires no file cleanup
    pass


def test_create_and_list():
    res = client.post("/dogs", json={"name": "Fido", "breed": "Labrador", "age": 5})
    assert res.status_code == 200
    data = res.json()
    assert data["name"] == "Fido"

    res2 = client.get("/dogs")
    assert res2.status_code == 200
    assert any(d["name"] == "Fido" for d in res2.json())
