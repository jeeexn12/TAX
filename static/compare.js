/**
 * 선입선출법과 이동평균법을 나란히 보여주는 화면.
 *
 * 어느 방법이 맞는지는 판단하지 않고 차이가 얼마인지만 드러낸다.
 */

import { COST_METHOD, compareMethods } from "./engine.js";
import { COST_METHODS } from "./settings.js";
import { loadSmeTickers } from "./storage.js";
import { isMixedRate, rateLabel } from "./taxview.js";

/** 차액이 이 정도면 어느 쪽인지 확인할 실익이 크다고 보고 강조한다. */
const MATERIAL_KRW = 500_000;

const el = {
  year: document.getElementById("compare-year"),
  body: document.getElementById("compare-body"),
};

const won = (value) => `₩${Math.round(value).toLocaleString("ko-KR")}`;
const signedWon = (value) =>
  `${value >= 0 ? "+" : "−"}₩${Math.abs(Math.round(value)).toLocaleString("ko-KR")}`;

function row(label, fifoValue, averageValue, className = "") {
  return `
    <tr class="${className}">
      <th scope="row">${label}</th>
      <td class="num">${fifoValue}</td>
      <td class="num">${averageValue}</td>
    </tr>`;
}

function verdict(result, currentMethod) {
  const gap = Math.abs(result.differenceKrw);

  if (gap === 0) {
    return `<p class="compare-verdict is-same">두 방법의 세액이 같습니다. 종목마다 매수가 한 번뿐이거나,
      차익이 모두 기본공제에 흡수되는 경우입니다.</p>`;
  }

  const cheaper = COST_METHODS[result.lowerMethod];
  const applied = COST_METHODS[currentMethod];
  const appliedIsCheaper = result.lowerMethod === currentMethod;
  const level = gap >= MATERIAL_KRW ? "is-large" : "is-small";

  return `
    <p class="compare-verdict ${level}">
      두 방법의 세액 차이는 <strong>${won(gap)}</strong>입니다.
      ${cheaper}이 그만큼 적게 나옵니다.
      ${
        appliedIsCheaper
          ? `지금 설정된 방법은 ${applied}입니다.`
          : `지금 설정된 방법은 ${applied}이라 <strong>${won(gap)}만큼 더 내는 쪽</strong>으로 계산되고 있습니다.`
      }
      ${
        gap >= MATERIAL_KRW
          ? "금액이 작지 않으니 증권사에 어느 방식을 적용하는지 반드시 확인하세요."
          : ""
      }
    </p>`;
}

function bucketOf(tax, percent) {
  return tax.byRate.find((bucket) => bucket.ratePercent === percent);
}

/** 세율이 섞이면 과세표준과 소득세를 세율별 줄로 나눈다. */
function taxRows(result) {
  if (!isMixedRate(result.fifo) && !isMixedRate(result.average)) {
    return [
      row("과세표준", won(result.fifo.taxableBaseKrw), won(result.average.taxableBaseKrw)),
      row("소득세 (20%)", won(result.fifo.incomeTaxKrw), won(result.average.incomeTaxKrw)),
      row("지방소득세 (2%)", won(result.fifo.localTaxKrw), won(result.average.localTaxKrw)),
    ].join("");
  }

  const percents = [
    ...new Set([...result.fifo.byRate, ...result.average.byRate].map((b) => b.ratePercent)),
  ].sort((a, b) => b - a);
  const cell = (tax, percent, key) => won(bucketOf(tax, percent)?.[key] ?? 0);

  return [
    ...percents.map((p) =>
      row(`과세표준 (${rateLabel(p)})`, cell(result.fifo, p, "taxableBaseKrw"), cell(result.average, p, "taxableBaseKrw"))
    ),
    ...percents.map((p) =>
      row(`소득세 (${rateLabel(p)})`, cell(result.fifo, p, "incomeTaxKrw"), cell(result.average, p, "incomeTaxKrw"))
    ),
    row("지방소득세 (소득세의 10%)", won(result.fifo.localTaxKrw), won(result.average.localTaxKrw)),
  ].join("");
}

export function renderCompare(transactions, currentMethod) {
  const year = new Date().getFullYear();
  el.year.textContent = `${year}년 귀속`;

  const result = compareMethods(transactions, year, 0, loadSmeTickers());

  if (!result.fifoSales.length && !result.averageSales.length) {
    el.body.innerHTML = `<p class="empty">${year}년에 결제가 완료된 매도가 없습니다.
      매도를 입력하면 두 방법의 차이를 계산합니다.</p>`;
    return;
  }

  const fifoIsCurrent = currentMethod === COST_METHOD.FIFO;

  el.body.innerHTML = `
    ${verdict(result, currentMethod)}
    <div class="table-scroll">
      <table class="compare-table">
        <thead>
          <tr>
            <th></th>
            <th class="num ${fifoIsCurrent ? "is-current" : ""}">
              선입선출법${fifoIsCurrent ? '<br /><small>현재 설정</small>' : ""}
            </th>
            <th class="num ${fifoIsCurrent ? "" : "is-current"}">
              이동평균법${fifoIsCurrent ? "" : '<br /><small>현재 설정</small>'}
            </th>
          </tr>
        </thead>
        <tbody>
          ${row("양도차익 합계", signedWon(result.fifo.totalGainKrw), signedWon(result.average.totalGainKrw))}
          ${row("기본공제", `−${won(result.fifo.deductionKrw)}`, `−${won(result.average.deductionKrw)}`)}
          ${taxRows(result)}
          ${row("예상세액 합계", won(result.fifo.totalTaxKrw), won(result.average.totalTaxKrw), "is-total")}
        </tbody>
      </table>
    </div>
    <p class="hint">
      매도 건별 취득가액이 달라져서 생기는 차이입니다. 양도가액은 두 방법이 같습니다.
    </p>`;
}
