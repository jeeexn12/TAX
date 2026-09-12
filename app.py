"""주가·환율 조회만 담당하는 서버.

거래 기록은 사용자 브라우저에만 저장되므로 이 서버는 어떤 개인 데이터도
받지 않고 저장하지도 않는다. 환율 API 키를 브라우저에 노출하지 않고,
하루 1,000회 조회 제한을 서버 캐시로 공유하기 위해 중계만 한다.
"""

from datetime import date

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


@app.get("/api/history")
def history():
    """정액 반복매수 미리보기에 쓰는 거래일별 종가 + 그날 고시환율.

    금액은 받지 않는다. 수량 역산은 브라우저에서 하므로 서버는 공개 시세만 다룬다.
    """
    ticker = request.args.get("ticker", "").strip().upper()
    if not ticker:
        return jsonify({"error": "티커를 입력해주세요."}), 400

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

    try:
        rates = get_usd_krw_rates([d for d, _ in closes])
    except FxLookupError as err:
        return jsonify({"error": str(err)}), 502
    except Exception:
        return jsonify({"error": "환율 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요."}), 502

    return jsonify(
        {
            "ticker": ticker,
            "rows": [
                {
                    "date": d.isoformat(),
                    "close_usd": round(close, 4),
                    "fx_rate": rates[d].rate,
                    "fx_applied_date": rates[d].applied_date.isoformat(),
                    "fx_is_fallback": rates[d].is_fallback,
                }
                for d, close in closes
            ],
        }
    )


if __name__ == "__main__":
    app.run(port=5000, debug=True)
