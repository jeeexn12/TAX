import { EngineError, canAddTransaction, replay, sellableInfo } from "./engine.js";
import { initHoldings, refreshHoldings } from "./holdings.js";
import { addTransaction, deleteTransaction, loadTransactions } from "./storage.js";

const TYPE_LABELS = { buy: "매수", sell: "매도", split: "주식분할" };

/** 입력을 막되 별도 오류문구는 띄우지 않는 경우(위 안내문이 이미 사유를 설명할 때). */
const BLOCKED_SILENTLY = Symbol("blocked");

const el = {
  form: document.getElementById("tx-form"),
  ticker: document.getElementById("ticker"),
  date: document.getElementById("date"),
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
};

let transactions = loadTransactions();
let fxAppliedDate = null;
let fxRequestToken = 0;

const number = (value, digits = 0) =>
  Number(value).toLocaleString("ko-KR", { maximumFractionDigits: digits });

const selectedType = () => document.querySelector('input[name="type"]:checked').value;

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      document.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.add("is-active");
      if (tab.dataset.tab === "holdings") refreshHoldings(transactions);
    });
  });
}

function applyTypeVisibility() {
  const isSplit = selectedType() === "split";
  document.querySelectorAll('[data-only="trade"]').forEach((node) => (node.hidden = isSplit));
  document.querySelectorAll('[data-only="split"]').forEach((node) => (node.hidden = !isSplit));
  el.submit.textContent = isSplit ? "주식분할 추가" : "거래 추가";
}

async function loadFxForDate() {
  const date = el.date.value;
  if (!date || selectedType() === "split" || el.fxManual.checked) return;

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

    const isFuture = date > new Date().toISOString().slice(0, 10);
    if (isFuture) {
      el.fxNote.textContent = `아직 고시되지 않은 날짜입니다. 최신 고시환율(${date_kr(
        data.applied_date
      )})을 임시로 넣었으니, 실제 매도 후 그날 환율로 정정하세요.`;
      el.fxNote.className = "hint is-warning";
    } else {
      el.fxNote.textContent = data.is_fallback
        ? `${data.applied_label} (거래일에는 고시가 없어 직전 영업일 환율을 씁니다)`
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
  const date = el.date.value;
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
      : `${date_kr(el.date.value)} 기준 보유수량이 없습니다.`;
  } else {
    el.sellNotice.textContent = `이 날짜에 최대 ${number(info.max, 8)}주까지 매도 가능합니다.${reason}`;
  }
  el.sellNotice.hidden = false;
}

function date_kr(iso) {
  const [, m, d] = iso.split("-");
  return `${Number(m)}월 ${Number(d)}일`;
}

function buildTransaction() {
  const type = selectedType();
  const base = {
    type,
    ticker: el.ticker.value.trim().toUpperCase(),
    date: el.date.value,
  };

  if (type === "split") return { ...base, ratio: Number(el.ratio.value) };

  return {
    ...base,
    quantity: Number(el.quantity.value),
    price_usd: Number(el.price.value),
    fee_usd: Number(el.fee.value || 0),
    fx_rate: Number(el.fxRate.value),
    fx_applied_date: el.fxManual.checked ? null : fxAppliedDate,
    fx_manual: el.fxManual.checked,
  };
}

function findError() {
  const type = selectedType();
  if (!el.ticker.value.trim()) return "티커를 입력해주세요.";
  if (!el.date.value) return "거래일을 입력해주세요.";

  if (type === "split") {
    if (!(Number(el.ratio.value) > 0)) return "분할비율은 0보다 커야 합니다.";
    return null;
  }

  if (!(Number(el.quantity.value) > 0)) return "수량은 0보다 커야 합니다.";
  if (!(Number(el.price.value) >= 0)) return "단가를 입력해주세요.";
  if (!(Number(el.fxRate.value) > 0)) return "적용환율을 확인해주세요.";

  const check = canAddTransaction(transactions, buildTransaction());
  if (!check.ok) {
    // 매도 초과는 위 안내문이 사유까지 알려주므로 같은 말을 두 번 띄우지 않는다.
    return describeSellable() ? BLOCKED_SILENTLY : check.error;
  }
  return null;
}

function validate() {
  updateSellNotice(describeSellable());

  const hasEnoughInput =
    el.ticker.value.trim() &&
    el.date.value &&
    (selectedType() === "split" ? el.ratio.value : el.quantity.value);

  const error = findError();
  const blocked = Boolean(error);
  const message = error === BLOCKED_SILENTLY ? "" : error;
  const showError = Boolean(message && hasEnoughInput);

  el.formError.textContent = message ?? "";
  el.formError.hidden = !showError;
  el.submit.disabled = blocked;
  el.sellNotice.classList.toggle("is-blocked", blocked && hasEnoughInput && selectedType() === "sell");
}

function renderTable() {
  const sorted = [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  el.tableBody.innerHTML = "";
  for (const tx of sorted) {
    const row = document.createElement("tr");
    const isSplit = tx.type === "split";

    row.innerHTML = `
      <td>${tx.date}</td>
      <td><span class="pill pill-${tx.type}">${TYPE_LABELS[tx.type]}</span></td>
      <td class="ticker">${tx.ticker}</td>
      <td class="num">${isSplit ? `${number(tx.ratio, 4)}배` : number(tx.quantity, 8)}</td>
      <td class="num">${isSplit ? "—" : number(tx.price_usd, 4)}</td>
      <td class="num">${isSplit ? "—" : number(tx.fee_usd, 4)}</td>
      <td class="num">${isSplit ? "—" : number(tx.fx_rate, 2) + (tx.fx_manual ? " ✎" : "")}</td>
      <td class="num"><button type="button" class="link-danger" data-delete="${tx.id}">삭제</button></td>
    `;
    el.tableBody.appendChild(row);
  }

  el.tableEmpty.hidden = transactions.length > 0;
  el.count.textContent = transactions.length ? `${transactions.length}건` : "";
}

function handleDelete(id) {
  const remaining = transactions.filter((tx) => tx.id !== id);
  try {
    replay(remaining);
  } catch (err) {
    if (err instanceof EngineError) {
      el.formError.textContent = `이 거래를 지우면 이후 거래가 성립하지 않습니다. ${err.message}`;
      el.formError.hidden = false;
      return;
    }
    throw err;
  }

  deleteTransaction(id);
  transactions = loadTransactions();
  el.formError.hidden = true;
  renderTable();
  refreshHoldings(transactions);
  validate();
}

function handleSubmit(event) {
  event.preventDefault();
  if (findError()) {
    validate();
    return;
  }

  addTransaction(buildTransaction());
  transactions = loadTransactions();

  el.quantity.value = "";
  el.price.value = "";
  el.fee.value = "";
  el.ratio.value = "";

  renderTable();
  refreshHoldings(transactions);
  validate();
}

function init() {
  setupTabs();
  el.date.value = new Date().toISOString().slice(0, 10);
  applyTypeVisibility();

  document.querySelectorAll('input[name="type"]').forEach((radio) =>
    radio.addEventListener("change", () => {
      applyTypeVisibility();
      loadFxForDate();
      validate();
    })
  );

  el.date.addEventListener("change", () => {
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

  [el.ticker, el.quantity, el.price, el.fee, el.ratio, el.fxRate].forEach((input) =>
    input.addEventListener("input", validate)
  );

  el.tableBody.addEventListener("click", (event) => {
    const id = event.target.dataset?.delete;
    if (id) handleDelete(id);
  });

  el.form.addEventListener("submit", handleSubmit);

  renderTable();
  initHoldings();
  loadFxForDate();
  validate();
}

init();
