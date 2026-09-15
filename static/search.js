/**
 * 종목 검색 자동완성. 이름(한글·영어)이나 티커를 치면 후보를 보여주고, 고르면 티커를 넣는다.
 *
 * 검색은 서버 /api/search가 한다. 한글 이름표와 야후 검색을 합친 결과가 온다.
 * 티커를 알고 있으면 목록을 무시하고 그대로 입력해도 된다.
 */

const DEBOUNCE_MS = 250;

const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function attachTickerSearch({ input, onSelect }) {
  const list = document.createElement("ul");
  list.className = "ticker-suggest";
  list.id = `${input.id}-suggest`;
  list.hidden = true;
  list.setAttribute("role", "listbox");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("autocomplete", "off");
  input.insertAdjacentElement("afterend", list);

  let items = [];
  let active = -1;
  let timer = null;
  let controller = null;
  let choosing = false;

  function close() {
    list.hidden = true;
    active = -1;
    input.setAttribute("aria-expanded", "false");
  }

  function show(message) {
    if (message) {
      list.innerHTML = `<li class="suggest-empty">${escapeHtml(message)}</li>`;
    } else {
      list.innerHTML = items
        .map((item, index) => {
          const name = item.name_ko || item.name_en || item.ticker;
          const meta = [
            item.ticker,
            item.exchange,
            item.currency,
            item.type === "ETF" ? "ETF" : null,
            item.name_ko && item.name_en ? item.name_en : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return `
            <li role="option" data-index="${index}" id="${list.id}-${index}"
                class="${index === active ? "is-active" : ""}" aria-selected="${index === active}">
              <strong>${escapeHtml(name)}</strong>
              <span class="suggest-meta">${escapeHtml(meta)}</span>
            </li>`;
        })
        .join("");
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (active >= 0) input.setAttribute("aria-activedescendant", `${list.id}-${active}`);
  }

  function choose(index) {
    const item = items[index];
    if (!item) return;
    close();
    // 티커를 넣으면서 input 이벤트를 흘려 다른 화면 로직(검증·통화 맞춤)이 돌게 한다.
    // 이때 다시 검색하지 않도록 표시해둔다.
    choosing = true;
    input.value = item.ticker;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    choosing = false;
    onSelect?.(item);
  }

  async function search(query) {
    controller?.abort();
    controller = new AbortController();
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (input.value.trim() !== query || document.activeElement !== input) return;

      items = data.results;
      active = items.length ? 0 : -1;
      if (items.length) {
        show();
      } else {
        show(
          data.remote_error
            ? "검색 서버에 연결하지 못했습니다. 티커를 직접 입력해주세요."
            : "찾는 종목이 없습니다. 영어 이름이나 티커로 검색해보세요."
        );
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      items = [];
      show("검색하지 못했습니다. 티커를 직접 입력해주세요.");
    }
  }

  input.addEventListener("input", () => {
    if (choosing) return;
    const query = input.value.trim();
    clearTimeout(timer);
    if (!query) {
      items = [];
      close();
      return;
    }
    timer = setTimeout(() => search(query), DEBOUNCE_MS);
  });

  // 한글은 마지막 글자를 조합하는 중에 누른 Enter가 글자 확정에만 쓰여 목록 선택이 안 된다.
  // 그 Enter를 기억해뒀다가 조합이 끝나는 즉시 고른다.
  let enterWhileComposing = false;
  input.addEventListener("compositionend", () => {
    if (!enterWhileComposing) return;
    enterWhileComposing = false;
    setTimeout(() => {
      if (!list.hidden && items.length) choose(active);
    }, 0);
  });

  input.addEventListener("keydown", (event) => {
    if (list.hidden || !items.length) return;
    if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
      enterWhileComposing = true;
      return;
    }
    if (event.key === "ArrowDown") {
      active = (active + 1) % items.length;
      show();
      event.preventDefault();
    } else if (event.key === "ArrowUp") {
      active = (active - 1 + items.length) % items.length;
      show();
      event.preventDefault();
    } else if (event.key === "Enter" && !event.isComposing) {
      // 목록이 열려 있을 때 Enter는 거래 추가가 아니라 후보 선택이다.
      choose(active);
      event.preventDefault();
    } else if (event.key === "Escape") {
      close();
    }
  });

  // 누르는 순간 입력칸 포커스가 빠지면 목록이 먼저 닫혀버리므로 pointerdown에서 고른다.
  list.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const option = event.target.closest("li[data-index]");
    if (option) choose(Number(option.dataset.index));
  });

  input.addEventListener("blur", () => setTimeout(close, 120));
}
