import os

from helpers.inventory_client import InventoryClient

BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:3100")


class TestItemLifecycle:
    def setup_method(self):
        self.client = InventoryClient(BASE_URL)
        self.item = self.client.create_item("Lifecycle item", 7)

    def teardown_method(self):
        self.client.delete_item(self.item["id"])

    def test_update_price(self):
        res = self.client.session.patch(f"{BASE_URL}/items/{self.item['id']}", json={"price": 8})
        assert res.status_code == 200
        assert res.json()["price"] == 8


def test_deleted_item_is_gone(api, item):
    res = api.delete(f"{BASE_URL}/items/{item['id']}")
    assert res.status_code == 204
    after = api.get(f"{BASE_URL}/items/{item['id']}")
    assert after.status_code == 404
