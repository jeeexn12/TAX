import pandas as pd
import pytest

import services.price as price
from services.price import PriceLookupError, normalize_quote


class FakeTicker:
    """마지막 거래일 종가가 비어 있는 야후 응답을 흉내 낸다."""

    closes = [3000.0, 3021.0, float("nan")]

    def __init__(self, symbol):
        self.history_metadata = {"currency": "JPY"}

    def history(self, **kwargs):
        index = pd.to_datetime(["2026-09-14", "2026-09-15", "2026-09-16"])
        return pd.DataFrame({"Close": self.closes}, index=index)


def test_empty_last_close_is_skipped_instead_of_returned_as_nan(monkeypatch):
    monkeypatch.setattr(price.yf, "Ticker", FakeTicker)

    assert price.get_current_price("7203.T") == (3021.0, "JPY")

    rows, currency = price.get_daily_quotes("7203.T", pd.Timestamp("2026-09-14").date(), pd.Timestamp("2026-09-16").date())
    assert [close for _, close in rows] == [3000.0, 3021.0]
    assert currency == "JPY"


def test_all_empty_closes_raise_a_lookup_error(monkeypatch):
    class AllEmpty(FakeTicker):
        closes = [float("nan")] * 3

    monkeypatch.setattr(price.yf, "Ticker", AllEmpty)

    with pytest.raises(PriceLookupError):
        price.get_current_price("7203.T")


def test_london_pence_are_converted_to_pounds():
    # SHEL.L은 3569.5(펜스)로 호가된다. 그대로 쓰면 파운드 기준 100배가 된다.
    price, currency = normalize_quote(3569.5, "GBp")
    assert currency == "GBP"
    assert price == pytest.approx(35.695)


def test_mainland_yuan_quotes_use_the_published_cnh_rate():
    assert normalize_quote(1272.75, "CNY") == (1272.75, "CNH")


def test_other_currencies_pass_through():
    assert normalize_quote(3021.0, "JPY") == (3021.0, "JPY")
    assert normalize_quote(180.5, None) == (180.5, None)
