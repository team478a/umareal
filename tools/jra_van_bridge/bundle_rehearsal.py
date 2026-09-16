from __future__ import annotations

import csv
import io
import json
import re
import tempfile
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path, PurePosixPath
from uuid import UUID

from .bridge import BridgeValidationError, parse_bridge_csv, render_csv, sha256_bytes
from .bundle import BUNDLE_FORMAT_VERSION, write_import_bundle
from .race_entry_adapter import (
    ENTRY_HEADERS,
    RACE_HEADERS,
    EntryCsvRow,
    RaceCsvRow,
    VENUES,
    render_entries_csv,
    render_races_csv,
)


REHEARSAL_FORMAT_VERSION = "UMAREAL_JRA_VAN_REHEARSAL_V1"
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
ENTRY_PATH_PATTERN = re.compile(r"^entries/(\d{4}-\d{2}-\d{2})-(0[1-9]|10)-(0[1-9]|1[0-2])R\.csv$")
ALLOWED_RACE_VALUES = {
    "surface": {"TURF", "DIRT"},
    "direction": {"LEFT", "RIGHT", "STRAIGHT"},
    "going": {"UNKNOWN", "GOOD", "YIELDING", "SOFT", "HEAVY"},
    "status": {"SCHEDULED", "ACTIVE", "DELAYED", "FINISHED", "CANCELLED"},
}
ALLOWED_ENTRY_VALUES = {
    "sex": {"MALE", "FEMALE", "GELDING"},
    "status": {"ACTIVE", "SCRATCHED", "EXCLUDED", "STOPPED"},
}


def _issue(condition: bool, message: str, issues: list[str]) -> None:
    if not condition:
        issues.append(message)


def _integer(value: object, name: str, issues: list[str], *, minimum: int = 0, maximum: int = 100000) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        issues.append(f"manifest.{name}は{minimum}〜{maximum}の整数で指定してください。")
        return 0
    return value


def _csv_dicts(content: bytes, headers: tuple[str, ...], label: str) -> list[dict[str, str]]:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise BridgeValidationError([f"{label}はBOMなしUTF-8で指定してください。"] ) from error
    reader = csv.DictReader(io.StringIO(text, newline=""))
    if tuple(reader.fieldnames or ()) != headers:
        raise BridgeValidationError([f"{label}の見出しが定義と一致しません。"])
    rows = list(reader)
    if not rows:
        raise BridgeValidationError([f"{label}にデータ行がありません。"])
    if any(None in row or any(value is None for value in row.values()) for row in rows):
        raise BridgeValidationError([f"{label}の列数が見出しと一致しません。"])
    return rows


def _parse_races(content: bytes, target_date: str) -> list[RaceCsvRow]:
    issues: list[str] = []
    parsed: list[RaceCsvRow] = []
    for line, row in enumerate(_csv_dicts(content, RACE_HEADERS, "races.csv"), 2):
        try:
            number = int(row["number"])
            distance = int(row["distance"])
            starts_at = datetime.fromisoformat(row["startsAt"])
        except ValueError:
            issues.append(f"races.csv {line}行目の数値または日時が不正です。")
            continue
        _issue(row["raceDate"] == target_date, f"races.csv {line}行目の開催日が対象日と一致しません。", issues)
        _issue(row["venue"] in VENUES.values(), f"races.csv {line}行目の競馬場が中央10場ではありません。", issues)
        _issue(1 <= number <= 12, f"races.csv {line}行目のレース番号が1〜12ではありません。", issues)
        _issue(bool(row["name"].strip()) and bool(row["raceClass"].strip()), f"races.csv {line}行目の名称またはクラスが空です。", issues)
        _issue(100 <= distance <= 10000, f"races.csv {line}行目の距離が不正です。", issues)
        for field, accepted in ALLOWED_RACE_VALUES.items():
            _issue(row[field] in accepted, f"races.csv {line}行目の{field}が不正です。", issues)
        _issue(starts_at.tzinfo is not None, f"races.csv {line}行目の発走時刻にタイムゾーンがありません。", issues)
        _issue(starts_at.utcoffset() == timedelta(hours=9), f"races.csv {line}行目の発走時刻がJSTではありません。", issues)
        parsed.append(RaceCsvRow(**{**row, "number": number, "distance": distance}))
    if issues:
        raise BridgeValidationError(issues)
    if render_races_csv(parsed) != content:
        raise BridgeValidationError(["races.csvが正規順序・LF改行・BOMなしUTF-8ではありません。"])
    return parsed


