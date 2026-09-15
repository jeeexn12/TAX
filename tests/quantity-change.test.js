import assert from "node:assert/strict";
import test from "node:test";

import { annualSummary, buildQuantityChange, replay, sellableInfo } from "../static/engine.js";
import { validateTransactions } from "../static/storage.js";

// 증권사 취득내역의 "변동 후 수량"과 금액으로 입력하는 수량 변동(분할·병합·무상주).

const buy = (id, date, quantity, priceUsd) => ({
  id,
  type: "buy",
  ticker: "A",
  date,
  settlement_date: date,
  quantity,
  price_usd: priceUsd,
  fee_usd: 0,
  fx_rate: 1000,
});

const sell = (id, date, quantity, priceUsd) => ({ ...buy(id, date, quantity, priceUsd), type: "sell" });

const change = (id, date, heldBefore, quantityAfter, costKrw = 0) => ({
  id,
  type: "split",
  ticker: "A",
  date,
  ...buildQuantityChange({ heldBefore, quantityAfter, costKrw }).fields,
});

test("금액 없이 100주가 400주가 되면 4배 분할로 기록하고 취득가액 총액은 그대로다", () => {
  const { fields } = buildQuantityChange({ heldBefore: 100, quantityAfter: 400 });
  assert.equal(fields.ratio, 4);
  assert.equal(fields.added_quantity, 0);

  const transactions = [buy("b", "2026-01-05", 100, 100), change("s", "2026-03-02", 100, 400)];
  const holding = replay(transactions).holdings.get("A");

  assert.equal(holding.quantity, 400);
  assert.equal(holding.totalCostKrw, 10_000_000);
  assert.equal(holding.avgCostKrw, 25_000);
});

test("금액이 있으면 늘어난 수량을 그 금액짜리 새 로트로 넣는다", () => {
  const transactions = [
    buy("b", "2026-01-05", 100, 10), // 100주, 1,000,000원
    change("bonus", "2026-03-02", 100, 110, 50_000), // +10주, 50,000원
    sell("s", "2026-06-01", 105, 20),
  ];

  const holdingBeforeSale = replay(transactions.slice(0, 2)).holdings.get("A");
  assert.equal(holdingBeforeSale.quantity, 110);
  assert.equal(holdingBeforeSale.totalCostKrw, 1_050_000);
  assert.equal(holdingBeforeSale.lots[1].date, "2026-03-02");

  // 선입선출: 기존 100주 전부(1,000,000) + 새 로트 5주(25,000)
  const [sale] = annualSummary(transactions, 2026).yearSales;
  assert.equal(sale.costKrw, 1_025_000);
});

test("비율로 저장하므로 변동일 이전 매수를 나중에 추가해도 배수가 유지된다", () => {
  const recorded = [buy("b", "2026-01-05", 100, 100), change("s", "2026-03-02", 100, 400)];
  const withEarlierBuy = [...recorded, buy("late", "2026-02-02", 10, 100)];

  assert.equal(replay(withEarlierBuy).holdings.get("A").quantity, 440);
});

test("병합으로 수량이 줄어도 비율로 계산하고, 이후 매도 가능 수량에 반영된다", () => {
  const transactions = [buy("b", "2026-01-05", 100, 100), change("m", "2026-03-02", 100, 25)];

  assert.equal(replay(transactions).holdings.get("A").quantity, 25);
  // 병합 전 날짜에 팔 수 있는 수량은 병합 후 25주를 넘지 않게 환산해 100주다
  assert.equal(sellableInfo(transactions, "A", "2026-02-01").max, 100);
});

test("입력이 명세서와 맞지 않을 만한 경우는 막고 이유를 알려준다", () => {
  assert.match(buildQuantityChange({ heldBefore: 0, quantityAfter: 10 }).error, /보유수량이 없습니다/);
  assert.match(buildQuantityChange({ heldBefore: 100, quantityAfter: 100 }).error, /같습니다/);
  assert.match(
    buildQuantityChange({ heldBefore: 100, quantityAfter: 90, costKrw: 1000 }).error,
    /늘어난 경우만/
  );
  assert.match(buildQuantityChange({ heldBefore: 100, quantityAfter: "" }).error, /변동 후 보유수량/);
});

test("예전 비율 방식 기록과 새 방식 기록을 모두 불러올 수 있다", () => {
  const [legacy, bonus] = validateTransactions([
    { type: "split", ticker: "a", date: "2026-03-02", ratio: 4 },
    {
      type: "split",
      ticker: "a",
      date: "2026-04-01",
      added_quantity: 10,
      cost_krw: 50_000,
      quantity_before: 400,
      quantity_after: 410,
    },
  ]);

  assert.equal(legacy.ratio, 4);
  assert.equal(legacy.added_quantity, 0);
  assert.equal(legacy.quantity_after, null);
  assert.equal(bonus.ratio, null);
  assert.equal(bonus.added_quantity, 10);
  assert.equal(bonus.cost_krw, 50_000);
  assert.equal(bonus.quantity_after, 410);
});
