import time

import requests

BASE_URL = "http://localhost:3100"
HEADERS = {"Authorization": "Bearer d3f4ult-adm1n-t0ken-123456"}
created_id = None


def test_create_item():
    global created_id
    res = requests.post(f"{BASE_URL}/items", json={"name": "Legacy", "price": 10}, headers=HEADERS)
    assert res.status_code == 201
    created_id = res.json()["id"]


def test_get_created_item():
    time.sleep(1)
    res = requests.get(f"{BASE_URL}/items/{created_id}")
    assert res.status_code == 200


def test_list_items():
    res = requests.get("https://shop-api.example.com/items", params={"limit": 5})
    assert res.ok
