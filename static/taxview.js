/**
 * 세액 결과를 화면에 옮길 때 보유현황과 방법 비교가 함께 쓰는 표시 규칙.
 */

/** 20% 한 가지뿐이면 예전처럼 한 줄로 보여주고, 그 외에는 세율별로 나눈다. */
export function isMixedRate(tax) {
  return tax.byRate.some((bucket) => bucket.ratePercent !== 20);
}

export function rateLabel(percent) {
  return percent === 10 ? "10% 중소기업" : `${percent}%`;
}

/** 국내주식 양도차익. 양도가액에서 취득가액 등 필요경비를 뺀다(소득세법 제97조). 원 미만은 버린다. */
export function domesticGain({ proceeds, cost }) {
  return Math.trunc((Number(proceeds) || 0) - (Number(cost) || 0));
}
