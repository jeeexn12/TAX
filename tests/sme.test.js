import assert from "node:assert/strict";
import test from "node:test";

import {
  COST_METHOD,
  annualSummary,
  calculateTaxByRate,
  compareMethods,
  simulate,
  taxFreeHeadroomKrw,
} from "../static/engine.js";

// 중소기업 주식 10% 세율이 섞인 해의 계산.
// 소득세법 제102조 제2항·시행령 제167조의2(손실 통산), 제103조 제2항(기본공제 순서).

/** 환율 1,000원, 매수 단가 0으로 두어 원화 차익을 바로 읽을 수 있게 한다. */
function roundTrip(ticker, sellDate, gainKrw, id = `${ticker}-${sellDate}`) {
  const buyPrice = gainKrw < 0 ? -gainKrw / 1000 : 0;
  const sellPrice = gainKrw < 0 ? 0 : gainKrw / 1000;
  return [
    {
      id: `${id}-buy`,
      type: "buy",
      ticker,
      date: "2026-01-02",
      quantity: 1,
      price_usd: buyPrice,
      fx_rate: 1000,
    },
    {
      id,
      type: "sell",
      ticker,
      date: sellDate,
      quantity: 1,
      price_usd: sellPrice,
      fx_rate: 1000,
    },
  ];
}

const rate = (tax, percent) => tax.byRate.find((b) => b.ratePercent === percent);

test("중소기업 표시가 없으면 전부 20%로 기존 계산과 같다", () => {
  const transactions = [
    ...roundTrip("BIG", "2026-03-10", 10_000_000),
    ...roundTrip("SMALL", "2026-04-10", 5_000_000),
  ];

  const { tax } = annualSummary(transactions, 2026);

  assert.equal(tax.taxableBaseKrw, 12_500_000);
  assert.equal(tax.incomeTaxKrw, 2_500_000);
  assert.equal(tax.totalTaxKrw, 2_750_000);
  assert.equal(tax.byRate.length, 1);
});

test("기본공제는 먼저 판 자산에서 빼므로 매도 순서가 세액을 바꾼다", () => {
  const bigFirst = [
    ...roundTrip("BIG", "2026-03-10", 10_000_000),
    ...roundTrip("SMALL", "2026-04-10", 5_000_000),
  ];
  const smallFirst = [
    ...roundTrip("BIG", "2026-04-10", 10_000_000),
    ...roundTrip("SMALL", "2026-03-10", 5_000_000),
  ];

  const a = annualSummary(bigFirst, 2026, COST_METHOD.FIFO, 0, ["SMALL"]).tax;
  // 20%: 1,000만 - 250만 = 750만 -> 150만 / 10%: 500만 -> 50만
  assert.equal(rate(a, 20).deductionKrw, 2_500_000);
  assert.equal(rate(a, 20).taxableBaseKrw, 7_500_000);
  assert.equal(rate(a, 10).taxableBaseKrw, 5_000_000);
  assert.equal(a.incomeTaxKrw, 2_000_000);
  assert.equal(a.localTaxKrw, 200_000);
  assert.equal(a.totalTaxKrw, 2_200_000);

  const b = annualSummary(smallFirst, 2026, COST_METHOD.FIFO, 0, ["SMALL"]).tax;
  // 10%: 500만 - 250만 = 250만 -> 25만 / 20%: 1,000만 -> 200만
  assert.equal(rate(b, 10).deductionKrw, 2_500_000);
  assert.equal(b.incomeTaxKrw, 2_250_000);
  assert.equal(b.totalTaxKrw, 2_475_000);
});

test("기본공제가 첫 자산 이익보다 크면 다음에 판 자산에서 이어서 뺀다", () => {
  const transactions = [
    ...roundTrip("BIG", "2026-01-20", 1_000_000),
    ...roundTrip("SMALL", "2026-02-20", 5_000_000),
    ...roundTrip("OTHER", "2026-03-20", 5_000_000),
  ];

  const tax = annualSummary(transactions, 2026, COST_METHOD.FIFO, 0, ["SMALL"]).tax;

  // BIG(20%)에서 100만, SMALL(10%)에서 150만
  assert.equal(rate(tax, 20).deductionKrw, 1_000_000);
  assert.equal(rate(tax, 10).deductionKrw, 1_500_000);
  assert.equal(rate(tax, 20).taxableBaseKrw, 5_000_000);
  assert.equal(rate(tax, 10).taxableBaseKrw, 3_500_000);
  assert.equal(tax.incomeTaxKrw, 1_350_000);
  assert.equal(tax.totalTaxKrw, 1_485_000);
});

