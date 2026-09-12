import { EngineError, canAddTransaction, replay, sellableInfo } from "./engine.js";
import {
  DCA_DISCLAIMER,
  buildLots,
  clampRange,
  nextStartDate,
  scheduledDates,
} from "./dca.js";
import { renderCompare } from "./compare.js";
import { initHoldings, refreshHoldings } from "./holdings.js";
import { COST_METHODS, loadSettings, saveSettings, settlementDate } from "./settings.js";
import {
  addTransaction,
  addTransactions,
  deleteTransaction,
  loadTransactions,
  updateTransaction,
} from "./storage.js";

const TYPE_LABELS = { buy: "매수", sell: "매도", split: "주식분할" };

/** 입력을 막되 별도 오류문구는 띄우지 않는 경우(위 안내문이 이미 사유를 설명할 때). */
const BLOCKED_SILENTLY = Symbol("blocked");

const el = {
  form: document.getElementById("tx-form"),
  ticker: document.getElementById("ticker"),
  date: document.getElementById("date"),
  settlementDate: document.getElementById("settlement-date"),
  settlementNote: document.getElementById("settlement-note"),
  settingsSummary: document.getElementById("settings-summary"),
  settlementDays: document.getElementById("settlement-days"),
  methodWarning: document.getElementById("method-warning"),
  ratio: document.getElementById("ratio"),
  quantity: document.getElementById("quantity"),
  price: document.getElementById("price"),
  fee: document.getElementById("fee"),
  fxRate: document.getElementById("fx-rate"),
  fxManual: document.getElementById("fx-manual"),
  fxNote: document.getElementById("fx-note"),
  sellNotice: document.getElementById("sell-notice"),
  formError: document.getElementById("form-error"),
  submit: document.getElementById("submit-btn"),
  tableBody: document.querySelector("#tx-table tbody"),
  tableEmpty: document.getElementById("tx-empty"),
  count: document.getElementById("tx-count"),
  approxNote: document.getElementById("tx-approx-note"),
  dcaAmount: document.getElementById("dca-amount"),
  dcaAmountHint: document.getElementById("dca-amount-hint"),
  dcaStart: document.getElementById("dca-start"),
  dcaEnd: document.getElementById("dca-end"),
  dcaRangeHint: document.getElementById("dca-range-hint"),
  dcaCard: document.getElementById("dca-preview-card"),
  dcaCount: document.getElementById("dca-preview-count"),
  dcaDisclaimer: document.getElementById("dca-disclaimer"),
  dcaNote: document.getElementById("dca-preview-note"),
  dcaBody: document.querySelector("#dca-preview-table tbody"),
  dcaSave: document.getElementById("dca-save"),
  dcaCancel: document.getElementById("dca-cancel"),
};

let transactions = loadTransactions();
let settings = loadSettings();
let fxAppliedDate = null;
let fxRequestToken = 0;
let dcaPreview = null;
let editingId = null;

const number = (value, digits = 0) =>
  Number(value).toLocaleString("ko-KR", { maximumFractionDigits: digits });
const won = (value) => `₩${Math.round(value).toLocaleString("ko-KR")}`;
const today = () => new Date().toISOString().slice(0, 10);

const selectedType = () => document.querySelector('input[name="type"]:checked').value;
const selectedCurrency = () => document.querySelector('input[name="currency"]:checked').value;
const selectedFrequency = () => document.querySelector('input[name="frequency"]:checked').value;

function dateKr(iso) {
  const [, m, d] = iso.split("-");
  return `${Number(m)}월 ${Number(d)}일`;
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      document.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.add("is-active");
      if (tab.dataset.tab === "holdings") refreshHoldings(transactions, settings.costMethod);
      if (tab.dataset.tab === "compare") renderCompare(transactions, settings.costMethod);
    });
  });
}

