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

/** 국고금 관리법 제47조 제1항에 따른 10원 미만 끝수 절사. */
function floorToTen(amount) {
  return Math.floor(amount / 10) * 10;
}

export class EngineError extends Error {}

export const COST_METHOD = { FIFO: "fifo", AVERAGE: "average" };

export class Holding {
  constructor(ticker) {
    this.ticker = ticker;
    this.quantity = 0;
    this.totalCostKrw = 0;
    /** 선입선출법에서만 쓰는 매수 로트 대기열. 먼저 취득한 것이 앞에 온다. */
    this.lots = [];
  }

  get avgCostKrw() {
    if (this.quantity <= QTY_EPSILON) return 0;
    return this.totalCostKrw / this.quantity;
  }
}

/** 먼저 취득한 로트부터 소진하며 대응 취득가액을 계산한다. */
function consumeFifo(holding, quantity) {
  let remaining = quantity;
  let cost = 0;

  while (remaining > QTY_EPSILON && holding.lots.length) {
    const lot = holding.lots[0];
    const take = Math.min(lot.quantity, remaining);
    const taken = lot.costKrw * (take / lot.quantity);

    cost += taken;
    lot.costKrw -= taken;
    lot.quantity -= take;
    remaining -= take;

    if (lot.quantity <= QTY_EPSILON) holding.lots.shift();
  }

  return cost;
}

export class RealizedSale {
  constructor({ txId, ticker, date, tradeDate, quantity, proceedsKrw, costKrw }) {
    this.txId = txId;
    this.ticker = ticker;
    /** 결제일. 대금청산일이 양도시기이므로 이 날짜가 귀속 연도를 정한다. */
    this.date = date;
    this.tradeDate = tradeDate;
    this.quantity = quantity;
    this.proceedsKrw = proceedsKrw;
    this.costKrw = costKrw;
  }

  get gainKrw() {
    return this.proceedsKrw - this.costKrw;
  }

  get crossesYear() {
    return this.date.slice(0, 4) !== this.tradeDate.slice(0, 4);
  }
}

/**
 * 계산의 기준이 되는 날짜. 양도·취득시기가 모두 대금청산일이므로 결제일을 쓴다.
 * (소득세법 제98조, 시행령 제178조의5 제1항)
 *
 * 결제일이 없는 기록은 결제일 개념을 넣기 전에 입력된 것이므로 체결일을 쓴다.
 * 주식분할은 대금 수수가 없어 결제일 자체가 없다.
 */
export function effectiveDate(tx) {
  return tx.settlement_date || tx.date;
}

