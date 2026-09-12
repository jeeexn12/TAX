from datetime import date, timedelta

import yfinance as yf


class PriceLookupError(Exception):
    pass


def get_daily_closes(ticker: str, start: date, end: date) -> list[tuple[date, float]]:
    """구간 내 거래일별 종가. 주말·휴장일은 애초에 행이 없으므로 자연히 빠진다."""
    hist = yf.Ticker(ticker).history(
        start=start.isoformat(), end=(end + timedelta(days=1)).isoformat()
    )
    if hist.empty:
        raise PriceLookupError(f"'{ticker}'의 {start}~{end} 구간 시세를 찾을 수 없습니다.")
    return [(stamp.date(), float(close)) for stamp, close in hist["Close"].items()]


def get_current_price_usd(ticker: str) -> float:
    """Return the most recent closing price in USD for a US-listed ticker."""
    t = yf.Ticker(ticker)
    hist = t.history(period="5d")
    if hist.empty:
        raise PriceLookupError(f"'{ticker}' 시세를 찾을 수 없습니다.")
    return float(hist["Close"].iloc[-1])
