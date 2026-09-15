/**
 * 거래 통화. 환율은 수출입은행 매매기준율을 쓰고, 엔화처럼 100단위로 고시되는 통화는
 * 화면에서도 100단위로 보여준다.
 *
 * 저장하는 적용환율(fx_rate)은 언제나 1통화당 원화다. 엔화 866.49원(100엔당)을 그대로
 * 곱하면 취득가액이 100배가 되므로, 화면에 보이거나 입력받는 값만 단위를 곱하고 나눈다.
 * 거래 기록의 price_usd·fee_usd는 달러만 받던 때의 이름이 남은 것이고, 실제로는 그 거래
 * 통화 기준 단가·수수료다.
 */

export const DEFAULT_CURRENCY = "USD";

export const CURRENCIES = {
  USD: { code: "USD", name: "미국 달러", symbol: "$", unit: 1, priceDigits: 2, example: "AAPL" },
  JPY: { code: "JPY", name: "일본 엔", symbol: "¥", unit: 100, priceDigits: 0, example: "7203.T" },
  HKD: { code: "HKD", name: "홍콩 달러", symbol: "HK$", unit: 1, priceDigits: 2, example: "0700.HK" },
  CNH: { code: "CNH", name: "중국 위안", symbol: "CN¥", unit: 1, priceDigits: 2, example: "600519.SS" },
  EUR: { code: "EUR", name: "유로", symbol: "€", unit: 1, priceDigits: 2, example: "SAP.DE" },
  GBP: { code: "GBP", name: "영국 파운드", symbol: "£", unit: 1, priceDigits: 2, example: "SHEL.L" },
};

/** 달러 환율 가정 슬라이더는 이용자가 정한 범위다. 다른 통화는 오늘 환율 기준으로 잡는다. */
const USD_SLIDER = { min: 1250, max: 1500, step: 10 };
const SLIDER_SPREAD = 0.1;

export function normalizeCurrency(code) {
  return Object.hasOwn(CURRENCIES, code) ? code : DEFAULT_CURRENCY;
}

export function currencyInfo(code) {
  return CURRENCIES[normalizeCurrency(code)];
}

/** 저장값(1통화당 원화) → 화면값(고시 단위당 원화). */
export function displayRate(rate, code) {
  return Number(rate) * currencyInfo(code).unit;
}

/** 화면값(고시 단위당 원화) → 저장값(1통화당 원화). */
export function storedRate(display, code) {
  return Number(display) / currencyInfo(code).unit;
}

/** "USD/KRW", "JPY(100)/KRW" */
export function rateUnitLabel(code) {
  const { unit } = currencyInfo(code);
  return unit > 1 ? `${normalizeCurrency(code)}(${unit})/KRW` : `${normalizeCurrency(code)}/KRW`;
}

export function formatMoney(value, code) {
  const { symbol, priceDigits } = currencyInfo(code);
  const digits = Number.isInteger(Number(value)) ? 0 : Math.max(priceDigits, 2);
  return `${symbol}${Number(value).toLocaleString("ko-KR", {
    minimumFractionDigits: Math.min(priceDigits, digits),
    maximumFractionDigits: Math.max(priceDigits, digits),
  })}`;
}

/** 거래 기록의 통화. 통화를 넣기 전에 저장된 거래는 모두 달러였다. */
export function transactionCurrency(tx) {
  return normalizeCurrency(tx?.currency ?? DEFAULT_CURRENCY);
}

/** 종목에 이미 입력된 거래의 통화. 한 종목은 한 통화로만 입력받는다. 주식분할은 통화가 없다. */
export function tickerCurrency(transactions, ticker) {
  const first = transactions.find((tx) => tx.ticker === ticker && tx.type !== "split");
  return first ? transactionCurrency(first) : null;
}

/** 오늘 환율(화면값)을 가운데 두고 ±10% 범위를 단위에 맞춰 반올림한 슬라이더 범위. */
export function sliderRange(code, todayDisplayRate) {
  if (normalizeCurrency(code) === "USD") return { ...USD_SLIDER };
  const center = Number(todayDisplayRate);
  if (!(center > 0)) return null;
  const step = center >= 500 ? 10 : center >= 50 ? 1 : 0.1;
  const round = (value) => Math.round(value / step) * step;
  return {
    min: Number(round(center * (1 - SLIDER_SPREAD)).toFixed(1)),
    max: Number(round(center * (1 + SLIDER_SPREAD)).toFixed(1)),
    step,
  };
}