test("손실은 같은 세율 이익에서 먼저 빼고 남은 것만 다른 세율에서 뺀다", () => {
  const transactions = [
    ...roundTrip("SMALL", "2026-02-10", 4_000_000),
    ...roundTrip("BIG", "2026-03-10", 4_000_000),
    ...roundTrip("LOSER", "2026-04-10", -1_000_000),
  ];

  const tax = annualSummary(transactions, 2026, COST_METHOD.FIFO, 0, ["SMALL"]).tax;

  // LOSER(20%) 손실은 BIG(20%)에서만 빠진다. SMALL은 400만 그대로.
  assert.equal(rate(tax, 20).incomeKrw, 3_000_000);
  assert.equal(rate(tax, 10).incomeKrw, 4_000_000);
  // 먼저 판 SMALL에서 기본공제
  assert.equal(rate(tax, 10).taxableBaseKrw, 1_500_000);
  assert.equal(rate(tax, 20).taxableBaseKrw, 3_000_000);
  assert.equal(tax.incomeTaxKrw, 750_000);
  assert.equal(tax.totalTaxKrw, 825_000);
});

test("같은 세율 이익을 넘는 손실은 다른 세율 이익에서 뺀다", () => {
  const transactions = [
    ...roundTrip("LOSER", "2026-02-10", -3_000_000),
    ...roundTrip("BIG", "2026-03-10", 1_000_000),
    ...roundTrip("SMALL", "2026-04-10", 8_000_000),
  ];

  const tax = annualSummary(transactions, 2026, COST_METHOD.FIFO, 0, ["SMALL"]).tax;

  // 20%: +100만 -300만 -> 남은 손실 200만을 SMALL에서 뺀다
  assert.equal(rate(tax, 20).incomeKrw, 0);
  assert.equal(rate(tax, 10).incomeKrw, 6_000_000);
  assert.equal(rate(tax, 10).taxableBaseKrw, 3_500_000);
  assert.equal(tax.totalGainKrw, 6_000_000);
  assert.equal(tax.totalTaxKrw, 385_000);
});

test("국내주식 손익은 20% 물량으로 통산된다", () => {
  const transactions = roundTrip("SMALL", "2026-04-10", 5_000_000);

  const tax = annualSummary(transactions, 2026, COST_METHOD.FIFO, -2_000_000, ["SMALL"]).tax;

  // 국내 손실 200만이 SMALL 이익에서 빠지고 남은 300만에서 기본공제
  assert.equal(rate(tax, 10).taxableBaseKrw, 500_000);
  assert.equal(tax.totalTaxKrw, 55_000);
  assert.equal(taxFreeHeadroomKrw(transactions, 2026, COST_METHOD.FIFO, -2_000_000, ["SMALL"]), 0);
});

test("세율이 섞여도 순손익이 기본공제 이하면 세금이 없다", () => {
  const transactions = [
    ...roundTrip("LOSER", "2026-02-10", -3_000_000),
    ...roundTrip("SMALL", "2026-03-10", 5_000_000),
  ];

  const tax = annualSummary(transactions, 2026, COST_METHOD.FIFO, 0, ["SMALL"]).tax;

  assert.equal(tax.totalGainKrw, 2_000_000);
  assert.equal(tax.totalTaxKrw, 0);
  assert.equal(taxFreeHeadroomKrw(transactions, 2026, COST_METHOD.FIFO, 0, ["SMALL"]), 500_000);
});

test("중소기업 종목을 파는 시뮬레이션은 10%로 늘어나는 세금을 계산한다", () => {
  const confirmed = roundTrip("BIG", "2026-03-10", 10_000_000);
  const virtual = roundTrip("SMALL", "2026-06-10", 2_000_000, "virtual");

  const asSme = simulate([...confirmed, virtual[0]], [virtual[1]], 2026, COST_METHOD.FIFO, 0, [
    "SMALL",
  ]);
  const asStandard = simulate([...confirmed, virtual[0]], [virtual[1]], 2026);

  assert.equal(asSme.additionalTaxKrw, 220_000); // 200만 x 11%
  assert.equal(asStandard.additionalTaxKrw, 440_000); // 200만 x 22%
});

test("방법 비교도 중소기업 세율을 반영한다", () => {
  const transactions = roundTrip("SMALL", "2026-04-10", 12_500_000);

  const result = compareMethods(transactions, 2026, 0, ["SMALL"]);

  assert.equal(result.fifo.totalTaxKrw, 1_100_000);
  assert.equal(result.average.totalTaxKrw, 1_100_000);
});

test("세율별 과세표준은 1원, 세액은 10원 미만을 버린다", () => {
  const tax = calculateTaxByRate([
    { ratePercent: 10, gainKrw: 3_123_456.78, date: "2026-02-01", tradeDate: "2026-01-30" },
    { ratePercent: 20, gainKrw: 1_000_009.5, date: "2026-03-01", tradeDate: "2026-02-27" },
  ]);

  // 10%: 3,123,456 - 250만 = 623,456 -> 62,345.6 -> 62,340
  // 20%: 1,000,009 -> 200,001.8 -> 200,000
  assert.equal(tax.byRate.find((b) => b.ratePercent === 10).taxableBaseKrw, 623_456);
  assert.equal(tax.byRate.find((b) => b.ratePercent === 20).taxableBaseKrw, 1_000_009);
  assert.equal(tax.incomeTaxKrw, 262_340);
  assert.equal(tax.localTaxKrw, 26_230);
  assert.equal(tax.totalTaxKrw, 288_570);
});
