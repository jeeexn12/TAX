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

    def _fetch(d):
        calls.append(d)
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

    assert cached["2026-09-11"] == 1338.2
    assert "2026-09-12" not in cached


def test_api_error_code_raises(isolated_cache, monkeypatch, frozen_today):
    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return [{"result": 4}]

    monkeypatch.setattr(fx.requests, "get", lambda *a, **k: FakeResponse())

    with pytest.raises(fx.FxLookupError, match="일일 조회 제한"):
        fx.get_usd_krw_rate(FRIDAY)
