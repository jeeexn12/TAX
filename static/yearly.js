/**
 * 손익·세금 화면. 귀속 연도별로 확정된 매도의 양도소득금액과 예상세액, 신고 안내를 보여준다.
 *
 * 보유현황에 있던 올해 요약과 국내주식 입력을 옮겨왔다. "보유현황"이라는 이름 아래에
 * 이익과 세금이 나오면 무엇을 보는 화면인지 와닿지 않는다는 의견을 반영했다.
 */

import { COST_METHOD, TAX_FREE_HEADROOM_LABEL, annualSummary, replay, taxFreeHeadroomKrw } from "./engine.js";
import { loadSmeTickers } from "./storage.js";
import { domesticGain, isMixedRate, rateLabel } from "./taxview.js";

/** 다른 화면(보유현황·매도 계획)이 읽는 올해 국내주식 양도차익. 아래 금액에서 계산해 넣는다. */
const DOMESTIC_GAIN_KEY = "us-tax:domestic-gain";
/** 올해 국내주식 양도가액과 취득가액 등 필요경비 합계. */
const DOMESTIC_AMOUNTS_KEY = "us-tax:domestic-amounts";
/** 소득세법 제112조: 납부할 세액이 이 금액을 넘으면 분할납부할 수 있다. */
const INSTALLMENT_THRESHOLD_KRW = 10_000_000;

const el = {
  year: document.getElementById("tax-year"),
  gain: document.getElementById("tax-gain"),
  gainNote: document.getElementById("tax-gain-note"),
  total: document.getElementById("tax-total"),
  totalNote: document.getElementById("tax-total-note"),
  headroomItem: document.getElementById("tax-headroom-item"),
  headroomLabel: document.getElementById("tax-headroom-label"),
  headroom: document.getElementById("tax-headroom"),
  breakdown: document.getElementById("tax-breakdown"),
  domesticProceeds: document.getElementById("domestic-proceeds"),
  domesticCost: document.getElementById("domestic-cost"),
  domesticGain: document.getElementById("domestic-gain"),
  domesticWarning: document.getElementById("domestic-warning"),
  domesticYearNote: document.getElementById("domestic-year-note"),
  filing: document.getElementById("tax-filing"),
  salesTitle: document.getElementById("tax-sales-title"),
  salesCount: document.getElementById("tax-sales-count"),
  salesWrap: document.getElementById("tax-sales-wrap"),
  salesBody: document.querySelector("#tax-sales-table tbody"),
  salesEmpty: document.getElementById("tax-sales-empty"),
};

const won = (value) => `₩${Math.round(value).toLocaleString("ko-KR")}`;
const signedWon = (value) =>
  `${value >= 0 ? "+" : "−"}₩${Math.abs(Math.round(value)).toLocaleString("ko-KR")}`;
const shares = (value) => Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 8 });
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

let transactions = [];
let costMethod = COST_METHOD.FIFO;
let selectedYear = new Date().getFullYear();

const currentYear = () => new Date().getFullYear();

/** 국내주식 손익은 "올해" 금액 하나만 입력받으므로 올해 계산에만 넣는다. */
function domesticGainFor(year) {
  return year === currentYear() ? Number(localStorage.getItem(DOMESTIC_GAIN_KEY)) || 0 : 0;
}

