"""외부 데이터 연동 수동 확인용 스크립트.

    python scripts/test_apis.py
"""

import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.fx import CACHE_FILE, get_usd_krw_rate
from services.price import get_current_price_usd

WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"]


def show_rate(label: str, d: date) -> None:
    started = time.perf_counter()
    fx = get_usd_krw_rate(d)
    elapsed = time.perf_counter() - started
    note = f" -> {fx.applied_label}" if fx.is_fallback else ""
    print(f"  {label} {d} ({WEEKDAYS[d.weekday()]}): {fx.rate:,.2f}원{note}  [{elapsed:.3f}초]")


if __name__ == "__main__":
    print("[환율] 한국수출입은행 Open API")
    show_rate("영업일 ", date(2026, 9, 11))
    show_rate("일요일 ", date(2026, 9, 6))
    show_rate("오늘   ", date.today())
    print("  캐시 재조회(API 호출 없어야 함):")
    show_rate("영업일 ", date(2026, 9, 11))
    print(f"  캐시 파일: {CACHE_FILE}")

    print("\n[시세] yfinance")
    for ticker in ("AAPL", "MSFT"):
        print(f"  {ticker}: ${get_current_price_usd(ticker):,.2f}")
