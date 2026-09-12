/**
 * 거래 기록 저장소. 브라우저 localStorage에만 저장하며 서버로 전송하지 않는다.
 *
 * 저장하는 것은 계산 결과가 아니라 거래 기록이다. 적용환율을 포함한 어떤
 * 항목을 고쳐도 engine.js가 전체를 다시 계산하므로 이후 수치가 함께 갱신된다.
 */

const STORAGE_KEY = "us-tax:transactions";
const SCHEMA_VERSION = 1;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class StorageError extends Error {}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `tx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function loadTransactions() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return parsed.transactions ?? [];
  } catch {
    return [];
  }
}

export function saveTransactions(transactions) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: SCHEMA_VERSION, transactions })
  );
}

export function addTransaction(tx) {
  const saved = { ...tx, id: newId() };
  saveTransactions([...loadTransactions(), saved]);
  return saved;
}

/**
 * 거래의 일부 항목을 수정한다. 적용환율 정정도 이 경로를 쓴다.
 * 수동으로 고친 환율은 fx_manual로 표시해 자동 조회값이 덮어쓰지 않게 한다.
 */
export function updateTransaction(id, fields) {
  const transactions = loadTransactions().map((tx) =>
    tx.id === id ? { ...tx, ...fields } : tx
  );
  saveTransactions(transactions);
  return transactions.find((tx) => tx.id === id) ?? null;
}

export function updateFxRate(id, rate) {
  return updateTransaction(id, {
    fx_rate: Number(rate),
    fx_manual: true,
    fx_applied_date: null,
  });
}

export function deleteTransaction(id) {
  saveTransactions(loadTransactions().filter((tx) => tx.id !== id));
}

export function validateTransactions(raw) {
  const list = Array.isArray(raw) ? raw : raw?.transactions;
  if (!Array.isArray(list)) {
    throw new StorageError("거래 기록을 찾을 수 없는 파일입니다.");
  }

  return list.map((tx, index) => {
    const where = `${index + 1}번째 거래`;

    if (tx.type !== "buy" && tx.type !== "sell" && tx.type !== "split") {
      throw new StorageError(`${where}: 거래 구분이 매수/매도/주식분할이 아닙니다.`);
    }
    if (typeof tx.ticker !== "string" || !tx.ticker.trim()) {
      throw new StorageError(`${where}: 종목 티커가 비어 있습니다.`);
    }
    if (typeof tx.date !== "string" || !DATE_PATTERN.test(tx.date)) {
      throw new StorageError(`${where}: 거래일 형식이 올바르지 않습니다. (예: 2026-01-15)`);
    }

    if (tx.type === "split") {
      if (!(Number(tx.ratio) > 0)) {
        throw new StorageError(`${where}: 분할비율이 올바르지 않습니다. (예: 1주가 4주가 되면 4)`);
      }
      return {
        id: typeof tx.id === "string" && tx.id ? tx.id : newId(),
        type: "split",
        ticker: tx.ticker.trim().toUpperCase(),
        date: tx.date,
        ratio: Number(tx.ratio),
      };
    }

    if (!(Number(tx.quantity) > 0)) {
      throw new StorageError(`${where}: 수량은 0보다 커야 합니다.`);
    }
    if (!(Number(tx.price_usd) >= 0)) {
      throw new StorageError(`${where}: 단가가 올바르지 않습니다.`);
    }
    if (!(Number(tx.fx_rate) > 0)) {
      throw new StorageError(`${where}: 적용환율이 올바르지 않습니다.`);
    }

    return {
      id: typeof tx.id === "string" && tx.id ? tx.id : newId(),
      type: tx.type,
      ticker: tx.ticker.trim().toUpperCase(),
      date: tx.date,
      quantity: Number(tx.quantity),
      price_usd: Number(tx.price_usd),
      fee_usd: Number(tx.fee_usd ?? 0),
      fx_rate: Number(tx.fx_rate),
      fx_applied_date: tx.fx_applied_date ?? null,
      fx_manual: Boolean(tx.fx_manual),
      source: tx.source === "dca" ? "dca" : "manual",
      corrected: Boolean(tx.corrected),
    };
  });
}

export function addTransactions(newTransactions) {
  const saved = newTransactions.map((tx) => ({ ...tx, id: newId() }));
  saveTransactions([...loadTransactions(), ...saved]);
  return saved;
}

export function buildExportPayload(transactions = loadTransactions()) {
  return {
    version: SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    transactions,
  };
}

export function exportFileName(today = new Date()) {
  const stamp = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("");
  return `us-tax-백업-${stamp}.json`;
}

export function downloadBackup() {
  const blob = new Blob([JSON.stringify(buildExportPayload(), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = exportFileName();
  link.click();
  URL.revokeObjectURL(url);
}

export async function restoreBackup(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StorageError("JSON 파일이 아니거나 내용이 손상되었습니다.");
  }
  const transactions = validateTransactions(parsed);
  saveTransactions(transactions);
  return transactions;
}
