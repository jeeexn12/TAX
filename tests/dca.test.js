import assert from "node:assert/strict";
import test from "node:test";

import { buildLots, clampRange, nextStartDate, scheduledDates } from "../static/dca.js";
import { replay } from "../static/engine.js";

/** 10거래일치 종가·환율. 환율이 날마다 다르게 움직이도록 흔들어 둔다. */
const TEN_TRADING_DAYS = [
  { date: "2026-03-02", close_usd: 180.0, fx_rate: 1300.0, fx_applied_date: "2026-03-02" },
  { date: "2026-03-03", close_usd: 182.5, fx_rate: 1310.5, fx_applied_date: "2026-03-03" },
  { date: "2026-03-04", close_usd: 179.2, fx_rate: 1295.0, fx_applied_date: "2026-03-04" },
  { date: "2026-03-05", close_usd: 185.7, fx_rate: 1322.4, fx_applied_date: "2026-03-05" },
  { date: "2026-03-06", close_usd: 190.1, fx_rate: 1330.8, fx_applied_date: "2026-03-06" },
  { date: "2026-03-09", close_usd: 188.4, fx_rate: 1318.2, fx_applied_date: "2026-03-09" },
  { date: "2026-03-10", close_usd: 193.6, fx_rate: 1340.0, fx_applied_date: "2026-03-10" },
  { date: "2026-03-11", close_usd: 191.0, fx_rate: 1333.3, fx_applied_date: "2026-03-11" },
  { date: "2026-03-12", close_usd: 196.8, fx_rate: 1351.7, fx_applied_date: "2026-03-12" },
  { date: "2026-03-13", close_usd: 199.5, fx_rate: 1345.9, fx_applied_date: "2026-03-13" },
];

test("매일 5,000원씩 10거래일이면 로트 10개가 생기고 총 취득가액은 50,000원이다", () => {
  const lots = buildLots({
    ticker: "AAPL",
    currency: "KRW",
    amount: 5000,
    rows: TEN_TRADING_DAYS,
  });

  assert.equal(lots.length, 10);

  const { holdings } = replay(lots);
  const holding = holdings.get("AAPL");
  assert.ok(Math.abs(holding.totalCostKrw - 50_000) < 1e-6);

  // 평균으로 뭉치지 않고 날짜별로 각각 남아야 한다.
  assert.deepEqual(
    lots.map((lot) => lot.date),
    TEN_TRADING_DAYS.map((row) => row.date)
  );
  lots.forEach((lot, i) => {
    assert.equal(lot.price_usd, TEN_TRADING_DAYS[i].close_usd);
    assert.equal(lot.fx_rate, TEN_TRADING_DAYS[i].fx_rate);
    assert.equal(lot.source, "dca");
  });
});

test("원화 정액이면 회차마다 취득가액이 정확히 같고 수량이 달라진다", () => {
  const lots = buildLots({ ticker: "AAPL", currency: "KRW", amount: 5000, rows: TEN_TRADING_DAYS });

  const costs = lots.map((lot) => lot.price_usd * lot.quantity * lot.fx_rate);
  costs.forEach((cost) => assert.ok(Math.abs(cost - 5000) < 1e-9));

  const quantities = new Set(lots.map((lot) => lot.quantity));
  assert.equal(quantities.size, 10);
});

test("외화 정액이면 달러 금액이 같고 원화 취득가액은 환율따라 달라진다", () => {
  const lots = buildLots({ ticker: "AAPL", currency: "USD", amount: 100, rows: TEN_TRADING_DAYS });

  lots.forEach((lot, i) => {
    assert.ok(Math.abs(lot.quantity * lot.price_usd - 100) < 1e-9);
    assert.ok(Math.abs(lot.quantity - 100 / TEN_TRADING_DAYS[i].close_usd) < 1e-12);
  });

  const { holdings } = replay(lots);
  const expected = TEN_TRADING_DAYS.reduce((sum, row) => sum + 100 * row.fx_rate, 0);
  assert.ok(Math.abs(holdings.get("AAPL").totalCostKrw - expected) < 1e-6);
});

test("매일 모드는 구간 안의 거래일만 고른다", () => {
  const tradingDates = TEN_TRADING_DAYS.map((row) => row.date);

  const picked = scheduledDates({
    start: "2026-03-01",
    end: "2026-03-13",
    frequency: "daily",
    tradingDates,
  });

  // 3/7~3/8 주말은 애초에 거래일 목록에 없다.
  assert.equal(picked.length, 10);
  assert.ok(!picked.includes("2026-03-07"));
});

test("매주 모드는 휴장일이면 다음 거래일로 민다", () => {
  const tradingDates = TEN_TRADING_DAYS.map((row) => row.date);

  // 3/8은 일요일이라 거래일이 아니고, 다음 거래일인 3/9로 밀려야 한다.
  const picked = scheduledDates({
    start: "2026-03-01",
    end: "2026-03-13",
    frequency: "weekly",
    tradingDates,
  });

  assert.deepEqual(picked, ["2026-03-02", "2026-03-09"]);
});

test("긴 연휴로 두 회차가 같은 거래일로 밀리면 한 번만 매수한다", () => {
  const picked = scheduledDates({
    start: "2026-03-01",
    end: "2026-03-20",
    frequency: "weekly",
    tradingDates: ["2026-03-18"],
  });

  assert.deepEqual(picked, ["2026-03-18"]);
});

test("1년을 넘는 구간은 시작일 기준 1년으로 줄여서 알려준다", () => {
  assert.deepEqual(clampRange("2026-01-01", "2026-06-30"), {
    end: "2026-06-30",
    clamped: false,
  });
  assert.deepEqual(clampRange("2024-01-01", "2026-01-01"), {
    end: "2025-01-01",
    clamped: true,
  });
});

test("다음 구간 시작일은 마지막 로트 다음 날이다", () => {
  const lots = buildLots({ ticker: "AAPL", currency: "KRW", amount: 5000, rows: TEN_TRADING_DAYS });

  assert.equal(nextStartDate(lots), "2026-03-14");
  assert.equal(nextStartDate([]), null);
});
