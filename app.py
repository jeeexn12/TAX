"""주가·환율 조회만 담당하는 서버.

거래 기록은 사용자 브라우저에만 저장되므로 이 서버는 어떤 개인 데이터도
받지 않고 저장하지도 않는다. 환율 API 키를 브라우저에 노출하지 않고,
하루 1,000회 조회 제한을 서버 캐시로 공유하기 위해 중계만 한다.
"""

from datetime import date

from flask import Flask, jsonify, request, send_from_directory

from services.fx import FxLookupError, get_usd_krw_rate
from services.price import PriceLookupError, get_current_price_usd

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


if __name__ == "__main__":
    app.run(port=5000, debug=True)
