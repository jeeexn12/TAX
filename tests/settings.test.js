import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SETTINGS, settlementDate } from "../static/settings.js";

test("결제일은 체결일에 영업일을 더해 구한다", () => {
  // 2026-03-02는 월요일
  assert.equal(settlementDate("2026-03-02", 1), "2026-03-03");
  assert.equal(settlementDate("2026-03-02", 2), "2026-03-04");
  assert.equal(settlementDate("2026-03-02", 3), "2026-03-05");
});

test("주말은 영업일에서 빠진다", () => {
  // 목요일 + 2영업일이면 금요일을 지나 다음 월요일
  assert.equal(settlementDate("2026-03-05", 2), "2026-03-09");
  // 금요일 + 1영업일은 다음 월요일
  assert.equal(settlementDate("2026-03-06", 1), "2026-03-09");
});

test("연말 체결은 결제일이 다음 해로 넘어간다", () => {
  // 2026-12-30은 수요일
  assert.equal(settlementDate("2026-12-30", 2), "2027-01-01");
  assert.equal(settlementDate("2026-12-31", 2), "2027-01-04");
});

test("기본값은 선입선출법과 T+2영업일이다", () => {
  assert.equal(DEFAULT_SETTINGS.costMethod, "fifo");
  assert.equal(DEFAULT_SETTINGS.settlementDays, 2);
});
