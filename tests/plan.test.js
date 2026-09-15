import assert from "node:assert/strict";
import test from "node:test";

import {
  activePlan,
  addPlan,
  duplicatePlan,
  evaluatePlan,
  loadPlanBook,
  normalizePlan,
  normalizePlanBook,
  removePlan,
  renamePlan,
  savePlanBook,
  setActiveItems,
} from "../static/plan.js";

test("계획이 없으면 빈 '매도계획 1'을 만든다", () => {
  const book = normalizePlanBook(null);

  assert.equal(book.plans.length, 1);
  assert.equal(book.plans[0].name, "매도계획 1");
  assert.equal(book.activeId, book.plans[0].id);
});

test("새 계획은 다음 번호 이름으로 만들고 그 계획을 보여준다", () => {
  const book = addPlan(normalizePlanBook(null));

  assert.deepEqual(book.plans.map((p) => p.name), ["매도계획 1", "매도계획 2"]);
  assert.equal(activePlan(book).name, "매도계획 2");
});

test("복사본은 줄을 그대로 옮기되 고쳐도 원본이 바뀌지 않는다", () => {
  const original = setActiveItems(normalizePlanBook(null), [
    { id: "x", ticker: "A", quantity: 1, targetPrice: 1, saleDate: "2026-10-01", fxRate: 1300, included: true },
  ]);
  const copied = duplicatePlan(original, original.activeId);
  const edited = setActiveItems(copied, [{ ...activePlan(copied).items[0], quantity: 99 }]);

  assert.equal(activePlan(copied).name, "매도계획 1 복사본");
  assert.notEqual(activePlan(copied).items[0].id, "x");
  assert.equal(edited.plans[0].items[0].quantity, 1);
  assert.equal(edited.plans[1].items[0].quantity, 99);
});

test("이름은 앞뒤 공백을 빼고 30자까지, 빈 이름으로는 바꾸지 않는다", () => {
  const book = normalizePlanBook(null);
  const id = book.activeId;

  assert.equal(activePlan(renamePlan(book, id, "  연말 절세안  ")).name, "연말 절세안");
  assert.equal(activePlan(renamePlan(book, id, "   ")).name, "매도계획 1");
  assert.equal(activePlan(renamePlan(book, id, "가".repeat(40))).name.length, 30);
});

test("보고 있던 계획을 지우면 첫 계획으로, 마지막 하나를 지우면 빈 계획을 둔다", () => {
  const two = addPlan(normalizePlanBook(null));
  const afterRemove = removePlan(two, two.activeId);

  assert.deepEqual(afterRemove.plans.map((p) => p.name), ["매도계획 1"]);
  assert.equal(afterRemove.activeId, afterRemove.plans[0].id);

  const empty = removePlan(afterRemove, afterRemove.activeId);
  assert.equal(empty.plans.length, 1);
  assert.equal(empty.plans[0].items.length, 0);
});

test("하나만 저장하던 예전 계획은 '매도계획 1'로 옮긴다", () => {
  const store = new Map([
    ["us-tax:sale-plan", JSON.stringify([{ id: "old", ticker: "A", quantity: 2, targetPrice: 5, saleDate: "2026-10-01", fxRate: 1300 }])],
  ]);
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  try {
    const book = loadPlanBook();
    assert.equal(book.plans[0].name, "매도계획 1");
    assert.equal(book.plans[0].items[0].id, "old");

    savePlanBook(book);
    assert.equal(store.has("us-tax:sale-plan"), false);
    assert.equal(JSON.parse(store.get("us-tax:sale-plans")).plans[0].items.length, 1);
  } finally {
    delete globalThis.localStorage;
  }
});

// 환율 1,000원 고정. A·B 모두 주당 $100에 10주씩 보유(취득가액 각 100만원).
const HOLDINGS = [
  { id: "a", type: "buy", ticker: "A", date: "2026-01-05", settlement_date: "2026-01-07", quantity: 10, price_usd: 100, fx_rate: 1000 },
  { id: "b", type: "buy", ticker: "B", date: "2026-01-05", settlement_date: "2026-01-07", quantity: 10, price_usd: 100, fx_rate: 1000 },
];

function line(id, ticker, quantity, targetPrice, saleDate, included = true) {
  return { id, ticker, quantity, targetPrice, saleDate, fxRate: 1000, included };
}

// A 10주 $600 -> 대금 600만, 이익 500만 / B 10주 $400 -> 대금 400만, 이익 300만
const SELL_A = line("1", "A", 10, 600, "2026-06-01");
const SELL_B = line("2", "B", 10, 400, "2026-07-01");

const OPTIONS = { currentYear: 2026, settlementDays: 0 };
const itemOf = (result, id) => result.items.find((i) => i.id === id);

test("켠 줄을 모두 합쳐 세금과 손에 남는 돈을 계산한다", () => {
  const result = evaluatePlan(HOLDINGS, [SELL_A, SELL_B], OPTIONS);

  // (500만 + 300만 - 250만) x 22% = 1,210,000
  assert.equal(result.totals.additionalTaxKrw, 1_210_000);
  assert.equal(result.totals.proceedsKrw, 10_000_000);
  assert.equal(result.totals.netCashKrw, 8_790_000);

  // 다른 줄은 그대로 두고 이 줄만 뺐을 때와의 차이
  assert.equal(itemOf(result, "1").marginalTaxKrw, 1_100_000); // B만 팔면 110,000
  assert.equal(itemOf(result, "2").marginalTaxKrw, 660_000); // A만 팔면 550,000
  assert.equal(itemOf(result, "1").gainKrw, 5_000_000);
});

