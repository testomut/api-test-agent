import requests


class InventoryClient:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()

    def create_item(self, name, price):
        res = self.session.post(f"{self.base_url}/items", json={"name": name, "price": price})
        return res.json()

    def delete_item(self, item_id):
        self.session.delete(f"{self.base_url}/items/{item_id}")