def _parse_entries(content: bytes, label: str) -> list[EntryCsvRow]:
    issues: list[str] = []
    parsed: list[EntryCsvRow] = []
    for line, row in enumerate(_csv_dicts(content, ENTRY_HEADERS, label), 2):
        try:
            UUID(row["horseId"])
            number, gate, age = int(row["number"]), int(row["gate"]), int(row["age"])
            weight = Decimal(row["carriedWeight"])
            odds = None if row["winOdds"] == "" else Decimal(row["winOdds"])
            popularity = None if row["popularity"] == "" else int(row["popularity"])
        except (ValueError, InvalidOperation):
            issues.append(f"{label} {line}行目のUUIDまたは数値が不正です。")
            continue
        _issue(1 <= number <= 18 and 1 <= gate <= 8, f"{label} {line}行目の馬番または枠番が不正です。", issues)
        _issue(1 <= age <= 20 and Decimal("30") <= weight <= Decimal("80"), f"{label} {line}行目の馬齢または斤量が不正です。", issues)
        _issue(bool(row["horseName"].strip()) and bool(row["jockey"].strip()) and bool(row["trainer"].strip()), f"{label} {line}行目の馬名・騎手・調教師が空です。", issues)
        _issue(row["sex"] in ALLOWED_ENTRY_VALUES["sex"], f"{label} {line}行目の性別が不正です。", issues)
        _issue(row["status"] in ALLOWED_ENTRY_VALUES["status"], f"{label} {line}行目の状態が不正です。", issues)
        _issue(odds is None or odds >= 0, f"{label} {line}行目の単勝オッズが不正です。", issues)
        _issue(popularity is None or 1 <= popularity <= 18, f"{label} {line}行目の人気が不正です。", issues)
        parsed.append(EntryCsvRow(**{**row, "number": number, "gate": gate, "age": age}))
    if issues:
        raise BridgeValidationError(issues)
    if render_entries_csv(parsed) != content:
        raise BridgeValidationError([f"{label}が正規順序・LF改行・BOMなしUTF-8ではありません。"])
    return parsed


def _safe_artifact_path(root: Path, value: object, issues: list[str]) -> tuple[str, Path] | None:
    if not isinstance(value, str) or not value or "\\" in value:
        issues.append("manifest.files.pathが不正です。")
        return None
    pure = PurePosixPath(value)
    if pure.is_absolute() or ".." in pure.parts or str(pure) != value:
        issues.append(f"manifest.files.pathが安全な相対パスではありません: {value}")
        return None
    path = root.joinpath(*pure.parts)
    parent = path.parent
    parent_is_symlink = False
    while parent != root:
        parent_is_symlink = parent_is_symlink or parent.is_symlink()
        parent = parent.parent
    if path.is_symlink() or parent_is_symlink:
        issues.append(f"シンボリックリンクは取込一式に使用できません: {value}")
        return None
    return value, path


