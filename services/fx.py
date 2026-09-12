"""한국수출입은행 Open API 기반 USD/KRW 매매기준율 조회.

고시는 영업일에만 이뤄지므로(평일 11시 전후 갱신), 조회일에 고시가 없으면
직전 영업일까지 거슬러 올라가고 실제로 적용된 고시일을 함께 반환한다.
과거 고시환율은 바뀌지 않으므로 날짜별로 로컬에 캐시한다.
"""

from __future__ import annotations

import json
import re
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv()

EXIM_API_KEY = os.getenv("EXIM_API_KEY")
EXIM_URL = "https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON"
CACHE_FILE = Path(__file__).resolve().parent.parent / "data" / "fx_cache.json"

RESULT_MESSAGES = {
    2: "DATA 코드 오류",
    3: "인증코드 오류 (API 키를 확인해주세요)",
    4: "일일 조회 제한 횟수(1,000회)를 초과했습니다",
}


class FxLookupError(Exception):
    pass


@dataclass
class FxRate:
    requested_date: date
    applied_date: date
    rate: float

    @property
    def is_fallback(self) -> bool:
        return self.applied_date != self.requested_date

    @property
    def applied_label(self) -> str:
        return f"{self.applied_date.month}월 {self.applied_date.day}일 고시환율 적용"


def cache_key(d: date, currency: str) -> str:
    return f"{currency}:{d.isoformat()}"


def _load_cache() -> dict[str, float | None]:
    if not CACHE_FILE.exists():
        return {}
    try:
        with CACHE_FILE.open(encoding="utf-8") as f:
            raw = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}
    # 통화 구분을 넣기 전에 저장된 항목은 전부 USD였다.
    return {(k if ":" in k else f"USD:{k}"): v for k, v in raw.items()}


def _save_cache(cache: dict[str, float | None]) -> None:
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with CACHE_FILE.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2, sort_keys=True)


def parse_cur_unit(cur_unit: str) -> tuple[str, int]:
    """고시 통화코드를 (통화, 단위배수)로 나눈다.

    엔화는 'JPY(100)', 루피아는 'IDR(100)'처럼 100단위로 고시된다. 배수를
    무시하고 그대로 곱하면 취득가액이 100배로 부풀어 오르므로 반드시 나눠야 한다.
    """
    match = re.fullmatch(r"([A-Z]{3})(?:\((\d+)\))?", cur_unit.strip())
    if not match:
        return cur_unit.strip(), 1
    return match.group(1), int(match.group(2) or 1)


def _fetch_rate(d: date, currency: str = "USD") -> float | None:
    """해당 날짜의 1통화당 원화 매매기준율. 고시가 없는 날(주말/공휴일)이면 None."""
    resp = requests.get(
        EXIM_URL,
        params={"authkey": EXIM_API_KEY, "searchdate": d.strftime("%Y%m%d"), "data": "AP01"},
        timeout=15,
    )
    resp.raise_for_status()

    try:
        rows = resp.json()
    except json.JSONDecodeError:
        raise FxLookupError(f"환율 API 응답을 해석할 수 없습니다: {resp.text[:200]}")

    if not rows:
        return None

    result_code = rows[0].get("result")
    if result_code != 1:
        raise FxLookupError(
            f"환율 API 오류({result_code}): {RESULT_MESSAGES.get(result_code, '알 수 없는 오류')}"
        )

    for row in rows:
        code, multiplier = parse_cur_unit(row.get("cur_unit", ""))
        if code == currency:
            quoted = float(row["deal_bas_r"].replace(",", ""))
            return quoted / multiplier
    return None


_cache_lock = threading.Lock()
BULK_WORKERS = 8


def get_usd_krw_rates(
    target_dates: list[date], max_lookback_days: int = 10, currency: str = "USD"
) -> dict[date, FxRate]:
    """여러 날짜의 고시환율을 한 번에 조회한다.

    수출입은행 API는 날짜당 1회 호출만 가능해서 1년치면 250회가 된다. 순차로
    돌면 수십 초가 걸리므로 병렬로 받아오고, 캐시는 마지막에 한 번만 저장한다.
    고시가 없는 날은 직전 영업일을 다시 조회해야 하므로 라운드를 반복한다.
    """
    today = date.today()
    with _cache_lock:
        cache = _load_cache()

    def fetch_missing(candidates: set[date]) -> None:
        pending = sorted(d for d in candidates if cache_key(d, currency) not in cache)
        if not pending:
            return
        with ThreadPoolExecutor(max_workers=BULK_WORKERS) as pool:
            rates = pool.map(lambda d: _fetch_rate(d, currency), pending)
            for d, rate in zip(pending, rates):
                if rate is not None or d < today:
                    cache[cache_key(d, currency)] = rate

    resolved: dict[date, FxRate] = {}
    unresolved = {min(d, today) for d in target_dates}
    fetch_missing(unresolved)

    for _ in range(max_lookback_days):
        still_missing: set[date] = set()
        for original in target_dates:
            if original in resolved:
                continue
            cursor = min(original, today)
            for _ in range(max_lookback_days):
                key = cache_key(cursor, currency)
                if key not in cache:
                    still_missing.add(cursor)
                    break
                if cache[key] is not None:
                    resolved[original] = FxRate(original, cursor, cache[key])
                    break
                cursor -= timedelta(days=1)
        if not still_missing:
            break
        fetch_missing(still_missing)

    with _cache_lock:
        stored = _load_cache()
        stored.update(cache)
        _save_cache(stored)

    missing = [d for d in target_dates if d not in resolved]
    if missing:
        raise FxLookupError(f"{missing[0].isoformat()} 등 {len(missing)}건의 고시환율을 찾을 수 없습니다.")
    return resolved


def get_usd_krw_rate(target_date: date, max_lookback_days: int = 10, currency: str = "USD") -> FxRate:
    """target_date 기준 매매기준율을 조회한다.

    고시가 없는 날짜면 직전 영업일 고시를 사용하고, 실제 적용된 고시일을
    FxRate.applied_date로 알려준다.
    """
    today = date.today()
    cache = _load_cache()
    cache_dirty = False

    cursor = min(target_date, today)
    for _ in range(max_lookback_days):
        key = cache_key(cursor, currency)

        if key in cache:
            rate = cache[key]
        else:
            rate = _fetch_rate(cursor, currency)
            # 고시 없음(None)은 과거 날짜에 대해서만 캐시한다.
            # 오늘은 아직 고시 전(11시 이전)일 수 있어 나중에 값이 생긴다.
            if rate is not None or cursor < today:
                cache[key] = rate
                cache_dirty = True

        if rate is not None:
            if cache_dirty:
                _save_cache(cache)
            return FxRate(requested_date=target_date, applied_date=cursor, rate=rate)

        cursor -= timedelta(days=1)

    if cache_dirty:
        _save_cache(cache)
    raise FxLookupError(
        f"{target_date.isoformat()} 기준 최근 {max_lookback_days}일 내 고시환율을 찾을 수 없습니다."
    )
