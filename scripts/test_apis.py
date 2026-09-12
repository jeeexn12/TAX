import os
import sys
from datetime import date, timedelta

import requests
import yfinance as yf
from dotenv import load_dotenv

load_dotenv()

EXIM_API_KEY = os.getenv("EXIM_API_KEY")


def test_exim(search_date: str) -> bool:
    url = "https://www.koreaexim.go.kr/site/program/financial/exchangeJSON"
    params = {"authkey": EXIM_API_KEY, "searchdate": search_date, "data": "AP01"}
    resp = requests.get(url, params=params, timeout=10)
    resp.raise_for_status()
    rows = resp.json()
    usd_rows = [r for r in rows if r.get("cur_unit") == "USD"]
    if usd_rows:
        print(f"[한국수출입은행] {search_date} USD 매매기준율(deal_bas_r): {usd_rows[0].get('deal_bas_r')}")
        return True
    print(f"[한국수출입은행] {search_date} 데이터 없음 (주말/공휴일로 추정), 이전 영업일 재시도")
    return False


def test_yfinance(ticker: str) -> None:
    t = yf.Ticker(ticker)
    price = t.fast_info.get("last_price") if hasattr(t, "fast_info") else None
    if price is None:
        hist = t.history(period="1d")
        price = hist["Close"].iloc[-1] if not hist.empty else None
    print(f"[yfinance] {ticker} 현재가: {price}")


if __name__ == "__main__":
    today = date.today()
    for delta in range(7):
        d = today - timedelta(days=delta)
        if test_exim(d.strftime("%Y%m%d")):
            break

    test_yfinance("AAPL")
