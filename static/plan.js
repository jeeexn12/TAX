/**
 * 매도 계획. 팔 계획을 여러 줄 적어두고 줄마다 켜고 끄며 세금과 손에 남는 돈을 본다.
 *
 * 계획은 실제 거래가 아니라 가정이므로 거래 기록과 따로 저장한다. 계산할 때만
 * 가상 매도로 바꿔 확정 거래 뒤에 끼워 넣는다.
 */

import { COST_METHOD, annualSummary, canAddTransaction, replay } from "./engine.js";
import { settlementDate } from "./settings.js";

const PLAN_KEY = "us-tax:sale-plan";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `plan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createPlanItem({ ticker, quantity, targetPrice, saleDate, fxRate }) {
  return {
    id: newId(),
    ticker: String(ticker ?? "").trim().toUpperCase(),
    quantity: Number(quantity) || 0,
    targetPrice: Number(targetPrice) || 0,
    saleDate: saleDate ?? "",
    fxRate: Number(fxRate) || 0,
    included: true,
  };
}

export function normalizePlan(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === "object" && typeof item.ticker === "string")
    .map((item) => ({
      id: typeof item.id === "string" && item.id ? item.id : newId(),
      ticker: item.ticker.trim().toUpperCase(),
      quantity: Number(item.quantity) || 0,
      targetPrice: Number(item.targetPrice) || 0,
      saleDate: typeof item.saleDate === "string" ? item.saleDate : "",
      fxRate: Number(item.fxRate) || 0,
      included: item.included !== false,
    }));
}

/**
 * 이름 붙인 계획 여러 개를 담는 묶음. 복사해서 조금씩 바꿔가며 비교할 수 있게 한다.
 * { activeId, plans: [{ id, name, items }] }
 */
const PLAN_BOOK_KEY = "us-tax:sale-plans";
const PLAN_NAME_MAX = 30;

function cleanName(name) {
  return typeof name === "string" ? name.trim().slice(0, PLAN_NAME_MAX) : "";
}

/** 아직 쓰지 않은 "매도계획 N" 이름. */
export function nextPlanName(plans) {
  const names = new Set(plans.map((plan) => plan.name));
  let n = plans.length + 1;
  while (names.has(`매도계획 ${n}`)) n += 1;
  return `매도계획 ${n}`;
}

export function normalizePlanBook(raw) {
  const plans = [];
  const seen = new Set();
  for (const plan of Array.isArray(raw?.plans) ? raw.plans : []) {
    if (!plan || typeof plan !== "object") continue;
    const id = typeof plan.id === "string" && plan.id && !seen.has(plan.id) ? plan.id : newId();
    seen.add(id);
    plans.push({
      id,
      name: cleanName(plan.name) || nextPlanName(plans),
      items: normalizePlan(plan.items),
    });
  }
  // 계획이 하나도 없으면 빈 계획 하나를 둔다. 화면이 늘 어떤 계획을 보고 있게 하기 위해서다.
  if (!plans.length) plans.push({ id: newId(), name: nextPlanName(plans), items: [] });

  const activeId = plans.some((plan) => plan.id === raw?.activeId) ? raw.activeId : plans[0].id;
  return { activeId, plans };
}

export function activePlan(book) {
  return book.plans.find((plan) => plan.id === book.activeId) ?? book.plans[0];
}

export function addPlan(book) {
  const plan = { id: newId(), name: nextPlanName(book.plans), items: [] };
  return { activeId: plan.id, plans: [...book.plans, plan] };
}

export function duplicatePlan(book, id) {
  const source = book.plans.find((plan) => plan.id === id);
  if (!source) return book;
  const copy = {
    id: newId(),
    name: cleanName(`${source.name} 복사본`),
    items: source.items.map((item) => ({ ...item, id: newId() })),
  };
  const plans = [...book.plans];
  plans.splice(plans.indexOf(source) + 1, 0, copy);
  return { activeId: copy.id, plans };
}

/** 빈 이름으로는 바꾸지 않는다. */
export function renamePlan(book, id, name) {
  const cleaned = cleanName(name);
  if (!cleaned) return book;
  return { ...book, plans: book.plans.map((plan) => (plan.id === id ? { ...plan, name: cleaned } : plan)) };
}

export function removePlan(book, id) {
  const plans = book.plans.filter((plan) => plan.id !== id);
  return normalizePlanBook({
    activeId: book.activeId === id ? plans[0]?.id : book.activeId,
    plans,
  });
}

export function setActivePlan(book, id) {
  return book.plans.some((plan) => plan.id === id) ? { ...book, activeId: id } : book;
}

export function setActiveItems(book, items) {
  return {
    ...book,
    plans: book.plans.map((plan) => (plan.id === book.activeId ? { ...plan, items } : plan)),
  };
}

export function loadPlanBook() {
  try {
    const saved = localStorage.getItem(PLAN_BOOK_KEY);
    if (saved) return normalizePlanBook(JSON.parse(saved));
    // 계획을 하나만 두던 때 저장한 목록은 "매도계획 1"로 옮긴다.
    const legacy = normalizePlan(JSON.parse(localStorage.getItem(PLAN_KEY) ?? "[]"));
    return normalizePlanBook({ plans: [{ name: "매도계획 1", items: legacy }] });
  } catch {
    return normalizePlanBook(null);
  }
}

export function savePlanBook(book) {
  const normalized = normalizePlanBook(book);
  localStorage.setItem(PLAN_BOOK_KEY, JSON.stringify(normalized));
  localStorage.removeItem(PLAN_KEY);
  return normalized;
}

function inputError(item) {
  if (!item.ticker) return "종목을 골라주세요.";
  if (!(item.quantity > 0)) return "수량을 입력해주세요.";
  if (!(item.targetPrice >= 0)) return "목표가를 입력해주세요.";
  if (!DATE_PATTERN.test(item.saleDate)) return "매도일을 입력해주세요.";
  if (!(item.fxRate > 0)) return "환율을 입력해주세요.";
  return null;
}

/** 계획 한 줄을 가상 매도로 바꾼다. 귀속 연도는 결제일로 가르므로 결제일도 추정해 넣는다. */
export function planSale(item, settlementDays = 2) {
  return {
    id: `plan:${item.id}`,
    type: "sell",
    ticker: item.ticker,
    date: item.saleDate,
    settlement_date: settlementDate(item.saleDate, settlementDays),
    quantity: item.quantity,
    price_usd: item.targetPrice,
    fee_usd: 0,
    fx_rate: item.fxRate,
  };
}

const yearOf = (sale) => Number(sale.settlement_date.slice(0, 4));

/**
 * 계획 전체를 계산한다.
 *
 * - 켠 줄만 합산한다. 결제일 순서로 하나씩 넣어보고 보유수량이 모자라는 줄은
 *   오류로 표시하고 뺀다.
 * - "이 줄로 늘어나는 세금"은 다른 켠 줄은 그대로 두고 이 줄이 있을 때와 없을 때의
 *   차이다. 끈 줄은 켰을 때 늘어날 세금을 보여준다. 기본공제를 나눠 쓰므로 줄별
 *   금액을 더해도 전체 증가액과 같지 않다.
 * - 세금은 매도한 해마다 따로 계산해 더한다. 먼저 판 주식이 다음 해 매도의
 *   취득가액을 바꿀 수 있어서 계획이 걸친 해 이후의 매도 연도를 모두 본다.
 * - 국내주식 손익은 올해 금액이므로 올해 세금에만 넣는다.
 */
export function evaluatePlan(transactions, plan, options = {}) {
  const {
    method = COST_METHOD.FIFO,
    domesticGainKrw = 0,
    smeTickers = [],
    settlementDays = 2,
    currentYear = new Date().getFullYear(),
  } = options;

  const lines = plan.map((item, index) => {
    const error = inputError(item);
    return {
      item,
      index,
      sale: error ? null : planSale(item, settlementDays),
      error,
    };
  });

  const byDate = (a, b) =>
    a.sale.settlement_date === b.sale.settlement_date
      ? a.index - b.index
      : a.sale.settlement_date < b.sale.settlement_date
        ? -1
        : 1;

  const accepted = [];
  for (const line of lines.filter((l) => l.item.included && l.sale).sort(byDate)) {
    const check = canAddTransaction([...transactions, ...accepted], line.sale, method);
    if (check.ok) accepted.push(line.sale);
    else line.error = `보유수량이 모자랍니다. 다른 계획 줄과 합쳐 보유수량을 넘지 않는지 확인하세요.`;
  }

  const planYears = lines.filter((l) => l.sale).map((l) => yearOf(l.sale));
  const firstPlanYear = planYears.length ? Math.min(...planYears) : currentYear;
  const confirmedYears = replay(transactions, method)
    .sales.map((s) => Number(s.date.slice(0, 4)))
    .filter((year) => year >= firstPlanYear);
  const years = [...new Set([...planYears, ...confirmedYears])].sort((a, b) => a - b);

  const summaryFor = (txs, year) =>
    annualSummary(txs, year, method, year === currentYear ? domesticGainKrw : 0, smeTickers);
  const totalTax = (txs) => years.reduce((sum, year) => sum + summaryFor(txs, year).tax.totalTaxKrw, 0);

  const withAccepted = [...transactions, ...accepted];
  const taxBefore = totalTax(transactions);
  const taxAfter = totalTax(withAccepted);
  const afterSales = replay(withAccepted, method).sales;

  const items = lines.map((line) => {
    const base = {
      id: line.item.id,
      ticker: line.item.ticker,
      included: line.item.included,
      settlementDate: line.sale?.settlement_date ?? null,
      year: line.sale ? yearOf(line.sale) : null,
      error: line.error,
      proceedsKrw: null,
      costKrw: null,
      gainKrw: null,
      marginalTaxKrw: null,
    };
    if (!line.sale) return base;

    const isAccepted = accepted.includes(line.sale);
    if (!isAccepted && line.item.included) return base;

    let scenarioSales = afterSales;
    let marginal;
    if (isAccepted) {
      marginal = taxAfter - totalTax(withAccepted.filter((tx) => tx !== line.sale));
    } else {
      const check = canAddTransaction(withAccepted, line.sale, method);
      if (!check.ok) {
        return { ...base, error: "지금 켜둔 계획과 합치면 보유수량이 모자랍니다." };
      }
      const withThis = [...withAccepted, line.sale];
      marginal = totalTax(withThis) - taxAfter;
      scenarioSales = replay(withThis, method).sales;
    }

    const realized = scenarioSales.find((s) => s.txId === line.sale.id);
    return {
      ...base,
      proceedsKrw: realized.proceedsKrw,
      costKrw: realized.costKrw,
      gainKrw: realized.gainKrw,
      marginalTaxKrw: marginal,
    };
  });

  const acceptedIds = new Set(accepted.map((sale) => sale.id));
  const acceptedYears = new Set(accepted.map(yearOf));
  const perYear = years.map((year) => {
    const before = summaryFor(transactions, year).tax;
    const after = summaryFor(withAccepted, year).tax;
    const plannedProceeds = afterSales
      .filter((s) => acceptedIds.has(s.txId) && Number(s.date.slice(0, 4)) === year)
      .reduce((sum, s) => sum + s.proceedsKrw, 0);
    return {
      year,
      before,
      after,
      additionalTaxKrw: after.totalTaxKrw - before.totalTaxKrw,
      plannedProceedsKrw: plannedProceeds,
      taxFreeHeadroomKrw: Math.max(0, 2_500_000 - after.totalGainKrw),
      // 양도소득세 확정신고·납부는 다음 해 5월 1일부터 31일까지
      paymentMonth: `${year + 1}년 5월`,
    };
  });

  const proceeds = items
    .filter((i) => i.included && !i.error && i.proceedsKrw !== null)
    .reduce((sum, i) => sum + i.proceedsKrw, 0);
  const additionalTax = taxAfter - taxBefore;

  return {
    items,
    // 끈 줄만 있는 해는 빈 줄로 보여줄 이유가 없다. 켠 계획이 없어도 먼저 판 주식 때문에
    // 세금이 달라진 해는 남긴다.
    years: perYear.filter((y) => acceptedYears.has(y.year) || y.additionalTaxKrw !== 0),
    totals: {
      proceedsKrw: proceeds,
      additionalTaxKrw: additionalTax,
      netCashKrw: proceeds - additionalTax,
    },
  };
}
