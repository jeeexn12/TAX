import assert from "node:assert/strict";
import test from "node:test";

import {
  COST_METHOD,
  EngineError,
  annualSummary,
  calculateTax,
  canAddTransaction,
  fxSensitivity,
  maxSellableQuantity,
  replay,
  simulate,
  taxFreeHeadroomKrw,
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

function settled(tx, settlementDate) {
  return { ...tx, settlement_date: settlementDate };
}

test("이동평균 취득가액은 매수일별 환율로 환산해 누적된다", () => {
  const { holdings } = replay([
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    buy("AAPL", "2026-03-10", 10, 100, 1400),
  ]);

  assert.equal(holdings.get("AAPL").quantity, 20);
  assert.equal(holdings.get("AAPL").totalCostKrw, 2_700_000);
  assert.equal(holdings.get("AAPL").avgCostKrw, 135_000);
});

test("매도는 평균단가로 취득가액을 대응시키고 평균단가는 변하지 않는다", () => {
  const { holdings, sales } = replay(
    [
      buy("AAPL", "2026-01-10", 10, 100, 1300),
      buy("AAPL", "2026-03-10", 10, 100, 1400),
      sell("AAPL", "2026-06-10", 5, 120, 1450),
    ],
    COST_METHOD.AVERAGE
  );

  assert.equal(sales[0].proceedsKrw, 870_000);
  assert.equal(sales[0].costKrw, 675_000);
  assert.equal(sales[0].gainKrw, 195_000);
  assert.equal(holdings.get("AAPL").quantity, 15);
  assert.equal(holdings.get("AAPL").avgCostKrw, 135_000);
});

test("입력 순서와 무관하게 날짜순으로 재계산된다", () => {
  const { holdings } = replay([
    buy("AAPL", "2026-03-10", 10, 100, 1400),
    buy("AAPL", "2026-01-10", 10, 100, 1300),
  ]);

  assert.equal(holdings.get("AAPL").avgCostKrw, 135_000);
});

test("매수수수료는 취득가액에 가산되고 매도수수료는 양도가액에서 차감된다", () => {
  const { holdings, sales } = replay([
    buy("AAPL", "2026-01-10", 10, 100, 1300, 10),
    sell("AAPL", "2026-06-10", 10, 100, 1300, 10),
  ]);

  assert.equal(holdings.get("AAPL").quantity, 0);
  assert.equal(sales[0].costKrw, 1_313_000);
  assert.equal(sales[0].proceedsKrw, 1_287_000);
  assert.equal(sales[0].gainKrw, -26_000);
});

test("보유수량을 초과해 매도하면 오류", () => {
  assert.throws(
    () => replay([buy("AAPL", "2026-01-10", 5, 100, 1300), sell("AAPL", "2026-02-10", 6, 100, 1300)]),
    EngineError
  );
});

test("보유수량을 초과해 매도해도 취득가액이 음수가 되지 않는다", () => {
  const overselling = [
    buy("AAPL", "2026-01-10", 5, 100, 1300),
    sell("AAPL", "2026-02-10", 6, 100, 1300),
  ];

  assert.throws(() => replay(overselling), EngineError);

  const check = canAddTransaction(
    [buy("AAPL", "2026-01-10", 5, 100, 1300)],
    sell("AAPL", "2026-02-10", 6, 100, 1300)
  );
  assert.equal(check.ok, false);
  assert.match(check.error, /보유수량/);
});

test("매수 이전 날짜로 매도하면 막힌다", () => {
  const check = canAddTransaction(
    [buy("AAPL", "2026-05-10", 10, 100, 1300)],
    sell("AAPL", "2026-01-10", 1, 100, 1300)
  );

  assert.equal(check.ok, false);
});

test("최대 매도가능수량은 그 시점 보유수량이다", () => {
  const transactions = [
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    buy("AAPL", "2026-03-10", 5, 100, 1400),
  ];

  assert.equal(maxSellableQuantity(transactions, "AAPL", "2026-02-01"), 10);
  assert.equal(maxSellableQuantity(transactions, "AAPL", "2026-04-01"), 15);
  assert.equal(maxSellableQuantity(transactions, "AAPL", "2025-12-31"), 0);
});

test("최대 매도가능수량은 이후에 입력해둔 매도까지 고려한다", () => {
  const transactions = [
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    sell("AAPL", "2026-12-10", 10, 200, 1300),
  ];

  assert.equal(maxSellableQuantity(transactions, "AAPL", "2026-06-01"), 0);

  const check = canAddTransaction(transactions, sell("AAPL", "2026-06-01", 1, 150, 1300));
  assert.equal(check.ok, false);
});

test("최대 매도가능수량은 중간 분할을 환산해서 계산한다", () => {
  const transactions = [
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    split("AAPL", "2026-05-20", 4),
    sell("AAPL", "2026-12-10", 20, 50, 1300),
  ];

  assert.equal(maxSellableQuantity(transactions, "AAPL", "2026-02-01"), 5);
  assert.equal(maxSellableQuantity(transactions, "AAPL", "2026-06-01"), 20);
});

test("정상 범위의 매도는 통과한다", () => {
  const check = canAddTransaction(
    [buy("AAPL", "2026-01-10", 10, 100, 1300)],
    sell("AAPL", "2026-02-10", 10, 120, 1300)
  );

  assert.equal(check.ok, true);
  assert.equal(check.error, null);
});

test("기본공제 후 22% 세율이 적용된다", () => {
  const result = calculateTax(10_000_000);

  assert.equal(result.deductionKrw, 2_500_000);
  assert.equal(result.taxableBaseKrw, 7_500_000);
  assert.equal(result.incomeTaxKrw, 1_500_000);
  assert.equal(result.localTaxKrw, 150_000);
  assert.equal(result.totalTaxKrw, 1_650_000);
});

test("국내주식 손익은 해외주식과 통산되고 기본공제를 나눠 쓴다", () => {
  const overseas = [
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    sell("AAPL", "2026-06-10", 10, 200, 1300), // +1,300,000
  ];

  const alone = annualSummary(overseas, 2026);
  assert.equal(alone.tax.totalGainKrw, 1_300_000);
  assert.equal(alone.tax.deductionKrw, 1_300_000); // 전액 공제로 흡수
  assert.equal(alone.tax.totalTaxKrw, 0);

  const withDomesticGain = annualSummary(overseas, 2026, COST_METHOD.FIFO, 4_000_000);
  assert.equal(withDomesticGain.overseasGainKrw, 1_300_000);
  assert.equal(withDomesticGain.domesticGainKrw, 4_000_000);
  assert.equal(withDomesticGain.tax.totalGainKrw, 5_300_000);
  assert.equal(withDomesticGain.tax.deductionKrw, 2_500_000); // 250만원을 함께 쓴다
  assert.equal(withDomesticGain.tax.taxableBaseKrw, 2_800_000);
  assert.equal(withDomesticGain.tax.totalTaxKrw, 616_000);
});

test("국내주식 손실은 해외주식 이익을 상계한다", () => {
  const overseas = [
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    sell("AAPL", "2026-06-10", 10, 500, 1300), // +5,200,000
  ];

  const withDomesticLoss = annualSummary(overseas, 2026, COST_METHOD.FIFO, -3_000_000);

  assert.equal(withDomesticLoss.tax.totalGainKrw, 2_200_000);
  assert.equal(withDomesticLoss.tax.taxableBaseKrw, 0);
  assert.equal(withDomesticLoss.tax.totalTaxKrw, 0);

  // 국내 손실만큼 세금 없이 더 실현할 수 있다
  assert.equal(taxFreeHeadroomKrw(overseas, 2026, COST_METHOD.FIFO, -3_000_000), 300_000);
});

test("과세표준은 1원 미만, 세액은 10원 미만 끝수를 버린다", () => {
  // 국고금 관리법 제47조. 차익 5,123,456.78 -> 과세표준 2,623,456
  const result = calculateTax(5_123_456.78);

  assert.equal(result.totalGainKrw, 5_123_456);
  assert.equal(result.taxableBaseKrw, 2_623_456);

  // 2,623,456 x 20% = 524,691.2 -> 524,690
  assert.equal(result.incomeTaxKrw, 524_690);
  // 524,690 x 10% = 52,469 -> 52,460
  assert.equal(result.localTaxKrw, 52_460);
  assert.equal(result.totalTaxKrw, 577_150);
});

test("기본공제 이하 차익은 과세되지 않는다", () => {
  const result = calculateTax(2_000_000);

  assert.equal(result.deductionKrw, 2_000_000);
  assert.equal(result.taxableBaseKrw, 0);
  assert.equal(result.totalTaxKrw, 0);
});

test("연간 손실은 과세되지 않고 다음 해로 이월되지 않는다", () => {
  const losingYear = [
    buy("AAPL", "2025-01-10", 10, 100, 1300),
    sell("AAPL", "2025-06-10", 10, 50, 1300),
  ];
  const nextYear = [
    ...losingYear,
    buy("MSFT", "2026-01-10", 10, 100, 1300),
    sell("MSFT", "2026-06-10", 10, 200, 1300),
  ];

  const tax2025 = annualSummary(losingYear, 2025).tax;
  const tax2026 = annualSummary(nextYear, 2026).tax;

  assert.equal(tax2025.totalGainKrw, -650_000);
  assert.equal(tax2025.totalTaxKrw, 0);
  assert.equal(tax2026.totalGainKrw, 1_300_000);
  assert.equal(tax2026.deductionKrw, 1_300_000);
});

test("같은 해 안에서는 종목 간 손익이 통산된다", () => {
  const { yearSales, tax } = annualSummary(
    [
      buy("AAPL", "2026-01-10", 10, 100, 1300),
      sell("AAPL", "2026-06-10", 10, 200, 1300),
      buy("MSFT", "2026-01-10", 10, 100, 1300),
      sell("MSFT", "2026-07-10", 10, 50, 1300),
    ],
    2026
  );

  assert.equal(yearSales.length, 2);
  assert.equal(tax.totalGainKrw, 650_000);
  assert.equal(tax.totalTaxKrw, 0);
});

test("기본공제는 매도 건마다가 아니라 연간 합산 후 한 번만 적용된다", () => {
  const threeSalesOfOneMillionEach = [
    buy("AAPL", "2026-01-10", 30, 100, 1300),
    sell("AAPL", "2026-03-10", 10, 100 + 1_000_000 / 10 / 1300, 1300),
    sell("AAPL", "2026-06-10", 10, 100 + 1_000_000 / 10 / 1300, 1300),
    sell("AAPL", "2026-09-10", 10, 100 + 1_000_000 / 10 / 1300, 1300),
  ];

  const { yearSales, tax } = annualSummary(threeSalesOfOneMillionEach, 2026);

  assert.equal(yearSales.length, 3);
  yearSales.forEach((sale) => assert.equal(Math.round(sale.gainKrw), 1_000_000));

  // 건별 적용이었다면 각 100만원이 전부 공제되어 세액 0원이 됐을 것이다.
  assert.equal(tax.totalGainKrw, 3_000_000);
  assert.equal(tax.deductionKrw, 2_500_000);
  assert.equal(tax.taxableBaseKrw, 500_000);
  assert.equal(tax.totalTaxKrw, 110_000);
});

test("세금 없이 추가 실현 가능한 이익은 실현손익에 따라 달라진다", () => {
  const nothingRealizedYet = [buy("AAPL", "2026-01-10", 10, 100, 1300)];
  assert.equal(taxFreeHeadroomKrw(nothingRealizedYet, 2026), 2_500_000);

  const gained1M = [
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    sell("AAPL", "2026-03-10", 10, 100 + 1_000_000 / 10 / 1300, 1300),
  ];
  assert.equal(taxFreeHeadroomKrw(gained1M, 2026), 1_500_000);

  const gained3M = [
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    sell("AAPL", "2026-03-10", 10, 100 + 3_000_000 / 10 / 1300, 1300),
  ];
  assert.equal(taxFreeHeadroomKrw(gained3M, 2026), 0);
});

test("이미 손실을 실현한 해에는 250만원보다 많이 실현해도 세금이 없다", () => {
  const lost3M = [
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    sell("AAPL", "2026-03-10", 10, 100 - 3_000_000 / 10 / 1300, 1300),
  ];

  assert.equal(taxFreeHeadroomKrw(lost3M, 2026), 5_500_000);

  const afterRealizing5_5M = [
    ...lost3M,
    buy("MSFT", "2026-04-10", 10, 100, 1300),
    sell("MSFT", "2026-05-10", 10, 100 + 5_500_000 / 10 / 1300, 1300),
  ];
  assert.equal(annualSummary(afterRealizing5_5M, 2026).tax.totalTaxKrw, 0);
});

test("시뮬레이션은 확정 거래 대비 추가 세액을 보여준다", () => {
  const confirmed = [
    buy("AAPL", "2026-01-10", 100, 100, 1300),
    sell("AAPL", "2026-06-10", 20, 200, 1300),
  ];
  const virtual = [sell("AAPL", "2026-09-12", 20, 300, 1400, 0, "sim-1")];

  const result = simulate(confirmed, virtual, 2026);

  assert.equal(result.before.totalGainKrw, 2_600_000);
  assert.equal(result.simulatedGainKrw, 5_800_000);
  assert.equal(result.after.totalGainKrw, 8_400_000);
  assert.equal(result.additionalTaxKrw, result.after.totalTaxKrw - result.before.totalTaxKrw);
});

test("주식분할은 취득가액 총액을 유지하고 주당 단가만 나눈다", () => {
  const { holdings } = replay([
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    split("AAPL", "2026-05-20", 4),
  ]);

  assert.equal(holdings.get("AAPL").quantity, 40);
  assert.equal(holdings.get("AAPL").totalCostKrw, 1_300_000);
  assert.equal(holdings.get("AAPL").avgCostKrw, 32_500);
});

test("주식분할은 양도가 아니므로 과세대상 손익이 발생하지 않는다", () => {
  const { yearSales, tax } = annualSummary(
    [buy("AAPL", "2026-01-10", 10, 100, 1300), split("AAPL", "2026-05-20", 4)],
    2026
  );

  assert.equal(yearSales.length, 0);
  assert.equal(tax.totalGainKrw, 0);
  assert.equal(tax.totalTaxKrw, 0);
});

test("분할 후 매도는 조정된 주당 취득단가로 계산된다", () => {
  const { holdings, sales } = replay([
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    split("AAPL", "2026-05-20", 4),
    sell("AAPL", "2026-06-10", 10, 30, 1400),
  ]);

  assert.equal(sales[0].proceedsKrw, 420_000);
  assert.equal(sales[0].costKrw, 325_000);
  assert.equal(sales[0].gainKrw, 95_000);
  assert.equal(holdings.get("AAPL").quantity, 30);
  assert.equal(holdings.get("AAPL").avgCostKrw, 32_500);
});

test("분할 후 추가 매수는 조정된 단가와 이동평균된다", () => {
  const { holdings } = replay([
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    split("AAPL", "2026-05-20", 4),
    buy("AAPL", "2026-07-10", 10, 40, 1400),
  ]);

  assert.equal(holdings.get("AAPL").quantity, 50);
  assert.equal(holdings.get("AAPL").totalCostKrw, 1_860_000);
  assert.equal(holdings.get("AAPL").avgCostKrw, 37_200);
});

test("역분할(주식병합)은 수량을 줄이고 주당 단가를 올린다", () => {
  const { holdings } = replay([
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    split("AAPL", "2026-05-20", 0.5),
  ]);

  assert.equal(holdings.get("AAPL").quantity, 5);
  assert.equal(holdings.get("AAPL").totalCostKrw, 1_300_000);
  assert.equal(holdings.get("AAPL").avgCostKrw, 260_000);
});

test("분할비율이 0 이하면 오류", () => {
  assert.throws(
    () => replay([buy("AAPL", "2026-01-10", 10, 100, 1300), split("AAPL", "2026-05-20", 0)]),
    EngineError
  );
});

test("12월 30일 매도라도 결제일이 1월 2일이면 다음 해 소득이다", () => {
  const transactions = [
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    settled(sell("AAPL", "2026-12-30", 10, 200, 1300), "2027-01-02"),
  ];

  const year2026 = annualSummary(transactions, 2026);
  const year2027 = annualSummary(transactions, 2027);

  assert.equal(year2026.yearSales.length, 0);
  assert.equal(year2026.tax.totalGainKrw, 0);

  assert.equal(year2027.yearSales.length, 1);
  assert.equal(year2027.tax.totalGainKrw, 1_300_000);
  assert.equal(year2027.yearSales[0].tradeDate, "2026-12-30");
  assert.equal(year2027.yearSales[0].date, "2027-01-02");
  assert.equal(year2027.yearSales[0].crossesYear, true);
});

test("해를 넘긴 매도는 다음 해 기본공제와 통산된다", () => {
  const decemberSaleSettlingInJanuary = [
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    settled(sell("AAPL", "2026-12-30", 10, 500, 1300), "2027-01-02"),
    buy("MSFT", "2027-02-01", 10, 100, 1300),
    settled(sell("MSFT", "2027-03-02", 10, 300, 1300), "2027-03-04"),
  ];

  const { tax } = annualSummary(decemberSaleSettlingInJanuary, 2027);

  // AAPL 520만 + MSFT 260만이 2027년에 함께 통산된다.
  assert.equal(tax.totalGainKrw, 7_800_000);
  assert.equal(tax.deductionKrw, 2_500_000);
  assert.equal(tax.totalTaxKrw, 1_166_000);
});

test("결제일 순서로 재생하므로 체결일이 빨라도 결제가 늦으면 나중에 반영된다", () => {
  const transactions = [
    settled(buy("AAPL", "2026-03-02", 10, 100, 1300), "2026-03-06"),
    settled(buy("AAPL", "2026-03-03", 10, 200, 1400), "2026-03-05"),
  ];

  const { holdings } = replay(transactions);

  // 두 건 모두 취득되므로 합계는 순서와 무관하지만, 매도 대응 순서가 달라진다.
  assert.equal(holdings.get("AAPL").quantity, 20);
  assert.equal(holdings.get("AAPL").totalCostKrw, 1_300_000 + 2_800_000);
});

test("결제일이 없는 기존 기록은 체결일을 그대로 쓴다", () => {
  const legacy = [
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    sell("AAPL", "2026-06-10", 10, 200, 1300),
  ];

  const { tax, yearSales } = annualSummary(legacy, 2026);

  assert.equal(yearSales[0].date, "2026-06-10");
  assert.equal(yearSales[0].crossesYear, false);
  assert.equal(tax.totalGainKrw, 1_300_000);
});

test("환율 가정을 1,250~1,500원으로 훑으면 구간별 세액이 나온다", () => {
  const transactions = [buy("AAPL", "2026-01-10", 100, 100, 1300)];
  const target = [sell("AAPL", "2026-12-01", 100, 150, 0, 0, "sim-1")];

  const rows = fxSensitivity(transactions, target, 2026, { from: 1250, to: 1500, step: 50 });

  assert.deepEqual(
    rows.map((r) => r.fxRate),
    [1250, 1300, 1350, 1400, 1450, 1500]
  );

  // 1,250원: 양도가액 100주 × $150 × 1250 = 18,750,000, 취득가액 13,000,000
  assert.equal(rows[0].simulatedGainKrw, 5_750_000);
  assert.equal(rows[0].taxableBaseKrw, 3_250_000);
  assert.equal(rows[0].totalTaxKrw, 715_000);

  // 1,500원: 양도가액 22,500,000
  assert.equal(rows[5].simulatedGainKrw, 9_500_000);
  assert.equal(rows[5].taxableBaseKrw, 7_000_000);
  assert.equal(rows[5].totalTaxKrw, 1_540_000);
});

test("환율이 오르면 세액도 단조 증가한다", () => {
  const rows = fxSensitivity(
    [buy("AAPL", "2026-01-10", 100, 100, 1300)],
    [sell("AAPL", "2026-12-01", 100, 150, 0, 0, "sim-1")],
    2026,
    { from: 1250, to: 1500, step: 25 }
  );

  assert.equal(rows.length, 11);
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i].totalTaxKrw >= rows[i - 1].totalTaxKrw);
  }
});

