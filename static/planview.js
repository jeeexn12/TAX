/**
 * 매도 계획 화면. 이름 붙인 계획을 여러 개 두고, 계획마다 팔 줄을 적어 켜고 끄며
 * 세금과 손에 남는 돈을 비교한다. 계산은 plan.js가 하고 여기서는 입력과 표시만 맡는다.
 */

import { COST_METHOD, replay } from "./engine.js";
import {
  activePlan,
  addPlan,
  createPlanItem,
  duplicatePlan,
  evaluatePlan,
  loadPlanBook,
  removePlan,
  renamePlan,
  savePlanBook,
  setActiveItems,
  setActivePlan,
} from "./plan.js";
import { loadSmeTickers } from "./storage.js";

const DOMESTIC_GAIN_KEY = "us-tax:domestic-gain";

const el = {
  planSelect: document.getElementById("plan-select"),
  planName: document.getElementById("plan-name"),
  planNew: document.getElementById("plan-new"),
  planCopy: document.getElementById("plan-copy"),
  planRemove: document.getElementById("plan-remove"),
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
  listTitle: document.getElementById("plan-list-title"),
  count: document.getElementById("plan-count"),
  marginalNote: document.getElementById("plan-marginal-note"),
  result: document.getElementById("plan-result"),
  resultTitle: document.getElementById("plan-result-title"),
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
let book = { activeId: null, plans: [] };
let todayFxRate = null;
const prices = new Map();

const currentItems = () => activePlan(book).items;

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

function renderBook() {
  const plan = activePlan(book);
  el.planSelect.innerHTML = book.plans
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${p.items.length}줄)</option>`
    )
    .join("");
  el.planSelect.value = plan.id;
  // 이름을 고치는 중에는 덮어쓰지 않는다.
  if (document.activeElement !== el.planName) el.planName.value = plan.name;
  el.listTitle.textContent = plan.name;
  el.resultTitle.textContent = `${plan.name}: 켠 줄을 모두 실행하면`;
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
  renderBook();
  renderForm();

  const items = currentItems();
  const result = evaluatePlan(transactions, items, {
    method: settings.costMethod,
    settlementDays: settings.settlementDays,
    domesticGainKrw: Number(localStorage.getItem(DOMESTIC_GAIN_KEY)) || 0,
    smeTickers: loadSmeTickers(),
  });
  const resultById = new Map(result.items.map((item) => [item.id, item]));

  el.tableBody.innerHTML = items.map((item) => rowHtml(item, resultById.get(item.id))).join("");
  el.empty.hidden = items.length > 0;
  el.tableWrap.hidden = items.length === 0;

  const includedCount = items.filter((item) => item.included).length;
  el.marginalNote.hidden = includedCount < 2;
  el.count.textContent = items.length ? `${items.length}줄 중 ${includedCount}줄 포함` : "";

  el.result.hidden = result.years.length === 0;
  el.proceeds.textContent = won(result.totals.proceedsKrw);
  el.tax.textContent = won(result.totals.additionalTaxKrw);
  el.net.textContent = won(result.totals.netCashKrw);
  el.yearsBody.innerHTML = result.years.map(yearRowHtml).join("");
}

function commit(nextBook) {
  book = savePlanBook(nextBook);
  render();
}

const updateItems = (items) => commit(setActiveItems(book, items));

function handleSubmit(event) {
  event.preventDefault();
  const item = createPlanItem({
    ticker: el.ticker.value,
    quantity: el.quantity.value,
    targetPrice: el.price.value,
    saleDate: el.date.value,
    fxRate: el.fx.value,
  });
  updateItems([...currentItems(), item]);
}

/** 표 안 입력은 change(입력을 마쳤을 때)에만 다시 계산한다. 타이핑 중에 다시 그리면 커서가 튄다. */
function handleTableChange(event) {
  const includeId = event.target.dataset.planInclude;
  if (includeId) {
    updateItems(
      currentItems().map((item) =>
        item.id === includeId ? { ...item, included: event.target.checked } : item
      )
    );
    return;
  }

  const fieldName = event.target.dataset.planField;
  const id = event.target.dataset.planId;
  if (!fieldName || !id) return;
  const value = fieldName === "saleDate" ? event.target.value : Number(event.target.value) || 0;
  updateItems(currentItems().map((item) => (item.id === id ? { ...item, [fieldName]: value } : item)));
}

function handleTableClick(event) {
  const deleteId = event.target.dataset.planDelete;
  if (deleteId) updateItems(currentItems().filter((item) => item.id !== deleteId));
}

function focusName() {
  el.planName.focus();
  el.planName.select();
}

function setupBookControls() {
  el.planSelect.addEventListener("change", () => commit(setActivePlan(book, el.planSelect.value)));

  // 입력하는 대로 저장한다. 한글은 조합 중 Enter가 글자 확정에 쓰여서 Enter나 칸을
  // 벗어나는 순간에만 저장하면 이름이 안 바뀐 것처럼 보이는 경우가 생긴다.
  // 표까지 다시 그릴 필요는 없어 계획 선택 영역만 갱신한다.
  el.planName.addEventListener("input", () => {
    book = savePlanBook(renamePlan(book, book.activeId, el.planName.value));
    renderBook();
  });
  // 빈 이름은 받지 않으므로 칸을 벗어나면 저장된 이름으로 되돌려 보여준다.
  el.planName.addEventListener("blur", () => {
    el.planName.value = activePlan(book).name;
  });
  el.planName.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) el.planName.blur();
  });

  el.planNew.addEventListener("click", () => {
    commit(addPlan(book));
    focusName();
  });

  el.planCopy.addEventListener("click", () => {
    commit(duplicatePlan(book, book.activeId));
    focusName();
  });

  el.planRemove.addEventListener("click", () => {
    const plan = activePlan(book);
    const detail = plan.items.length ? ` ${plan.items.length}줄이 함께 지워지고` : "";
    if (!window.confirm(`"${plan.name}" 계획을 삭제할까요?${detail} 되돌릴 수 없습니다.`)) return;
    commit(removePlan(book, plan.id));
  });
}

export function refreshPlan(latestTransactions, latestSettings) {
  transactions = latestTransactions;
  settings = latestSettings;
  // 백업을 불러오면 계획도 바뀌므로 화면에 올 때마다 저장된 것을 다시 읽는다.
  book = loadPlanBook();
  render();
}

export function initPlan(initialTransactions, initialSettings) {
  transactions = initialTransactions;
  settings = initialSettings;
  book = savePlanBook(loadPlanBook());
  el.date.value = today();

  setupBookControls();
  el.form.addEventListener("submit", handleSubmit);
  el.ticker.addEventListener("change", fillDefaults);
  el.tableBody.addEventListener("change", handleTableChange);
  el.tableBody.addEventListener("click", handleTableClick);

  fetchTodayFx();
  render();
}
