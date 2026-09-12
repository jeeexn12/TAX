"""한국수출입은행 Open API 기반 USD/KRW 매매기준율 조회.

고시는 영업일에만 이뤄지므로(평일 11시 전후 갱신), 조회일에 고시가 없으면
직전 영업일까지 거슬러 올라가고 실제로 적용된 고시일을 함께 반환한다.
과거 고시환율은 바뀌지 않으므로 날짜별로 로컬에 캐시한다.
"""

from __future__ import annotations

import json
import os
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


def _load_cache() -> dict[str, float | None]:
    if not CACHE_FILE.exists():
        return {}
    try:
        with CACHE_FILE.open(encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def _save_cache(cache: dict[str, float | None]) -> None:
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with CACHE_FILE.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2, sort_keys=True)


def _fetch_rate(d: date) -> float | None:
    """해당 날짜의 USD 매매기준율. 고시가 없는 날(주말/공휴일)이면 None."""
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
        if row.get("cur_unit") == "USD":
            return float(row["deal_bas_r"].replace(",", ""))
    return None


def get_usd_krw_rate(target_date: date, max_lookback_days: int = 10) -> FxRate:
    """target_date 기준 매매기준율을 조회한다.

    고시가 없는 날짜면 직전 영업일 고시를 사용하고, 실제 적용된 고시일을
    FxRate.applied_date로 알려준다.
    """
    today = date.today()
    cache = _load_cache()
    cache_dirty = False

    cursor = min(target_date, today)
    for _ in range(max_lookback_days):
        key = cursor.isoformat()

        if key in cache:
            rate = cache[key]
        else:
            rate = _fetch_rate(cursor)
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
