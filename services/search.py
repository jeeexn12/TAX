"""종목 검색. 한글 이름표와 야후 파이낸스 검색을 합쳐 후보를 돌려준다.

야후 검색은 한글 이름을 전혀 찾지 못한다(2026-09-15 확인: "애플", "테슬라" 모두 빈 결과).
그래서 자주 쓰는 종목은 ticker_names.json 이름표로 찾는다. 이름표의 티커와 통화는
scripts/verify_tickers.py로 야후에 조회해 확인한 값이다. 영어 이름과 티커는 야후 검색이
더 넓게 찾으므로 영문자나 숫자가 섞인 검색어는 야후 결과도 붙인다.
"""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path

NAMES_FILE = Path(__file__).with_name("ticker_names.json")
MAX_RESULTS = 8
CACHE_SECONDS = 3600

# 야후 검색 결과의 거래소 코드로 거래 통화를 추정한다. 런던 상장 ETF 중에는 달러로
# 거래되는 것도 있어서, 화면에서 고른 뒤 시세 조회로 실제 호가 통화를 다시 확인한다.
EXCHANGE_CURRENCY = {
    # 미국
    "NMS": "USD", "NGM": "USD", "NCM": "USD", "NAS": "USD", "NYQ": "USD",
    "PCX": "USD", "BTS": "USD", "ASE": "USD", "PNK": "USD", "OQX": "USD", "OQB": "USD",
    # 일본
    "JPX": "JPY", "TYO": "JPY",
    # 홍콩
    "HKG": "HKD",
    # 중국 본토 (호가 CNY → 고시 CNH)
    "SHH": "CNH", "SHZ": "CNH",
    # 영국
    "LSE": "GBP",
    # 유로존
    "GER": "EUR", "FRA": "EUR", "PAR": "EUR", "AMS": "EUR", "MIL": "EUR",
    "MCE": "EUR", "BRU": "EUR", "VIE": "EUR", "HEL": "EUR", "LIS": "EUR",
}
ALLOWED_TYPES = {"EQUITY", "ETF"}

_names: list[dict] | None = None
_remote_cache: dict[str, tuple[float, list[dict]]] = {}
_lock = threading.Lock()


def normalize(text: str | None) -> str:
    """띄어쓰기·대소문자·구분기호를 무시하고 비교한다. "나스닥 3배" == "나스닥3배", "brk-b" == "BRK-B"."""
    return re.sub(r"[\s\-_.·,()/]+", "", text or "").lower()


def load_names() -> list[dict]:
    global _names
    if _names is None:
        _names = json.loads(NAMES_FILE.read_text(encoding="utf-8"))
    return _names


def _score(entry: dict, q: str) -> int:
    ticker = normalize(entry["ticker"])
    keys = [normalize(name) for name in [entry["name_ko"], *entry.get("aliases", [])] if name]
    if ticker == q:
        return 100
    if q in keys:
        return 90
    if ticker.startswith(q):
        return 80
    if any(key.startswith(q) for key in keys):
        return 70
    if any(q in key for key in keys):
        return 50
    if len(q) >= 3 and q in normalize(entry.get("name_en")):
        return 30
    return 0


def _local_results(query: str) -> list[dict]:
    q = normalize(query)
    if not q:
        return []
    scored = [(_score(entry, q), index, entry) for index, entry in enumerate(load_names())]
    hits = sorted((item for item in scored if item[0] > 0), key=lambda item: (-item[0], item[1]))
    return [
        {
            "ticker": entry["ticker"],
            "name_ko": entry["name_ko"],
            "name_en": entry.get("name_en", ""),
            "currency": entry["currency"],
            "currency_verified": True,
            "type": entry.get("type", ""),
            "exchange": None,
            "source": "names",
        }
        for _, _, entry in hits
    ]


def _yahoo_quotes(query: str) -> list[dict]:
    import yfinance as yf

    return yf.Search(query, max_results=10, news_count=0, lists_count=0, recommended=0).quotes


def _remote_results(query: str) -> list[dict]:
    key = normalize(query)
    now = time.time()
    with _lock:
        cached = _remote_cache.get(key)
        if cached and now - cached[0] < CACHE_SECONDS:
            return cached[1]

    results = []
    for quote in _yahoo_quotes(query):
        exchange = quote.get("exchange")
        kind = quote.get("quoteType")
        if kind not in ALLOWED_TYPES or exchange not in EXCHANGE_CURRENCY or not quote.get("symbol"):
            continue
        results.append(
            {
                "ticker": quote["symbol"],
                "name_ko": None,
                "name_en": quote.get("longname") or quote.get("shortname") or "",
                "currency": EXCHANGE_CURRENCY[exchange],
                "currency_verified": False,
                "type": kind,
                "exchange": quote.get("exchDisp") or exchange,
                "source": "yahoo",
            }
        )

    with _lock:
        _remote_cache[key] = (now, results)
    return results


def search_tickers(query: str) -> dict:
    local = _local_results(query)
    remote: list[dict] = []
    remote_error = False

    # 야후 검색은 한글을 못 찾는다. 한글이 섞인 검색어를 보내면 "나스닥 3배"의 "3"만 보고
    # 상관없는 3배 ETF를 붙여오므로, 한글 없이 영문자나 숫자로 된 검색어만 보낸다.
    if (
        re.search(r"[A-Za-z0-9]", query)
        and not re.search(r"[가-힣ㄱ-ㅎㅏ-ㅣ]", query)
        and len(local) < MAX_RESULTS
    ):
        try:
            remote = _remote_results(query)
        except Exception:
            remote_error = True

    seen = {item["ticker"] for item in local}
    merged = local + [item for item in remote if item["ticker"] not in seen]
    return {"results": merged[:MAX_RESULTS], "remote_error": remote_error}
