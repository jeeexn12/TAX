import os
from datetime import date, timedelta

import requests
from dotenv import load_dotenv

load_dotenv()

EXIM_API_KEY = os.getenv("EXIM_API_KEY")
EXIM_URL = "https://www.koreaexim.go.kr/site/program/financial/exchangeJSON"

_cache: dict[str, float] = {}


class FxLookupError(Exception):
    pass


def _fetch_rate_for_date(d: date) -> float | None:
    """Query the Eximbank API for USD/KRW deal_bas_r on an exact date.
    Returns None if no data is published for that date (weekend/holiday)."""
    resp = requests.get(
        EXIM_URL,
        params={"authkey": EXIM_API_KEY, "searchdate": d.strftime("%Y%m%d"), "data": "AP01"},
        timeout=10,
    )
    resp.raise_for_status()
    rows = resp.json()
    for row in rows:
        if row.get("cur_unit") == "USD":
            return float(row["deal_bas_r"].replace(",", ""))
    return None


def get_usd_krw_rate(target_date: date, max_lookback_days: int = 7) -> float:
    """Return USD/KRW 매매기준율 for target_date.

    The Eximbank API only publishes rates on business days, so if target_date
    has no data (weekend/holiday) this walks backward to the most recent
    business day, matching how a same-day trade would be converted using the
    latest available published rate.
    """
    cache_key = target_date.isoformat()
    if cache_key in _cache:
        return _cache[cache_key]

    d = target_date
    for _ in range(max_lookback_days):
        rate = _fetch_rate_for_date(d)
        if rate is not None:
            _cache[cache_key] = rate
            return rate
        d -= timedelta(days=1)

    raise FxLookupError(
        f"{target_date.isoformat()} 기준 최근 {max_lookback_days}일 내 환율 데이터를 찾을 수 없습니다."
    )
