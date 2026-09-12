import assert from "node:assert/strict";
import test from "node:test";

import {
  COST_METHOD,
  annualSummary,
  compareMethods,
  replay,
} from "../static/engine.js";

function buy(ticker, date, quantity, priceUsd, fxRate, feeUsd = 0, id = "") {
  return {
    id,
    type: "buy",
    ticker,
    date,
    quantity,
    price_usd: priceUsd,
    fee_usd: feeUsd,
    fx_rate: fxRate,
  };
}

function sell(ticker, date, quantity, priceUsd, fxRate, feeUsd = 0, id = "") {
  return { ...buy(ticker, date, quantity, priceUsd, fxRate, feeUsd, id), type: "sell" };
}

function split(ticker, date, ratio, id = "") {
  return { id, type: "split", ticker, date, ratio };
}

/** 싸게 산 10주와 비싸게 산 10주 중 절반만 파는, 두 방법이 갈리는 표준 사례. */
const CHEAP_THEN_EXPENSIVE = [
  buy("AAPL", "2026-01-10", 10, 100, 1300), // 1,300,000
  buy("AAPL", "2026-03-10", 10, 200, 1400), // 2,800,000
  sell("AAPL", "2026-06-10", 10, 250, 1350), // 양도가액 3,375,000
];

test("선입선출법은 먼저 산 로트의 취득가액을 대응시킨다", () => {
  const { holdings, sales } = replay(CHEAP_THEN_EXPENSIVE, COST_METHOD.FIFO);

  // 1월에 산 10주(1,300,000원)가 통째로 나간다
  assert.equal(sales[0].costKrw, 1_300_000);
  assert.equal(sales[0].gainKrw, 2_075_000);

  // 남은 것은 3월에 산 10주뿐
  assert.equal(holdings.get("AAPL").quantity, 10);
  assert.equal(holdings.get("AAPL").totalCostKrw, 2_800_000);
  assert.equal(holdings.get("AAPL").avgCostKrw, 280_000);
});

test("이동평균법은 두 로트를 섞은 평균단가를 대응시킨다", () => {
  const { holdings, sales } = replay(CHEAP_THEN_EXPENSIVE, COST_METHOD.AVERAGE);

  // (1,300,000 + 2,800,000) / 20 = 205,000원/주
  assert.equal(sales[0].costKrw, 2_050_000);
  assert.equal(sales[0].gainKrw, 1_325_000);

  assert.equal(holdings.get("AAPL").quantity, 10);
  assert.equal(holdings.get("AAPL").totalCostKrw, 2_050_000);
  assert.equal(holdings.get("AAPL").avgCostKrw, 205_000);
});

test("두 방법은 같은 입력에서 서로 다른 세액을 낸다", () => {
  const fifo = annualSummary(CHEAP_THEN_EXPENSIVE, 2026, COST_METHOD.FIFO).tax;
  const average = annualSummary(CHEAP_THEN_EXPENSIVE, 2026, COST_METHOD.AVERAGE).tax;

  // 같은 값이 나오면 둘 중 하나가 잘못 구현된 것이다
  assert.notEqual(fifo.totalGainKrw, average.totalGainKrw);

  assert.equal(fifo.totalGainKrw, 2_075_000);
  assert.equal(average.totalGainKrw, 1_325_000);

  // 이 규모에서는 둘 다 250만원 공제에 흡수되어 세액 차이는 드러나지 않는다
  assert.equal(fifo.taxableBaseKrw, 0);
  assert.equal(average.taxableBaseKrw, 0);
});

