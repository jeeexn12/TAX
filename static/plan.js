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

export function loadPlan() {
  try {
    return normalizePlan(JSON.parse(localStorage.getItem(PLAN_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function savePlan(plan) {
  const normalized = normalizePlan(plan);
  localStorage.setItem(PLAN_KEY, JSON.stringify(normalized));
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
    years: perYear,
    totals: {
      proceedsKrw: proceeds,
      additionalTaxKrw: additionalTax,
      netCashKrw: proceeds - additionalTax,
    },
  };
}
