/**
 * 보유현황 화면. 평가와 시뮬레이션에만 쓰는 값이므로, 여기 환율은 거래입력의
 * 확정 고시환율과 성격이 다르다. 화면에서도 "오늘 참고환율"로 구분해 부른다.
 *
 * 종목마다 거래 통화가 다를 수 있어 오늘 참고환율도 보유 종목의 통화별로 따로 둔다.
 */

import { COST_METHOD, replay, sellableInfo, simulate } from "./engine.js";
import {
  DEFAULT_CURRENCY,
  currencyInfo,
  displayRate,
  formatMoney,
  rateUnitLabel,
  sliderRange,
  storedRate,
  tickerCurrency,
} from "./currency.js";
import { loadSettings, settlementDate } from "./settings.js";
import { loadSmeTickers, saveSmeTickers } from "./storage.js";
import { isMixedRate, rateLabel } from "./taxview.js";

const TYPE_LABELS = { buy: "매수", sell: "매도", split: "수량 변동" };
/** 오늘 달러 환율을 못 가져왔을 때 시뮬레이션 슬라이더를 놓을 자리. */
const USD_FALLBACK_RATE = 1350;

const el = {
  todayFxList: document.getElementById("today-fx-list"),
  tableBody: document.querySelector("#holdings-table tbody"),
  empty: document.getElementById("holdings-empty"),
  count: document.getElementById("holdings-count"),
  simPanel: document.getElementById("sim-panel"),
  smeHint: document.getElementById("sme-hint"),
  lotsCard: document.getElementById("lots-card"),
  lotsNote: document.getElementById("lots-note"),
  lotsWrap: document.getElementById("lots-wrap"),
  lotsBody: document.querySelector("#lots-table tbody"),
};

const DOMESTIC_GAIN_KEY = "us-tax:domestic-gain";

const won = (value) => `₩${Math.round(value).toLocaleString("ko-KR")}`;
const signedWon = (value) =>
  `${value >= 0 ? "+" : "−"}₩${Math.abs(Math.round(value)).toLocaleString("ko-KR")}`;
const shares = (value) => Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 8 });
const today = () => new Date().toISOString().slice(0, 10);
const dateKr = (iso) => {
  const [, m, d] = iso.split("-");
  return `${Number(m)}월 ${Number(d)}일`;
};
const roundRate = (value) => Number(Number(value).toFixed(4));
const fxText = (display, code) =>
  `${Number(display).toLocaleString("ko-KR")}원 · ${rateUnitLabel(code)}`;

let transactions = [];
let costMethod = COST_METHOD.FIFO;
let smeTickers = [];
/** 통화별 오늘 참고환율. rate는 1통화당 원화(저장 단위)다. */
const todayFx = new Map();
const prices = new Map();
const sim = new Map();
let expanded = null;

const methodLabel = () => (costMethod === COST_METHOD.FIFO ? "선입선출법" : "이동평균법");
const holdingCurrency = (ticker) => tickerCurrency(transactions, ticker) ?? DEFAULT_CURRENCY;
const todayRate = (code) => todayFx.get(code)?.rate ?? null;

function clampToRange(value, range) {
  const stepped = Math.round(value / range.step) * range.step;
  return roundRate(Math.min(range.max, Math.max(range.min, stepped)));
}

function simStateFor(ticker, holding) {
  if (!sim.has(ticker)) {
    sim.set(ticker, {
      quantity: holding.quantity,
      targetPrice: prices.get(ticker)?.value ?? null,
      saleDate: today(),
      fxRate: null,
    });
  }
  return sim.get(ticker);
}

/**
 * 환율 가정 슬라이더 범위를 정하고 가정값(화면 단위)을 범위 안으로 맞춘다.
 * 달러 외 통화는 오늘 환율이 있어야 범위를 잡을 수 있다.
 */
function prepareSimFx(state, code) {
  const rate = todayRate(code);
  const range = sliderRange(code, rate ? displayRate(rate, code) : null);
  if (!range) return null;
  const start = state.fxRate ?? (rate ? displayRate(rate, code) : USD_FALLBACK_RATE);
  state.fxRate = clampToRange(start, range);
  return range;
}

