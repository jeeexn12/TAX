/**
 * 국외주식 양도소득세 계산 엔진.
 *
 * 거래 기록(매수/매도)을 날짜순으로 재생(replay)해서 종목별 이동평균 취득가액과
 * 매도 건별 양도차익을 도출하고, 연간 손익통산 후 세액을 계산한다.
 *
 * 저장된 값은 취득가액이 아니라 거래 기록이므로, 과거 거래의 적용환율을
 * 나중에 고치면 그 이후의 평균단가·양도차익·세액이 전부 다시 계산된다.
 */

export const BASIC_DEDUCTION_KRW = 2_500_000;
export const INCOME_TAX_RATE = 0.2;
export const LOCAL_TAX_RATE = 0.1;

const QTY_EPSILON = 1e-9;

export class EngineError extends Error {}

export class Holding {
  constructor(ticker) {
    this.ticker = ticker;
    this.quantity = 0;
    this.totalCostKrw = 0;
  }

  get avgCostKrw() {
    if (this.quantity <= QTY_EPSILON) return 0;
    return this.totalCostKrw / this.quantity;
  }
}

export class RealizedSale {
  constructor({ txId, ticker, date, quantity, proceedsKrw, costKrw }) {
    this.txId = txId;
    this.ticker = ticker;
    this.date = date;
    this.quantity = quantity;
    this.proceedsKrw = proceedsKrw;
    this.costKrw = costKrw;
  }

  get gainKrw() {
    return this.proceedsKrw - this.costKrw;
  }
}

function sortedByDate(transactions) {
  return [...transactions].sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return 0;
  });
}

/** 거래를 날짜순으로 처리해 현재 보유현황과 실현된 매도 목록을 반환한다. */
export function replay(transactions) {
  const holdings = new Map();
  const sales = [];

  for (const tx of sortedByDate(transactions)) {
    const ticker = tx.ticker;
    if (!holdings.has(ticker)) holdings.set(ticker, new Holding(ticker));
    const holding = holdings.get(ticker);

    // 주식분할은 양도가 아니므로 취득가액 총액은 그대로 두고 수량만 늘린다.
    // 주당 취득단가는 avgCostKrw가 매번 나눠 계산하므로 자동으로 조정된다.
    if (tx.type === "split") {
      const ratio = Number(tx.ratio);
      if (!(ratio > 0)) {
        throw new EngineError(`${ticker} ${tx.date}: 분할비율은 0보다 커야 합니다.`);
      }
      holding.quantity *= ratio;
      continue;
    }

    const quantity = Number(tx.quantity);
    const fxRate = Number(tx.fx_rate);
    const grossUsd = Number(tx.price_usd) * quantity;
    const feeUsd = Number(tx.fee_usd ?? 0);

    if (!(quantity > 0)) {
      throw new EngineError(`${ticker} ${tx.date}: 수량은 0보다 커야 합니다.`);
    }

    if (tx.type === "buy") {
      holding.totalCostKrw += (grossUsd + feeUsd) * fxRate;
      holding.quantity += quantity;
    } else if (tx.type === "sell") {
      if (quantity > holding.quantity + QTY_EPSILON) {
        throw new EngineError(
          `${ticker} ${tx.date}: 매도수량(${quantity})이 보유수량(${holding.quantity})을 초과합니다.`
        );
      }
      const costKrw = holding.avgCostKrw * quantity;
      sales.push(
        new RealizedSale({
          txId: tx.id ?? "",
          ticker,
          date: tx.date,
          quantity,
          proceedsKrw: (grossUsd - feeUsd) * fxRate,
          costKrw,
        })
      );
      holding.totalCostKrw -= costKrw;
      holding.quantity -= quantity;
      if (holding.quantity <= QTY_EPSILON) {
        holding.quantity = 0;
        holding.totalCostKrw = 0;
      }
    } else {
      throw new EngineError(`알 수 없는 거래 구분: ${tx.type}`);
    }
  }

  return { holdings, sales };
}

/**
 * 해당 날짜에 최대 몇 주까지 매도할 수 있는지 계산한다.
 *
 * 그 시점의 보유수량만 보면 부족하다. 과거 날짜로 매도를 끼워 넣으면 이미
 * 입력해둔 이후 매도가 수량 부족으로 깨질 수 있기 때문에, 기준일 이후 모든
 * 시점의 잔량까지 확인해 가장 빡빡한 값을 돌려준다. 중간에 분할이 있으면
 * 팔린 주식도 같은 비율로 불어나므로 그만큼 나눠서 환산한다.
 */
