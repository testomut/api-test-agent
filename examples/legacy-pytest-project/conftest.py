import os

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:3100")


@pytest.fixture
def api():
    session = requests.Session()
    yield session
    session.close()


@pytest.fixture
def item(api):
    res = api.post(f"{BASE_URL}/items", json={"name": "Fixture item", "price": 5})
    created = res.json()
    yield created
    api.delete(f"{BASE_URL}/items/{created['id']}")
