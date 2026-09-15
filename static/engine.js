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
/** 중소기업 주식 세율. 외국법인도 중소기업이면 적용된다(소득세법 제104조 제1항 제12호 가목). */
export const SME_INCOME_TAX_RATE = 0.1;
export const LOCAL_TAX_RATE = 0.1;

/**
 * 세율은 백분율 정수로 계산한다. 0.2 같은 소수는 2진수로 정확히 표현되지 않아
 * 곱한 뒤 끝수를 버리면 10원이 통째로 날아가는 경우가 생긴다.
 */
const STANDARD_RATE_PERCENT = 20;
const SME_RATE_PERCENT = 10;

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

    // 수량 변동(분할·병합·무상주)은 양도가 아니다. 증권사 취득내역에 금액이 붙어 나오면
    // 늘어난 주식을 그 금액짜리 새 로트로 넣고, 금액이 없으면 기존 로트를 같은 비율로
    // 나눈다(취득가액 총액과 취득 순서는 그대로). 어느 쪽인지 도구가 판단하지 않고
    // 입력된 금액 유무로만 가른다.
    if (tx.type === "split") {
      const added = Number(tx.added_quantity ?? 0);
      if (added > 0) {
        const costKrw = Number(tx.cost_krw ?? 0);
        holding.quantity += added;
        holding.totalCostKrw += costKrw;
        holding.lots.push({ quantity: added, costKrw, date: effectiveDate(tx) });
        continue;
      }
      const ratio = Number(tx.ratio);
      if (!(ratio > 0)) {
        throw new EngineError(`${ticker} ${tx.date}: 수량 변동의 변동 후 수량이 올바르지 않습니다.`);
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
      // 취득일은 결제일이다. 화면의 남은 로트 목록에 쓴다.
      holding.lots.push({ quantity, costKrw, date: effectiveDate(tx) });
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
    if (tx.type === "split") quantity = applyQuantityChange(quantity, tx);
    else if (tx.type === "buy") quantity += Number(tx.quantity);
    else if (tx.type === "sell") quantity -= Number(tx.quantity);
  }

  const heldAtDate = quantity;
  let limit = quantity;
  let limitedBy = null;
  let splitFactor = 1;

  for (const tx of sorted.filter((tx) => effectiveDate(tx) > date)) {
    if (tx.type === "split" && Number(tx.added_quantity ?? 0) > 0) {
      quantity += Number(tx.added_quantity);
    } else if (tx.type === "split") {
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

/** 수량 변동 한 건을 보유수량에 반영한다. 금액이 붙은 무상주는 더하고, 나머지는 비율을 곱한다. */
function applyQuantityChange(quantity, tx) {
  const added = Number(tx.added_quantity ?? 0);
  return added > 0 ? quantity + added : quantity * Number(tx.ratio);
}

/**
 * 증권사 취득내역의 "변동 후 수량"과 금액으로 수량 변동 거래의 값을 만든다.
 *
 * 금액이 있으면 늘어난 수량을 그 금액짜리 새 로트로, 없으면 변동 전후 비율로 기록한다.
 * 변동 후 수량 그대로가 아니라 비율·늘어난 수량으로 저장해야, 나중에 그 이전 거래를
 * 고치거나 추가해도 분할 배수가 틀어지지 않는다.
 */
export function buildQuantityChange({ heldBefore, quantityAfter, costKrw = 0 }) {
  const before = Number(heldBefore);
  const after = Number(quantityAfter);
  const cost = Number(costKrw) || 0;

  if (!(before > QTY_EPSILON)) {
    return { error: "변동일 기준 기록상 보유수량이 없습니다. 이전 매수를 먼저 입력해주세요." };
  }
  if (!(after > 0)) return { error: "변동 후 보유수량을 입력해주세요." };
  if (cost < 0) return { error: "금액은 0 이상이어야 합니다." };

  if (cost > 0) {
    if (!(after > before + QTY_EPSILON)) {
      return { error: "금액이 있는 수량 변동은 수량이 늘어난 경우만 입력할 수 있습니다." };
    }
    return {
      fields: {
        quantity_before: before,
        quantity_after: after,
        added_quantity: after - before,
        cost_krw: cost,
        ratio: null,
      },
    };
  }

  if (Math.abs(after - before) <= QTY_EPSILON) {
    return { error: "변동 전과 수량이 같습니다. 증권사 취득내역의 변동 후 수량을 확인해주세요." };
  }
  return {
    fields: {
      quantity_before: before,
      quantity_after: after,
      added_quantity: 0,
      cost_krw: 0,
      ratio: after / before,
    },
  };
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

/** 결제일, 체결일 순. 기본공제는 먼저 양도한 자산부터 빼기 때문에 순서가 세액을 바꾼다. */
function byTransferOrder(left, right) {
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  if (left.tradeDate !== right.tradeDate) return left.tradeDate < right.tradeDate ? -1 : 1;
  return left.order - right.order;
}

/**
 * 세율이 다른 물량을 함께 통산해 세액을 계산한다.
 *
 * items: { ratePercent, gainKrw, date, tradeDate }. 순서는 다음과 같다.
 *
 * 1. 양도차손은 같은 세율 자산의 이익에서 먼저 빼고, 남으면 다른 세율 자산에서
 *    뺀다. 다른 세율이 둘 이상이면 세율별 소득금액 비율로 나눈다.
 *    (소득세법 제102조 제2항, 시행령 제167조의2 제1항)
 *    같은 세율 안에서 이익 자산이 여럿일 때 어느 자산에서 먼저 뺄지는 조문에 없어서,
 *    각 자산 이익 비율대로 나눈다.
 * 2. 기본공제 250만원은 먼저 양도한 자산의 소득금액부터 순서대로 뺀다.
 *    (소득세법 제103조 제2항)
 * 3. 세율별 과세표준에 세율을 곱해 합하고, 지방소득세는 소득세의 10%다.
 *
 * 세율이 하나뿐이면 합계에서 기본공제를 빼고 세율을 곱하는 계산과 같다.
 */
export function calculateTaxByRate(items) {
  const entries = items.map((item, order) => ({
    ...item,
    order,
    amount: Math.max(0, item.gainKrw),
  }));
  const rates = [...new Set(entries.map((e) => e.ratePercent))].sort((a, b) => b - a);
  const gainsOf = (rate) => entries.filter((e) => e.ratePercent === rate && e.amount > 0);
  const remainingOf = (rate) => gainsOf(rate).reduce((sum, e) => sum + e.amount, 0);

  /** 같은 세율 안의 이익 자산들에서 손실을 이익 비율대로 뺀다. 뺀 금액을 돌려준다. */
  function offsetProRata(rate, loss) {
    const total = remainingOf(rate);
    if (total <= 0 || loss <= 0) return 0;
    const offset = Math.min(loss, total);
    const keep = 1 - offset / total;
    gainsOf(rate).forEach((e) => (e.amount *= keep));
    return offset;
  }

  // 1단계: 같은 세율끼리 통산
  const leftoverLoss = new Map();
  for (const rate of rates) {
    const loss = entries
      .filter((e) => e.ratePercent === rate && e.gainKrw < 0)
      .reduce((sum, e) => sum - e.gainKrw, 0);
    leftoverLoss.set(rate, loss - offsetProRata(rate, loss));
  }

  // 2단계: 남은 손실을 다른 세율 자산의 소득금액 비율로 나눠 뺀다
  for (const rate of rates) {
    const loss = leftoverLoss.get(rate);
    if (!(loss > 0)) continue;
    const others = rates.filter((r) => r !== rate).map((r) => [r, remainingOf(r)]);
    const othersTotal = others.reduce((sum, [, remaining]) => sum + remaining, 0);
    if (othersTotal <= 0) continue;
    const spread = Math.min(loss, othersTotal);
    for (const [other, remaining] of others) {
      offsetProRata(other, spread * (remaining / othersTotal));
    }
  }

  const buckets = new Map(
    rates.map((rate) => [
      rate,
      {
        ratePercent: rate,
        gainKrw: Math.trunc(
          entries.filter((e) => e.ratePercent === rate).reduce((sum, e) => sum + e.gainKrw, 0)
        ),
        incomeKrw: Math.trunc(remainingOf(rate)),
        deductionKrw: 0,
      },
    ])
  );

  // 3단계: 기본공제를 먼저 양도한 자산부터 뺀다. 자산별 금액은 소수라 올림해서
  // 한도로 쓰고, 실제로 빼는 금액은 세율별 소득금액(1원 절사)을 넘지 않게 한다.
  let deductionLeft = BASIC_DEDUCTION_KRW;
  for (const entry of entries.filter((e) => e.amount > 0).sort(byTransferOrder)) {
    if (deductionLeft <= 0) break;
    const bucket = buckets.get(entry.ratePercent);
    const take = Math.min(
      deductionLeft,
      Math.ceil(entry.amount),
      bucket.incomeKrw - bucket.deductionKrw
    );
    if (take <= 0) continue;
    bucket.deductionKrw += take;
    deductionLeft -= take;
  }

  const byRate = [...buckets.values()].map((bucket) => {
    const taxableBase = bucket.incomeKrw - bucket.deductionKrw;
    return {
      ...bucket,
      taxableBaseKrw: taxableBase,
      incomeTaxKrw: Math.floor((taxableBase * bucket.ratePercent) / 1000) * 10,
    };
  });

  const sum = (key) => byRate.reduce((total, bucket) => total + bucket[key], 0);
  const incomeTax = sum("incomeTaxKrw");
  const localTax = Math.floor(incomeTax / 100) * 10;

  return {
    totalGainKrw: Math.trunc(entries.reduce((total, e) => total + e.gainKrw, 0)),
    deductionKrw: sum("deductionKrw"),
    taxableBaseKrw: sum("taxableBaseKrw"),
    incomeTaxKrw: incomeTax,
    localTaxKrw: localTax,
    totalTaxKrw: incomeTax + localTax,
    byRate,
  };
}

/**
 * 연간 손익통산 결과에 기본공제와 세율을 적용한다. 모두 20% 물량일 때의 계산.
 *
 * 손실은 당해연도 내 통산만 가능하고 이월되지 않으므로, 통산 결과가 음수면
 * 과세표준은 0이 된다. 국고금 관리법 제47조에 따라 과세표준은 1원 미만,
 * 세액은 10원 미만 끝수를 버린다.
 */
export function calculateTax(totalGainKrw) {
  return calculateTaxByRate([
    { ratePercent: STANDARD_RATE_PERCENT, gainKrw: Math.trunc(totalGainKrw), date: "", tradeDate: "" },
  ]);
}

/**
 * 매도 건과 국내주식 손익을 세율별 계산 항목으로 바꾼다.
 *
 * 중소기업 여부는 도구가 판단하지 않고 사용자가 종목별로 표시한 목록을 쓴다.
 * 국내주식 손익은 날짜 없이 연간 합계만 받으므로 20% 물량으로 보고, 양도 순서는
 * 그 해 해외주식 매도보다 뒤로 둔다.
 */
function taxItems(yearSales, domesticGainKrw, smeTickers) {
  const sme = new Set(smeTickers);
  const items = yearSales.map((sale) => ({
    ratePercent: sme.has(sale.ticker) ? SME_RATE_PERCENT : STANDARD_RATE_PERCENT,
    gainKrw: sale.gainKrw,
    date: sale.date,
    tradeDate: sale.tradeDate,
  }));
  if (domesticGainKrw) {
    items.push({
      ratePercent: STANDARD_RATE_PERCENT,
      gainKrw: domesticGainKrw,
      date: "9999-12-31",
      tradeDate: "9999-12-31",
    });
  }
  return items;
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
export function annualSummary(
  transactions,
  year,
  method = COST_METHOD.FIFO,
  domesticGainKrw = 0,
  smeTickers = []
) {
  const { holdings, sales } = replay(transactions, method);
  const yearSales = sales.filter((s) => s.date.slice(0, 4) === String(year));
  const overseasGain = yearSales.reduce((sum, s) => sum + s.gainKrw, 0);
  return {
    holdings,
    yearSales,
    overseasGainKrw: overseasGain,
    domesticGainKrw,
    tax: calculateTaxByRate(taxItems(yearSales, domesticGainKrw, smeTickers)),
  };
}

/**
 * 같은 거래 기록을 선입선출법과 이동평균법으로 각각 계산해 나란히 돌려준다.
 */
export function compareMethods(transactions, year, domesticGainKrw = 0, smeTickers = []) {
  const fifo = annualSummary(transactions, year, COST_METHOD.FIFO, domesticGainKrw, smeTickers);
  const average = annualSummary(transactions, year, COST_METHOD.AVERAGE, domesticGainKrw, smeTickers);
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
 * 그래서 상한이 아니라 실제 여유분을 계산한다. 손실은 세율이 달라도 끝까지
 * 통산되므로 세율이 섞여도 여유분은 같다.
 */
export function taxFreeHeadroomKrw(
  transactions,
  year,
  method = COST_METHOD.FIFO,
  domesticGainKrw = 0,
  smeTickers = []
) {
  const { tax } = annualSummary(transactions, year, method, domesticGainKrw, smeTickers);
  return Math.max(0, BASIC_DEDUCTION_KRW - tax.totalGainKrw);
}

/**
 * 목표가 시뮬레이션에서 환율 가정을 바꿔가며 세액이 어떻게 달라지는지 계산한다.
 *
 * 매수 시점 환율은 이미 확정된 사실이므로 건드리지 않고, 앞으로 팔 시점의
 * 환율만 가정값으로 바꾼다. 환율이 오르면 원화 양도가액이 커져서 세금도
 * 함께 늘어난다.
 */
export function fxSensitivity(
  transactions,
  virtualSales,
  year,
  { from, to, step, method, domesticGainKrw, smeTickers } = {}
) {
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
    const result = simulate(
      transactions,
      atRate,
      year,
      method ?? COST_METHOD.FIFO,
      domesticGainKrw ?? 0,
      smeTickers ?? []
    );
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

/**
 * 가상 매도를 추가했을 때 늘어나는 세액을 계산한다.
 *
 * 확정 거래만으로 계산한 세액과, 가상 매도를 포함해 계산한 세액의 차액이
 * '지금 팔면 추가로 내야 하는 세금'이다.
 */
export function simulate(
  transactions,
  virtualSales,
  year,
  method = COST_METHOD.FIFO,
  domesticGainKrw = 0,
  smeTickers = []
) {
  const before = annualSummary(transactions, year, method, domesticGainKrw, smeTickers).tax;
  const withVirtual = annualSummary(
    [...transactions, ...virtualSales],
    year,
    method,
    domesticGainKrw,
    smeTickers
  );
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