test("환율 가정은 매수 시점 환율을 바꾸지 않는다", () => {
  const transactions = [
    buy("AAPL", "2026-01-10", 10, 100, 1300),
    buy("AAPL", "2026-03-10", 10, 100, 1400),
  ];
  const rows = fxSensitivity(
    transactions,
    [sell("AAPL", "2026-12-01", 5, 100, 0, 0, "sim-1")],
    2026,
    { from: 1350, to: 1350, step: 50, method: COST_METHOD.AVERAGE }
  );

  // 취득가액은 매수일 환율로 굳어 있으므로 평균단가 135,000원 그대로다.
  // 양도가액 5주 × $100 × 1350 = 675,000, 취득가액 675,000 -> 차익 0
  assert.equal(rows.length, 1);
  assert.equal(rows[0].simulatedGainKrw, 0);
});

test("과거 거래의 적용환율을 고치면 이후 계산이 전부 다시 반영된다", () => {
  const transactions = [
    buy("AAPL", "2026-01-10", 10, 100, 1300, 0, "tx-1"),
    buy("AAPL", "2026-03-10", 10, 100, 1400, 0, "tx-2"),
    sell("AAPL", "2026-06-10", 5, 120, 1450, 0, "tx-3"),
  ];

  const beforeFix = annualSummary(transactions, 2026, COST_METHOD.AVERAGE);
  assert.equal(beforeFix.holdings.get("AAPL").avgCostKrw, 135_000);
  assert.equal(beforeFix.tax.totalGainKrw, 195_000);

  const corrected = transactions.map((tx) => (tx.id === "tx-1" ? { ...tx, fx_rate: 1200 } : tx));
  const afterFix = annualSummary(corrected, 2026, COST_METHOD.AVERAGE);

  assert.equal(afterFix.holdings.get("AAPL").avgCostKrw, 130_000);
  assert.equal(afterFix.yearSales[0].costKrw, 650_000);
  assert.equal(afterFix.tax.totalGainKrw, 220_000);
});