function loadDomesticAmounts() {
  try {
    const raw = JSON.parse(localStorage.getItem(DOMESTIC_AMOUNTS_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return null;
    return { proceeds: Number(raw.proceeds) || 0, cost: Number(raw.cost) || 0 };
  } catch {
    return null;
  }
}

function saveDomesticAmounts() {
  if (!el.domesticProceeds.value && !el.domesticCost.value) {
    localStorage.removeItem(DOMESTIC_AMOUNTS_KEY);
    localStorage.setItem(DOMESTIC_GAIN_KEY, "0");
    return;
  }
  const amounts = {
    proceeds: Math.trunc(Number(el.domesticProceeds.value) || 0),
    cost: Math.trunc(Number(el.domesticCost.value) || 0),
  };
  localStorage.setItem(DOMESTIC_AMOUNTS_KEY, JSON.stringify(amounts));
  localStorage.setItem(DOMESTIC_GAIN_KEY, String(domesticGain(amounts)));
}

function availableYears() {
  const { sales } = replay(transactions, costMethod);
  const years = new Set([currentYear(), ...sales.map((sale) => Number(sale.date.slice(0, 4)))]);
  return [...years].sort((a, b) => b - a);
}

function renderYearOptions() {
  const years = availableYears();
  if (!years.includes(selectedYear)) selectedYear = currentYear();
  el.year.innerHTML = years
    .map((year) => `<option value="${year}">${year}년 귀속${year === currentYear() ? " (올해)" : ""}</option>`)
    .join("");
  el.year.value = String(selectedYear);
}

function breakdownHtml(tax) {
  const baseRows = isMixedRate(tax)
    ? tax.byRate
        .map(
          (bucket) => `
        <div><dt>과세표준 <em>${rateLabel(bucket.ratePercent)} · 소득세 ${won(bucket.incomeTaxKrw)}</em></dt>
          <dd>${won(bucket.taxableBaseKrw)}</dd></div>`
        )
        .join("")
    : `<div><dt>과세표준</dt><dd>${won(tax.taxableBaseKrw)}</dd></div>`;

  return `
    <div><dt>양도소득금액 <em>양도차익·차손 통산</em></dt><dd>${signedWon(tax.totalGainKrw)}</dd></div>
    <div><dt>기본공제 <em>연 250만원, 먼저 판 매도부터 차감</em></dt><dd>−${won(tax.deductionKrw)}</dd></div>
    ${baseRows}
    <div><dt>소득세 <em>${isMixedRate(tax) ? "세율별 합계" : "20%"}</em></dt><dd>${won(tax.incomeTaxKrw)}</dd></div>
    <div><dt>지방소득세 <em>소득세의 10%</em></dt><dd>${won(tax.localTaxKrw)}</dd></div>
    <div class="is-total"><dt>예상세액</dt><dd>${won(tax.totalTaxKrw)}</dd></div>`;
}

function filingHtml(year, tax) {
  const deadlineYear = year + 1;
  const installment =
    tax.incomeTaxKrw > INSTALLMENT_THRESHOLD_KRW
      ? `<li>납부할 소득세가 1천만원을 넘으면 일부를 납부기한이 지난 후 2개월 안에 나눠 낼 수
           있습니다(소득세법 제112조).</li>`
      : "";

  return `
    <h3>${year}년 귀속분 신고 안내</h3>
    <ul>
      <li><strong>${deadlineYear}년 5월 1일 ~ 5월 31일</strong>에 주소지 관할 세무서에 확정신고하고
        납부합니다(소득세법 제110조). 홈택스에서 신고할 수 있습니다.</li>
      <li>해외주식은 예정신고 대상이 아니므로 확정신고 때 한 번에 신고합니다(제105조 제1항).</li>
      <li>과세표준이 없거나 손실이 난 경우에도 확정신고 규정이 적용됩니다(제110조 제2항).</li>
      <li>지방소득세는 소득세 신고기한에 2개월을 더한 <strong>${deadlineYear}년 7월 31일</strong>까지
        납세지 관할 지방자치단체에 따로 신고·납부합니다(지방세법 제103조의7 제1항).</li>
      ${installment}
    </ul>
    <p class="hint">실제 신고 전 증권사 양도소득 계산 자료와 금액을 맞춰보고, 세무전문가의 확인을 받으세요.</p>`;
}

function salesRowHtml(sale, smeTickers) {
  const gainClass = sale.gainKrw >= 0 ? "gain-up" : "gain-down";
  return `
    <tr>
      <td>${sale.tradeDate}</td>
      <td>${sale.date}</td>
      <td class="ticker">${escapeHtml(sale.ticker)}</td>
      <td class="num">${shares(sale.quantity)}</td>
      <td class="num">${won(sale.proceedsKrw)}</td>
      <td class="num">${won(sale.costKrw)}</td>
      <td class="num ${gainClass}">${signedWon(sale.gainKrw)}</td>
      <td class="center">${smeTickers.includes(sale.ticker) ? "10% 중소기업" : "20%"}</td>
    </tr>`;
}

function renderDomestic(year, isCurrent) {
  const amounts = loadDomesticAmounts();
  const gain = Number(localStorage.getItem(DOMESTIC_GAIN_KEY)) || 0;

  el.domesticProceeds.disabled = !isCurrent;
  el.domesticCost.disabled = !isCurrent;
  el.domesticGain.textContent =
    gain === 0 && !amounts ? "—" : `${signedWon(gain)}${gain < 0 ? " (양도차손)" : ""}`;

  const notes = [];
  if (!isCurrent) {
    notes.push(`국내주식은 올해 금액만 입력받아 ${year}년 계산에는 넣지 않았습니다.`);
  } else if (!amounts && gain !== 0) {
    notes.push(
      `예전에 양도차익 ${signedWon(gain)}을 직접 입력해 두었습니다. 양도가액과 취득가액을 넣으면 그 값으로 바뀝니다.`
    );
  }
  el.domesticYearNote.hidden = notes.length === 0;
  el.domesticYearNote.textContent = notes.join(" ");

  // 국내주식은 대주주·보유기간·중소기업 여부에 따라 세율이 다르다. 20%가 아닌 물량이 섞이면
  // 과세표준 x 22%로 떨어지지 않으므로 통산 효과만 믿고 세액을 그대로 쓰면 안 된다.
  el.domesticWarning.hidden = !isCurrent || gain === 0;
  el.domesticWarning.textContent =
    "국내주식분 세율이 20%가 아니면(대주주 1년 미만 보유 30%, 대주주 과세표준 3억원 초과분 25%, " +
    "소액주주의 중소기업 주식 10% 등) 합산 세액은 참고용입니다. 이 도구는 국내주식 양도차익을 " +
    "20% 물량으로 보고 통산과 기본공제만 반영합니다.";
}

function render() {
  renderYearOptions();
  const year = selectedYear;
  const isCurrent = year === currentYear();
  const domestic = domesticGainFor(year);
  const smeTickers = loadSmeTickers();

  const { tax, overseasGainKrw, yearSales } = annualSummary(
    transactions,
    year,
    costMethod,
    domestic,
    smeTickers
  );

  el.gain.textContent = tax.totalGainKrw === 0 && !yearSales.length ? "—" : signedWon(tax.totalGainKrw);
  el.gainNote.textContent =
    domestic !== 0
      ? `해외 ${signedWon(overseasGainKrw)} + 국내 ${signedWon(domestic)} 통산`
      : `${year}년에 결제된 해외주식 매도 ${yearSales.length}건`;

  el.total.textContent = won(tax.totalTaxKrw);
  el.totalNote.textContent =
    tax.totalTaxKrw > 0
      ? `소득세 ${won(tax.incomeTaxKrw)} + 지방소득세 ${won(tax.localTaxKrw)}`
      : "낼 세금이 없습니다.";

  // 지난 해는 더 실현할 수 없으니 여유분을 보여주지 않는다.
  el.headroomItem.hidden = year < currentYear();
  el.headroomLabel.textContent = isCurrent
    ? TAX_FREE_HEADROOM_LABEL
    : TAX_FREE_HEADROOM_LABEL.replace("올해", `${year}년`);
  el.headroom.textContent = won(
    taxFreeHeadroomKrw(transactions, year, costMethod, domestic, smeTickers)
  );

  el.breakdown.innerHTML = breakdownHtml(tax);
  el.filing.innerHTML = filingHtml(year, tax);
  renderDomestic(year, isCurrent);

  el.salesTitle.textContent = `${year}년 확정 매도 내역`;
  el.salesCount.textContent = yearSales.length ? `${yearSales.length}건` : "";
  el.salesWrap.hidden = yearSales.length === 0;
  el.salesEmpty.hidden = yearSales.length > 0;
  el.salesBody.innerHTML = yearSales.map((sale) => salesRowHtml(sale, smeTickers)).join("");
}

export function refreshYearly(latestTransactions, method = COST_METHOD.FIFO) {
  transactions = latestTransactions;
  costMethod = method;
  render();
}

export function initYearly(initialTransactions, method = COST_METHOD.FIFO) {
  transactions = initialTransactions;
  costMethod = method;

  const amounts = loadDomesticAmounts();
  if (amounts) {
    el.domesticProceeds.value = amounts.proceeds || "";
    el.domesticCost.value = amounts.cost || "";
  }

  [el.domesticProceeds, el.domesticCost].forEach((input) =>
    input.addEventListener("input", () => {
      saveDomesticAmounts();
      render();
    })
  );

  el.year.addEventListener("change", () => {
    selectedYear = Number(el.year.value);
    render();
  });

  render();
}
