import pytest

from services.price import normalize_quote


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
