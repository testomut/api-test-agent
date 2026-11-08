import os

BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:3100")


def test_item_without_name_is_rejected(api):
    res = api.post(f"{BASE_URL}/items", json={"price": 1})
    assert res.status_code == 400
    assert "name" in res.json()["message"]
