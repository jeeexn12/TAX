/**
 * 매도 계획 화면. 팔 계획을 여러 줄 적어두고 줄마다 켜고 끄며 세금과 손에 남는 돈을
 * 비교한다. 계산은 plan.js가 하고 여기서는 입력과 표시만 맡는다.
 */

import { COST_METHOD, replay } from "./engine.js";
import { createPlanItem, evaluatePlan, loadPlan, savePlan } from "./plan.js";
import { loadSmeTickers } from "./storage.js";

const DOMESTIC_GAIN_KEY = "us-tax:domestic-gain";

const el = {
  form: document.getElementById("plan-form"),
  ticker: document.getElementById("plan-ticker"),
  quantity: document.getElementById("plan-quantity"),
  price: document.getElementById("plan-price"),
  date: document.getElementById("plan-date"),
  fx: document.getElementById("plan-fx"),
  add: document.getElementById("plan-add"),
  formNote: document.getElementById("plan-form-note"),
  tableBody: document.querySelector("#plan-table tbody"),
  tableWrap: document.getElementById("plan-table-wrap"),
  empty: document.getElementById("plan-empty"),
  count: document.getElementById("plan-count"),
  marginalNote: document.getElementById("plan-marginal-note"),
  result: document.getElementById("plan-result"),
  proceeds: document.getElementById("plan-proceeds"),
  tax: document.getElementById("plan-tax"),
  net: document.getElementById("plan-net"),
  yearsBody: document.querySelector("#plan-years tbody"),
};

const won = (value) => `₩${Math.round(value).toLocaleString("ko-KR")}`;
const signedWon = (value) =>
  `${value >= 0 ? "+" : "−"}₩${Math.abs(Math.round(value)).toLocaleString("ko-KR")}`;
const shares = (value) => Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 8 });
const today = () => new Date().toISOString().slice(0, 10);
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

let transactions = [];
let settings = { costMethod: COST_METHOD.FIFO, settlementDays: 2 };
let plan = [];
let todayFxRate = null;
const prices = new Map();

function heldHoldings() {
  const { holdings } = replay(transactions, settings.costMethod);
  return [...holdings.values()]
    .filter((holding) => holding.quantity > 0)
    .sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
}

