from __future__ import annotations

from pathlib import Path

from .bridge import BridgeValidationError, parse_bridge_csv
from .bundle_rehearsal import validate_import_bundle


COMPARISON_FORMAT_VERSION = "UMAREAL_JRA_VAN_BUNDLE_COMPARISON_V1"


def _artifact_map(report: dict[str, object]) -> dict[str, dict[str, object]]:
    artifacts = report.get("artifacts")
    if not isinstance(artifacts, list):
        raise BridgeValidationError(["bundle診断結果に成果物一覧がありません。"])
    return {
        str(artifact["path"]): artifact
        for artifact in artifacts
        if isinstance(artifact, dict) and "path" in artifact
    }


def _bundle_summary(report: dict[str, object], directory: Path) -> dict[str, object]:
    return {
        "directory": str(directory.resolve()),
        "targetDate": report["targetDate"],
        "manifestSha256": report["manifestSha256"],
        "raceCount": report["raceCount"],
        "entryCount": report["entryCount"],
        "resultsIncluded": report["resultsIncluded"],
        "finalizedRaceCount": report["finalizedRaceCount"],
    }


def _result_keys(directory: Path, report: dict[str, object]) -> set[tuple[str, str, int]]:
    if not bool(report["resultsIncluded"]):
        return set()
    return {row.race_key for row in parse_bridge_csv((directory / "results.csv").read_text(encoding="utf-8"))}


def compare_import_bundles(*, previous_dir: Path, current_dir: Path) -> dict[str, object]:
    """Compare two fully validated bundles without importing or confirming either one."""
    previous = validate_import_bundle(previous_dir)
    current = validate_import_bundle(current_dir)
    issues: list[str] = []
    if previous["targetDate"] != current["targetDate"]:
        issues.append("比較するbundleの対象日が一致しません。")
    if previous["bundleFormatVersion"] != current["bundleFormatVersion"]:
        issues.append("比較するbundleの形式版が一致しません。")
    if previous["sampleData"] != current["sampleData"]:
        issues.append("合成bundleと実データbundleは比較できません。")
    if issues:
        raise BridgeValidationError(issues)

    before = _artifact_map(previous)
    after = _artifact_map(current)
    previous_result_keys = _result_keys(previous_dir, previous)
    current_result_keys = _result_keys(current_dir, current)
    added_result_keys = current_result_keys - previous_result_keys
    removed_result_keys = previous_result_keys - current_result_keys
    changed: list[dict[str, object]] = []
    for path in sorted(set(before) | set(after)):
        old = before.get(path)
        new = after.get(path)
        if old is None:
            changed.append({"path": path, "kind": new["kind"], "change": "ADDED", "previousSha256": None, "currentSha256": new["sha256"]})
        elif new is None:
            changed.append({"path": path, "kind": old["kind"], "change": "REMOVED", "previousSha256": old["sha256"], "currentSha256": None})
        elif old["sha256"] != new["sha256"]:
            changed.append({"path": path, "kind": new["kind"], "change": "MODIFIED", "previousSha256": old["sha256"], "currentSha256": new["sha256"]})

    changed_kinds = {str(item["kind"]) for item in changed}
    results_regressed = bool(removed_result_keys)
    if not changed:
        classification = "UNCHANGED"
        action = "NO_ACTION"
        next_actions = ["成果物に変更はありません。管理画面へ再投入しないでください。"]
    elif results_regressed:
        classification = "REVIEW_REQUIRED"
        action = "MANUAL_REVIEW_REQUIRED"
        next_actions = ["確定結果が前回より減っています。投入せず、JRA-VANの取得状態と公式発表を確認してください。"]
    elif changed_kinds <= {"RESULTS"} and bool(added_result_keys):
        classification = "RESULTS_AVAILABLE"
        action = "PREVIEW_RESULTS"
        next_actions = ["結果管理でresults.csvとmanifest.jsonをプレビューし、公式結果と照合してください。"]
    elif changed_kinds <= {"RESULTS"}:
        classification = "RESULT_CORRECTION_CANDIDATE"
        action = "PREVIEW_RESULT_CORRECTION"
        next_actions = ["結果管理で公式訂正候補としてプレビューし、前回結果との差分を人が照合してください。"]
    else:
        classification = "RACE_DATA_CHANGED"
        action = "PREVIEW_RACE_DATA"
        next_actions = ["開催日一括取込でレース・出走馬差分を確認してください。"]
        if "RESULTS" in changed_kinds or bool(current["resultsIncluded"]):
            next_actions.append("結果も変わっている場合は、開催情報の確認後に結果管理で別途プレビューしてください。")

    return {
        "comparisonFormatVersion": COMPARISON_FORMAT_VERSION,
        "status": "READY" if classification != "REVIEW_REQUIRED" else "REVIEW_REQUIRED",
        "classification": classification,
        "recommendedAction": action,
        "sampleData": current["sampleData"],
        "productionDataVerified": False,
        "productionImportEligible": current["productionImportEligible"],
        "liveConnectionAttempted": False,
        "automaticImportAttempted": False,
        "resultConfirmationRequired": True,
        "manifestChanged": previous["manifestSha256"] != current["manifestSha256"],
        "previous": _bundle_summary(previous, previous_dir),
        "current": _bundle_summary(current, current_dir),
        "changedArtifacts": changed,
        "resultRaceChanges": {
            "addedCount": len(added_result_keys),
            "removedCount": len(removed_result_keys),
        },
        "nextActions": next_actions,
    }
