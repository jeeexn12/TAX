/**
 * 전역 설정. 취득가액 계산방법과 결제일 계산 기준을 담는다.
 *
 * 두 값 모두 거래 증권사가 실제로 어떻게 처리하는지에 달려 있어서 하드코딩하지
 * 않는다. 결제일은 대금이 고객계좌에 입출금된 날이라 증권사마다 다르다.
 */

const SETTINGS_KEY = "us-tax:settings";

export const COST_METHODS = {
  fifo: "선입선출법",
  average: "이동평균법",
};

export const DEFAULT_SETTINGS = {
  costMethod: "fifo",
  // 미국 현지 결제는 2024-05-28부터 T+1이고, 국내 증권사가 고객계좌에 반영하기까지
  // 통상 하루가 더 걸린다. 그 이전 거래는 T+3인 경우가 많으므로 개별 수정이 필요하다.
  settlementDays: 2,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(partial) {
  const merged = { ...loadSettings(), ...partial };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

/**
 * 체결일에 영업일 N일을 더해 결제일을 추정한다.
 *
 * 주말만 제외한다. 미국·한국 공휴일은 양쪽 달력에 모두 걸려 있어 자동 판정이
 * 오히려 틀리기 쉬우므로, 실제 입출금일과 다르면 개별 수정하도록 남겨둔다.
 */
export function settlementDate(tradeDate, days) {
  if (!tradeDate) return "";
  const d = new Date(`${tradeDate}T00:00:00Z`);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const weekday = d.getUTCDay();
    if (weekday !== 0 && weekday !== 6) added += 1;
  }
  return d.toISOString().slice(0, 10);
}
