from fastapi.testclient import TestClient

import main

client = TestClient(main.app)


def test_health_check():
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
