from __future__ import annotations

import argparse
import json
import platform
import struct
import sys
from datetime import date
from pathlib import Path

from . import BRIDGE_VERSION, FORMAT_VERSION
from .bridge import (
    BridgeRow,
    BridgeValidationError,
    atomic_write,
    build_manifest,
    build_summary,
    parse_bridge_csv,
    parse_json_lines,
    render_csv,
    sha256_bytes,
)
from .bundle import write_import_bundle
from .bundle_comparison import COMPARISON_FORMAT_VERSION, compare_import_bundles
from .bundle_rehearsal import REHEARSAL_FORMAT_VERSION, create_sample_rehearsal_bundle, validate_import_bundle
from .collector import JvLinkCollectionError, collect_race_records, collect_se_records
from .jvlink import JvLinkUnavailableError, get_readiness, probe_jvlink
from .race_entry_adapter import (
    VENUES,
    build_catalog_manifest,
    decode_sdk_entry_records,
    decode_sdk_ra_records,
    render_entries_csv,
    render_races_csv,
)
from .sdk_adapter import decode_sdk_se_records


def _json(value: object, *, stream: object = sys.stdout) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True), file=stream)


def _doctor() -> int:
    windows = platform.system() == "Windows"
    architecture = struct.calcsize("P") * 8
    python_supported = sys.version_info >= (3, 11)
    jvlink = get_readiness()
    result = {
        "bridgeVersion": BRIDGE_VERSION,
        "formatVersion": FORMAT_VERSION,
        "platform": platform.system(),
        "architectureBits": architecture,
        "pythonVersion": platform.python_version(),
        "offlineReady": windows and architecture == 64 and python_supported,
        "sdkReferenceRuntime": "Python 3.14 / JRA-VAN SDK 5.0.0 64bit",
        "jvLink": jvlink.as_public_dict(),
        "jvLinkConnector": "READY_FOR_PROBE" if jvlink.ready_for_probe else "NOT_CONFIGURED",
        "liveConnectionAttempted": False,
    }
    _json(result)
    return 0 if result["offlineReady"] else 3


def _probe() -> int:
    _json(probe_jvlink())
    return 0


