"""Check a BI estimate ledger for arithmetic and structural consistency."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any


def _reject_constant(value: str) -> None:
    """Reject non-standard JSON numeric constants such as NaN and Infinity."""
    raise ValueError(f"non-finite JSON number: {value}")


def validate(data: Any) -> list[str]:
    """Return structural and quantitative errors in an estimate ledger."""
    if not isinstance(data, dict):
        return ["ledger root must be a JSON object"]

    errors: list[str] = []
    references = data.get("references", {})
    if not isinstance(references, dict):
        errors.append("references must be an object keyed by reference ID")
        references = {}

    if "components" not in data:
        errors.append("components is required")
    components = data.get("components", [])
    if not isinstance(components, list):
        errors.append("components must be a list")
        components = []
    elif not components:
        errors.append("components must contain at least one component")

    raw_component_ids = {
        component["id"] for component in components
        if isinstance(component, dict) and isinstance(component.get("id"), str)
    }
    by_component: dict[str, dict[str, Any]] = {}
    valid_hours: dict[str, float] = {}
    ownership_keys: set[str] = set()
    for index, component in enumerate(components):
        where = f"components[{index}]"
        if not isinstance(component, dict):
            errors.append(f"{where} must be an object")
            continue

        component_id = component.get("id")
        if not isinstance(component_id, str) or not component_id.strip():
            errors.append(f"{where}.id must be a non-empty string")
            continue
        if component_id in by_component:
            errors.append(f"duplicate component ID: {component_id}")
        else:
            by_component[component_id] = component

        title = component.get("title")
        if not isinstance(title, str) or not title.strip():
            errors.append(f"{component_id}: title must be a non-empty string")

        owner = component.get("owner")
        if not isinstance(owner, str) or not owner.strip():
            errors.append(f"{component_id}: owner must be a non-empty string")

        ownership_key = component.get("ownership_key")
        if not isinstance(ownership_key, str) or not ownership_key.strip():
            errors.append(f"{component_id}: ownership_key must be a non-empty string")
        elif ownership_key in ownership_keys:
            errors.append(f"duplicate ownership_key: {ownership_key}")
        else:
            ownership_keys.add(ownership_key)

        hours = component.get("hours")
        if isinstance(hours, bool) or not isinstance(hours, (int, float)):
            errors.append(f"{component_id}: hours must be a finite non-negative number")
        else:
            try:
                numeric_hours = float(hours)
                if not math.isfinite(numeric_hours) or hours < 0:
                    errors.append(f"{component_id}: hours must be a finite non-negative number")
                else:
                    valid_hours[component_id] = numeric_hours
            except OverflowError:
                errors.append(f"{component_id}: hours must be a finite non-negative number")

        for field in ("references", "prerequisites"):
            values = component.get(field, [])
            if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
                errors.append(f"{component_id}: {field} must be a list of IDs")
                continue
            if field == "references":
                for reference in values:
                    if reference not in references:
                        errors.append(f"{component_id}: missing reference {reference}")
            else:
                for prerequisite in values:
                    if prerequisite not in raw_component_ids:
                        errors.append(f"{component_id}: missing prerequisite {prerequisite}")

        group = component.get("alternative_group")
        choice = component.get("alternative")
        if (group is None) != (choice is None):
            errors.append(f"{component_id}: alternative_group and alternative must appear together")
        elif group is not None and (
            not isinstance(group, str) or not group.strip()
            or not isinstance(choice, str) or not choice.strip()
        ):
            errors.append(f"{component_id}: alternative group and choice must be non-empty strings")

    if "scenarios" not in data:
        errors.append("scenarios is required")
    scenarios = data.get("scenarios", [])
    if not isinstance(scenarios, list):
        errors.append("scenarios must be a list")
        scenarios = []
    elif not scenarios:
        errors.append("scenarios must contain at least one scenario")

    raw_scenario_ids = {
        scenario["id"] for scenario in scenarios
        if isinstance(scenario, dict) and isinstance(scenario.get("id"), str)
    }
    by_scenario: dict[str, dict[str, Any]] = {}
    for index, scenario in enumerate(scenarios):
        where = f"scenarios[{index}]"
        if not isinstance(scenario, dict):
            errors.append(f"{where} must be an object")
            continue
        scenario_id = scenario.get("id")
        if not isinstance(scenario_id, str) or not scenario_id.strip():
            errors.append(f"{where}.id must be a non-empty string")
            continue
        if scenario_id in by_scenario:
            errors.append(f"duplicate scenario ID: {scenario_id}")
        else:
            by_scenario[scenario_id] = scenario
        label = scenario.get("label")
        if not isinstance(label, str) or not label.strip():
            errors.append(f"{scenario_id}: label must be a non-empty string")
        if "must_retain_discovery" in scenario and not isinstance(
            scenario["must_retain_discovery"], bool
        ):
            errors.append(f"{scenario_id}: must_retain_discovery must be a boolean")
        for field in ("includes", "extends"):
            values = scenario.get(field, [])
            if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
                errors.append(f"{scenario_id}: {field} must be a list of IDs")
                continue
            known = by_component if field == "includes" else by_scenario
            all_ids = raw_component_ids if field == "includes" else raw_scenario_ids
            for value in values:
                if value not in known and value not in all_ids:
                    errors.append(f"{scenario_id}: missing {field[:-1]} {value}")

    effective: dict[str, set[str]] = {}
    visiting: set[str] = set()

    def resolve(scenario_id: str) -> set[str]:
        if scenario_id in effective:
            return effective[scenario_id]
        if scenario_id in visiting:
            errors.append(f"scenario inheritance cycle includes {scenario_id}")
            return set()
        scenario = by_scenario.get(scenario_id)
        if scenario is None:
            return set()
        visiting.add(scenario_id)
        includes = scenario.get("includes", [])
        if not isinstance(includes, list):
            includes = []
        extends = scenario.get("extends", [])
        if not isinstance(extends, list):
            extends = []
        selected = {
            value for value in includes
            if isinstance(value, str) and value in by_component
        }
        for parent in extends:
            if isinstance(parent, str) and parent in by_scenario:
                selected.update(resolve(parent))
        visiting.remove(scenario_id)
        effective[scenario_id] = selected
        return selected

    for scenario_id, scenario in by_scenario.items():
        selected = resolve(scenario_id)
        choices: dict[str, set[str]] = {}
        for component_id in selected:
            component = by_component.get(component_id)
            if component is None:
                continue
            prerequisites = component.get("prerequisites", [])
            if not isinstance(prerequisites, list):
                continue
            for prerequisite in prerequisites:
                if not isinstance(prerequisite, str):
                    continue
                if prerequisite not in selected:
                    errors.append(
                        f"{scenario_id}: {component_id} requires unselected prerequisite {prerequisite}"
                    )
            group = component.get("alternative_group")
            choice = component.get("alternative")
            if isinstance(group, str) and isinstance(choice, str):
                choices.setdefault(group, set()).add(choice)
        for group, alternatives in choices.items():
            if len(alternatives) > 1:
                errors.append(
                    f"{scenario_id}: conflicting alternatives in {group}: {', '.join(sorted(alternatives))}"
                )
        if scenario.get("must_retain_discovery") is True and not any(
            by_component.get(component_id, {}).get("kind") == "discovery"
            for component_id in selected
        ):
            errors.append(f"{scenario_id}: must retain at least one discovery component")
        if not all(component_id in valid_hours for component_id in selected):
            continue
        try:
            total = sum(valid_hours[component_id] for component_id in selected)
            if not math.isfinite(total):
                errors.append(f"{scenario_id}: selected total must be finite")
        except (OverflowError, TypeError, ValueError):
            errors.append(f"{scenario_id}: selected total must be finite")

    return errors


def scenario_total(data: dict[str, Any], scenario_id: str) -> float:
    """Sum component hours selected by a valid scenario and its parents."""
    components = {component["id"]: component for component in data["components"]}
    scenarios = {scenario["id"]: scenario for scenario in data["scenarios"]}
    selected: set[str] = set()

    def add(sid: str) -> None:
        scenario = scenarios[sid]
        selected.update(scenario.get("includes", []))
        for parent in scenario.get("extends", []):
            add(parent)

    add(scenario_id)
    return sum(float(components[component_id]["hours"]) for component_id in selected)


def component_share(hours: float, total: float) -> float:
    """Return the rounded percentage share, including a safe zero-total case."""
    return round((hours / total) * 100, 2) if total else 0.0


def run_self_test() -> None:
    """Exercise ledger validation and arithmetic with synthetic cases."""
    fixture_path = Path(__file__).parents[1] / "templates" / "estimate-data.json"
    data = json.loads(fixture_path.read_text(encoding="utf-8"), parse_constant=_reject_constant)
    assert validate(data) == [], validate(data)
    assert scenario_total(data, "baseline") == 21
    assert scenario_total(data, "no-build") == 21
    assert scenario_total(data, "with-build") == 26
    assert component_share(8, 21) == 38.1
    assert component_share(0, 0) == 0.0

    changed = json.loads(json.dumps(data))
    changed["components"][1]["hours"] = 14
    assert scenario_total(changed, "baseline") == 22
    assert scenario_total(changed, "with-build") == 27

    duplicate_id = json.loads(json.dumps(data))
    duplicate_id["components"].append(dict(duplicate_id["components"][0]))
    assert any("duplicate component ID" in error for error in validate(duplicate_id))

    duplicate_owner = json.loads(json.dumps(data))
    duplicate_owner["components"][1]["ownership_key"] = duplicate_owner["components"][0]["ownership_key"]
    assert any("duplicate ownership_key" in error for error in validate(duplicate_owner))

    missing_ref = json.loads(json.dumps(data))
    missing_ref["components"][0]["references"] = ["UNKNOWN"]
    assert any("missing reference" in error for error in validate(missing_ref))

    missing_prerequisite = json.loads(json.dumps(data))
    missing_prerequisite["components"][1]["prerequisites"] = ["UNKNOWN"]
    assert any("missing prerequisite" in error for error in validate(missing_prerequisite))

    invalid_hours = json.loads(json.dumps(data))
    invalid_hours["components"][0]["hours"] = -1
    assert any("finite non-negative" in error for error in validate(invalid_hours))
    nonfinite_hours = json.loads(json.dumps(data))
    nonfinite_hours["components"][0]["hours"] = math.inf
    assert any("finite non-negative" in error for error in validate(nonfinite_hours))

    conflicting = json.loads(json.dumps(data))
    conflicting["scenarios"].append(
        {
            "id": "invalid-combined",
            "label": "Invalid alternatives combined",
            "includes": ["OPT-01", "OPT-02"],
            "extends": ["baseline"],
        }
    )
    assert any("conflicting alternatives" in error for error in validate(conflicting))

    no_discovery = json.loads(json.dumps(data))
    no_discovery["scenarios"][1]["extends"] = []
    no_discovery["scenarios"][1]["includes"] = ["OPT-02"]
    assert any("must retain at least one discovery" in error for error in validate(no_discovery))

    zero_total = json.loads(json.dumps(data))
    for component in zero_total["components"]:
        component["hours"] = 0
    assert validate(zero_total) == [], validate(zero_total)
    assert scenario_total(zero_total, "baseline") == 0
    assert component_share(0, 0) == 0.0

    # Regression case: 415 baseline hours plus an 80-hour conditional build equals 495.
    regression = json.loads(json.dumps(data))
    regression["components"][0]["hours"] = 415
    regression["components"][1]["hours"] = 0
    regression["components"][2]["hours"] = 80
    regression["scenarios"][0]["includes"] = ["DISC-01"]
    assert validate(regression) == [], validate(regression)
    assert scenario_total(regression, "baseline") == 415
    assert scenario_total(regression, "no-build") == 415
    assert scenario_total(regression, "with-build") == 495

    cycle = json.loads(json.dumps(data))
    cycle["scenarios"][0]["extends"] = ["no-build"]
    assert any("inheritance cycle" in error for error in validate(cycle))

    unselected_prerequisite = json.loads(json.dumps(data))
    unselected_prerequisite["scenarios"][0]["includes"] = ["DATA-01"]
    assert any("requires unselected prerequisite" in error for error in validate(unselected_prerequisite))

    malformed = json.loads(json.dumps(data))
    malformed["scenarios"][0]["extends"] = [{"bad": "id"}]
    malformed["scenarios"][1]["includes"] = [None]
    malformed["components"][2]["alternative"] = []
    errors = validate(malformed)
    assert any("extends must be a list of IDs" in error for error in errors)
    assert any("includes must be a list of IDs" in error for error in errors)
    assert any("alternative group and choice" in error for error in errors)

    for bad_prerequisite in ({"object": "entry"}, ["list-entry"], None):
        malformed_prerequisite = json.loads(json.dumps(data))
        malformed_prerequisite["components"][1]["prerequisites"] = [bad_prerequisite]
        errors = validate(malformed_prerequisite)
        assert any("prerequisites must be a list of IDs" in error for error in errors)

    missing_hours = json.loads(json.dumps(data))
    del missing_hours["components"][0]["hours"]
    errors = validate(missing_hours)
    assert any("DISC-01: hours must be a finite non-negative number" in error for error in errors)

    missing_title = json.loads(json.dumps(data))
    del missing_title["components"][0]["title"]
    assert any("title must be a non-empty string" in error for error in validate(missing_title))

    missing = json.loads(json.dumps(data))
    del missing["components"]
    del missing["scenarios"]
    missing_errors = validate(missing)
    assert any("components is required" in error for error in missing_errors)
    assert any("scenarios is required" in error for error in missing_errors)

    print("Self-test passed: totals, shares, zero totals, invalid ledgers, cycle/prerequisite checks, discovery retention, and 415 + 80 = 495 scenario regression.")


def main() -> int:
    """Run self-tests or validate and summarize one JSON ledger."""
    parser = argparse.ArgumentParser(description=__doc__)
    options = parser.add_mutually_exclusive_group(required=True)
    options.add_argument("--self-test", action="store_true")
    options.add_argument("--input", type=Path, help="Path to estimate-data.json")
    args = parser.parse_args()

    if args.self_test:
        run_self_test()
        return 0

    try:
        data = json.loads(args.input.read_text(encoding="utf-8"), parse_constant=_reject_constant)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(f"Cannot read estimate ledger: {error}", file=sys.stderr)
        return 2

    errors = validate(data)
    if errors:
        print("Invalid estimate ledger:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print(f"Valid ledger: {args.input}")
    for scenario in data["scenarios"]:
        scenario_id = scenario["id"]
        total = scenario_total(data, scenario_id)
        print(f"{scenario_id}: {total:g} {data.get('unit', 'hours')}")
        by_id = {component["id"]: component for component in data["components"]}
        by_scenario = {row["id"]: row for row in data["scenarios"]}
        selected: set[str] = set()

        def add(sid: str) -> None:
            selected.update(by_scenario[sid].get("includes", []))
            for parent in by_scenario[sid].get("extends", []):
                add(parent)

        add(scenario_id)
        for component_id in sorted(selected):
            component = by_id[component_id]
            hours = float(component["hours"])
            share = component_share(hours, total)
            print(f"  {component_id}: {hours:g} h ({share:.2f}%) - {component['title']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