function applyTypeVisibility() {
  const type = selectedType();
  const show = (selector, visible) =>
    document.querySelectorAll(selector).forEach((node) => (node.hidden = !visible));

  show('[data-only="single"]', type !== "dca");
  show('[data-only="trade"]', type === "buy" || type === "sell");
  show('[data-only="split"]', type === "split");
  show('[data-only="dca"]', type === "dca");

  el.submit.textContent =
    type === "dca" ? "미리보기 만들기" : type === "split" ? "주식분할 추가" : "거래 추가";

  if (type !== "dca") hidePreview();
}

/** 결제일을 체결일 + N영업일로 다시 계산한다. 사용자가 직접 고친 값은 건드리지 않는다. */
function refreshSettlementDate({ force = false } = {}) {
  const type = selectedType();
  if (type !== "buy" && type !== "sell") return;
  if (!el.date.value) return;

  const auto = settlementDate(el.date.value, settings.settlementDays);
  if (force || !el.settlementDate.value || el.settlementDate.dataset.auto !== "false") {
    el.settlementDate.value = auto;
    el.settlementDate.dataset.auto = "true";
  }

  const manual = el.settlementDate.value !== auto;
  const crossesYear = el.settlementDate.value.slice(0, 4) !== el.date.value.slice(0, 4);
  const parts = [
    manual
      ? "직접 지정한 결제일입니다."
      : `체결일 + ${settings.settlementDays}영업일로 계산했습니다.`,
  ];
  if (crossesYear) {
    parts.push(
      `결제일이 ${el.settlementDate.value.slice(0, 4)}년이라 이 거래는 ${el.settlementDate.value.slice(
        0,
        4
      )}년 소득으로 잡힙니다.`
    );
  }
  el.settlementNote.textContent = parts.join(" ");
  el.settlementNote.className = crossesYear ? "hint is-warning" : "hint";
}

/** 환율은 체결일이 아니라 결제일(대금 입출금일) 기준으로 조회한다. */
async function loadFxForDate() {
  const type = selectedType();
  if (type !== "buy" && type !== "sell") return;

  const date = el.settlementDate.value;
  if (!date || el.fxManual.checked) return;

  const token = ++fxRequestToken;
  el.fxNote.textContent = "고시환율 조회 중…";
  el.fxNote.className = "hint";
  el.fxRate.value = "";
  fxAppliedDate = null;

  try {
    const response = await fetch(`/api/fx?date=${date}`);
    const data = await response.json();
    if (token !== fxRequestToken) return;
    if (!response.ok) throw new Error(data.error);

    el.fxRate.value = data.rate;
    fxAppliedDate = data.applied_date;

    if (date > today()) {
      el.fxNote.textContent = `결제일이 아직 오지 않아 고시환율이 없습니다. 최신 고시환율(${dateKr(
        data.applied_date
      )})을 임시로 넣었으니, 결제 후 그날 환율로 정정하세요.`;
      el.fxNote.className = "hint is-warning";
    } else {
      el.fxNote.textContent = data.is_fallback
        ? `${data.applied_label} (결제일에는 고시가 없어 직전 영업일 환율을 씁니다)`
        : data.applied_label;
      el.fxNote.className = "hint";
    }
  } catch (err) {
    if (token !== fxRequestToken) return;
    el.fxManual.checked = true;
    el.fxRate.disabled = false;
    el.fxNote.textContent = `${err.message} 환율을 직접 입력해주세요.`;
    el.fxNote.className = "hint is-warning";
  }
  validate();
}

function describeSellable() {
  const ticker = el.ticker.value.trim().toUpperCase();
  // 보유 판정도 결제일 기준이어야 원장 재생 순서와 어긋나지 않는다.
  const date = el.settlementDate.value || el.date.value;
  if (selectedType() !== "sell" || !ticker || !date) return null;
  return sellableInfo(transactions, ticker, date);
}

