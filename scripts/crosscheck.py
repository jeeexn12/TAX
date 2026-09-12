"""파이썬 엔진과 자바스크립트 엔진에 같은 입력을 넣고 결과가 일치하는지 대조한다.

    python scripts/crosscheck.py
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from engine import EngineError, annual_summary, calculate_tax, simulate

SCENARIOS = json.loads((ROOT / "scripts" / "crosscheck_scenarios.json").read_text(encoding="utf-8"))
NODE = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"


def tax_to_dict(tax) -> dict:
    return {
        "total_gain_krw": tax.total_gain_krw,
        "deduction_krw": tax.deduction_krw,
        "taxable_base_krw": tax.taxable_base_krw,
        "income_tax_krw": tax.income_tax_krw,
        "local_tax_krw": tax.local_tax_krw,
        "total_tax_krw": tax.total_tax_krw,
    }


def run_python(scenario: dict) -> dict:
    if "gain_only" in scenario:
        return {"tax": tax_to_dict(calculate_tax(scenario["gain_only"]))}

    holdings, sales, tax = annual_summary(scenario["transactions"], scenario["year"])

    result = {
        "holdings": {
            ticker: {
                "quantity": h.quantity,
                "total_cost_krw": h.total_cost_krw,
                "avg_cost_krw": h.avg_cost_krw,
            }
            for ticker, h in sorted(holdings.items())
        },
        "sales": [
            {
                "ticker": s.ticker,
                "date": s.date,
                "quantity": s.quantity,
                "proceeds_krw": s.proceeds_krw,
                "cost_krw": s.cost_krw,
                "gain_krw": s.gain_krw,
            }
            for s in sales
        ],
        "tax": tax_to_dict(tax),
    }

    if "virtual_sales" in scenario:
        sim = simulate(scenario["transactions"], scenario["virtual_sales"], scenario["year"])
        result["simulation"] = {
            "before_tax_krw": sim["before"].total_tax_krw,
            "after_tax_krw": sim["after"].total_tax_krw,
            "additional_tax_krw": sim["additional_tax_krw"],
            "simulated_gain_krw": sim["simulated_gain_krw"],
        }

    return result


def python_results() -> list[dict]:
    output = []
    for scenario in SCENARIOS:
        try:
            output.append({"name": scenario["name"], **run_python(scenario)})
        except EngineError:
            output.append({"name": scenario["name"], "error": "EngineError"})
    return output


def js_results() -> list[dict]:
    completed = subprocess.run(
        [NODE, str(ROOT / "scripts" / "crosscheck_js.mjs")],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return json.loads(completed.stdout)


def diff_paths(a, b, path="") -> list[str]:
    if isinstance(a, dict) and isinstance(b, dict):
        problems = []
        for key in sorted(set(a) | set(b)):
            if key not in a:
                problems.append(f"{path}.{key}: 파이썬에 없음")
            elif key not in b:
                problems.append(f"{path}.{key}: 자바스크립트에 없음")
            else:
                problems.extend(diff_paths(a[key], b[key], f"{path}.{key}"))
        return problems
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return [f"{path}: 개수 불일치 (파이썬 {len(a)}, 자바스크립트 {len(b)})"]
        problems = []
        for i, (x, y) in enumerate(zip(a, b)):
            problems.extend(diff_paths(x, y, f"{path}[{i}]"))
        return problems
    if a != b:
        return [f"{path}: 파이썬 {a!r} != 자바스크립트 {b!r}"]
    return []


if __name__ == "__main__":
    py = python_results()
    js = js_results()

    all_problems = []
    for p, j in zip(py, js):
        problems = diff_paths(p, j)
        mark = "OK  " if not problems else "FAIL"
        print(f"  [{mark}] {p['name']}")
        for problem in problems:
            print(f"         {problem}")
        all_problems.extend(problems)

    print()
    if all_problems:
        print(f"불일치 {len(all_problems)}건 - 파이썬 엔진을 삭제하면 안 됨")
        sys.exit(1)
    print(f"{len(py)}개 시나리오 전부 일치 (모든 수치가 완전히 동일)")