def validate_import_bundle(input_dir: Path) -> dict[str, object]:
    root = input_dir.resolve()
    issues: list[str] = []
    if not root.is_dir():
        raise BridgeValidationError([f"一括出力ディレクトリが見つかりません: {root}"])
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise BridgeValidationError(["manifest.jsonがありません。"])
    try:
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BridgeValidationError(["manifest.jsonをBOMなしUTF-8のJSONとして解析できません。"] ) from error
    if not isinstance(manifest, dict):
        raise BridgeValidationError(["manifest.jsonのルートはオブジェクトにしてください。"])
    allowed_keys = {"formatVersion", "targetDate", "raceCount", "entryRaceCount", "entryCount", "finalizedRaceCount", "resultsIncluded", "sampleData", "source", "files", "collection"}
    _issue(set(manifest).issubset(allowed_keys) and allowed_keys - {"collection", "sampleData"} <= set(manifest), "manifest.jsonの項目が定義と一致しません。", issues)
    _issue(manifest.get("formatVersion") == BUNDLE_FORMAT_VERSION, "manifestの形式版が対応していません。", issues)
    target_date = manifest.get("targetDate")
    try:
        normalized_date = date.fromisoformat(target_date).isoformat() if isinstance(target_date, str) else ""
    except ValueError:
        normalized_date = ""
    _issue(normalized_date == target_date, "manifest.targetDateはYYYY-MM-DD形式で指定してください。", issues)
    race_count = _integer(manifest.get("raceCount"), "raceCount", issues, minimum=1, maximum=36)
    entry_race_count = _integer(manifest.get("entryRaceCount"), "entryRaceCount", issues, minimum=1, maximum=36)
    entry_count = _integer(manifest.get("entryCount"), "entryCount", issues, minimum=1, maximum=648)
    finalized_count = _integer(manifest.get("finalizedRaceCount"), "finalizedRaceCount", issues, maximum=36)
    results_included = manifest.get("resultsIncluded")
    _issue(isinstance(results_included, bool), "manifest.resultsIncludedは真偽値で指定してください。", issues)
    sample_data = manifest.get("sampleData", False)
    _issue(isinstance(sample_data, bool), "manifest.sampleDataは真偽値で指定してください。", issues)
    source = manifest.get("source")
    if not isinstance(source, dict) or set(source) != {"raRecordCount", "raSha256", "seRecordCount", "seSha256"}:
        issues.append("manifest.sourceの項目が定義と一致しません。")
    else:
        _integer(source.get("raRecordCount"), "source.raRecordCount", issues, minimum=1)
        _integer(source.get("seRecordCount"), "source.seRecordCount", issues, minimum=1)
        _issue(isinstance(source.get("raSha256"), str) and bool(SHA256_PATTERN.fullmatch(source["raSha256"])), "manifest.source.raSha256が不正です。", issues)
        _issue(isinstance(source.get("seSha256"), str) and bool(SHA256_PATTERN.fullmatch(source["seSha256"])), "manifest.source.seSha256が不正です。", issues)
    collection = manifest.get("collection")
    if collection is not None:
        _issue(isinstance(collection, dict) and all(isinstance(key, str) and isinstance(value, int) and not isinstance(value, bool) and value >= 0 for key, value in collection.items()), "manifest.collectionは0以上の整数を持つオブジェクトにしてください。", issues)
    files = manifest.get("files")
    if not isinstance(files, list) or not 2 <= len(files) <= 38:
        issues.append("manifest.filesは2〜38件で指定してください。")
        files = []
    artifacts: dict[str, tuple[str, bytes, int, str]] = {}
    for index, metadata in enumerate(files):
        if not isinstance(metadata, dict) or set(metadata) != {"kind", "path", "rowCount", "sha256"}:
            issues.append(f"manifest.files[{index}]の項目が定義と一致しません。")
            continue
        kind = metadata.get("kind")
        _issue(kind in {"RACES", "ENTRIES", "RESULTS"}, f"manifest.files[{index}].kindが不正です。", issues)
        safe = _safe_artifact_path(root, metadata.get("path"), issues)
        row_count = _integer(metadata.get("rowCount"), f"files[{index}].rowCount", issues, minimum=1, maximum=648)
        expected_sha = metadata.get("sha256")
        _issue(isinstance(expected_sha, str) and bool(SHA256_PATTERN.fullmatch(expected_sha)), f"manifest.files[{index}].sha256が不正です。", issues)
        if not safe:
            continue
        relative, path = safe
        if relative in artifacts:
            issues.append(f"manifestでファイルが重複しています: {relative}")
            continue
        if not path.is_file():
            issues.append(f"manifest記載ファイルがありません: {relative}")
            continue
        content = path.read_bytes()
        _issue(len(content) <= 100000, f"ファイルが100KBを超えています: {relative}", issues)
        actual_sha = sha256_bytes(content)
        _issue(actual_sha == expected_sha, f"SHA-256がmanifestと一致しません: {relative}", issues)
        artifacts[relative] = (str(kind), content, row_count, actual_sha)
    actual_paths = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and path.name != "manifest.json"
    }
    _issue(actual_paths == set(artifacts), "manifestにないファイル、または不足ファイルがあります。", issues)
    race_files = [path for path, value in artifacts.items() if value[0] == "RACES"]
    entry_files = [path for path, value in artifacts.items() if value[0] == "ENTRIES"]
    result_files = [path for path, value in artifacts.items() if value[0] == "RESULTS"]
    _issue(race_files == ["races.csv"], "RACESはraces.csvを1件だけ指定してください。", issues)
    _issue(len(entry_files) == entry_race_count, "ENTRIESファイル数がentryRaceCountと一致しません。", issues)
    _issue(result_files == (["results.csv"] if results_included else []), "RESULTSとresultsIncludedが一致しません。", issues)
    if issues:
        raise BridgeValidationError(issues)

    races = _parse_races(artifacts["races.csv"][1], str(target_date))
    _issue(len(races) == race_count == entry_race_count, "レース件数がmanifestと一致しません。", issues)
    _issue(len(races) == artifacts["races.csv"][2], "races.csvの行数がmanifestと一致しません。", issues)
    code_by_venue = {venue: code for code, venue in VENUES.items()}
    race_keys = {(race.raceDate, code_by_venue[race.venue], race.number) for race in races}
    entry_keys: set[tuple[str, str, int]] = set()
    total_entries = 0
    for relative in sorted(entry_files):
        match = ENTRY_PATH_PATTERN.fullmatch(relative)
        if not match:
            issues.append(f"出走馬ファイル名が定義と一致しません: {relative}")
            continue
        key = (match.group(1), match.group(2), int(match.group(3)))
        rows = _parse_entries(artifacts[relative][1], relative)
        _issue(key[0] == target_date, f"出走馬ファイルの対象日がmanifestと一致しません: {relative}", issues)
        _issue(len(rows) == artifacts[relative][2], f"データ行数がmanifestと一致しません: {relative}", issues)
        entry_keys.add(key)
        total_entries += len(rows)
    _issue(entry_keys == race_keys, "レースCSVと出走馬CSVの対象レースが一致しません。", issues)
    _issue(total_entries == entry_count, "出走馬合計がmanifest.entryCountと一致しません。", issues)

    result_row_count = 0
    result_race_count = 0
    if results_included:
        result_content = artifacts["results.csv"][1]
        try:
            result_rows = parse_bridge_csv(result_content.decode("utf-8"))
        except UnicodeDecodeError as error:
            raise BridgeValidationError(["results.csvはBOMなしUTF-8で指定してください。"] ) from error
        _issue(render_csv(result_rows) == result_content, "results.csvが正規順序・LF改行・BOMなしUTF-8ではありません。", issues)
        result_keys = {row.race_key for row in result_rows}
        _issue(all(row.race_date == target_date for row in result_rows), "results.csvにmanifest対象日以外の行があります。", issues)
        _issue(result_keys <= race_keys, "results.csvにレースCSVにないレースがあります。", issues)
        result_row_count, result_race_count = len(result_rows), len(result_keys)
        _issue(result_row_count == artifacts["results.csv"][2], "results.csvの行数がmanifestと一致しません。", issues)
    _issue(result_race_count == finalized_count, "確定結果レース数がmanifestと一致しません。", issues)
    if issues:
        raise BridgeValidationError(issues)

    return {
        "rehearsalFormatVersion": REHEARSAL_FORMAT_VERSION,
        "status": "READY",
        "sampleData": bool(sample_data),
        "productionDataVerified": False,
        "productionImportEligible": not bool(sample_data),
        "liveConnectionAttempted": False,
        "bundleFormatVersion": BUNDLE_FORMAT_VERSION,
        "targetDate": target_date,
        "manifestSha256": sha256_bytes(manifest_bytes),
        "raceCount": race_count,
        "entryRaceCount": entry_race_count,
        "entryCount": entry_count,
        "resultsIncluded": results_included,
        "finalizedRaceCount": finalized_count,
        "resultRowCount": result_row_count,
        "readyForRaceImport": True,
        "readyForResultPreview": bool(results_included),
        "resultConfirmationRequired": True,
        "checks": {
            "manifestSchema": "PASS",
            "artifactSet": "PASS",
            "artifactSha256": "PASS",
            "canonicalCsv": "PASS",
            "raceEntryCoverage": "PASS",
            "resultCoverage": "PASS",
        },
        "artifacts": [
            {"kind": artifacts[path][0], "path": path, "rowCount": artifacts[path][2], "sha256": artifacts[path][3]}
            for path in sorted(artifacts)
        ],
        "nextActions": [
            "管理画面の開催日一括取込でmanifest.json、races.csv、entries/*.csvをプレビューする。",
            "results.csvがある場合は発走後に結果管理で同じmanifest.jsonと一緒にプレビューする。",
            "結果はレース別に公式発表と照合してから確定する。",
        ],
    }


