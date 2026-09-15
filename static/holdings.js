/**
 * 보유현황 화면. 평가와 시뮬레이션에만 쓰는 값이므로, 여기 환율은 거래입력의
 * 확정 고시환율과 성격이 다르다. 화면에서도 "오늘 참고환율"로 구분해 부른다.
 */

import { COST_METHOD, annualSummary, replay, sellableInfo, simulate, taxFreeHeadroomKrw } from "./engine.js";
import { loadSmeTickers, saveSmeTickers } from "./storage.js";
import { isMixedRate, rateLabel } from "./taxview.js";

const FX_SLIDER = { min: 1250, max: 1500, step: 10 };
const TYPE_LABELS = { buy: "매수", sell: "매도", split: "주식분할" };

const el = {
  todayFx: document.getElementById("today-fx"),
  todayFxManual: document.getElementById("today-fx-manual"),
  todayFxNote: document.getElementById("today-fx-note"),
  ytdGain: document.getElementById("ytd-gain"),
  ytdTax: document.getElementById("ytd-tax"),
  headroom: document.getElementById("headroom"),
  tableBody: document.querySelector("#holdings-table tbody"),
  empty: document.getElementById("holdings-empty"),
  count: document.getElementById("holdings-count"),
  simPanel: document.getElementById("sim-panel"),
  domesticGain: document.getElementById("domestic-gain"),
  domesticWarning: document.getElementById("domestic-warning"),
  smeHint: document.getElementById("sme-hint"),
};

const DOMESTIC_GAIN_KEY = "us-tax:domestic-gain";

const won = (value) => `₩${Math.round(value).toLocaleString("ko-KR")}`;
const signedWon = (value) =>
  `${value >= 0 ? "+" : "−"}₩${Math.abs(Math.round(value)).toLocaleString("ko-KR")}`;
const usd = (value) =>
  `$${Number(value).toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shares = (value) => Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 8 });
const today = () => new Date().toISOString().slice(0, 10);
const dateKr = (iso) => {
  const [, m, d] = iso.split("-");
  return `${Number(m)}월 ${Number(d)}일`;
};

let transactions = [];
let costMethod = COST_METHOD.FIFO;
let domesticGainKrw = 0;
let smeTickers = [];
let todayFxRate = null;
const prices = new Map();
const sim = new Map();
let expanded = null;

const methodLabel = () => (costMethod === COST_METHOD.FIFO ? "선입선출법" : "이동평균법");

function clampToSlider(rate) {
  const stepped = Math.round(rate / FX_SLIDER.step) * FX_SLIDER.step;
  return Math.min(FX_SLIDER.max, Math.max(FX_SLIDER.min, stepped));
}

function simStateFor(ticker, holding) {
  if (!sim.has(ticker)) {
    sim.set(ticker, {
      quantity: holding.quantity,
      targetPrice: prices.get(ticker)?.value ?? null,
      saleDate: today(),
      fxRate: clampToSlider(todayFxRate ?? 1350),
    });
  }
  return sim.get(ticker);
}

async function loadTodayFx() {
  if (el.todayFxManual.checked) return;
  el.todayFxNote.textContent = "조회 중…";
  try {
    const response = await fetch(`/api/fx?date=${today()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    todayFxRate = data.rate;
    el.todayFx.value = data.rate;
    el.todayFxNote.textContent = `${dateKr(data.applied_date)} 고시환율 기준 (가장 최근 고시)`;
    el.todayFxNote.className = "hint";
  } catch (err) {
    el.todayFxManual.checked = true;
    el.todayFx.disabled = false;
    el.todayFxNote.textContent = `${err.message} 환율을 직접 입력해주세요.`;
    el.todayFxNote.className = "hint is-warning";
  }
}