function sortedByDate(transactions) {
  return [...transactions].sort((a, b) => {
    const left = effectiveDate(a);
    const right = effectiveDate(b);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

/**
 * 거래를 날짜순으로 처리해 현재 보유현황과 실현된 매도 목록을 반환한다.
 *
 * 취득가액 대응 방식은 method로 고른다. 선입선출법은 먼저 산 로트부터 소진하고,
 * 이동평균법은 그 시점 평균단가를 쓴다.
 */
export function replay(transactions, method = COST_METHOD.FIFO) {
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
      holding.lots.forEach((lot) => (lot.quantity *= ratio));
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
      const costKrw = (grossUsd + feeUsd) * fxRate;
      holding.totalCostKrw += costKrw;
      holding.quantity += quantity;
      holding.lots.push({ quantity, costKrw });
    } else if (tx.type === "sell") {
      if (quantity > holding.quantity + QTY_EPSILON) {
        throw new EngineError(
          `${ticker} ${tx.date}: 매도수량(${quantity})이 보유수량(${holding.quantity})을 초과합니다.`
        );
      }
      const costKrw =
        method === COST_METHOD.FIFO
          ? consumeFifo(holding, quantity)
          : holding.avgCostKrw * quantity;
      sales.push(
        new RealizedSale({
          txId: tx.id ?? "",
          ticker,
          date: effectiveDate(tx),
          tradeDate: tx.date,
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
        holding.lots = [];
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
export function sellableInfo(transactions, ticker, date) {
  const sorted = sortedByDate(transactions.filter((tx) => tx.ticker === ticker));

  let quantity = 0;
  for (const tx of sorted.filter((tx) => effectiveDate(tx) <= date)) {
    if (tx.type === "split") quantity *= Number(tx.ratio);
    else if (tx.type === "buy") quantity += Number(tx.quantity);
    else if (tx.type === "sell") quantity -= Number(tx.quantity);
  }

  const heldAtDate = quantity;
  let limit = quantity;
  let limitedBy = null;
  let splitFactor = 1;

  for (const tx of sorted.filter((tx) => effectiveDate(tx) > date)) {
    if (tx.type === "split") {
      const ratio = Number(tx.ratio);
      quantity *= ratio;
      splitFactor *= ratio;
    } else if (tx.type === "buy") {
      quantity += Number(tx.quantity);
    } else if (tx.type === "sell") {
      quantity -= Number(tx.quantity);
    }
    if (quantity / splitFactor < limit) {
      limit = quantity / splitFactor;
      limitedBy = tx;
    }
  }

  return { max: Math.max(0, limit), heldAtDate, limitedBy };
}

export function maxSellableQuantity(transactions, ticker, date) {
  return sellableInfo(transactions, ticker, date).max;
}

/** 거래를 추가해도 원장이 깨지지 않는지 미리 확인한다. 화면에서 입력을 막는 용도. */
export function canAddTransaction(transactions, candidate, method = COST_METHOD.FIFO) {
  try {
    replay([...transactions, candidate], method);
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
  // 국고금 관리법 제47조: 과세표준은 1원 미만, 세액은 10원 미만 끝수를 버린다.
  const gain = Math.trunc(totalGainKrw);
  const deduction = gain > 0 ? Math.min(BASIC_DEDUCTION_KRW, gain) : 0;
  const taxableBase = Math.max(0, gain - deduction);
  const incomeTax = floorToTen(taxableBase * INCOME_TAX_RATE);
  const localTax = floorToTen(incomeTax * LOCAL_TAX_RATE);

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
 * 귀속 연도는 체결일이 아니라 결제일로 가른다. 12월 말 매도가 다음 해 초에
 * 결제되면 그 해가 아니라 다음 해 소득이 된다.
 *
 * 기본공제는 매도 건마다 차감되는 게 아니라, 그 해 매도를 전부 합산한
 * 뒤(손익통산) 연 1회만 적용된다.
 */
export function annualSummary(transactions, year, method = COST_METHOD.FIFO, domesticGainKrw = 0) {
  const { holdings, sales } = replay(transactions, method);
  const yearSales = sales.filter((s) => s.date.slice(0, 4) === String(year));
  const overseasGain = yearSales.reduce((sum, s) => sum + s.gainKrw, 0);
  return {
    holdings,
    yearSales,
    overseasGainKrw: overseasGain,
    domesticGainKrw,
    tax: calculateTax(overseasGain + domesticGainKrw),
  };
}

/**
 * 같은 거래 기록을 선입선출법과 이동평균법으로 각각 계산해 나란히 돌려준다.
 */
export function compareMethods(transactions, year, domesticGainKrw = 0) {
  const fifo = annualSummary(transactions, year, COST_METHOD.FIFO, domesticGainKrw);
  const average = annualSummary(transactions, year, COST_METHOD.AVERAGE, domesticGainKrw);
  const differenceKrw = fifo.tax.totalTaxKrw - average.tax.totalTaxKrw;

  return {
    fifo: fifo.tax,
    average: average.tax,
    fifoSales: fifo.yearSales,
    averageSales: average.yearSales,
    differenceKrw,
    lowerMethod:
      differenceKrw === 0 ? null : differenceKrw < 0 ? COST_METHOD.FIFO : COST_METHOD.AVERAGE,
  };
}

export const TAX_FREE_HEADROOM_LABEL = "올해 세금 없이 추가로 실현 가능한 이익";

/**
 * 올해 추가로 실현해도 세금이 붙지 않는 이익 금액.
 *
 * "남은 기본공제"라고 부르면 250만원이 상한인 것처럼 읽히지만, 이미 손실을
 * 실현해 둔 해에는 그 손실만큼 이익을 더 얹어도 통산되어 세금이 없다.
 * 그래서 상한이 아니라 실제 여유분을 계산한다.
 */
export function taxFreeHeadroomKrw(transactions, year, method = COST_METHOD.FIFO, domesticGainKrw = 0) {
  const { tax } = annualSummary(transactions, year, method, domesticGainKrw);
  return Math.max(0, BASIC_DEDUCTION_KRW - tax.totalGainKrw);
}

/**
 * 가상 매도를 추가했을 때 늘어나는 세액을 계산한다.
 *
 * 확정 거래만으로 계산한 세액과, 가상 매도를 포함해 계산한 세액의 차액이
 * '지금 팔면 추가로 내야 하는 세금'이다.
 */
/**
 * 목표가 시뮬레이션에서 환율 가정을 바꿔가며 세액이 어떻게 달라지는지 계산한다.
 *
 * 매수 시점 환율은 이미 확정된 사실이므로 건드리지 않고, 앞으로 팔 시점의
 * 환율만 가정값으로 바꾼다. 환율이 오르면 원화 양도가액이 커져서 세금도
 * 함께 늘어난다.
 */
export function fxSensitivity(transactions, virtualSales, year, { from, to, step, method } = {}) {
  const start = from ?? 1250;
  const end = to ?? 1500;
  const increment = step ?? 50;

  if (!(increment > 0)) throw new EngineError("환율 간격은 0보다 커야 합니다.");
  if (end < start) throw new EngineError("환율 상한이 하한보다 작습니다.");

  const rows = [];
  const stepCount = Math.floor((end - start) / increment + 1e-9);
  for (let i = 0; i <= stepCount; i += 1) {
    // 누적 덧셈은 오차가 쌓이므로 매번 시작값에서 계산한다.
    const rate = start + i * increment;
    const atRate = virtualSales.map((sale) => ({ ...sale, fx_rate: rate }));
    const result = simulate(transactions, atRate, year, method ?? COST_METHOD.FIFO);
    rows.push({
      fxRate: rate,
      simulatedGainKrw: result.simulatedGainKrw,
      totalGainKrw: result.after.totalGainKrw,
      taxableBaseKrw: result.after.taxableBaseKrw,
      totalTaxKrw: result.after.totalTaxKrw,
      additionalTaxKrw: result.additionalTaxKrw,
    });
  }
  return rows;
}

export function simulate(transactions, virtualSales, year, method = COST_METHOD.FIFO, domesticGainKrw = 0) {
  const before = annualSummary(transactions, year, method, domesticGainKrw).tax;
  const withVirtual = annualSummary([...transactions, ...virtualSales], year, method, domesticGainKrw);
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
