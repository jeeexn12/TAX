from __future__ import annotations

from datetime import date, timedelta

import yfinance as yf


class PriceLookupError(Exception):
    pass


# 야후 파이낸스의 호가 통화 표기를 수출입은행 고시 통화로 맞춘다.
# 런던 상장 주식은 펜스(GBp)로 호가되어 그대로 쓰면 파운드 기준 100배가 되고,
# 중국 본토 주식은 CNY로 표시되지만 고시환율은 CNH(위안화)로만 나온다.
QUOTE_CURRENCY = {
    "GBp": ("GBP", 100),
    "GBX": ("GBP", 100),
    "CNY": ("CNH", 1),
}


def normalize_quote(price: float, currency: str | None) -> tuple[float, str | None]:
    """야후 호가를 (고시 통화 기준 가격, 고시 통화코드)로 바꾼다."""
    if currency in QUOTE_CURRENCY:
        code, divisor = QUOTE_CURRENCY[currency]
        return price / divisor, code
    return price, currency


def _quote_currency(ticker: yf.Ticker) -> str | None:
    """history()를 부른 뒤에만 채워지는 메타데이터에서 호가 통화를 읽는다."""
    try:
        return (ticker.history_metadata or {}).get("currency")
    except Exception:
        return None


def get_daily_quotes(ticker: str, start: date, end: date) -> tuple[list[tuple[date, float]], str | None]:
    """구간 내 거래일별 종가와 호가 통화. 주말·휴장일은 애초에 행이 없으므로 자연히 빠진다."""
    t = yf.Ticker(ticker)
    hist = t.history(start=start.isoformat(), end=(end + timedelta(days=1)).isoformat())
    if hist.empty:
        raise PriceLookupError(f"'{ticker}'의 {start}~{end} 구간 시세를 찾을 수 없습니다.")

    raw_currency = _quote_currency(t)
    _, currency = normalize_quote(0.0, raw_currency)
    rows = [
        (stamp.date(), normalize_quote(float(close), raw_currency)[0])
        for stamp, close in hist["Close"].items()
    ]
    return rows, currency


def get_daily_closes(ticker: str, start: date, end: date) -> list[tuple[date, float]]:
    return get_daily_quotes(ticker, start, end)[0]


def get_current_price(ticker: str) -> tuple[float, str | None]:
    """가장 최근 종가와 호가 통화."""
    t = yf.Ticker(ticker)
    hist = t.history(period="5d")
    if hist.empty:
        raise PriceLookupError(f"'{ticker}' 시세를 찾을 수 없습니다.")
    return normalize_quote(float(hist["Close"].iloc[-1]), _quote_currency(t))


def get_current_price_usd(ticker: str) -> float:
    """달러 종목만 다루던 때의 이름. 통화까지 필요하면 get_current_price를 쓴다."""
    return get_current_price(ticker)[0]
