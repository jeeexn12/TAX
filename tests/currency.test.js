import assert from "node:assert/strict";
import test from "node:test";

import {
  displayRate,
  formatMoney,
  normalizeCurrency,
  rateUnitLabel,
  sliderRange,
  storedRate,
  tickerCurrency,
  transactionCurrency,
} from "../static/currency.js";
import { annualSummary } from "../static/engine.js";

test("엔화는 100엔 단위로 보여주고 1엔당 값으로 저장한다", () => {
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual}`);
  near(storedRate(866.49, "JPY"), 8.6649);
  near(displayRate(8.6649, "JPY"), 866.49);
  assert.equal(storedRate(1345.3, "USD"), 1345.3);
  assert.equal(rateUnitLabel("JPY"), "JPY(100)/KRW");
  assert.equal(rateUnitLabel("HKD"), "HKD/KRW");
});

test("엔화 거래를 1엔당 환율로 저장해야 취득가액이 100배로 부풀지 않는다", () => {
  // 7203.T 100주 × 2,500엔, 100엔당 866.49원 -> 약 2,166,225원
  const transactions = [
    {
      id: "b",
      type: "buy",
      ticker: "7203.T",
      date: "2026-03-02",
      settlement_date: "2026-03-04",
      quantity: 100,
      price_usd: 2500,
      fee_usd: 0,
      fx_rate: storedRate(866.49, "JPY"),
      currency: "JPY",
    },
    {
      id: "s",
      type: "sell",
      ticker: "7203.T",
      date: "2026-06-01",
      settlement_date: "2026-06-03",
      quantity: 100,
      price_usd: 3000,
      fee_usd: 0,
      fx_rate: storedRate(900, "JPY"),
      currency: "JPY",
    },
  ];

  const [sale] = annualSummary(transactions, 2026).yearSales;
  assert.equal(Math.round(sale.costKrw), 2_166_225);
  assert.equal(Math.round(sale.proceedsKrw), 2_700_000);
});

test("모르는 통화와 통화가 없는 예전 거래는 달러로 본다", () => {
  assert.equal(normalizeCurrency("XYZ"), "USD");
  assert.equal(normalizeCurrency(undefined), "USD");
  assert.equal(transactionCurrency({ type: "buy" }), "USD");
  assert.equal(transactionCurrency({ type: "buy", currency: "HKD" }), "HKD");
});

test("종목의 통화는 이미 입력된 매수·매도에서 가져오고 주식분할은 보지 않는다", () => {
  const transactions = [
    { type: "split", ticker: "0700.HK", ratio: 2 },
    { type: "buy", ticker: "0700.HK", currency: "HKD" },
    { type: "buy", ticker: "AAPL" },
  ];

  assert.equal(tickerCurrency(transactions, "0700.HK"), "HKD");
  assert.equal(tickerCurrency(transactions, "AAPL"), "USD");
  assert.equal(tickerCurrency(transactions, "NEW"), null);
});

test("달러 슬라이더는 정한 범위, 다른 통화는 오늘 환율 ±10%", () => {
  assert.deepEqual(sliderRange("USD", 1345), { min: 1250, max: 1500, step: 10 });
  assert.deepEqual(sliderRange("JPY", 866.49), { min: 780, max: 950, step: 10 });
  assert.deepEqual(sliderRange("HKD", 172.4), { min: 155, max: 190, step: 1 });
  assert.equal(sliderRange("EUR", null), null);
});

test("금액은 통화 기호와 자릿수에 맞춰 표시한다", () => {
  assert.equal(formatMoney(180.5, "USD"), "$180.50");
  assert.equal(formatMoney(2500, "JPY"), "¥2,500");
  assert.equal(formatMoney(412.8, "HKD"), "HK$412.80");
});