async function loadPrice(ticker) {
  const existing = prices.get(ticker);
  if (existing?.manual || existing?.loading) return;

  prices.set(ticker, { ...existing, loading: true });
  try {
    const response = await fetch(`/api/price?ticker=${encodeURIComponent(ticker)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    // 미국 주식은 센트 단위로 호가되므로 소수점 이하 긴 꼬리는 표시상 잡음이다.
    prices.set(ticker, {
      value: Math.round(data.price_usd * 100) / 100,
      manual: false,
      loading: false,
      error: null,
    });
  } catch (err) {
    prices.set(ticker, { value: null, manual: false, loading: false, error: err.message });
  }
  render();
}

function activeHoldings() {
  const { holdings } = replay(transactions, costMethod);
  return [...holdings.values()]
    .filter((holding) => holding.quantity > 0)
    .sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
}

function renderSummary() {
  const year = new Date().getFullYear();
  const { tax, overseasGainKrw } = annualSummary(
    transactions,
    year,
    costMethod,
    domesticGainKrw,
    smeTickers
  );

  el.ytdGain.textContent = tax.totalGainKrw === 0 ? "—" : signedWon(tax.totalGainKrw);
  el.ytdTax.textContent =
    domesticGainKrw !== 0
      ? `해외 ${signedWon(overseasGainKrw)} + 국내 ${signedWon(domesticGainKrw)} 통산` +
        (tax.totalTaxKrw > 0 ? ` · 예상세액 ${won(tax.totalTaxKrw)}` : " · 세금 없음")
      : tax.totalTaxKrw > 0
        ? `확정 매도분 예상세액 ${won(tax.totalTaxKrw)}`
        : "확정 매도분에 대한 세금은 없습니다.";
  el.headroom.textContent = won(
    taxFreeHeadroomKrw(transactions, year, costMethod, domesticGainKrw, smeTickers)
  );

  // 국내 대주주 30%, 비상장 중소기업 10% 등 20%가 아닌 물량이 섞이면
  // 과세표준 x 22%로 떨어지지 않는다. 통산 효과만 믿고 세액을 그대로 쓰면 안 된다.
  el.domesticWarning.hidden = domesticGainKrw === 0;
  el.domesticWarning.textContent =
    "국내주식분의 세율이 20%가 아닌 경우(대주주 1년 미만 30%, 비상장 중소기업 10% 등) " +
    "합산 세액은 참고용입니다. 통산과 기본공제 효과만 반영되며, 물량별로 나눠 계산해야 합니다.";
}

function limitReason(limitedBy) {
  if (!limitedBy) return "";
  const amount =
    limitedBy.type === "split"
      ? `${shares(limitedBy.ratio)}배`
      : `${shares(limitedBy.quantity)}주`;
  return ` ${limitedBy.date} ${TYPE_LABELS[limitedBy.type]} ${amount} 때문에 제한됩니다.`;
}

function simResultHtml(holding) {
  const state = simStateFor(holding.ticker, holding);
  const price = prices.get(holding.ticker);
  const targetPrice = state.targetPrice ?? price?.value ?? 0;
  const quantity = state.quantity;
  const saleDate = state.saleDate;

  if (!saleDate) return '<p class="empty">매도 가정일을 선택해주세요.</p>';

  const info = sellableInfo(transactions, holding.ticker, saleDate);
  if (!(quantity > 0) || !(targetPrice >= 0)) {
    return `<p class="empty">매도수량과 목표가를 입력해주세요.</p>`;
  }
  if (quantity > info.max) {
    const headline =
      info.max === 0
        ? `${saleDate} 기준으로는 매도할 수 있는 수량이 없습니다.`
        : `${saleDate} 기준 최대 ${shares(info.max)}주까지 매도할 수 있습니다.`;
    return `<p class="sim-warning">${headline}${limitReason(info.limitedBy)}</p>`;
  }

  const year = Number(saleDate.slice(0, 4));
  const outcome = simulate(
    transactions,
    [
      {
        id: "__sim__",
        type: "sell",
        ticker: holding.ticker,
        date: saleDate,
        quantity,
        price_usd: targetPrice,
        fee_usd: 0,
        fx_rate: state.fxRate,
      },
    ],
    year,
    costMethod,
    domesticGainKrw,
    smeTickers
  );
  const sale = outcome.simulatedSales[0];
  const isSme = smeTickers.includes(holding.ticker);

  const yearNote =
    year === new Date().getFullYear()
      ? ""
      : `<p class="sim-yearnote">${year}년 거래로 계산됩니다. 손익통산과 기본공제 250만원 모두 ${year}년 기준으로 따로 적용됩니다.</p>`;

  return `
    ${yearNote}
    <dl class="sim-result">
      <div><dt>양도가액</dt><dd>${won(sale.proceedsKrw)}</dd></div>
      <div><dt>취득가액 <em>${methodLabel()} 기준 ${shares(quantity)}주 대응분</em></dt><dd>${won(sale.costKrw)}</dd></div>
      <div class="is-strong"><dt>양도차익 <em>${isSme ? "중소기업 10% 세율" : "20% 세율"}</em></dt><dd>${signedWon(sale.gainKrw)}</dd></div>
      <div class="divider"></div>
      <div><dt>${year}년 실현손익 합계 <em>확정분 + 이 매도</em></dt><dd>${signedWon(outcome.after.totalGainKrw)}</dd></div>
      <div><dt>기본공제 <em>먼저 판 매도부터 차감</em></dt><dd>−${won(outcome.after.deductionKrw)}</dd></div>
      ${taxBaseRowsHtml(outcome.after)}
      <div class="is-total"><dt>${year}년 예상세액 <em>${
        isMixedRate(outcome.after)
          ? "세율별 소득세 + 지방소득세(소득세의 10%)"
          : "소득세 20% + 지방소득세 2%"
      }</em></dt><dd>${won(outcome.after.totalTaxKrw)}</dd></div>
      <div class="is-highlight"><dt>이 매도로 늘어나는 세금</dt><dd>${won(outcome.additionalTaxKrw)}</dd></div>
    </dl>`;
}

/** 세율이 하나면 과세표준 한 줄, 섞이면 세율별로 나눠 보여준다. */
function taxBaseRowsHtml(tax) {
  if (!isMixedRate(tax)) {
    return `<div><dt>과세표준</dt><dd>${won(tax.taxableBaseKrw)}</dd></div>`;
  }
  return tax.byRate
    .map(
      (bucket) => `
      <div><dt>과세표준 <em>${rateLabel(bucket.ratePercent)} · 소득세 ${won(bucket.incomeTaxKrw)}</em></dt>
        <dd>${won(bucket.taxableBaseKrw)}</dd></div>`
    )
    .join("");
}

function simulationHtml(holding) {
  const state = simStateFor(holding.ticker, holding);
  const price = prices.get(holding.ticker);
  const targetPrice = state.targetPrice ?? price?.value ?? 0;

  return `
    <div class="sim" data-sim="${holding.ticker}">
      <h3>${holding.ticker} 매도 시뮬레이션</h3>
      <div class="sim-inputs">
        <label>
          <span class="label">매도수량 <em class="label-note">보유 ${shares(holding.quantity)}주</em></span>
          <input type="number" step="any" min="0" value="${state.quantity}" data-sim-field="quantity" />
        </label>
        <label>
          <span class="label">목표가 (USD) <em class="label-note">${
            price?.value ? `현재 ${usd(price.value)}` : "시세 없음"
          }</em></span>
          <input type="number" step="any" min="0" value="${targetPrice}" data-sim-field="targetPrice" />
        </label>
        <label>
          <span class="label">매도 가정일 <em class="label-note">이 날짜가 속한 해로 계산됩니다</em></span>
          <input type="date" value="${state.saleDate}" data-sim-field="saleDate" />
        </label>
      </div>
      <div class="sim-fx">
        <div class="sim-fx-head">
          <span class="label">환율 가정 <em class="label-note">매도 시점 환율을 가정해봅니다</em></span>
          <strong class="fx-value" id="sim-fx-value">${state.fxRate.toLocaleString("ko-KR")}원</strong>
        </div>
        <input type="range" min="${FX_SLIDER.min}" max="${FX_SLIDER.max}" step="${FX_SLIDER.step}"
               value="${state.fxRate}" data-sim-field="fxRate" />
        <div class="sim-fx-scale">
          <span>${FX_SLIDER.min.toLocaleString("ko-KR")}원</span>
          <span>${FX_SLIDER.max.toLocaleString("ko-KR")}원</span>
        </div>
      </div>
      <div id="sim-result">${simResultHtml(holding)}</div>
    </div>`;
}

function refreshSimResult() {
  const holding = activeHoldings().find((h) => h.ticker === expanded);
  const slot = document.getElementById("sim-result");
  if (!holding || !slot) return;
  slot.innerHTML = simResultHtml(holding);
}

function render() {
  const holdings = activeHoldings();
  renderSummary();

  // 선입선출법에서는 잔여 로트의 가중평균이라 "이동평균단가"가 아니다.
  document.getElementById("avg-cost-header").textContent =
    costMethod === COST_METHOD.FIFO ? "주당 취득가액" : "이동평균단가";

  el.tableBody.innerHTML = "";
  for (const holding of holdings) {
    const price = prices.get(holding.ticker);
    const hasValue = Boolean(price?.value) && todayFxRate;
    const marketKrw = hasValue ? price.value * holding.quantity * todayFxRate : null;
    const gain = hasValue ? marketKrw - holding.totalCostKrw : null;
    const isOpen = expanded === holding.ticker;

    const priceCell = price?.loading
      ? '<span class="muted">조회 중…</span>'
      : price?.error
        ? '<span class="muted">시세 없음</span>'
        : `<input class="price-input" type="number" step="any" min="0" value="${price?.value ?? ""}"
             data-price="${holding.ticker}" ${price?.manual ? "" : "disabled"} />
           <label class="checkbox inline"><input type="checkbox" data-price-manual="${holding.ticker}"
             ${price?.manual ? "checked" : ""} /><span>직접</span></label>`;

    const row = document.createElement("tr");
    row.className = isOpen ? "is-open" : "";
    row.innerHTML = `
      <td class="ticker">${holding.ticker}</td>
      <td class="num">${shares(holding.quantity)}</td>
      <td class="num">${won(holding.avgCostKrw)}</td>
      <td class="num">${won(holding.totalCostKrw)}</td>
      <td class="num price-cell">${priceCell}</td>
      <td class="num">${marketKrw === null ? "—" : won(marketKrw)}</td>
      <td class="num ${gain === null ? "" : gain >= 0 ? "gain-up" : "gain-down"}">
        ${
          gain === null
            ? "—"
            : `${signedWon(gain)}<br /><small>${((gain / holding.totalCostKrw) * 100).toFixed(1)}%</small>`
        }
      </td>
      <td class="center">
        <input type="checkbox" class="sme-toggle" data-sme="${holding.ticker}"
          aria-label="${holding.ticker} 중소기업" ${smeTickers.includes(holding.ticker) ? "checked" : ""} />
      </td>
      <td class="num">
        <button type="button" class="link" data-toggle="${holding.ticker}">
          ${isOpen ? "닫기" : "팔아보기"}
        </button>
      </td>`;
    el.tableBody.appendChild(row);
  }

  const openHolding = holdings.find((holding) => holding.ticker === expanded);
  el.simPanel.innerHTML = openHolding ? simulationHtml(openHolding) : "";

  el.empty.hidden = holdings.length > 0;
  el.smeHint.hidden = holdings.length === 0;
  el.count.textContent = holdings.length ? `${holdings.length}종목` : "";

  for (const holding of holdings) {
    if (!prices.has(holding.ticker)) loadPrice(holding.ticker);
  }
}

function handlePriceInput(event) {
  const ticker = event.target.dataset.price;
  if (!ticker) return;
  const existing = prices.get(ticker) ?? {};
  prices.set(ticker, { ...existing, value: Number(event.target.value) || null });
  render();
}

/** 입력 중에는 결과만 갈아끼운다. 패널 전체를 다시 그리면 커서가 튄다. */
function handleSimInput(event) {
  const field = event.target.dataset.simField;
  if (!field) return;

  const ticker = event.target.closest("[data-sim]")?.dataset.sim;
  const state = sim.get(ticker);
  if (!state) return;

  state[field] = field === "saleDate" ? event.target.value : Number(event.target.value);

  if (field === "fxRate") {
    document.getElementById("sim-fx-value").textContent = `${state.fxRate.toLocaleString("ko-KR")}원`;
  }
  refreshSimResult();
}

function handleTableClick(event) {
  const toggle = event.target.dataset.toggle;
  if (toggle) {
    expanded = expanded === toggle ? null : toggle;
    render();
    return;
  }

  const smeTicker = event.target.dataset.sme;
  if (smeTicker) {
    smeTickers = saveSmeTickers(
      event.target.checked
        ? [...smeTickers, smeTicker]
        : smeTickers.filter((ticker) => ticker !== smeTicker)
    );
    render();
    return;
  }

  const manualTicker = event.target.dataset.priceManual;
  if (manualTicker) {
    const existing = prices.get(manualTicker) ?? {};
    const manual = event.target.checked;
    prices.set(manualTicker, { ...existing, manual });
    if (!manual) {
      prices.delete(manualTicker);
      loadPrice(manualTicker);
    }
    render();
  }
}

export function refreshHoldings(latestTransactions, method = COST_METHOD.FIFO) {
  transactions = latestTransactions;
  costMethod = method;
  render();
}

export function initHoldings() {
  smeTickers = loadSmeTickers();
  domesticGainKrw = Number(localStorage.getItem(DOMESTIC_GAIN_KEY)) || 0;
  if (domesticGainKrw) el.domesticGain.value = domesticGainKrw;

  el.domesticGain.addEventListener("input", () => {
    domesticGainKrw = Math.trunc(Number(el.domesticGain.value) || 0);
    localStorage.setItem(DOMESTIC_GAIN_KEY, String(domesticGainKrw));
    render();
  });

  el.todayFxManual.addEventListener("change", () => {
    el.todayFx.disabled = !el.todayFxManual.checked;
    if (el.todayFxManual.checked) {
      el.todayFxNote.textContent = "직접 입력한 환율로 평가합니다.";
      el.todayFxNote.className = "hint";
    } else {
      loadTodayFx().then(render);
    }
  });

  el.todayFx.addEventListener("input", () => {
    todayFxRate = Number(el.todayFx.value) || null;
    render();
  });

  el.tableBody.addEventListener("input", handlePriceInput);
  el.tableBody.addEventListener("click", handleTableClick);
  el.simPanel.addEventListener("input", handleSimInput);

  loadTodayFx().then(render);
}
