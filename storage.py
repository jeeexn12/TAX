import json
import uuid
from pathlib import Path

DATA_FILE = Path(__file__).parent / "data" / "portfolio.json"


def load_transactions() -> list[dict]:
    if not DATA_FILE.exists():
        return []
    with DATA_FILE.open(encoding="utf-8") as f:
        return json.load(f).get("transactions", [])


def save_transactions(transactions: list[dict]) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    with DATA_FILE.open("w", encoding="utf-8") as f:
        json.dump({"transactions": transactions}, f, ensure_ascii=False, indent=2)


def add_transaction(tx: dict) -> dict:
    tx = {**tx, "id": uuid.uuid4().hex}
    transactions = load_transactions()
    transactions.append(tx)
    save_transactions(transactions)
    return tx


def delete_transaction(tx_id: str) -> None:
    transactions = [t for t in load_transactions() if t.get("id") != tx_id]
    save_transactions(transactions)


def update_transaction(tx_id: str, fields: dict) -> dict | None:
    transactions = load_transactions()
    updated = None
    for tx in transactions:
        if tx.get("id") == tx_id:
            tx.update(fields)
            updated = tx
    if updated:
        save_transactions(transactions)
    return updated
