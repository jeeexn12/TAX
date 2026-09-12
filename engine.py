"""국외주식 양도소득세 계산 엔진.

거래 기록(매수/매도)을 날짜순으로 재생(replay)해서 종목별 이동평균 취득가액과
매도 건별 양도차익을 도출하고, 연간 손익통산 후 세액을 계산한다.
"""

from __future__ import annotations

from dataclasses import dataclass

BASIC_DEDUCTION_KRW = 2_500_000
INCOME_TAX_RATE = 0.20
LOCAL_TAX_RATE = 0.10

QTY_EPSILON = 1e-9


class EngineError(Exception):
    pass


@dataclass
class Holding:
    ticker: str
    quantity: float = 0.0
    total_cost_krw: float = 0.0

    @property
    def avg_cost_krw(self) -> float:
        if self.quantity <= QTY_EPSILON:
            return 0.0
        return self.total_cost_krw / self.quantity


@dataclass
class RealizedSale:
    tx_id: str
    ticker: str
    date: str
    quantity: float
    proceeds_krw: float
    cost_krw: float

    @property
    def gain_krw(self) -> float:
        return self.proceeds_krw - self.cost_krw


@dataclass
class TaxResult:
    total_gain_krw: int
    deduction_krw: int
    taxable_base_krw: int
    income_tax_krw: int
    local_tax_krw: int
    total_tax_krw: int


def _sorted_transactions(transactions: list[dict]) -> list[dict]:
    return sorted(transactions, key=lambda t: t["date"])


def replay(transactions: list[dict]) -> tuple[dict[str, Holding], list[RealizedSale]]:
    """거래를 날짜순으로 처리해 현재 보유현황과 실현된 매도 목록을 반환한다."""
    holdings: dict[str, Holding] = {}
    sales: list[RealizedSale] = []

    for tx in _sorted_transactions(transactions):
        ticker = tx["ticker"]
        holding = holdings.setdefault(ticker, Holding(ticker))
        quantity = float(tx["quantity"])
        fx_rate = float(tx["fx_rate"])
        gross_usd = float(tx["price_usd"]) * quantity
        fee_usd = float(tx.get("fee_usd") or 0.0)

        if quantity <= 0:
            raise EngineError(f"{ticker} {tx['date']}: 수량은 0보다 커야 합니다.")

        if tx["type"] == "buy":
            holding.total_cost_krw += (gross_usd + fee_usd) * fx_rate
            holding.quantity += quantity
        elif tx["type"] == "sell":
            if quantity > holding.quantity + QTY_EPSILON:
                raise EngineError(
                    f"{ticker} {tx['date']}: 매도수량({quantity})이 보유수량({holding.quantity})을 초과합니다."
                )
            cost_krw = holding.avg_cost_krw * quantity
            sales.append(
                RealizedSale(
                    tx_id=tx.get("id", ""),
                    ticker=ticker,
                    date=tx["date"],
                    quantity=quantity,
                    proceeds_krw=(gross_usd - fee_usd) * fx_rate,
                    cost_krw=cost_krw,
                )
            )
            holding.total_cost_krw -= cost_krw
            holding.quantity -= quantity
            if holding.quantity <= QTY_EPSILON:
                holding.quantity = 0.0
                holding.total_cost_krw = 0.0
        else:
            raise EngineError(f"알 수 없는 거래 구분: {tx['type']}")

    return holdings, sales


def calculate_tax(total_gain_krw: float) -> TaxResult:
    """연간 손익통산 결과에 기본공제와 세율을 적용한다.

    손실은 당해연도 내 통산만 가능하고 이월되지 않으므로, 통산 결과가 음수면
    과세표준은 0이 된다.
    """
    gain = int(total_gain_krw)
    deduction = min(BASIC_DEDUCTION_KRW, gain) if gain > 0 else 0
    taxable_base = max(0, gain - deduction)
    income_tax = int(taxable_base * INCOME_TAX_RATE)
    local_tax = int(income_tax * LOCAL_TAX_RATE)

    return TaxResult(
        total_gain_krw=gain,
        deduction_krw=deduction,
        taxable_base_krw=taxable_base,
        income_tax_krw=income_tax,
        local_tax_krw=local_tax,
        total_tax_krw=income_tax + local_tax,
    )


def annual_summary(transactions: list[dict], year: int) -> tuple[dict[str, Holding], list[RealizedSale], TaxResult]:
    """해당 연도 기준 보유현황, 실현 매도 내역, 세액을 함께 반환한다."""
    holdings, sales = replay(transactions)
    year_sales = [s for s in sales if s.date[:4] == str(year)]
    total_gain = sum(s.gain_krw for s in year_sales)
    return holdings, year_sales, calculate_tax(total_gain)


def simulate(transactions: list[dict], virtual_sales: list[dict], year: int) -> dict:
    """가상 매도를 추가했을 때 늘어나는 세액을 계산한다.

    확정 거래만으로 계산한 세액과, 가상 매도를 포함해 계산한 세액의 차액이
    '지금 팔면 추가로 내야 하는 세금'이다.
    """
    _, _, before = annual_summary(transactions, year)
    _, sim_sales, after = annual_summary(transactions + virtual_sales, year)

    virtual_ids = {v.get("id") for v in virtual_sales}
    sim_only = [s for s in sim_sales if s.tx_id in virtual_ids]

    return {
        "before": before,
        "after": after,
        "additional_tax_krw": after.total_tax_krw - before.total_tax_krw,
        "simulated_sales": sim_only,
        "simulated_gain_krw": int(sum(s.gain_krw for s in sim_only)),
    }
