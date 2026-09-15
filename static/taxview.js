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
