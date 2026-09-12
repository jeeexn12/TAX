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

/** 해당 연도 기준 보유현황, 실현 매도 내역, 세액을 함께 반환한다. */
export function annualSummary(transactions, year) {
  const { holdings, sales } = replay(transactions);
  const yearSales = sales.filter((s) => s.date.slice(0, 4) === String(year));
  const totalGain = yearSales.reduce((sum, s) => sum + s.gainKrw, 0);
  return { holdings, yearSales, tax: calculateTax(totalGain) };
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
