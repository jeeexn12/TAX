import pytest

from engine import EngineError, annual_summary, calculate_tax, replay, simulate


def buy(ticker, date, quantity, price_usd, fx_rate, fee_usd=0.0, id=""):
    return {
        "id": id,
        "type": "buy",
        "ticker": ticker,
        "date": date,
        "quantity": quantity,
        "price_usd": price_usd,
        "fee_usd": fee_usd,
        "fx_rate": fx_rate,
    }


def sell(ticker, date, quantity, price_usd, fx_rate, fee_usd=0.0, id=""):
    return {**buy(ticker, date, quantity, price_usd, fx_rate, fee_usd, id), "type": "sell"}


def test_moving_average_uses_krw_at_each_purchase_date():
    txs = [
        buy("AAPL", "2026-01-10", 10, 100, 1300),
        buy("AAPL", "2026-03-10", 10, 100, 1400),
    ]
    holdings, _ = replay(txs)

    assert holdings["AAPL"].quantity == 20
    assert holdings["AAPL"].total_cost_krw == 2_700_000
    assert holdings["AAPL"].avg_cost_krw == 135_000


def test_sale_uses_average_cost_and_leaves_average_unchanged():
    txs = [
        buy("AAPL", "2026-01-10", 10, 100, 1300),
        buy("AAPL", "2026-03-10", 10, 100, 1400),
        sell("AAPL", "2026-06-10", 5, 120, 1450),
    ]
    holdings, sales = replay(txs)

    assert sales[0].proceeds_krw == 870_000
    assert sales[0].cost_krw == 675_000
    assert sales[0].gain_krw == 195_000
    assert holdings["AAPL"].quantity == 15
    assert holdings["AAPL"].avg_cost_krw == 135_000


def test_transactions_are_replayed_in_date_order_regardless_of_entry_order():
    out_of_order = [
        buy("AAPL", "2026-03-10", 10, 100, 1400),
        buy("AAPL", "2026-01-10", 10, 100, 1300),
    ]
    holdings, _ = replay(out_of_order)

    assert holdings["AAPL"].avg_cost_krw == 135_000


def test_fees_increase_cost_and_reduce_proceeds():
    txs = [
        buy("AAPL", "2026-01-10", 10, 100, 1300, fee_usd=10),
        sell("AAPL", "2026-06-10", 10, 100, 1300, fee_usd=10),
    ]
    holdings, sales = replay(txs)

    assert holdings["AAPL"].quantity == 0
    assert sales[0].cost_krw == 1_313_000
    assert sales[0].proceeds_krw == 1_287_000
    assert sales[0].gain_krw == -26_000


def test_selling_more_than_held_raises():
    txs = [buy("AAPL", "2026-01-10", 5, 100, 1300), sell("AAPL", "2026-02-10", 6, 100, 1300)]

    with pytest.raises(EngineError):
        replay(txs)


def test_tax_applies_basic_deduction_then_22_percent():
    result = calculate_tax(10_000_000)

    assert result.deduction_krw == 2_500_000
    assert result.taxable_base_krw == 7_500_000
    assert result.income_tax_krw == 1_500_000
    assert result.local_tax_krw == 150_000
    assert result.total_tax_krw == 1_650_000


def test_gain_below_deduction_is_not_taxed():
    result = calculate_tax(2_000_000)

    assert result.deduction_krw == 2_000_000
    assert result.taxable_base_krw == 0
    assert result.total_tax_krw == 0


def test_annual_loss_is_not_taxed_and_does_not_carry_forward():
    losing_year = [
        buy("AAPL", "2025-01-10", 10, 100, 1300),
        sell("AAPL", "2025-06-10", 10, 50, 1300),
    ]
    next_year = losing_year + [
        buy("MSFT", "2026-01-10", 10, 100, 1300),
        sell("MSFT", "2026-06-10", 10, 200, 1300),
    ]

    _, _, tax_2025 = annual_summary(losing_year, 2025)
    _, _, tax_2026 = annual_summary(next_year, 2026)

    assert tax_2025.total_gain_krw == -650_000
    assert tax_2025.total_tax_krw == 0
    assert tax_2026.total_gain_krw == 1_300_000
    assert tax_2026.deduction_krw == 1_300_000


def test_gains_and_losses_offset_within_the_same_year():
    txs = [
        buy("AAPL", "2026-01-10", 10, 100, 1300),
        sell("AAPL", "2026-06-10", 10, 200, 1300),
        buy("MSFT", "2026-01-10", 10, 100, 1300),
        sell("MSFT", "2026-07-10", 10, 50, 1300),
    ]
    _, sales, tax = annual_summary(txs, 2026)

    assert len(sales) == 2
    assert tax.total_gain_krw == 650_000
    assert tax.total_tax_krw == 0


def test_simulation_reports_additional_tax_over_confirmed_trades():
    confirmed = [
        buy("AAPL", "2026-01-10", 100, 100, 1300),
        sell("AAPL", "2026-06-10", 20, 200, 1300),
    ]
    virtual = [sell("AAPL", "2026-09-12", 20, 300, 1400, id="sim-1")]

    result = simulate(confirmed, virtual, 2026)

    assert result["before"].total_gain_krw == 2_600_000
    assert result["simulated_gain_krw"] == 5_800_000
    assert result["after"].total_gain_krw == 8_400_000
    assert result["additional_tax_krw"] == result["after"].total_tax_krw - result["before"].total_tax_krw
