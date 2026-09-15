import assert from "node:assert/strict";
import test from "node:test";

import { buildExportPayload, normalizeSmeTickers } from "../static/storage.js";
import { isMixedRate, rateLabel } from "../static/taxview.js";

test("중소기업 종목 목록은 대문자로 맞추고 중복과 빈 값을 뺀다", () => {
  assert.deepEqual(normalizeSmeTickers([" abc ", "ABC", "", "xyz", 3, null]), ["ABC", "XYZ"]);
  assert.deepEqual(normalizeSmeTickers("ABC"), []);
  assert.deepEqual(normalizeSmeTickers(undefined), []);
});

test("백업 파일에 중소기업 표시가 함께 들어간다", () => {
  const payload = buildExportPayload([], ["small", "SMALL", "tiny"]);

  assert.deepEqual(payload.sme_tickers, ["SMALL", "TINY"]);
  assert.deepEqual(payload.transactions, []);
});

test("백업 파일에 이름 붙인 매도 계획이 함께 들어간다", () => {
  const book = {
    activeId: "p2",
    plans: [
      { id: "p1", name: "기본안", items: [] },
      { id: "p2", name: "연말 절세안", items: [{ id: "i", ticker: "a", quantity: 1, targetPrice: 1, saleDate: "2026-12-01", fxRate: 1300 }] },
    ],
  };

  const payload = buildExportPayload([], [], book);

  assert.deepEqual(payload.sale_plans.plans.map((p) => p.name), ["기본안", "연말 절세안"]);
  assert.equal(payload.sale_plans.activeId, "p2");
  assert.equal(payload.sale_plans.plans[1].items[0].ticker, "A");
});

test("20%만 있으면 세율별로 나눠 보여주지 않는다", () => {
  assert.equal(isMixedRate({ byRate: [] }), false);
  assert.equal(isMixedRate({ byRate: [{ ratePercent: 20 }] }), false);
  assert.equal(isMixedRate({ byRate: [{ ratePercent: 20 }, { ratePercent: 10 }] }), true);
  assert.equal(isMixedRate({ byRate: [{ ratePercent: 10 }] }), true);
  assert.equal(rateLabel(10), "10% 중소기업");
  assert.equal(rateLabel(20), "20%");
});
