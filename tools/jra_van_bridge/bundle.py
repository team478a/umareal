from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path

from .bridge import BridgeValidationError, atomic_write, render_csv, sha256_bytes
from .race_entry_adapter import (
    SDK_RA_RECORD_BYTES,
    SDK_SE_RECORD_BYTES,
    VENUES,
    decode_sdk_entry_groups,
    decode_sdk_ra_records,
    render_entries_csv,
    render_races_csv,
)
from .sdk_adapter import decode_sdk_final_se_groups


BUNDLE_FORMAT_VERSION = "UMAREAL_JRA_VAN_BUNDLE_V1"
VENUE_CODES = {name: code for code, name in VENUES.items()}


def _artifact(kind: str, relative_path: str, content: bytes, row_count: int) -> dict[str, object]:
    return {
        "kind": kind,
        "path": relative_path,
        "rowCount": row_count,
        "sha256": sha256_bytes(content),
    }


def write_import_bundle(
    *,
    ra_source: bytes,
    se_source: bytes,
    structure_path: Path,
    target_date: str,
    output_dir: Path,
    collection_metadata: dict[str, int] | None = None,
    sample_data: bool = False,
) -> dict[str, object]:
    """Build a complete import directory without exposing or persisting raw JV-Data."""
    output = output_dir.resolve()
    if output.exists():
        raise FileExistsError(f"既存ディレクトリを上書きしません: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)

    races = decode_sdk_ra_records(ra_source, structure_path, target_date=target_date)
    entries = decode_sdk_entry_groups(se_source, structure_path, target_date=target_date)
    final_results = decode_sdk_final_se_groups(se_source, structure_path, target_date=target_date)

    race_keys = {
        (race.raceDate, VENUE_CODES[race.venue], race.number)
        for race in races
    }
    entry_keys = set(entries)
    missing_entries = sorted(race_keys - entry_keys)
    unknown_entries = sorted(entry_keys - race_keys)
    if missing_entries or unknown_entries:
        issues: list[str] = []
        if missing_entries:
            issues.append(f"RAに対応するSEがありません: {missing_entries}")
        if unknown_entries:
            issues.append(f"RAに存在しないSEがあります: {unknown_entries}")
        raise BridgeValidationError(issues)

    unknown_results = sorted(set(final_results) - race_keys)
    if unknown_results:
        raise BridgeValidationError([f"RAに存在しない確定結果があります: {unknown_results}"])

    artifacts: list[tuple[str, bytes, dict[str, object]]] = []
    races_bytes = render_races_csv(races)
    artifacts.append(("races.csv", races_bytes, _artifact("RACES", "races.csv", races_bytes, len(races))))

    entry_count = 0
    for key, rows in sorted(entries.items()):
        race_date, venue_code, race_number = key
        relative_path = f"entries/{race_date}-{venue_code}-{race_number:02d}R.csv"
        content = render_entries_csv(rows)
        entry_count += len(rows)
        artifacts.append((relative_path, content, _artifact("ENTRIES", relative_path, content, len(rows))))

    result_rows = [row for key in sorted(final_results) for row in final_results[key]]
    if result_rows:
        results_bytes = render_csv(result_rows)
        artifacts.append(
            ("results.csv", results_bytes, _artifact("RESULTS", "results.csv", results_bytes, len(result_rows)))
        )

    manifest: dict[str, object] = {
        "formatVersion": BUNDLE_FORMAT_VERSION,
        "targetDate": target_date,
        "raceCount": len(races),
        "entryRaceCount": len(entries),
        "entryCount": entry_count,
        "finalizedRaceCount": len(final_results),
        "resultsIncluded": bool(result_rows),
        "sampleData": sample_data,
        "source": {
            "raRecordCount": len(ra_source) // SDK_RA_RECORD_BYTES,
            "raSha256": sha256_bytes(ra_source),
            "seRecordCount": len(se_source) // SDK_SE_RECORD_BYTES,
            "seSha256": sha256_bytes(se_source),
        },
        "files": [metadata for _, _, metadata in artifacts],
    }
    if collection_metadata:
        manifest["collection"] = dict(sorted(collection_metadata.items()))

    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    committed = False
    try:
        for relative_path, content, _ in artifacts:
            atomic_write(staging / relative_path, content, force=False)
        atomic_write(
            staging / "manifest.json",
            (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"),
            force=False,
        )
        os.replace(staging, output)
        committed = True
    finally:
        if not committed and staging.exists():
            shutil.rmtree(staging)
    return manifest