function updateSellNotice(info) {
  if (!info) {
    el.sellNotice.hidden = true;
    return;
  }

  const limit = info.limitedBy;
  const reason = limit
    ? ` ${limit.date} ${TYPE_LABELS[limit.type]} ${
        limit.type === "split" ? `${number(limit.ratio, 4)}배` : `${number(limit.quantity, 8)}주`
      } 때문에 제한됩니다.`
    : "";

  if (info.max === 0) {
    el.sellNotice.textContent = limit
      ? `이 날짜에는 0주만 매도 가능합니다.${reason}`
      : `${dateKr(el.date.value)} 기준 보유수량이 없습니다.`;
  } else {
    el.sellNotice.textContent = `이 날짜에 최대 ${number(info.max, 8)}주까지 매도 가능합니다.${reason}`;
  }
  el.sellNotice.hidden = false;
}

function buildTransaction() {
  const type = selectedType();
  const base = { type, ticker: el.ticker.value.trim().toUpperCase(), date: el.date.value };

  if (type === "split") return { ...base, ratio: Number(el.ratio.value) };

  return {
    ...base,
    settlement_date: el.settlementDate.value || null,
    quantity: Number(el.quantity.value),
    price_usd: Number(el.price.value),
    fee_usd: Number(el.fee.value || 0),
    fx_rate: Number(el.fxRate.value),
    fx_applied_date: el.fxManual.checked ? null : fxAppliedDate,
    fx_manual: el.fxManual.checked,
    source: "manual",
  };
}

function findError() {
  const type = selectedType();
  if (!el.ticker.value.trim()) return "티커를 입력해주세요.";

  if (type === "dca") {
    if (!(Number(el.dcaAmount.value) > 0)) return "1회 매수금액을 입력해주세요.";
    if (!el.dcaStart.value) return "시작일을 입력해주세요.";
    if (!el.dcaEnd.value) return "종료일을 입력해주세요.";
    if (el.dcaEnd.value < el.dcaStart.value) return "종료일이 시작일보다 빠릅니다.";
    if (el.dcaStart.value > today()) return "시작일이 미래입니다.";
    return null;
  }

  if (!el.date.value) return "체결일을 입력해주세요.";

  if (type === "split") {
    if (!(Number(el.ratio.value) > 0)) return "분할비율은 0보다 커야 합니다.";
    return null;
  }

  if (!el.settlementDate.value) return "결제일을 입력해주세요.";
  if (el.settlementDate.value < el.date.value) return "결제일이 체결일보다 빠릅니다.";
  if (!(Number(el.quantity.value) > 0)) return "수량은 0보다 커야 합니다.";
  if (!(Number(el.price.value) >= 0)) return "단가를 입력해주세요.";
  if (!(Number(el.fxRate.value) > 0)) return "적용환율을 확인해주세요.";

  const check = canAddTransaction(transactions, buildTransaction(), settings.costMethod);
  if (!check.ok) {
    // 매도 초과는 위 안내문이 사유까지 알려주므로 같은 말을 두 번 띄우지 않는다.
    return describeSellable() ? BLOCKED_SILENTLY : check.error;
  }
  return null;
}

function validate() {
  const type = selectedType();
  updateSellNotice(describeSellable());

  const hasEnoughInput =
    el.ticker.value.trim() &&
    (type === "dca"
      ? el.dcaAmount.value && el.dcaStart.value && el.dcaEnd.value
      : el.date.value && (type === "split" ? el.ratio.value : el.quantity.value));

  const error = findError();
  const blocked = Boolean(error);
  const message = error === BLOCKED_SILENTLY ? "" : error;
  const showError = Boolean(message && hasEnoughInput);

  el.formError.textContent = message ?? "";
  el.formError.hidden = !showError;
  el.submit.disabled = blocked;
  el.sellNotice.classList.toggle("is-blocked", blocked && hasEnoughInput && type === "sell");
}

