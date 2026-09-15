import json
from datetime import date

import pytest

from services import fx

FRIDAY = date(2026, 9, 11)
SATURDAY = date(2026, 9, 12)
SUNDAY = date(2026, 9, 6)

PUBLISHED = {date(2026, 9, 4): 1359.5, FRIDAY: 1338.2}


@pytest.fixture
def isolated_cache(tmp_path, monkeypatch):
    cache_file = tmp_path / "fx_cache.json"
    monkeypatch.setattr(fx, "CACHE_FILE", cache_file)
    return cache_file


@pytest.fixture
def fake_api(monkeypatch):
    calls = []

    def _fetch(d, currency="USD"):
        calls.append((d, currency))
        return PUBLISHED.get(d)

    monkeypatch.setattr(fx, "_fetch_rate", _fetch)
    return calls


@pytest.fixture
def frozen_today(monkeypatch):
    class FakeDate(date):
        @classmethod
        def today(cls):
            return SATURDAY

    monkeypatch.setattr(fx, "date", FakeDate)


def test_business_day_uses_its_own_published_rate(isolated_cache, fake_api, frozen_today):
    result = fx.get_usd_krw_rate(FRIDAY)

    assert result.rate == 1338.2
    assert result.applied_date == FRIDAY
    assert not result.is_fallback


def test_weekend_falls_back_to_previous_business_day(isolated_cache, fake_api, frozen_today):
    result = fx.get_usd_krw_rate(SUNDAY)

    assert result.rate == 1359.5
    assert result.applied_date == date(2026, 9, 4)
    assert result.is_fallback
    assert result.applied_label == "9월 4일 고시환율 적용"


def test_future_date_uses_latest_available_rate(isolated_cache, fake_api, frozen_today):
    result = fx.get_usd_krw_rate(date(2026, 12, 25))

    assert result.applied_date == FRIDAY
    assert result.rate == 1338.2


def test_repeat_lookup_is_served_from_cache(isolated_cache, fake_api, frozen_today):
    fx.get_usd_krw_rate(FRIDAY)
    call_count_after_first = len(fake_api)
    fx.get_usd_krw_rate(FRIDAY)

    assert len(fake_api) == call_count_after_first


def test_past_non_publication_days_are_cached_but_today_is_not(isolated_cache, fake_api, frozen_today):
    fx.get_usd_krw_rate(SATURDAY)
    cached = json.loads(isolated_cache.read_text(encoding="utf-8"))

    assert cached["USD:2026-09-11"] == 1338.2
    assert "USD:2026-09-12" not in cached


def test_cur_unit_multiplier_is_stripped():
    assert fx.parse_cur_unit("USD") == ("USD", 1)
    assert fx.parse_cur_unit("JPY(100)") == ("JPY", 100)
    assert fx.parse_cur_unit("IDR(100)") == ("IDR", 100)
    assert fx.parse_cur_unit("CNH") == ("CNH", 1)


def test_hundred_unit_currencies_are_divided(isolated_cache, monkeypatch):
    """엔화는 100엔당으로 고시된다. 그대로 쓰면 취득가액이 100배가 된다."""

    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return [
                {"result": 1, "cur_unit": "USD", "deal_bas_r": "1,338.2"},
                {"result": 1, "cur_unit": "JPY(100)", "deal_bas_r": "866.49"},
            ]

    monkeypatch.setattr(fx.requests, "get", lambda *a, **k: FakeResponse())

    assert fx._fetch_rate(FRIDAY, "USD") == 1338.2
    assert fx._fetch_rate(FRIDAY, "JPY") == pytest.approx(8.6649)


def test_cache_separates_currencies(isolated_cache, monkeypatch, frozen_today):
    published = {("USD", FRIDAY): 1338.2, ("JPY", FRIDAY): 8.6649}
    monkeypatch.setattr(fx, "_fetch_rate", lambda d, c="USD": published.get((c, d)))

    assert fx.get_usd_krw_rate(FRIDAY, currency="USD").rate == 1338.2
    assert fx.get_usd_krw_rate(FRIDAY, currency="JPY").rate == 8.6649

    cached = json.loads(isolated_cache.read_text(encoding="utf-8"))
    assert cached["USD:2026-09-11"] == 1338.2
    assert cached["JPY:2026-09-11"] == 8.6649


def test_legacy_cache_entries_are_read_as_usd(isolated_cache, monkeypatch, frozen_today):
    isolated_cache.write_text(json.dumps({"2026-09-11": 1338.2}), encoding="utf-8")

    def _fail(*args, **kwargs):
        raise AssertionError("캐시에 있는 값을 다시 조회하면 안 된다")

    monkeypatch.setattr(fx, "_fetch_rate", _fail)

    assert fx.get_usd_krw_rate(FRIDAY).rate == 1338.2


def test_api_error_code_raises(isolated_cache, monkeypatch, frozen_today):
    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return [{"result": 4}]

    monkeypatch.setattr(fx.requests, "get", lambda *a, **k: FakeResponse())

    with pytest.raises(fx.FxLookupError, match="일일 조회 제한"):
        fx.get_usd_krw_rate(FRIDAY)


def test_missing_api_key_is_reported_before_calling_the_api(monkeypatch):
    calls = []
    monkeypatch.setattr(fx, "EXIM_API_KEY", "")
    monkeypatch.setattr(fx.requests, "get", lambda *args, **kwargs: calls.append(args))

    with pytest.raises(fx.FxLookupError, match="EXIM_API_KEY"):
        fx._fetch_rate(FRIDAY, "USD")
    assert calls == []
