import yfinance as yf


class PriceLookupError(Exception):
    pass


def get_current_price_usd(ticker: str) -> float:
    """Return the most recent closing price in USD for a US-listed ticker."""
    t = yf.Ticker(ticker)
    hist = t.history(period="5d")
    if hist.empty:
        raise PriceLookupError(f"'{ticker}' 시세를 찾을 수 없습니다.")
    return float(hist["Close"].iloc[-1])
