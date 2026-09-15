import pytest

import services.search as search


@pytest.fixture
def yahoo(monkeypatch):
    """야후 검색을 가짜로 바꾼다. 인터넷 없이 돌고, 몇 번 불렸는지도 확인할 수 있다."""
    search._remote_cache.clear()
    state = {"calls": [], "quotes": [], "error": False}

    def fake(query):
        state["calls"].append(query)
        if state["error"]:
            raise RuntimeError("yahoo down")
        return state["quotes"]

    monkeypatch.setattr(search, "_yahoo_quotes", fake)
    return state


def tickers(result):
    return [item["ticker"] for item in result["results"]]


def test_korean_name_finds_the_ticker_without_asking_yahoo(yahoo):
    result = search.search_tickers("애플")

    assert tickers(result)[0] == "AAPL"
    assert "AAPU" in tickers(result)  # 애플 2배
    assert yahoo["calls"] == []


def test_leveraged_etfs_are_found_by_korean_alias(yahoo):
    assert tickers(search.search_tickers("나스닥 3배"))[0] == "TQQQ"

    top = tickers(search.search_tickers("엔비디아 2배"))
    assert set(top[:3]) == {"NVDL", "NVDU", "NVDX"}
    assert "NVDA" not in top


def test_spacing_case_and_punctuation_do_not_matter(yahoo):
    assert tickers(search.search_tickers("tqqq"))[0] == "TQQQ"
    assert tickers(search.search_tickers("나스닥3배"))[0] == "TQQQ"
    assert tickers(search.search_tickers("brk-b"))[0] == "BRK-B"
    assert tickers(search.search_tickers("7203.t"))[0] == "7203.T"


def test_yahoo_results_are_filtered_to_supported_markets_and_merged(yahoo):
    yahoo["quotes"] = [
        {"symbol": "AAPL", "quoteType": "EQUITY", "exchange": "NMS", "shortname": "Apple Inc."},
        {"symbol": "APLE", "quoteType": "EQUITY", "exchange": "NYQ", "shortname": "Apple Hospitality", "exchDisp": "NYSE"},
        {"symbol": "AAPL.TO", "quoteType": "EQUITY", "exchange": "TOR", "shortname": "Apple CDR"},
        {"symbol": "SAAPL=F", "quoteType": "FUTURE", "exchange": "CME", "shortname": "Apple futures"},
    ]

    result = search.search_tickers("apple")

    assert tickers(result)[0] == "AAPL"
    assert tickers(result).count("AAPL") == 1
    assert "APLE" in tickers(result)
    assert "AAPL.TO" not in tickers(result)  # 캐나다 달러는 지원하지 않는다
    assert "SAAPL=F" not in tickers(result)  # 선물은 주식이 아니다

    aple = next(item for item in result["results"] if item["ticker"] == "APLE")
    assert aple["currency"] == "USD"
    assert aple["currency_verified"] is False
    assert aple["exchange"] == "NYSE"


def test_yahoo_failure_still_returns_the_name_list(yahoo):
    yahoo["error"] = True

    result = search.search_tickers("tesla")

    assert "TSLA" in tickers(result)
    assert result["remote_error"] is True


def test_korean_query_with_digits_does_not_pull_unrelated_yahoo_results(yahoo):
    yahoo["quotes"] = [
        {"symbol": "KORU", "quoteType": "ETF", "exchange": "PCX", "shortname": "Direxion Korea Bull 3X"},
    ]

    result = search.search_tickers("나스닥 3배")

    assert tickers(result)[0] == "TQQQ"
    assert "KORU" not in tickers(result)
    assert yahoo["calls"] == []


def test_unknown_korean_name_returns_nothing_quietly(yahoo):
    result = search.search_tickers("없는종목이름")

    assert result == {"results": [], "remote_error": False}
    assert yahoo["calls"] == []


def test_name_list_has_unique_tickers_in_supported_currencies():
    names = search.load_names()
    listed = [entry["ticker"] for entry in names]

    assert len(listed) == len(set(listed))
    assert all(entry["currency"] in {"USD", "JPY", "HKD", "CNH", "EUR", "GBP"} for entry in names)
    assert all(entry["name_ko"] for entry in names)