test("끈 줄은 합계에서 빠지고, 켰을 때 늘어날 세금을 보여준다", () => {
  const result = evaluatePlan(HOLDINGS, [SELL_A, { ...SELL_B, included: false }], OPTIONS);

  assert.equal(result.totals.additionalTaxKrw, 550_000);
  assert.equal(result.totals.proceedsKrw, 6_000_000);
  assert.equal(result.totals.netCashKrw, 5_450_000);

  const b = itemOf(result, "2");
  assert.equal(b.included, false);
  assert.equal(b.marginalTaxKrw, 660_000);
  assert.equal(b.proceedsKrw, 4_000_000);
});

test("계획 줄을 합쳐 보유수량을 넘으면 나중 줄을 오류로 빼고 계산한다", () => {
  const result = evaluatePlan(
    HOLDINGS,
    [line("1", "A", 8, 600, "2026-06-01"), line("2", "A", 5, 600, "2026-08-01")],
    OPTIONS
  );

  assert.match(itemOf(result, "2").error, /보유수량/);
  assert.equal(itemOf(result, "1").error, null);
  // A 8주만: 이익 400만 -> (400만 - 250만) x 22%
  assert.equal(result.totals.additionalTaxKrw, 330_000);
  assert.equal(result.totals.proceedsKrw, 4_800_000);
});

test("해를 나눠 팔면 해마다 기본공제를 따로 받는다", () => {
  const nextYearB = { ...SELL_B, saleDate: "2027-01-15" };
  const result = evaluatePlan(HOLDINGS, [SELL_A, nextYearB], OPTIONS);

  // 2026: (500만 - 250만) x 22% / 2027: (300만 - 250만) x 22%
  assert.equal(result.totals.additionalTaxKrw, 660_000);
  assert.deepEqual(
    result.years.map((y) => [y.year, y.additionalTaxKrw, y.paymentMonth]),
    [
      [2026, 550_000, "2027년 5월"],
      [2027, 110_000, "2028년 5월"],
    ]
  );
});

test("끈 줄만 있는 해는 연도별 결과에 나오지 않는다", () => {
  const nextYearB = { ...SELL_B, saleDate: "2027-01-15", included: false };
  const result = evaluatePlan(HOLDINGS, [SELL_A, nextYearB], OPTIONS);

  assert.deepEqual(result.years.map((y) => y.year), [2026]);
  // 켰을 때 늘어날 세금은 여전히 계산한다
  assert.equal(itemOf(result, "2").marginalTaxKrw, 110_000);
});

test("연말 매도는 결제일이 다음 해면 다음 해 세금으로 계산된다", () => {
  const december = { ...SELL_A, saleDate: "2026-12-30" };
  const result = evaluatePlan(HOLDINGS, [december], { currentYear: 2026, settlementDays: 2 });

  assert.equal(itemOf(result, "1").settlementDate, "2027-01-01");
  assert.equal(itemOf(result, "1").year, 2027);
  assert.deepEqual(result.years.map((y) => y.year), [2027]);
});

test("국내주식 손익은 올해 세금에만 합산된다", () => {
  const nextYearB = { ...SELL_B, saleDate: "2027-01-15" };
  const result = evaluatePlan(HOLDINGS, [SELL_A, nextYearB], {
    ...OPTIONS,
    domesticGainKrw: 1_000_000,
  });

  const [y2026, y2027] = result.years;
  // 2026: 국내 100만은 이미 기본공제 안이라 계획 전 세금 0, 계획 후 (600만 - 250만) x 22%
  assert.equal(y2026.before.totalTaxKrw, 0);
  assert.equal(y2026.after.totalTaxKrw, 770_000);
  assert.equal(y2027.after.totalTaxKrw, 110_000);
});

test("중소기업 종목을 먼저 팔면 기본공제를 10% 물량에서 쓴다", () => {
  const result = evaluatePlan(HOLDINGS, [SELL_A, SELL_B], { ...OPTIONS, smeTickers: ["A"] });

  // A(10%): (500만 - 250만) x 11% = 275,000 / B(20%): 300만 x 22% = 660,000
  assert.equal(result.totals.additionalTaxKrw, 935_000);
});

test("입력이 비어 있는 줄은 계산에서 빠지고 이유를 알려준다", () => {
  const result = evaluatePlan(HOLDINGS, [SELL_A, line("3", "B", 0, 400, "2026-07-01")], OPTIONS);

  assert.equal(itemOf(result, "3").error, "수량을 입력해주세요.");
  assert.equal(result.totals.additionalTaxKrw, 550_000);
});

test("저장된 계획을 읽을 때 형식을 맞춘다", () => {
  const plan = normalizePlan([
    { id: "x", ticker: " aapl ", quantity: "3", targetPrice: "250.5", saleDate: "2026-10-01", fxRate: "1380" },
    { ticker: "msft", included: false },
    null,
    "garbage",
  ]);

  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], {
    id: "x",
    ticker: "AAPL",
    quantity: 3,
    targetPrice: 250.5,
    saleDate: "2026-10-01",
    fxRate: 1380,
    included: true,
  });
  assert.equal(plan[1].included, false);
  assert.ok(plan[1].id);
});