function applyRangeLimit() {
  el.dcaAmountHint.textContent =
    selectedCurrency() === "KRW"
      ? "회차마다 이 금액(원)어치를 매수합니다."
      : "회차마다 이 금액(달러)어치를 매수합니다.";

  const { end, clamped } = clampRange(el.dcaStart.value, el.dcaEnd.value);
  if (clamped) {
    el.dcaEnd.value = end;
    el.dcaRangeHint.textContent = `한 번에 최대 1년까지 생성됩니다. 종료일을 ${end}로 맞췄습니다. 더 긴 기간은 1년 단위로 나눠서 넣어주세요.`;
    el.dcaRangeHint.className = "hint is-warning";
  } else {
    el.dcaRangeHint.textContent = "한 번에 최대 1년까지 생성됩니다.";
    el.dcaRangeHint.className = "hint";
  }
}

function hidePreview() {
  dcaPreview = null;
  el.dcaCard.hidden = true;
}

async function buildPreview() {
  const ticker = el.ticker.value.trim().toUpperCase();
  const amount = Number(el.dcaAmount.value);
  const currency = selectedCurrency();
  const frequency = selectedFrequency();
  const start = el.dcaStart.value;
  const end = el.dcaEnd.value;

  el.submit.disabled = true;
  el.submit.textContent = "조회 중… (최대 1분)";
  el.formError.hidden = true;

  try {
    const response = await fetch(
      `/api/history?ticker=${encodeURIComponent(ticker)}&start=${start}&end=${end}` +
        `&settlement_days=${settings.settlementDays}`
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    const byDate = new Map(data.rows.map((row) => [row.date, row]));
    const picked = scheduledDates({
      start,
      end,
      frequency,
      tradingDates: data.rows.map((row) => row.date),
    });
    const rows = picked.map((d) => byDate.get(d));
    const lots = buildLots({ ticker, currency, amount, rows });

    dcaPreview = { lots, rows, start, end, requested: data.rows.length };
    renderPreview();
  } catch (err) {
    el.formError.textContent = err.message;
    el.formError.hidden = false;
  } finally {
    el.submit.textContent = "미리보기 만들기";
    validate();
  }
}

function renderPreview() {
  const { lots, rows, start, end, requested } = dcaPreview;
  el.dcaDisclaimer.textContent = DCA_DISCLAIMER;

  el.dcaBody.innerHTML = "";
  lots.forEach((lot, i) => {
    const row = document.createElement("tr");
    const crossesYear = lot.settlement_date?.slice(0, 4) !== lot.date.slice(0, 4);
    row.innerHTML = `
      <td>${lot.date}</td>
      <td class="${crossesYear ? "year-cross" : ""}">${lot.settlement_date ?? "—"}</td>
      <td class="num">${number(lot.price_usd, 4)}</td>
      <td class="num">${number(lot.fx_rate, 2)}${
        rows[i].fx_is_fallback ? `<br /><small class="muted">${dateKr(rows[i].fx_applied_date)} 고시</small>` : ""
      }</td>
      <td class="num">${number(lot.quantity, 6)}</td>
      <td class="num">${won(lot.price_usd * lot.quantity * lot.fx_rate)}</td>`;
    el.dcaBody.appendChild(row);
  });

  const totalKrw = lots.reduce((sum, lot) => sum + lot.price_usd * lot.quantity * lot.fx_rate, 0);
  el.dcaCount.textContent = `${lots.length}건 · 합계 ${won(totalKrw)}`;

  const calendarDays = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  const notes = [`${start}~${end} 달력 ${calendarDays}일 중 거래일은 ${requested}일이었습니다.`];
  if (selectedFrequency() === "weekly") {
    notes.push(`매주 기준으로 ${lots.length}회차를 골랐습니다.`);
  }
  notes.push(`환율은 결제일(체결일 + ${settings.settlementDays}영업일) 기준으로 조회했습니다.`);
  const fallbacks = rows.filter((row) => row.fx_is_fallback).length;
  if (fallbacks) {
    notes.push(`${fallbacks}건은 결제일에 고시가 없어 직전 영업일 환율을 적용했습니다.`);
  }
  const yearCrossing = lots.filter(
    (lot) => lot.settlement_date?.slice(0, 4) !== lot.date.slice(0, 4)
  ).length;
  if (yearCrossing) {
    notes.push(`${yearCrossing}건은 결제일이 다음 해로 넘어갑니다.`);
  }
  if (end > today()) notes.push("종료일이 미래라 오늘까지만 생성했습니다.");

  el.dcaNote.textContent = notes.join(" ");
  el.dcaNote.hidden = false;
  el.dcaSave.textContent = `${lots.length}건 저장`;
  el.dcaSave.disabled = lots.length === 0;
  el.dcaCard.hidden = false;
}

function savePreview() {
  const lots = dcaPreview.lots;
  addTransactions(lots);
  transactions = loadTransactions();

  const next = nextStartDate(lots);
  hidePreview();
  el.dcaStart.value = next;
  el.dcaEnd.value = "";
  el.dcaAmount.focus();

  el.formError.className = "notice";
  el.formError.textContent = `${lots.length}건을 저장했습니다. 이어서 넣으실 수 있도록 다음 시작일을 ${next}로 채웠습니다. 종료일만 정하고 다시 미리보기를 만드세요.`;
  el.formError.hidden = false;

  renderTable();
  refreshHoldings(transactions, settings.costMethod);
}

function renderTable() {
  const sorted = [...transactions].sort((a, b) => {
    const left = a.settlement_date || a.date;
    const right = b.settlement_date || b.date;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  el.tableBody.innerHTML = "";
  for (const tx of sorted) {
    el.tableBody.appendChild(tx.id === editingId ? editRow(tx) : readRow(tx));
  }

  el.tableEmpty.hidden = transactions.length > 0;
  el.count.textContent = transactions.length ? `${transactions.length}건` : "";

  const hasDca = transactions.some((tx) => tx.source === "dca" && !tx.corrected);
  el.approxNote.textContent = `자동생성된 로트가 있습니다. ${DCA_DISCLAIMER}`;
  el.approxNote.hidden = !hasDca;
}

function readRow(tx) {
  const row = document.createElement("tr");
  const isSplit = tx.type === "split";
  const badge =
    tx.source === "dca"
      ? `<span class="tag ${tx.corrected ? "tag-fixed" : ""}">${tx.corrected ? "정정됨" : "자동생성"}</span>`
      : "";

  const crossesYear =
    tx.settlement_date && tx.settlement_date.slice(0, 4) !== tx.date.slice(0, 4);

  row.innerHTML = `
    <td>${tx.date}</td>
    <td class="${crossesYear ? "year-cross" : ""}">
      ${isSplit ? "—" : (tx.settlement_date ?? "—")}
      ${crossesYear ? `<br /><small>${tx.settlement_date.slice(0, 4)}년 귀속</small>` : ""}
    </td>
    <td><span class="pill pill-${tx.type}">${TYPE_LABELS[tx.type]}</span>${badge}</td>
    <td class="ticker">${tx.ticker}</td>
    <td class="num">${isSplit ? `${number(tx.ratio, 4)}배` : number(tx.quantity, 8)}</td>
    <td class="num">${isSplit ? "—" : number(tx.price_usd, 4)}</td>
    <td class="num">${isSplit ? "—" : number(tx.fee_usd, 4)}</td>
    <td class="num">${isSplit ? "—" : number(tx.fx_rate, 2) + (tx.fx_manual ? " ✎" : "")}</td>
    <td class="num row-actions">
      ${isSplit ? "" : `<button type="button" class="link" data-edit="${tx.id}">정정</button>`}
      <button type="button" class="link-danger" data-delete="${tx.id}">삭제</button>
    </td>`;
  return row;
}

function editRow(tx) {
  const row = document.createElement("tr");
  row.className = "is-editing";
  row.innerHTML = `
    <td>${tx.date}</td>
    <td><input class="cell-input" type="date" value="${tx.settlement_date ?? ""}" data-field="settlement_date" /></td>
    <td><span class="pill pill-${tx.type}">${TYPE_LABELS[tx.type]}</span></td>
    <td class="ticker">${tx.ticker}</td>
    <td class="num"><input class="cell-input" type="number" step="any" min="0" value="${tx.quantity}" data-field="quantity" /></td>
    <td class="num"><input class="cell-input" type="number" step="any" min="0" value="${tx.price_usd}" data-field="price_usd" /></td>
    <td class="num"><input class="cell-input" type="number" step="any" min="0" value="${tx.fee_usd}" data-field="fee_usd" /></td>
    <td class="num"><input class="cell-input" type="number" step="any" min="0" value="${tx.fx_rate}" data-field="fx_rate" /></td>
    <td class="num row-actions">
      <button type="button" class="link" data-save="${tx.id}">저장</button>
      <button type="button" class="link" data-cancel="1">취소</button>
    </td>`;
  return row;
}

function commitEdit(id) {
  const row = el.tableBody.querySelector("tr.is-editing");
  const fields = {};
  row.querySelectorAll("[data-field]").forEach((input) => {
    fields[input.dataset.field] =
      input.dataset.field === "settlement_date" ? input.value || null : Number(input.value);
  });

  if (!(fields.quantity > 0) || !(fields.fx_rate > 0) || !(fields.price_usd >= 0)) {
    showRowError("수량과 환율은 0보다 커야 하고, 단가는 0 이상이어야 합니다.");
    return;
  }

  const original = transactions.find((tx) => tx.id === id);
  if (fields.settlement_date && fields.settlement_date < original.date) {
    showRowError("결제일이 체결일보다 빠릅니다.");
    return;
  }

  const candidate = transactions.map((tx) => (tx.id === id ? { ...tx, ...fields } : tx));
  try {
    replay(candidate, settings.costMethod);
  } catch (err) {
    if (err instanceof EngineError) {
      showRowError(`이렇게 고치면 이후 거래가 성립하지 않습니다. ${err.message}`);
      return;
    }
    throw err;
  }

  updateTransaction(id, { ...fields, fx_manual: true, corrected: true });
  transactions = loadTransactions();
  editingId = null;
  el.formError.hidden = true;
  renderTable();
  refreshHoldings(transactions, settings.costMethod);
}

function showRowError(message) {
  el.formError.className = "error";
  el.formError.textContent = message;
  el.formError.hidden = false;
}

function handleDelete(id) {
  const remaining = transactions.filter((tx) => tx.id !== id);
  try {
    replay(remaining, settings.costMethod);
  } catch (err) {
    if (err instanceof EngineError) {
      showRowError(`이 거래를 지우면 이후 거래가 성립하지 않습니다. ${err.message}`);
      return;
    }
    throw err;
  }

  deleteTransaction(id);
  transactions = loadTransactions();
  el.formError.hidden = true;
  renderTable();
  refreshHoldings(transactions, settings.costMethod);
  validate();
}

function handleSubmit(event) {
  event.preventDefault();
  if (findError()) {
    validate();
    return;
  }

  el.formError.className = "error";

  if (selectedType() === "dca") {
    buildPreview();
    return;
  }

  addTransaction(buildTransaction());
  transactions = loadTransactions();

  el.quantity.value = "";
  el.price.value = "";
  el.fee.value = "";
  el.ratio.value = "";

  renderTable();
  refreshHoldings(transactions, settings.costMethod);
  validate();
}

function renderSettingsSummary() {
  el.settingsSummary.textContent = `${COST_METHODS[settings.costMethod]} · 결제일 체결일+${
    settings.settlementDays
  }영업일`;
}

function reportedYears() {
  const years = new Set(
    transactions
      .filter((tx) => tx.type === "sell")
      .map((tx) => (tx.settlement_date || tx.date).slice(0, 4))
  );
  return [...years].sort();
}

function setupSettings() {
  document.querySelector(`input[name="cost-method"][value="${settings.costMethod}"]`).checked = true;
  el.settlementDays.value = settings.settlementDays;
  renderSettingsSummary();

  document.querySelectorAll('input[name="cost-method"]').forEach((radio) =>
    radio.addEventListener("change", () => {
      settings = saveSettings({ costMethod: radio.value });
      renderSettingsSummary();

      // 이동평균법은 증권사가 과세연도별로 계속 적용하는 경우에만 쓸 수 있다.
      // 이미 신고를 마친 연도가 있으면 방법을 바꾸는 순간 실제 신고와 어긋난다.
      const years = reportedYears();
      if (years.length) {
        el.methodWarning.textContent = `이미 매도가 확정된 연도(${years.join(
          ", "
        )})가 있습니다. 그 연도를 이미 신고하셨다면 방법을 바꾸면 실제 신고와 어긋날 수 있습니다. 과세연도별로 계속 적용해야 하는 요건도 확인하세요.`;
        el.methodWarning.hidden = false;
      } else {
        el.methodWarning.hidden = true;
      }

      renderTable();
      refreshHoldings(transactions, settings.costMethod);
      renderCompare(transactions, settings.costMethod);
    })
  );

  el.settlementDays.addEventListener("change", () => {
    const days = Math.min(10, Math.max(0, Math.round(Number(el.settlementDays.value) || 0)));
    el.settlementDays.value = days;
    settings = saveSettings({ settlementDays: days });
    renderSettingsSummary();
    refreshSettlementDate({ force: true });
    loadFxForDate();
    hidePreview();
  });
}

function init() {
  setupTabs();
  setupSettings();
  el.date.value = today();
  applyTypeVisibility();
  refreshSettlementDate({ force: true });
  applyRangeLimit();

  document.querySelectorAll('input[name="type"]').forEach((radio) =>
    radio.addEventListener("change", () => {
      applyTypeVisibility();
      refreshSettlementDate();
      loadFxForDate();
      validate();
    })
  );

  document.querySelectorAll('input[name="currency"], input[name="frequency"]').forEach((radio) =>
    radio.addEventListener("change", () => {
      applyRangeLimit();
      hidePreview();
    })
  );

  el.date.addEventListener("change", () => {
    refreshSettlementDate({ force: true });
    loadFxForDate();
    validate();
  });

  el.settlementDate.addEventListener("change", () => {
    el.settlementDate.dataset.auto = "false";
    refreshSettlementDate();
    loadFxForDate();
    validate();
  });

  el.fxManual.addEventListener("change", () => {
    el.fxRate.disabled = !el.fxManual.checked;
    if (el.fxManual.checked) {
      el.fxNote.textContent = "직접 입력한 환율이 적용됩니다.";
      el.fxNote.className = "hint";
      el.fxRate.focus();
    } else {
      loadFxForDate();
    }
    validate();
  });

  [el.ticker, el.quantity, el.price, el.fee, el.ratio, el.fxRate, el.dcaAmount].forEach((input) =>
    input.addEventListener("input", validate)
  );

  [el.dcaStart, el.dcaEnd].forEach((input) =>
    input.addEventListener("change", () => {
      applyRangeLimit();
      hidePreview();
      validate();
    })
  );

  el.tableBody.addEventListener("click", (event) => {
    const { delete: deleteId, edit, save, cancel } = event.target.dataset;
    if (deleteId) handleDelete(deleteId);
    else if (edit) {
      editingId = edit;
      el.formError.hidden = true;
      renderTable();
    } else if (save) commitEdit(save);
    else if (cancel) {
      editingId = null;
      el.formError.hidden = true;
      renderTable();
    }
  });

  el.dcaSave.addEventListener("click", savePreview);
  el.dcaCancel.addEventListener("click", hidePreview);
  el.form.addEventListener("submit", handleSubmit);

  renderTable();
  initHoldings();
  loadFxForDate();
  validate();
}

init();