def _write_artifacts(
    *,
    rows: list[BridgeRow],
    input_bytes: bytes,
    input_path: Path,
    output_path: Path,
    manifest_argument: str | None,
    force: bool,
    source_kind: str,
    output_metadata: dict[str, object] | None = None,
) -> int:
    output_bytes = render_csv(rows)
    manifest = build_manifest(rows, input_bytes, output_bytes, input_path.name, source_kind=source_kind)
    manifest_path = Path(manifest_argument) if manifest_argument else Path(f"{output_path}.manifest.json")
    if not force:
        existing = [str(path.resolve()) for path in (output_path, manifest_path) if path.exists()]
        if existing:
            raise FileExistsError(
                f"既存ファイルを上書きしません: {', '.join(existing)}（必要な場合は--forceを指定）"
            )
    atomic_write(output_path, output_bytes, force=force)
    atomic_write(
        manifest_path,
        (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        force=force,
    )
    _json({**manifest, "outputFile": output_path.name, "manifestFile": manifest_path.name, **(output_metadata or {})})
    return 0


def _convert(arguments: argparse.Namespace) -> int:
    input_path = Path(arguments.input)
    input_bytes = input_path.read_bytes()
    rows = parse_json_lines(input_bytes.decode("utf-8-sig"))
    return _write_artifacts(
        rows=rows,
        input_bytes=input_bytes,
        input_path=input_path,
        output_path=Path(arguments.output),
        manifest_argument=arguments.manifest,
        force=arguments.force,
        source_kind="DECODED_SE_JSONL",
    )


def _decode_sdk_se(arguments: argparse.Namespace) -> int:
    input_path = Path(arguments.input)
    input_bytes = input_path.read_bytes()
    rows = decode_sdk_se_records(input_bytes, Path(arguments.sdk_structure), race_canceled=arguments.race_canceled)
    return _write_artifacts(
        rows=rows,
        input_bytes=input_bytes,
        input_path=input_path,
        output_path=Path(arguments.output),
        manifest_argument=arguments.manifest,
        force=arguments.force,
        source_kind="JVLINK_SE_RECORDS",
    )


def _write_catalog_artifact(
    *,
    kind: str,
    rows: list[object],
    input_bytes: bytes,
    input_path: Path,
    output_path: Path,
    manifest_argument: str | None,
    force: bool,
    output_bytes: bytes,
) -> int:
    manifest = build_catalog_manifest(
        kind=kind,
        rows=rows,
        input_bytes=input_bytes,
        output_bytes=output_bytes,
        input_name=input_path.name,
    )
    manifest_path = Path(manifest_argument) if manifest_argument else Path(f"{output_path}.manifest.json")
    if not force:
        existing = [str(path.resolve()) for path in (output_path, manifest_path) if path.exists()]
        if existing:
            raise FileExistsError(
                f"既存ファイルを上書きしません: {', '.join(existing)}（必要な場合は--forceを指定）"
            )
    atomic_write(output_path, output_bytes, force=force)
    atomic_write(
        manifest_path,
        (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        force=force,
    )
    _json({**manifest, "outputFile": output_path.name, "manifestFile": manifest_path.name})
    return 0


def _decode_sdk_races(arguments: argparse.Namespace) -> int:
    input_path = Path(arguments.input)
    input_bytes = input_path.read_bytes()
    rows = decode_sdk_ra_records(input_bytes, Path(arguments.sdk_structure))
    return _write_catalog_artifact(
        kind="RACES",
        rows=list(rows),
        input_bytes=input_bytes,
        input_path=input_path,
        output_path=Path(arguments.output),
        manifest_argument=arguments.manifest,
        force=arguments.force,
        output_bytes=render_races_csv(rows),
    )


def _decode_sdk_entries(arguments: argparse.Namespace) -> int:
    try:
        race_date = date.fromisoformat(arguments.race_date).isoformat()
    except ValueError as error:
        raise BridgeValidationError(["対象日はYYYY-MM-DD形式で指定してください。"]) from error
    if arguments.venue_code not in VENUES:
        raise BridgeValidationError(["競馬場コードは中央10場の01〜10で指定してください。"])
    if not 1 <= arguments.race_number <= 12:
        raise BridgeValidationError(["レース番号は1〜12で指定してください。"])
    input_path = Path(arguments.input)
    input_bytes = input_path.read_bytes()
    rows = decode_sdk_entry_records(
        input_bytes,
        Path(arguments.sdk_structure),
        race_date=race_date,
        venue_code=arguments.venue_code,
        race_number=arguments.race_number,
    )
    return _write_catalog_artifact(
        kind="ENTRIES",
        rows=list(rows),
        input_bytes=input_bytes,
        input_path=input_path,
        output_path=Path(arguments.output),
        manifest_argument=arguments.manifest,
        force=arguments.force,
        output_bytes=render_entries_csv(rows),
    )


def _collect_jvlink(arguments: argparse.Namespace) -> int:
    try:
        target_date = date.fromisoformat(arguments.target_date).isoformat()
    except ValueError as error:
        raise JvLinkCollectionError("TARGET_DATE_INVALID", "対象日はYYYY-MM-DD形式で指定してください。") from error
    readiness = get_readiness()
    probe_jvlink(readiness=readiness)

    import pythoncom
    import win32com.client

    initialized = False
    try:
        pythoncom.CoInitialize()
        initialized = True
        try:
            client = win32com.client.Dispatch("JVDTLab.JVLink")
        except Exception as error:
            raise JvLinkUnavailableError("JVLINK_COM_DISPATCH_FAILED", "JV-Link COMオブジェクトを取得できませんでした。") from error
        collected = collect_se_records(
            client,
            sid=arguments.sid,
            from_time=target_date.replace("-", "") + "000000",
            timeout_seconds=arguments.timeout_seconds,
        )
        raw = b"".join(collected.records)
        rows = [
            row
            for row in decode_sdk_se_records(raw, Path(arguments.sdk_structure), race_canceled=False)
            if row.race_date == target_date
        ]
        if not rows:
            raise JvLinkCollectionError("TARGET_DATE_NOT_FOUND", "対象日のSEレコードがありません。")
        return _write_artifacts(
            rows=rows,
            input_bytes=raw,
            input_path=Path(f"jvlink-se-{target_date}.dat"),
            output_path=Path(arguments.output),
            manifest_argument=arguments.manifest,
            force=arguments.force,
            source_kind="JVLINK_LIVE_SE_RECORDS",
            output_metadata={
                "readFileCount": collected.read_count,
                "downloadFileCount": collected.download_count,
                "ignoredNonSeRecords": collected.ignored_record_count,
                "targetDate": target_date,
            },
        )
    finally:
        if initialized:
            pythoncom.CoUninitialize()


def _collect_jvlink_bundle(arguments: argparse.Namespace) -> int:
    try:
        target_date = date.fromisoformat(arguments.target_date).isoformat()
    except ValueError as error:
        raise JvLinkCollectionError("TARGET_DATE_INVALID", "対象日はYYYY-MM-DD形式で指定してください。") from error
    readiness = get_readiness()
    probe_jvlink(readiness=readiness)

    import pythoncom
    import win32com.client

    initialized = False
    try:
        pythoncom.CoInitialize()
        initialized = True
        try:
            client = win32com.client.Dispatch("JVDTLab.JVLink")
        except Exception as error:
            raise JvLinkUnavailableError("JVLINK_COM_DISPATCH_FAILED", "JV-Link COMオブジェクトを取得できませんでした。") from error
        collected = collect_race_records(
            client,
            sid=arguments.sid,
            from_time=target_date.replace("-", "") + "000000",
            timeout_seconds=arguments.timeout_seconds,
        )
        if not collected.ra_records:
            raise JvLinkCollectionError("NO_RA_RECORDS", "レース詳細（RA）がありません。")
        if not collected.se_records:
            raise JvLinkCollectionError("NO_SE_RECORDS", "馬毎レース情報（SE）がありません。")
        manifest = write_import_bundle(
            ra_source=b"".join(collected.ra_records),
            se_source=b"".join(collected.se_records),
            structure_path=Path(arguments.sdk_structure),
            target_date=target_date,
            output_dir=Path(arguments.output_dir),
            collection_metadata={
                "readFileCount": collected.read_count,
                "downloadFileCount": collected.download_count,
                "ignoredRecordCount": collected.ignored_record_count,
            },
        )
        _json({**manifest, "outputDirectory": str(Path(arguments.output_dir).resolve())})
        return 0
    finally:
        if initialized:
            pythoncom.CoUninitialize()


def _validate(arguments: argparse.Namespace) -> int:
    input_path = Path(arguments.input)
    input_bytes = input_path.read_bytes()
    rows = parse_bridge_csv(input_bytes.decode("utf-8-sig"))
    canonical = render_csv(rows)
    result = build_summary(rows, canonical)
    result.update(
        {
            "inputFile": input_path.name,
            "inputSha256": sha256_bytes(input_bytes),
            "canonical": input_bytes == canonical,
        }
    )
    _json(result)
    return 0


def _rehearsal_report_path(input_path: Path, configured: str | None) -> Path:
    return Path(configured) if configured else Path(f"{input_path.resolve()}.rehearsal.json")


def _write_rehearsal_report(path: Path, report: dict[str, object], *, force: bool) -> None:
    atomic_write(
        path,
        (json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        force=force,
    )


def _validate_bundle(arguments: argparse.Namespace) -> int:
    input_dir = Path(arguments.input_dir)
    report_path = _rehearsal_report_path(input_dir, arguments.report)
    try:
        report = validate_import_bundle(input_dir)
    except (BridgeValidationError, FileExistsError, UnicodeDecodeError, OSError, ValueError) as error:
        issues = error.issues if isinstance(error, BridgeValidationError) else [str(error)]
        _write_rehearsal_report(report_path, {
            "rehearsalFormatVersion": REHEARSAL_FORMAT_VERSION,
            "status": "FAILED",
            "sampleData": False,
            "productionDataVerified": False,
            "productionImportEligible": False,
            "liveConnectionAttempted": False,
            "inputDirectory": str(input_dir.resolve()),
            "issues": issues,
        }, force=arguments.force_report)
        raise
    report.update({"inputDirectory": str(input_dir.resolve()), "reportFile": str(report_path.resolve())})
    _write_rehearsal_report(report_path, report, force=arguments.force_report)
    _json(report)
    return 0


def _rehearse_bundle(arguments: argparse.Namespace) -> int:
    output_dir = Path(arguments.output_dir)
    report_path = _rehearsal_report_path(output_dir, arguments.report)
    try:
        report = create_sample_rehearsal_bundle(target_date=arguments.target_date, output_dir=output_dir)
    except (BridgeValidationError, FileExistsError, UnicodeDecodeError, OSError, ValueError) as error:
        issues = error.issues if isinstance(error, BridgeValidationError) else [str(error)]
        _write_rehearsal_report(report_path, {
            "rehearsalFormatVersion": REHEARSAL_FORMAT_VERSION,
            "status": "FAILED",
            "sampleData": True,
            "productionDataVerified": False,
            "productionImportEligible": False,
            "liveConnectionAttempted": False,
            "outputDirectory": str(output_dir.resolve()),
            "issues": issues,
        }, force=arguments.force_report)
        raise
    report.update({"outputDirectory": str(output_dir.resolve()), "reportFile": str(report_path.resolve())})
    _write_rehearsal_report(report_path, report, force=arguments.force_report)
    _json(report)
    return 0


def _compare_bundles(arguments: argparse.Namespace) -> int:
    previous_dir = Path(arguments.previous_dir)
    current_dir = Path(arguments.current_dir)
    report_path = Path(arguments.report) if arguments.report else Path(f"{current_dir.resolve()}.comparison.json")
    try:
        report = compare_import_bundles(previous_dir=previous_dir, current_dir=current_dir)
    except (BridgeValidationError, FileExistsError, UnicodeDecodeError, OSError, ValueError) as error:
        issues = error.issues if isinstance(error, BridgeValidationError) else [str(error)]
        _write_rehearsal_report(report_path, {
            "comparisonFormatVersion": COMPARISON_FORMAT_VERSION,
            "status": "FAILED",
            "productionDataVerified": False,
            "productionImportEligible": False,
            "liveConnectionAttempted": False,
            "automaticImportAttempted": False,
            "previousDirectory": str(previous_dir.resolve()),
            "currentDirectory": str(current_dir.resolve()),
            "issues": issues,
        }, force=arguments.force_report)
        raise
    report.update({"reportFile": str(report_path.resolve())})
    _write_rehearsal_report(report_path, report, force=arguments.force_report)
    _json(report)
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        prog="python -m tools.jra_van_bridge",
        description="JRA-VAN SDKで復号・構造化したRA/SEデータをウマリアル取込CSVへ変換します。",
    )
    subcommands = result.add_subparsers(dest="command", required=True)
    subcommands.add_parser("doctor", help="オフライン変換環境だけを確認し、JV-Linkへ接続しません。")
    subcommands.add_parser("probe", help="JV-Link COMオブジェクトの取得だけを確認し、JVInitや通信は行いません。")

    convert = subcommands.add_parser("convert", help="復号済みSE JSON Linesを決定的なCSVへ変換します。")
    convert.add_argument("--input", required=True, help="復号済みSE JSON Linesファイル")
    convert.add_argument("--output", required=True, help="出力CSVファイル")
    convert.add_argument("--manifest", help="監査用manifestの出力先（既定: <output>.manifest.json）")
    convert.add_argument("--force", action="store_true", help="既存の出力とmanifestを上書きします。")

    decode = subcommands.add_parser("decode-sdk-se", help="JV-Linkが返したSE固定長レコードをSDK構造体でCSVへ変換します。")
    decode.add_argument("--input", required=True, help="SE固定長レコードファイル")
    decode.add_argument("--sdk-structure", required=True, help="SDK 5.0.0のJVData_Struct.py")
    decode.add_argument("--output", required=True, help="出力CSVファイル")
    decode.add_argument("--manifest", help="監査用manifestの出力先（既定: <output>.manifest.json）")
    decode.add_argument("--race-canceled", action="store_true", help="入力全体をレース中止として変換します。")
    decode.add_argument("--force", action="store_true", help="既存の出力とmanifestを上書きします。")

    decode_races = subcommands.add_parser("decode-sdk-races", help="RA固定長レコードをレース登録CSVへ変換します。")
    decode_races.add_argument("--input", required=True, help="RA固定長レコードファイル")
    decode_races.add_argument("--sdk-structure", required=True, help="SDK 5.0.0のJVData_Struct.py")
    decode_races.add_argument("--output", required=True, help="レースCSV出力先")
    decode_races.add_argument("--manifest", help="監査用manifestの出力先（既定: <output>.manifest.json）")
    decode_races.add_argument("--force", action="store_true", help="既存の出力とmanifestを上書きします。")

    decode_entries = subcommands.add_parser("decode-sdk-entries", help="SE固定長レコードを指定レースの出走馬CSVへ変換します。")
    decode_entries.add_argument("--input", required=True, help="SE固定長レコードファイル")
    decode_entries.add_argument("--sdk-structure", required=True, help="SDK 5.0.0のJVData_Struct.py")
    decode_entries.add_argument("--race-date", required=True, help="対象日 YYYY-MM-DD")
    decode_entries.add_argument("--venue-code", required=True, help="JRA-VAN競馬場コード 01〜10")
    decode_entries.add_argument("--race-number", required=True, type=int, help="レース番号 1〜12")
    decode_entries.add_argument("--output", required=True, help="出走馬CSV出力先")
    decode_entries.add_argument("--manifest", help="監査用manifestの出力先（既定: <output>.manifest.json）")
    decode_entries.add_argument("--force", action="store_true", help="既存の出力とmanifestを上書きします。")

    collect = subcommands.add_parser("collect-jvlink", help="JV-Linkの今週RACEデータから対象日のSEだけを取得します。")
    collect.add_argument("--target-date", required=True, help="対象日 YYYY-MM-DD")
    collect.add_argument("--sdk-structure", required=True, help="SDK 5.0.0のJVData_Struct.py")
    collect.add_argument("--output", required=True, help="出力CSVファイル")
    collect.add_argument("--manifest", help="監査用manifestの出力先（既定: <output>.manifest.json）")
    collect.add_argument("--sid", default="UNKNOWN", help="JVInit SID（既定: UNKNOWN）")
    collect.add_argument("--timeout-seconds", type=int, default=300, help="ダウンロード待機秒数（1〜1800）")
    collect.add_argument("--force", action="store_true", help="既存の出力とmanifestを上書きします。")

    collect_bundle = subcommands.add_parser(
        "collect-jvlink-bundle",
        help="JV-LinkのRA/SEを1回で取得し、対象日の取込一式を新規ディレクトリへ出力します。",
    )
    collect_bundle.add_argument("--target-date", required=True, help="対象日 YYYY-MM-DD")
    collect_bundle.add_argument("--sdk-structure", required=True, help="SDK 5.0.0のJVData_Struct.py")
    collect_bundle.add_argument("--output-dir", required=True, help="新規作成する一括出力ディレクトリ")
    collect_bundle.add_argument("--sid", default="UNKNOWN", help="JVInit SID（既定: UNKNOWN）")
    collect_bundle.add_argument("--timeout-seconds", type=int, default=300, help="ダウンロード待機秒数（1〜1800）")

    validate = subcommands.add_parser("validate", help="ブリッジCSVの形式と決定性を検証します。")
    validate.add_argument("--input", required=True, help="検証するCSVファイル")

    validate_bundle = subcommands.add_parser("validate-bundle", help="生成済みの開催日一括出力を管理画面投入前に再検証します。")
    validate_bundle.add_argument("--input-dir", required=True, help="manifest.jsonを含む一括出力ディレクトリ")
    validate_bundle.add_argument("--report", help="診断レポート出力先（既定: <input-dir>.rehearsal.json）")
    validate_bundle.add_argument("--force-report", action="store_true", help="既存の診断レポートだけを上書きします。")

    rehearse_bundle = subcommands.add_parser("rehearse-bundle", help="合成データで一括生成と投入前検査を行います。JV-Linkへ接続しません。")
    rehearse_bundle.add_argument("--target-date", required=True, help="合成データの対象日 YYYY-MM-DD")
    rehearse_bundle.add_argument("--output-dir", required=True, help="新規作成する合成一括出力ディレクトリ")
    rehearse_bundle.add_argument("--report", help="診断レポート出力先（既定: <output-dir>.rehearsal.json）")
    rehearse_bundle.add_argument("--force-report", action="store_true", help="既存の診断レポートだけを上書きします。")

    compare_bundles = subcommands.add_parser("compare-bundles", help="前回と今回の検証済みbundleを比較し、再取込・訂正候補を判定します。")
    compare_bundles.add_argument("--previous-dir", required=True, help="前回取得した一括出力ディレクトリ")
    compare_bundles.add_argument("--current-dir", required=True, help="今回取得した一括出力ディレクトリ")
    compare_bundles.add_argument("--report", help="比較レポート出力先（既定: <current-dir>.comparison.json）")
    compare_bundles.add_argument("--force-report", action="store_true", help="既存の比較レポートだけを上書きします。")
    return result


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    arguments = parser().parse_args(argv)
    try:
        if arguments.command == "doctor":
            return _doctor()
        if arguments.command == "probe":
            return _probe()
        if arguments.command == "convert":
            return _convert(arguments)
        if arguments.command == "decode-sdk-se":
            return _decode_sdk_se(arguments)
        if arguments.command == "decode-sdk-races":
            return _decode_sdk_races(arguments)
        if arguments.command == "decode-sdk-entries":
            return _decode_sdk_entries(arguments)
        if arguments.command == "collect-jvlink":
            return _collect_jvlink(arguments)
        if arguments.command == "collect-jvlink-bundle":
            return _collect_jvlink_bundle(arguments)
        if arguments.command == "validate":
            return _validate(arguments)
        if arguments.command == "validate-bundle":
            return _validate_bundle(arguments)
        if arguments.command == "rehearse-bundle":
            return _rehearse_bundle(arguments)
        if arguments.command == "compare-bundles":
            return _compare_bundles(arguments)
    except JvLinkUnavailableError as error:
        _json({"error": error.code, "issues": [str(error)]}, stream=sys.stderr)
        return 3
    except JvLinkCollectionError as error:
        _json({"error": error.code, "issues": [str(error)]}, stream=sys.stderr)
        return 4
    except (BridgeValidationError, FileExistsError, UnicodeDecodeError, OSError, ValueError) as error:
        issues = error.issues if isinstance(error, BridgeValidationError) else [str(error)]
        _json({"error": "BRIDGE_VALIDATION_FAILED", "issues": issues}, stream=sys.stderr)
        return 2
    return 2