async function fetchTodayFx() {
  try {
    const response = await fetch(`/api/fx?date=${today()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    todayFxRate = data.rate;
    if (!el.fx.value) el.fx.value = data.rate;
  } catch {
    todayFxRate = null;
  }
}

async function fetchPrice(ticker) {
  if (prices.has(ticker)) return prices.get(ticker);
  try {
    const response = await fetch(`/api/price?ticker=${encodeURIComponent(ticker)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    const value = Math.round(data.price_usd * 100) / 100;
    prices.set(ticker, value);
    return value;
  } catch {
    prices.set(ticker, null);
    return null;
  }
}

/** 종목을 고르면 보유수량·현재가·오늘 환율을 미리 채운다. 모두 고쳐 쓸 수 있다. */
async function fillDefaults() {
  const ticker = el.ticker.value;
  const holding = heldHoldings().find((h) => h.ticker === ticker);
  if (!holding) return;

  el.quantity.value = holding.quantity;
  if (!el.date.value) el.date.value = today();
  if (!el.fx.value && todayFxRate) el.fx.value = todayFxRate;

  el.formNote.textContent = `보유 ${shares(holding.quantity)}주 · 현재가 조회 중…`;
  el.formNote.className = "hint";
  const price = await fetchPrice(ticker);
  if (el.ticker.value !== ticker) return;
  if (price === null) {
    el.formNote.textContent = `보유 ${shares(holding.quantity)}주 · 현재가를 가져오지 못했습니다. 목표가를 직접 입력하세요.`;
    el.formNote.className = "hint is-warning";
  } else {
    el.price.value = price;
    el.formNote.textContent = `보유 ${shares(holding.quantity)}주 · 목표가는 현재가 $${price}로 채웠습니다.`;
  }
}

function renderForm() {
  const holdings = heldHoldings();
  const previous = el.ticker.value;
  el.ticker.innerHTML = holdings
    .map((h) => `<option value="${escapeHtml(h.ticker)}">${escapeHtml(h.ticker)}</option>`)
    .join("");

  const hasHoldings = holdings.length > 0;
  [el.ticker, el.quantity, el.price, el.date, el.fx, el.add].forEach(
    (node) => (node.disabled = !hasHoldings)
  );
  if (!hasHoldings) {
    el.formNote.textContent = "보유 중인 종목이 없습니다. 거래입력에서 매수를 먼저 넣어주세요.";
    el.formNote.className = "hint";
    return;
  }

  if (holdings.some((h) => h.ticker === previous)) {
    el.ticker.value = previous;
  } else {
    fillDefaults();
  }
}

function marginalCell(result) {
  if (result.marginalTaxKrw === null) return "—";
  if (result.included) return signedWon(result.marginalTaxKrw);
  return `<span class="muted">켜면 ${signedWon(result.marginalTaxKrw)}</span>`;
}

function rowHtml(item, result) {
  const id = escapeHtml(item.id);
  const field = (name, type, value) =>
    `<input class="cell-input" type="${type}" ${type === "number" ? 'step="any" min="0"' : ""}
       value="${escapeHtml(value)}" data-plan-field="${name}" data-plan-id="${id}" />`;

  const gainClass =
    result.gainKrw === null ? "" : result.gainKrw >= 0 ? "gain-up" : "gain-down";

  return `
    <tr class="${item.included ? "" : "is-excluded"}">
      <td class="center">
        <input type="checkbox" class="plan-include" data-plan-include="${id}"
          aria-label="${escapeHtml(item.ticker)} 계획 포함" ${item.included ? "checked" : ""} />
      </td>
      <td class="ticker">${escapeHtml(item.ticker)}</td>
      <td class="num">${field("quantity", "number", item.quantity)}</td>
      <td class="num">${field("targetPrice", "number", item.targetPrice)}</td>
      <td>
        ${field("saleDate", "date", item.saleDate)}
        ${result.year ? `<small class="muted plan-year">${result.year}년 세금</small>` : ""}
      </td>
      <td class="num">${field("fxRate", "number", item.fxRate)}</td>
      <td class="num">${result.proceedsKrw === null ? "—" : won(result.proceedsKrw)}</td>
      <td class="num ${gainClass}">${result.gainKrw === null ? "—" : signedWon(result.gainKrw)}</td>
      <td class="num">${marginalCell(result)}</td>
      <td class="num">
        <button type="button" class="link-danger" data-plan-delete="${id}">삭제</button>
      </td>
    </tr>
    ${
      result.error
        ? `<tr class="plan-error-row"><td colspan="10">${escapeHtml(item.ticker)}: ${escapeHtml(result.error)}</td></tr>`
        : ""
    }`;
}

function yearRowHtml(year) {
  return `
    <tr>
      <th scope="row">${year.year}년</th>
      <td class="num">${won(year.plannedProceedsKrw)}</td>
      <td class="num">${signedWon(year.after.totalGainKrw)}</td>
      <td class="num">
        <span class="muted">${won(year.before.totalTaxKrw)} →</span>
        <strong>${won(year.after.totalTaxKrw)}</strong>
      </td>
      <td class="num">${signedWon(year.additionalTaxKrw)}</td>
      <td>${year.paymentMonth}</td>
      <td class="num">${won(year.taxFreeHeadroomKrw)}</td>
    </tr>`;
}

function render() {
  renderForm();

  const result = evaluatePlan(transactions, plan, {
    method: settings.costMethod,
    settlementDays: settings.settlementDays,
    domesticGainKrw: Number(localStorage.getItem(DOMESTIC_GAIN_KEY)) || 0,
    smeTickers: loadSmeTickers(),
  });
  const resultById = new Map(result.items.map((item) => [item.id, item]));

  el.tableBody.innerHTML = plan.map((item) => rowHtml(item, resultById.get(item.id))).join("");
  el.empty.hidden = plan.length > 0;
  el.tableWrap.hidden = plan.length === 0;
  el.marginalNote.hidden = plan.filter((item) => item.included).length < 2;

  const includedCount = plan.filter((item) => item.included).length;
  el.count.textContent = plan.length ? `${plan.length}줄 중 ${includedCount}줄 포함` : "";

  el.result.hidden = result.years.length === 0;
  el.proceeds.textContent = won(result.totals.proceedsKrw);
  el.tax.textContent = won(result.totals.additionalTaxKrw);
  el.net.textContent = won(result.totals.netCashKrw);
  el.yearsBody.innerHTML = result.years.map(yearRowHtml).join("");
}

function updatePlan(nextPlan) {
  plan = savePlan(nextPlan);
  render();
}

function handleSubmit(event) {
  event.preventDefault();
  const item = createPlanItem({
    ticker: el.ticker.value,
    quantity: el.quantity.value,
    targetPrice: el.price.value,
    saleDate: el.date.value,
    fxRate: el.fx.value,
  });
  updatePlan([...plan, item]);
}

/** 표 안 입력은 change(입력을 마쳤을 때)에만 다시 계산한다. 타이핑 중에 다시 그리면 커서가 튄다. */
function handleTableChange(event) {
  const includeId = event.target.dataset.planInclude;
  if (includeId) {
    updatePlan(
      plan.map((item) => (item.id === includeId ? { ...item, included: event.target.checked } : item))
    );
    return;
  }

  const fieldName = event.target.dataset.planField;
  const id = event.target.dataset.planId;
  if (!fieldName || !id) return;
  const value = fieldName === "saleDate" ? event.target.value : Number(event.target.value) || 0;
  updatePlan(plan.map((item) => (item.id === id ? { ...item, [fieldName]: value } : item)));
}

function handleTableClick(event) {
  const deleteId = event.target.dataset.planDelete;
  if (deleteId) updatePlan(plan.filter((item) => item.id !== deleteId));
}

export function refreshPlan(latestTransactions, latestSettings) {
  transactions = latestTransactions;
  settings = latestSettings;
  render();
}

export function initPlan(initialTransactions, initialSettings) {
  transactions = initialTransactions;
  settings = initialSettings;
  plan = loadPlan();
  el.date.value = today();

  el.form.addEventListener("submit", handleSubmit);
  el.ticker.addEventListener("change", fillDefaults);
  el.tableBody.addEventListener("change", handleTableChange);
  el.tableBody.addEventListener("click", handleTableClick);

  fetchTodayFx();
  render();
}
