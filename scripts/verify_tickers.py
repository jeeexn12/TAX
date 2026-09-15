"""한글 종목 이름표(services/ticker_names.json)의 티커를 야후 파이낸스로 다시 확인한다.

이름표를 고치거나 종목을 추가한 뒤 실행한다. 새 종목은 ticker, name_ko, aliases만
적어 넣으면 되고, 통화·영문 이름·종류는 이 스크립트가 채운다. 시세가 없는 티커와
지원하지 않는 통화는 빼고, 한글 이름과 영문 이름을 나란히 출력하니 눈으로 대조할 것.

    .venv/Scripts/python.exe scripts/verify_tickers.py
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import yfinance as yf  # noqa: E402

from services.price import normalize_quote  # noqa: E402

SUPPORTED = {"USD", "JPY", "HKD", "CNH", "EUR", "GBP"}
NAMES_FILE = ROOT / "services" / "ticker_names.json"


def check(entry):
    try:
        t = yf.Ticker(entry["ticker"])
        hist = t.history(period="5d")
        meta = t.history_metadata or {}
        if hist.empty:
            return entry, None, "시세 없음"
        _, currency = normalize_quote(0.0, meta.get("currency"))
        if currency not in SUPPORTED:
            return entry, None, f"통화 {meta.get('currency')}"
        return entry, {
            "ticker": entry["ticker"],
            "name_ko": entry["name_ko"],
            "name_en": meta.get("longName") or meta.get("shortName") or "",
            "aliases": entry.get("aliases", []),
            "currency": currency,
            "type": meta.get("instrumentType") or "",
        }, None
    except Exception as err:
        return entry, None, f"{type(err).__name__}: {str(err)[:80]}"


def main():
    entries = json.loads(NAMES_FILE.read_text(encoding="utf-8"))
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(check, entries))

    kept, dropped = [], []
    for entry, row, problem in results:
        if row:
            kept.append(row)
            print(f"OK   {row['ticker']:<11} {row['currency']} {row['type']:<7} {row['name_ko']}  <->  {row['name_en']}")
        else:
            dropped.append((entry, problem))
    for entry, problem in dropped:
        print(f"DROP {entry['ticker']:<11} {entry['name_ko']}  ({problem})")

    NAMES_FILE.write_text(json.dumps(kept, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\nkept {len(kept)} / dropped {len(dropped)} -> {NAMES_FILE}")


if __name__ == "__main__":
    main()
