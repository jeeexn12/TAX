/**
 * 정액 반복매수(적립식) 로트 생성.
 *
 * 종가와 그날 고시환율로 수량을 역산하는 근사치다. 실제 체결가·체결시점 환율과는
 * 다르므로, 만들어진 로트에는 source="dca" 표시를 남겨 나중에 증권사 명세서와
 * 대조해 정정할 수 있게 한다.
 */

export const MAX_RANGE_DAYS = 366;

export const DCA_DISCLAIMER =
  "종가·고시환율 기준 근사치입니다. 실제 체결 내역과 다를 수 있으니 증권사 명세서로 확인 후 정정하세요.";

export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(startIso, endIso) {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  return Math.round((end - start) / 86400000);
}

/** 1년을 넘는 구간은 막지 않고 시작일 기준 1년 시점으로 줄여서 돌려준다. */
export function clampRange(startIso, endIso) {
  if (!startIso || !endIso) return { end: endIso, clamped: false };
  if (daysBetween(startIso, endIso) <= MAX_RANGE_DAYS) return { end: endIso, clamped: false };
  return { end: addDays(startIso, MAX_RANGE_DAYS), clamped: true };
}

/**
 * 실제 매수가 일어나는 날짜를 고른다.
 *
 * 매일: 거래일 전부. 매주: 시작일부터 7일 간격이되, 그날이 휴장이면 다음 거래일로
 * 민다(증권사 자동매수가 실제로 그렇게 체결된다). 긴 연휴로 두 회차가 같은
 * 거래일로 밀리면 한 번만 매수한 것으로 본다.
 */
export function scheduledDates({ start, end, frequency, tradingDates }) {
  const inRange = tradingDates.filter((d) => d >= start && d <= end).sort();
  if (frequency === "daily") return inRange;

  const picked = [];
  const used = new Set();
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 7)) {
    const actual = inRange.find((d) => d >= cursor);
    if (actual && !used.has(actual)) {
      picked.push(actual);
      used.add(actual);
    }
  }
  return picked;
}

/**
 * 회차별 매수금액에서 수량을 역산한다.
 *
 * 원화 정액이면 그날 환율로 거래 통화로 바꾼 뒤 종가로 나누고, 외화 정액이면 바로
 * 종가로 나눈다. 소수점 수량이 나오는 건 소수점 매수 서비스의 실제 동작과 같다.
 */
export function buildLots({ ticker, currency, amount, rows, tradeCurrency = "USD" }) {
  return rows.map((row) => {
    const close = row.close ?? row.close_usd;
    const amountForeign = currency === "KRW" ? amount / row.fx_rate : amount;
    return {
      type: "buy",
      ticker,
      currency: tradeCurrency,
      date: row.date,
      settlement_date: row.settlement_date ?? null,
      quantity: amountForeign / close,
      price_usd: close,
      fee_usd: 0,
      fx_rate: row.fx_rate,
      fx_applied_date: row.fx_applied_date,
      fx_manual: false,
      source: "dca",
    };
  });
}

/** 이어서 다음 구간을 넣을 때 쓸 시작일. 마지막 로트 다음 날. */
export function nextStartDate(lots) {
  if (!lots.length) return null;
  const last = lots.reduce((latest, lot) => (lot.date > latest ? lot.date : latest), lots[0].date);
  return addDays(last, 1);
}