export function maxSellableQuantity(transactions, ticker, date) {
  const sorted = sortedByDate(transactions.filter((tx) => tx.ticker === ticker));

  let quantity = 0;
  for (const tx of sorted.filter((tx) => tx.date <= date)) {
    if (tx.type === "split") quantity *= Number(tx.ratio);
    else if (tx.type === "buy") quantity += Number(tx.quantity);
    else if (tx.type === "sell") quantity -= Number(tx.quantity);
  }

  let limit = quantity;
  let splitFactor = 1;
  for (const tx of sorted.filter((tx) => tx.date > date)) {
    if (tx.type === "split") {
      const ratio = Number(tx.ratio);
      quantity *= ratio;
      splitFactor *= ratio;
    } else if (tx.type === "buy") {
      quantity += Number(tx.quantity);
    } else if (tx.type === "sell") {
      quantity -= Number(tx.quantity);
    }
    limit = Math.min(limit, quantity / splitFactor);
  }

  return Math.max(0, limit);
}

/** 거래를 추가해도 원장이 깨지지 않는지 미리 확인한다. 화면에서 입력을 막는 용도. */
export function canAddTransaction(transactions, candidate) {
  try {
    replay([...transactions, candidate]);
    return { ok: true, error: null };
  } catch (err) {
    if (err instanceof EngineError) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * 연간 손익통산 결과에 기본공제와 세율을 적용한다.
 *
 * 손실은 당해연도 내 통산만 가능하고 이월되지 않으므로, 통산 결과가 음수면
 * 과세표준은 0이 된다.
 */
export function calculateTax(totalGainKrw) {
  const gain = Math.trunc(totalGainKrw);
  const deduction = gain > 0 ? Math.min(BASIC_DEDUCTION_KRW, gain) : 0;
  const taxableBase = Math.max(0, gain - deduction);
  const incomeTax = Math.trunc(taxableBase * INCOME_TAX_RATE);
  const localTax = Math.trunc(incomeTax * LOCAL_TAX_RATE);

  return {
    totalGainKrw: gain,
    deductionKrw: deduction,
    taxableBaseKrw: taxableBase,
    incomeTaxKrw: incomeTax,
    localTaxKrw: localTax,
    totalTaxKrw: incomeTax + localTax,
  };
}

/**
 * 해당 연도 기준 보유현황, 실현 매도 내역, 세액을 함께 반환한다.
 *
 * 기본공제는 매도 건마다 차감되는 게 아니라, 그 해 매도를 전부 합산한
 * 뒤(손익통산) 연 1회만 적용된다.
 */
export function annualSummary(transactions, year) {
  const { holdings, sales } = replay(transactions);
  const yearSales = sales.filter((s) => s.date.slice(0, 4) === String(year));
  const totalGain = yearSales.reduce((sum, s) => sum + s.gainKrw, 0);
  return { holdings, yearSales, tax: calculateTax(totalGain) };
}

export const TAX_FREE_HEADROOM_LABEL = "올해 세금 없이 추가로 실현 가능한 이익";

/**
 * 올해 추가로 실현해도 세금이 붙지 않는 이익 금액.
 *
 * "남은 기본공제"라고 부르면 250만원이 상한인 것처럼 읽히지만, 이미 손실을
 * 실현해 둔 해에는 그 손실만큼 이익을 더 얹어도 통산되어 세금이 없다.
 * 그래서 상한이 아니라 실제 여유분을 계산한다.
 */
export function taxFreeHeadroomKrw(transactions, year) {
  const { tax } = annualSummary(transactions, year);
  return Math.max(0, BASIC_DEDUCTION_KRW - tax.totalGainKrw);
}

/**
 * 가상 매도를 추가했을 때 늘어나는 세액을 계산한다.
 *
 * 확정 거래만으로 계산한 세액과, 가상 매도를 포함해 계산한 세액의 차액이
 * '지금 팔면 추가로 내야 하는 세금'이다.
 */
export function simulate(transactions, virtualSales, year) {
  const before = annualSummary(transactions, year).tax;
  const withVirtual = annualSummary([...transactions, ...virtualSales], year);
  const after = withVirtual.tax;

  const virtualIds = new Set(virtualSales.map((v) => v.id));
  const simulatedSales = withVirtual.yearSales.filter((s) => virtualIds.has(s.txId));

  return {
    before,
    after,
    additionalTaxKrw: after.totalTaxKrw - before.totalTaxKrw,
    simulatedSales,
    simulatedGainKrw: Math.trunc(simulatedSales.reduce((sum, s) => sum + s.gainKrw, 0)),
  };
}
