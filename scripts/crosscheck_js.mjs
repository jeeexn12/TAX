/** 시나리오별 계산 결과를 JSON으로 출력한다. crosscheck.py가 파이썬 결과와 대조한다. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { annualSummary, calculateTax, simulate } from "../static/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(readFileSync(join(here, "crosscheck_scenarios.json"), "utf-8"));

function taxToObject(tax) {
  return {
    total_gain_krw: tax.totalGainKrw,
    deduction_krw: tax.deductionKrw,
    taxable_base_krw: tax.taxableBaseKrw,
    income_tax_krw: tax.incomeTaxKrw,
    local_tax_krw: tax.localTaxKrw,
    total_tax_krw: tax.totalTaxKrw,
  };
}

function run(scenario) {
  if (scenario.gain_only !== undefined) {
    return { tax: taxToObject(calculateTax(scenario.gain_only)) };
  }

  const { holdings, yearSales, tax } = annualSummary(scenario.transactions, scenario.year);

  const result = {
    holdings: Object.fromEntries(
      [...holdings.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([ticker, h]) => [
          ticker,
          { quantity: h.quantity, total_cost_krw: h.totalCostKrw, avg_cost_krw: h.avgCostKrw },
        ])
    ),
    sales: yearSales.map((s) => ({
      ticker: s.ticker,
      date: s.date,
      quantity: s.quantity,
      proceeds_krw: s.proceedsKrw,
      cost_krw: s.costKrw,
      gain_krw: s.gainKrw,
    })),
    tax: taxToObject(tax),
  };

  if (scenario.virtual_sales) {
    const sim = simulate(scenario.transactions, scenario.virtual_sales, scenario.year);
    result.simulation = {
      before_tax_krw: sim.before.totalTaxKrw,
      after_tax_krw: sim.after.totalTaxKrw,
      additional_tax_krw: sim.additionalTaxKrw,
      simulated_gain_krw: sim.simulatedGainKrw,
    };
  }

  return result;
}

const output = scenarios.map((scenario) => {
  try {
    return { name: scenario.name, ...run(scenario) };
  } catch (err) {
    return { name: scenario.name, error: err.constructor.name };
  }
});

process.stdout.write(JSON.stringify(output, null, 2));