async function loadTodayFx(code) {
  todayFx.set(code, { rate: null, manual: false, note: "조회 중…", warning: false });
  try {
    const response = await fetch(`/api/fx?date=${today()}&currency=${code}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    todayFx.set(code, {
      rate: data.rate,
      manual: false,
      note: `${dateKr(data.applied_date)} 고시환율 기준 (가장 최근 고시)`,
      warning: false,
    });
  } catch (err) {
    todayFx.set(code, {
      rate: null,
      manual: true,
      note: `${err.message} 환율을 직접 입력해주세요.`,
      warning: true,
    });
  }
  render();
}

async function loadPrice(ticker) {
  const existing = prices.get(ticker);
  if (existing?.manual || existing?.loading) return;

  prices.set(ticker, { ...existing, loading: true });
  try {
    const response = await fetch(`/api/price?ticker=${encodeURIComponent(ticker)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    // 소수점 이하 긴 꼬리는 표시상 잡음이라 호가 단위 수준에서 자른다.
    prices.set(ticker, {
      value: Math.round((data.price ?? data.price_usd) * 100) / 100,
      currency: data.currency ?? null,
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

function renderTodayFx(codes) {
  el.todayFxList.innerHTML = codes
    .map((code) => {
      const entry = todayFx.get(code) ?? { rate: null, manual: false, note: "조회 중…" };
      const value = entry.rate ? roundRate(displayRate(entry.rate, code)) : "";
      return `
        <div class="today-fx-row">
          <div class="summary-head">
            <span class="label">${rateUnitLabel(code)}</span>
            <label class="checkbox">
              <input type="checkbox" data-fx-manual="${code}" ${entry.manual ? "checked" : ""} />
              <span>직접 입력</span>
            </label>
          </div>
          <input type="number" step="any" min="0" value="${value}" data-fx-input="${code}"
            aria-label="${code} 오늘 참고환율" ${entry.manual ? "" : "disabled"} />
          <p class="hint ${entry.warning ? "is-warning" : ""}">${currencyInfo(code).name} · ${entry.note}</p>
        </div>`;
    })
    .join("");
}

/** 선입선출법에서 아직 팔리지 않은 매수 로트. 위에서부터 먼저 팔린 것으로 계산한다. */
function renderLots(holdings) {
  const isFifo = costMethod === COST_METHOD.FIFO;
  el.lotsCard.hidden = holdings.length === 0;
  el.lotsWrap.hidden = !isFifo;
  el.lotsNote.textContent = isFifo
    ? "선입선출법이라 종목마다 위에 있는 로트부터 먼저 팔린 것으로 계산합니다."
    : "이동평균법은 매수 로트를 나누지 않고 평균단가로 계산하므로 로트 목록을 보여주지 않습니다.";
  if (!isFifo) {
    el.lotsBody.innerHTML = "";
    return;
  }
  el.lotsBody.innerHTML = holdings
    .flatMap((holding) =>
      holding.lots
        .filter((lot) => lot.quantity > 1e-9)
        .map(
          (lot) => `
          <tr>
            <td class="ticker">${holding.ticker}</td>
            <td>${lot.date ?? "—"}</td>
            <td class="num">${shares(lot.quantity)}</td>
            <td class="num">${won(lot.costKrw / lot.quantity)}</td>
            <td class="num">${won(lot.costKrw)}</td>
          </tr>`
        )
    )
    .join("");
}

function limitReason(limitedBy) {
  if (!limitedBy) return "";
  const amount =
    limitedBy.type !== "split"
      ? `${shares(limitedBy.quantity)}주`
      : limitedBy.quantity_after != null
        ? `${shares(limitedBy.quantity_before)}주→${shares(limitedBy.quantity_after)}주`
        : Number(limitedBy.added_quantity) > 0
          ? `+${shares(limitedBy.added_quantity)}주`
          : `${shares(limitedBy.ratio)}배`;
  return ` ${limitedBy.date} ${TYPE_LABELS[limitedBy.type]} ${amount} 때문에 제한됩니다.`;
}

function simResultHtml(holding) {
  const code = holdingCurrency(holding.ticker);
  const state = simStateFor(holding.ticker, holding);
  const price = prices.get(holding.ticker);
  const targetPrice = state.targetPrice ?? price?.value ?? 0;
  const quantity = state.quantity;
  const saleDate = state.saleDate;

  if (!saleDate) return '<p class="empty">매도 가정일을 선택해주세요.</p>';
  if (!prepareSimFx(state, code)) {
    return `<p class="sim-warning">오늘 ${rateUnitLabel(code)} 참고환율이 없어 계산할 수 없습니다. 위에서 직접 입력해주세요.</p>`;
  }

  // 귀속 연도와 원장 순서는 결제일로 정한다. 매도 계획과 같은 기준이다.
  const settleDate = settlementDate(saleDate, loadSettings().settlementDays);
  const info = sellableInfo(transactions, holding.ticker, settleDate);
  if (!(quantity > 0) || !(targetPrice >= 0)) {
    return `<p class="empty">매도수량과 목표가를 입력해주세요.</p>`;
  }
  if (quantity > info.max) {
    const headline =
      info.max === 0
        ? `결제일 ${settleDate} 기준으로는 매도할 수 있는 수량이 없습니다.`
        : `결제일 ${settleDate} 기준 최대 ${shares(info.max)}주까지 매도할 수 있습니다.`;
    return `<p class="sim-warning">${headline}${limitReason(info.limitedBy)}</p>`;
  }

  const year = Number(settleDate.slice(0, 4));
  // 국내주식 손익은 "올해" 금액 하나만 입력받으므로 올해로 계산될 때만 넣는다.
  const domesticGainKrw =
    year === new Date().getFullYear() ? Number(localStorage.getItem(DOMESTIC_GAIN_KEY)) || 0 : 0;
  const outcome = simulate(
    transactions,
    [
      {
        id: "__sim__",
        type: "sell",
        ticker: holding.ticker,
        currency: code,
        date: saleDate,
        settlement_date: settleDate,
        quantity,
        price_usd: targetPrice,
        fee_usd: 0,
        fx_rate: storedRate(state.fxRate, code),
      },
    ],
    year,
    costMethod,
    domesticGainKrw,
    smeTickers
  );
  const sale = outcome.simulatedSales[0];
  const isSme = smeTickers.includes(holding.ticker);

  const crossesYear = saleDate.slice(0, 4) !== settleDate.slice(0, 4);
  const yearNote =
    year === new Date().getFullYear() && !crossesYear
      ? ""
      : `<p class="sim-yearnote">${
          crossesYear ? `결제일이 ${settleDate}로 해를 넘겨 ` : ""
        }${year}년 소득으로 계산됩니다. 손익통산과 기본공제 250만원 모두 ${year}년 기준으로 따로 적용됩니다.</p>`;

  return `
    ${yearNote}
    <dl class="sim-result">
      <div><dt>양도가액</dt><dd>${won(sale.proceedsKrw)}</dd></div>
      <div><dt>취득가액 <em>${methodLabel()} 기준 ${shares(quantity)}주 대응분</em></dt><dd>${won(sale.costKrw)}</dd></div>
      <div class="is-strong"><dt>양도차익 <em>${isSme ? "중소기업 10% 세율" : "20% 세율"}</em></dt><dd>${signedWon(sale.gainKrw)}</dd></div>
      <div class="divider"></div>
      <div><dt>${year}년 양도소득금액 <em>확정분 + 이 매도, 차익·차손 통산</em></dt><dd>${signedWon(outcome.after.totalGainKrw)}</dd></div>
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
  const code = holdingCurrency(holding.ticker);
  const state = simStateFor(holding.ticker, holding);
  const range = prepareSimFx(state, code);
  const price = prices.get(holding.ticker);
  const targetPrice = state.targetPrice ?? price?.value ?? 0;

  const fxBlock = range
    ? `
      <div class="sim-fx">
        <div class="sim-fx-head">
          <span class="label">환율 가정</span>
          <strong class="fx-value" id="sim-fx-value">${fxText(state.fxRate, code)}</strong>
        </div>
        <input type="range" min="${range.min}" max="${range.max}" step="${range.step}"
               value="${state.fxRate}" data-sim-field="fxRate" />
        <div class="sim-fx-scale">
          <span>${range.min.toLocaleString("ko-KR")}원</span>
          <span>${range.max.toLocaleString("ko-KR")}원</span>
        </div>
        <p class="hint">매도 시점 환율을 가정해봅니다.</p>
      </div>`
    : "";

  return `
    <div class="sim" data-sim="${holding.ticker}">
      <h3>${holding.ticker} 매도 시뮬레이션</h3>
      <div class="sim-inputs">
        <label>
          <span class="label">매도수량</span>
          <input type="number" step="any" min="0" value="${state.quantity}" data-sim-field="quantity" />
        </label>
        <label>
          <span class="label">목표가 (${code})</span>
          <input type="number" step="any" min="0" value="${targetPrice}" data-sim-field="targetPrice" />
        </label>
        <label>
          <span class="label">매도 가정일</span>
          <input type="date" value="${state.saleDate}" data-sim-field="saleDate" />
        </label>
      </div>
      <p class="hint">보유 ${shares(holding.quantity)}주 · ${
        price?.value ? `현재가 ${formatMoney(price.value, code)}` : "현재가 없음"
      } · 매도 가정일은 결제일이 속한 해로 계산합니다.</p>
      ${fxBlock}
      <div id="sim-result">${simResultHtml(holding)}</div>
    </div>`;
}

function refreshSimResult() {
  const holding = activeHoldings().find((h) => h.ticker === expanded);
  const slot = document.getElementById("sim-result");
  if (!holding || !slot) return;
  slot.innerHTML = simResultHtml(holding);
}

/** 시세 통화가 거래 통화와 다르면 티커나 통화를 잘못 넣은 것이라 평가하지 않는다. */
function isQuoteMismatch(price, code) {
  return Boolean(price?.currency && !price.manual && price.currency !== code);
}

function priceCellHtml(holding, code) {
  const price = prices.get(holding.ticker);
  if (price?.loading) return '<span class="muted">조회 중…</span>';
  if (price?.error && !price.manual) return '<span class="muted">시세 없음</span>';

  const mismatch = isQuoteMismatch(price, code);
  return `<input class="price-input" type="number" step="any" min="0" value="${price?.value ?? ""}"
            data-price="${holding.ticker}" ${price?.manual ? "" : "disabled"} />
          <label class="checkbox inline"><input type="checkbox" data-price-manual="${holding.ticker}"
            ${price?.manual ? "checked" : ""} /><span>직접</span></label>
          <br /><small class="${mismatch ? "is-warning" : "muted"}">${
            mismatch ? `시세는 ${price.currency} 기준, 거래는 ${code}` : code
          }</small>`;
}

function render({ skipFx = false } = {}) {
  const holdings = activeHoldings();
  const codes = [...new Set(holdings.map((holding) => holdingCurrency(holding.ticker)))];
  if (!codes.length) codes.push(DEFAULT_CURRENCY);
  for (const code of codes) {
    if (!todayFx.has(code)) loadTodayFx(code);
  }
  if (!skipFx) renderTodayFx(codes);
  renderLots(holdings);

  // 선입선출법에서는 잔여 로트의 가중평균이라 "이동평균단가"가 아니다.
  document.getElementById("avg-cost-header").textContent =
    costMethod === COST_METHOD.FIFO ? "주당 취득가액" : "이동평균단가";

  el.tableBody.innerHTML = "";
  for (const holding of holdings) {
    const code = holdingCurrency(holding.ticker);
    const price = prices.get(holding.ticker);
    const rate = todayRate(code);
    const hasValue = Boolean(price?.value) && Boolean(rate) && !isQuoteMismatch(price, code);
    const marketKrw = hasValue ? price.value * holding.quantity * rate : null;
    const gain = hasValue ? marketKrw - holding.totalCostKrw : null;
    const isOpen = expanded === holding.ticker;

    const row = document.createElement("tr");
    row.className = isOpen ? "is-open" : "";
    row.innerHTML = `
      <td class="ticker">${holding.ticker}</td>
      <td class="num">${shares(holding.quantity)}</td>
      <td class="num">${won(holding.avgCostKrw)}</td>
      <td class="num">${won(holding.totalCostKrw)}</td>
      <td class="num price-cell">${priceCellHtml(holding, code)}</td>
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
    document.getElementById("sim-fx-value").textContent = fxText(
      state.fxRate,
      holdingCurrency(ticker)
    );
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

function handleTodayFxChange(event) {
  const code = event.target.dataset.fxManual;
  if (!code) return;
  if (event.target.checked) {
    const entry = todayFx.get(code) ?? {};
    todayFx.set(code, { ...entry, manual: true, note: "직접 입력한 환율로 평가합니다.", warning: false });
    render();
  } else {
    loadTodayFx(code);
    render();
  }
}

/** 환율을 입력하는 중에는 환율 칸을 다시 그리지 않는다. 커서가 튀기 때문이다. */
function handleTodayFxInput(event) {
  const code = event.target.dataset.fxInput;
  if (!code) return;
  const entry = todayFx.get(code) ?? {};
  const display = Number(event.target.value);
  todayFx.set(code, { ...entry, rate: display > 0 ? storedRate(display, code) : null });
  render({ skipFx: true });
}

export function refreshHoldings(latestTransactions, method = COST_METHOD.FIFO) {
  transactions = latestTransactions;
  costMethod = method;
  render();
}

export function initHoldings() {
  smeTickers = loadSmeTickers();

  el.todayFxList.addEventListener("change", handleTodayFxChange);
  el.todayFxList.addEventListener("input", handleTodayFxInput);
  el.tableBody.addEventListener("input", handlePriceInput);
  el.tableBody.addEventListener("click", handleTableClick);
  el.simPanel.addEventListener("input", handleSimInput);

  render();
}