test("공제를 넘는 규모에서는 세액 차이가 그대로 드러난다", () => {
  const bigger = [
    buy("AAPL", "2026-01-10", 100, 100, 1300), // 13,000,000
    buy("AAPL", "2026-03-10", 100, 200, 1400), // 28,000,000
    sell("AAPL", "2026-06-10", 100, 250, 1350), // 33,750,000
  ];

  const fifo = annualSummary(bigger, 2026, COST_METHOD.FIFO).tax;
  const average = annualSummary(bigger, 2026, COST_METHOD.AVERAGE).tax;

  assert.equal(fifo.totalGainKrw, 20_750_000);
  assert.equal(fifo.taxableBaseKrw, 18_250_000);
  assert.equal(fifo.totalTaxKrw, 4_015_000);

  assert.equal(average.totalGainKrw, 13_250_000);
  assert.equal(average.taxableBaseKrw, 10_750_000);
  assert.equal(average.totalTaxKrw, 2_365_000);
});

test("선입선출법은 로트를 걸쳐서 부분 소진한다", () => {
  const acrossLots = [
    buy("AAPL", "2026-01-10", 10, 100, 1300), // 1,300,000
    buy("AAPL", "2026-03-10", 10, 200, 1400), // 2,800,000
    sell("AAPL", "2026-06-10", 15, 250, 1350),
  ];

  const { holdings, sales } = replay(acrossLots, COST_METHOD.FIFO);

  // 1월 10주 전부(1,300,000) + 3월 5주(2,800,000의 절반 = 1,400,000)
  assert.equal(sales[0].costKrw, 2_700_000);
  assert.equal(holdings.get("AAPL").quantity, 5);
  assert.equal(holdings.get("AAPL").totalCostKrw, 1_400_000);
});

test("선입선출법에서도 분할은 로트별 수량만 늘리고 취득가액은 유지한다", () => {
  const withSplit = [
    buy("AAPL", "2026-01-10", 10, 100, 1300), // 1,300,000
    buy("AAPL", "2026-03-10", 10, 200, 1400), // 2,800,000
    split("AAPL", "2026-05-20", 2),
    sell("AAPL", "2026-06-10", 20, 60, 1350),
  ];

  const { holdings, sales } = replay(withSplit, COST_METHOD.FIFO);

  // 분할로 1월 로트가 20주가 되었고, 그 20주가 통째로 나간다
  assert.equal(sales[0].costKrw, 1_300_000);
  assert.equal(holdings.get("AAPL").quantity, 20);
  assert.equal(holdings.get("AAPL").totalCostKrw, 2_800_000);
});

test("매수가 한 번뿐이면 두 방법의 결과가 같다", () => {
  const singleLot = [
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    sell("AAPL", "2026-06-10", 5, 200, 1400),
  ];

  const fifo = annualSummary(singleLot, 2026, COST_METHOD.FIFO).tax;
  const average = annualSummary(singleLot, 2026, COST_METHOD.AVERAGE).tax;

  assert.equal(fifo.totalGainKrw, average.totalGainKrw);
});

test("비교 함수는 두 결과와 차액, 더 유리한 쪽을 함께 준다", () => {
  const bigger = [
    buy("AAPL", "2026-01-10", 100, 100, 1300),
    buy("AAPL", "2026-03-10", 100, 200, 1400),
    sell("AAPL", "2026-06-10", 100, 250, 1350),
  ];

  const result = compareMethods(bigger, 2026);

  assert.equal(result.fifo.totalTaxKrw, 4_015_000);
  assert.equal(result.average.totalTaxKrw, 2_365_000);
  assert.equal(result.differenceKrw, 1_650_000);
  assert.equal(result.lowerMethod, COST_METHOD.AVERAGE);
});

test("차이가 없으면 더 유리한 쪽도 없다", () => {
  const singleLot = [
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    sell("AAPL", "2026-06-10", 5, 200, 1400),
  ];

  assert.equal(compareMethods(singleLot, 2026).lowerMethod, null);
});

test("기본값은 선입선출법이다", () => {
  const viaDefault = replay(CHEAP_THEN_EXPENSIVE);
  const viaFifo = replay(CHEAP_THEN_EXPENSIVE, COST_METHOD.FIFO);

  assert.equal(viaDefault.sales[0].costKrw, viaFifo.sales[0].costKrw);
  assert.equal(viaDefault.sales[0].costKrw, 1_300_000);
});
