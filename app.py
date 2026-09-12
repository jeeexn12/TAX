"""주가·환율 조회만 담당하는 서버.

거래 기록은 사용자 브라우저에만 저장되므로 이 서버는 어떤 개인 데이터도
받지 않고 저장하지도 않는다. 환율 API 키를 브라우저에 노출하지 않고,
하루 1,000회 조회 제한을 서버 캐시로 공유하기 위해 중계만 한다.
"""

from datetime import date, timedelta

from flask import Flask, jsonify, request, send_from_directory

from services.fx import FxLookupError, get_usd_krw_rate, get_usd_krw_rates
from services.price import PriceLookupError, get_current_price_usd, get_daily_closes

MAX_HISTORY_DAYS = 366

app = Flask(__name__, static_folder="static", static_url_path="")


@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.get("/api/fx")
def fx():
    raw_date = request.args.get("date", "")
    try:
        target = date.fromisoformat(raw_date)
    except ValueError:
        return jsonify({"error": "날짜 형식이 올바르지 않습니다. (예: 2026-01-15)"}), 400

    try:
        result = get_usd_krw_rate(target)
    except FxLookupError as err:
        return jsonify({"error": str(err)}), 502
    except Exception:
        return jsonify({"error": "환율 서버에 연결하지 못했습니다. 직접 입력해주세요."}), 502

    return jsonify(
        {
            "rate": result.rate,
            "applied_date": result.applied_date.isoformat(),
            "applied_label": result.applied_label,
            "is_fallback": result.is_fallback,
        }
    )


@app.get("/api/price")
def price():
    ticker = request.args.get("ticker", "").strip().upper()
    if not ticker:
        return jsonify({"error": "티커를 입력해주세요."}), 400

    try:
        return jsonify({"ticker": ticker, "price_usd": get_current_price_usd(ticker)})
    except PriceLookupError as err:
        return jsonify({"error": str(err)}), 404
    except Exception:
        return jsonify({"error": "시세 서버에 연결하지 못했습니다. 직접 입력해주세요."}), 502


def _settlement_date(trade_day: date, business_days: int) -> date:
    """체결일 + N영업일. 주말만 제외하며 settings.js의 계산과 같아야 한다."""
    cursor = trade_day
    added = 0
    while added < business_days:
        cursor += timedelta(days=1)
        if cursor.weekday() < 5:
            added += 1
    return cursor


@app.get("/api/history")
def history():
    """정액 반복매수 미리보기에 쓰는 거래일별 종가 + 결제일 고시환율.

    환율은 체결일이 아니라 결제일 기준이다(시행령 제178조의5 제1항). 금액은 받지
    않는다. 수량 역산은 브라우저에서 하므로 서버는 공개 시세만 다룬다.
    """
    ticker = request.args.get("ticker", "").strip().upper()
    if not ticker:
        return jsonify({"error": "티커를 입력해주세요."}), 400

    try:
        settlement_days = int(request.args.get("settlement_days", 2))
    except ValueError:
        return jsonify({"error": "결제일 기준이 올바르지 않습니다."}), 400
    if not 0 <= settlement_days <= 10:
        return jsonify({"error": "결제일 기준은 0~10영업일 사이여야 합니다."}), 400

    try:
        start = date.fromisoformat(request.args.get("start", ""))
        end = date.fromisoformat(request.args.get("end", ""))
    except ValueError:
        return jsonify({"error": "날짜 형식이 올바르지 않습니다. (예: 2026-01-15)"}), 400

    if end < start:
        return jsonify({"error": "종료일이 시작일보다 빠릅니다."}), 400
    if (end - start).days > MAX_HISTORY_DAYS:
        return jsonify({"error": "한 번에 조회할 수 있는 기간은 1년까지입니다."}), 400

    end = min(end, date.today())

    try:
        closes = get_daily_closes(ticker, start, end)
    except PriceLookupError as err:
        return jsonify({"error": str(err)}), 404
    except Exception:
        return jsonify({"error": "시세 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요."}), 502

    settlements = {d: _settlement_date(d, settlement_days) for d, _ in closes}

    try:
        rates = get_usd_krw_rates(list(settlements.values()))
    except FxLookupError as err:
        return jsonify({"error": str(err)}), 502
    except Exception:
        return jsonify({"error": "환율 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요."}), 502

    return jsonify(
        {
            "ticker": ticker,
            "settlement_days": settlement_days,
            "rows": [
                {
                    "date": d.isoformat(),
                    "settlement_date": settlements[d].isoformat(),
                    "close_usd": round(close, 4),
                    "fx_rate": rates[settlements[d]].rate,
                    "fx_applied_date": rates[settlements[d]].applied_date.isoformat(),
                    "fx_is_fallback": rates[settlements[d]].is_fallback,
                }
                for d, close in closes
            ],
        }
    )


if __name__ == "__main__":
    app.run(port=5000, debug=True)