def create_sample_rehearsal_bundle(*, target_date: str, output_dir: Path) -> dict[str, object]:
    try:
        normalized = date.fromisoformat(target_date).isoformat()
    except ValueError as error:
        raise BridgeValidationError(["対象日はYYYY-MM-DD形式で指定してください。"] ) from error
    if normalized != target_date:
        raise BridgeValidationError(["対象日はYYYY-MM-DD形式で指定してください。"])
    module_source = f'''from types import SimpleNamespace
class JV_RA_RACE:
    @classmethod
    def SetDataB(cls, raw):
        return SimpleNamespace(head=SimpleNamespace(RecordSpec="RA"), id=SimpleNamespace(Year="{target_date[:4]}", MonthDay="{target_date[5:7]}{target_date[8:10]}", JyoCD="05", RaceNum="10"), RaceInfo=SimpleNamespace(Hondai="リハーサル特別"), JyokenName="3勝クラス", Kyori="1600", TrackCD="11", HassoTime="1500", TenkoBaba=SimpleNamespace(TenkoCD="1", SibaBabaCD="1", DirtBabaCD="0"))
class JV_SE_RACE_UMA:
    @classmethod
    def SetDataB(cls, raw):
        number = int(chr(raw[2]))
        return SimpleNamespace(head=SimpleNamespace(RecordSpec="SE"), id=SimpleNamespace(Year="{target_date[:4]}", MonthDay="{target_date[5:7]}{target_date[8:10]}", JyoCD="05", RaceNum="10"), KettoNum=f"209910123{{number}}", Umaban=f"{{number:02d}}", Wakuban=str(number), Bamei=f"リハーサル馬{{number}}", SexCD="1", Barei="03", Futan="570", KisyuRyakusyo="試験騎手", ChokyosiRyakusyo="試験調教師", Odds=f"00{{30 + number}}", Ninki=f"{{number:02d}}", IJyoCD="0", KakuteiJyuni=f"{{number:02d}}")
'''
    fixed = lambda kind, marker, size: kind + marker + (b" " * (size - 5)) + b"\r\n"
    with tempfile.TemporaryDirectory() as directory:
        structure = Path(directory) / "JVData_Struct.py"
        structure.write_text(module_source, encoding="utf-8")
        write_import_bundle(
            ra_source=fixed(b"RA", b"R", 1272),
            se_source=fixed(b"SE", b"1", 555) + fixed(b"SE", b"2", 555),
            structure_path=structure,
            target_date=target_date,
            output_dir=output_dir,
            collection_metadata={"readFileCount": 0, "downloadFileCount": 0, "ignoredRecordCount": 0},
            sample_data=True,
        )
    return validate_import_bundle(output_dir)
