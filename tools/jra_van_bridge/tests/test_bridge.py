from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools.jra_van_bridge.bridge import (
    BridgeValidationError,
    atomic_write,
    build_manifest,
    parse_bridge_csv,
    parse_json_lines,
    render_csv,
    sha256_bytes,
)
from tools.jra_van_bridge.bundle import write_import_bundle
from tools.jra_van_bridge.bundle_comparison import compare_import_bundles
from tools.jra_van_bridge.bundle_rehearsal import create_sample_rehearsal_bundle, validate_import_bundle
from tools.jra_van_bridge.cli import main
from tools.jra_van_bridge.collector import JvLinkCollectionError, collect_race_records, collect_se_records
from tools.jra_van_bridge.jvlink import JvLinkReadiness, JvLinkUnavailableError, probe_jvlink
from tools.jra_van_bridge.race_entry_adapter import (
    map_sdk_entry,
    map_sdk_ra,
    render_entries_csv,
    render_races_csv,
    stable_horse_uuid,
)
from tools.jra_van_bridge.sdk_adapter import decode_sdk_se_records, map_sdk_se


def row(**changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "recordType": "SE",
        "raceDate": "2026-09-13",
        "venueCode": "05",
        "raceNumber": 10,
        "horseNumber": 1,
        "abnormalCode": "0",
        "finishPosition": 1,
        "popularity": 2,
        "finalOdds": "3.4",
        "raceCanceled": False,
    }
    value.update(changes)
    return value


def json_lines(*rows: dict[str, object]) -> str:
    return "\n".join(json.dumps(value, ensure_ascii=False) for value in rows)


class BridgeTest(unittest.TestCase):
    @staticmethod
    def _rewrite_artifact(root: Path, relative_path: str, replacement: bytes) -> None:
        (root / relative_path).write_bytes(replacement)
        manifest_path = root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for artifact in manifest["files"]:
            if artifact["path"] == relative_path:
                artifact["sha256"] = sha256_bytes(replacement)
                break
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")

    @staticmethod
    def _remove_results(root: Path) -> None:
        manifest_path = root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"] = [artifact for artifact in manifest["files"] if artifact["path"] != "results.csv"]
        manifest["resultsIncluded"] = False
        manifest["finalizedRaceCount"] = 0
        (root / "results.csv").unlink()
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")

    def test_collects_ra_and_se_records_in_one_jvlink_session(self) -> None:
        class FakeClient:
            def __init__(self) -> None:
                self.results = iter(
                    [
                        (1272, memoryview(b"RArace"), b""),
                        (555, memoryview(b"SEhorse"), b""),
                        (20, memoryview(b"XXignored"), b""),
                        (0, memoryview(b""), b""),
                    ]
                )
                self.closed = False

            def JVInit(self, _: str) -> int:
                return 0

            def JVOpen(self, *_: object) -> tuple[int, int, int, str]:
                return (0, 3, 0, "")

            def JVStatus(self) -> int:
                return 0

            def JVGets(self, *_: object) -> object:
                return next(self.results)

            def JVClose(self) -> int:
                self.closed = True
                return 0

        client = FakeClient()
        result = collect_race_records(
            client,
            sid="UNKNOWN",
            from_time="20260913000000",
            timeout_seconds=30,
        )
        self.assertEqual(result.ra_records, [b"RArace"])
        self.assertEqual(result.se_records, [b"SEhorse"])
        self.assertEqual(result.ignored_record_count, 1)
        self.assertTrue(client.closed)

    def test_maps_sdk_ra_to_existing_race_csv_contract(self) -> None:
        record = SimpleNamespace(
            head=SimpleNamespace(RecordSpec="RA"),
            id=SimpleNamespace(Year="2026", MonthDay="0913", JyoCD="05", RaceNum="10"),
            RaceInfo=SimpleNamespace(Hondai="秋空特別"),
            JyokenName="3勝クラス",
            Kyori="1600",
            TrackCD="11",
            HassoTime="1500",
            TenkoBaba=SimpleNamespace(TenkoCD="1", SibaBabaCD="1", DirtBabaCD="0"),
        )
        mapped = map_sdk_ra(record)
        self.assertEqual(mapped.venue, "東京")
        self.assertEqual(mapped.surface, "TURF")
        self.assertEqual(mapped.direction, "LEFT")
        self.assertEqual(mapped.startsAt, "2026-09-13T15:00:00+09:00")
        samples = Path(__file__).parents[1] / "samples"
        self.assertEqual(render_races_csv([mapped]), (samples / "expected-jra-van-races.csv").read_bytes())

    def test_maps_sdk_se_to_existing_entry_csv_contract(self) -> None:
        record = SimpleNamespace(
            head=SimpleNamespace(RecordSpec="SE"),
            id=SimpleNamespace(Year="2026", MonthDay="0913", JyoCD="05", RaceNum="10"),
            KettoNum="2023101234",
            Umaban="06",
            Wakuban="3",
            Bamei="テストホース",
            SexCD="1",
            Barei="03",
            Futan="570",
            KisyuRyakusyo="試験騎手",
            ChokyosiRyakusyo="試験調教",
            Odds="0034",
            Ninki="02",
            IJyoCD="0",
        )
        key, mapped = map_sdk_entry(record)
        self.assertEqual(key, ("2026-09-13", "05", 10))
        self.assertEqual(mapped.horseId, "b17761fa-2467-54f6-88da-2eb89455840c")
        self.assertEqual(mapped.carriedWeight, "57.0")
        samples = Path(__file__).parents[1] / "samples"
        self.assertEqual(render_entries_csv([mapped]), (samples / "expected-jra-van-entries.csv").read_bytes())

    def test_race_entry_mapping_rejects_unsupported_or_unstable_identifiers(self) -> None:
        self.assertEqual(
            stable_horse_uuid("2023101234"),
            stable_horse_uuid("2023101234"),
        )
        with self.assertRaisesRegex(ValueError, "10桁"):
            stable_horse_uuid("0000000000")
        record = SimpleNamespace(
            head=SimpleNamespace(RecordSpec="RA"),
            id=SimpleNamespace(Year="2026", MonthDay="0913", JyoCD="05", RaceNum="10"),
            RaceInfo=SimpleNamespace(Hondai="障害競走"),
            JyokenName="障害",
            Kyori="3000",
            TrackCD="51",
            HassoTime="1200",
            TenkoBaba=SimpleNamespace(TenkoCD="1", SibaBabaCD="1", DirtBabaCD="1"),
        )
        with self.assertRaisesRegex(ValueError, "未対応のトラック"):
            map_sdk_ra(record)

    def test_collects_only_se_records_with_official_jvlink_call_order(self) -> None:
        class FakeClient:
            def __init__(self) -> None:
                self.calls: list[str] = []
                self.statuses = iter([0, 1])
                self.results = iter(
                    [
                        (100, memoryview(b"RAignored"), b""),
                        (555, memoryview(b"SEaccepted"), b""),
                        (-1, memoryview(b""), b""),
                        (0, memoryview(b""), b""),
                    ]
                )

            def JVInit(self, sid: str) -> int:
                self.calls.append(f"JVInit:{sid}")
                return 0

            def JVOpen(self, *arguments: object) -> tuple[int, int, int, str]:
                self.calls.append(f"JVOpen:{arguments[0]}:{arguments[2]}")
                return (0, 2, 1, "")

            def JVStatus(self) -> int:
                self.calls.append("JVStatus")
                return next(self.statuses)

            def JVGets(self, *_: object) -> object:
                self.calls.append("JVGets")
                return next(self.results)

            def JVClose(self) -> int:
                self.calls.append("JVClose")
                return 0

        client = FakeClient()
        ticks = iter([0.0, 0.0, 0.1])
        result = collect_se_records(
            client,
            sid="UNKNOWN",
            from_time="20260913000000",
            timeout_seconds=30,
            monotonic=lambda: next(ticks),
            sleep=lambda _: None,
        )
        self.assertEqual(result.records, [b"SEaccepted"])
        self.assertEqual(result.ignored_record_count, 1)
        self.assertEqual(client.calls[0:2], ["JVInit:UNKNOWN", "JVOpen:RACE:2"])
        self.assertEqual(client.calls[-1], "JVClose")

    def test_collection_error_closes_open_jvlink_resource(self) -> None:
        class FakeClient:
            closed = False

            def JVInit(self, _: str) -> int:
                return 0

            def JVOpen(self, *_: object) -> tuple[int, int, int, str]:
                return (0, 1, 0, "")

            def JVStatus(self) -> int:
                return 0

            def JVGets(self, *_: object) -> tuple[int, memoryview, bytes]:
                return (-203, memoryview(b""), b"")

            def JVClose(self) -> int:
                self.closed = True
                return 0

        client = FakeClient()
        with self.assertRaisesRegex(JvLinkCollectionError, "code -203"):
            collect_se_records(client, sid="UNKNOWN", from_time="20260913000000", timeout_seconds=30)
        self.assertTrue(client.closed)

    def test_collection_error_is_not_hidden_by_close_failure(self) -> None:
        class FakeClient:
            def JVInit(self, _: str) -> int:
                return 0

            def JVOpen(self, *_: object) -> tuple[int, int, int, str]:
                return (0, 1, 0, "")

            def JVStatus(self) -> int:
                return 0

            def JVGets(self, *_: object) -> tuple[int, memoryview, bytes]:
                return (-203, memoryview(b""), b"")

            def JVClose(self) -> int:
                raise RuntimeError("private close error")

        with self.assertRaises(JvLinkCollectionError) as raised:
            collect_se_records(FakeClient(), sid="UNKNOWN", from_time="20260913000000", timeout_seconds=30)
        self.assertEqual(raised.exception.code, "JVGETS_FAILED")
        self.assertNotIn("private close error", str(raised.exception))
        self.assertIn("JVClose", " ".join(raised.exception.__notes__))

    def test_maps_official_sdk_se_fields_without_betting_data(self) -> None:
        record = SimpleNamespace(
            head=SimpleNamespace(RecordSpec="SE"),
            id=SimpleNamespace(Year="2026", MonthDay="0913", JyoCD="05", RaceNum="10"),
            Umaban="01",
            IJyoCD="0",
            KakuteiJyuni="01",
            Ninki="02",
            Odds="0034",
        )
        mapped = map_sdk_se(record, race_canceled=False)
        self.assertEqual(mapped.race_date, "2026-09-13")
        self.assertEqual(mapped.venue_code, "05")
        self.assertEqual(mapped.race_number, 10)
        self.assertEqual(mapped.horse_number, 1)
        self.assertEqual(mapped.final_odds, "3.4")

    def test_decodes_fixed_length_se_with_sdk_structure_module(self) -> None:
        module_source = """
from types import SimpleNamespace
class JV_SE_RACE_UMA:
    @classmethod
    def SetDataB(cls, raw):
        return SimpleNamespace(
            head=SimpleNamespace(RecordSpec='SE'),
            id=SimpleNamespace(Year='2026', MonthDay='0913', JyoCD='05', RaceNum='10'),
            Umaban='01', IJyoCD='0', KakuteiJyuni='01', Ninki='02', Odds='0034'
        )
"""
        with tempfile.TemporaryDirectory() as directory:
            structure = Path(directory) / "JVData_Struct.py"
            structure.write_text(module_source, encoding="utf-8")
            raw = b"SE" + (b" " * 551) + b"\r\n"
            rows = decode_sdk_se_records(raw, structure, race_canceled=False)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].final_odds, "3.4")

    def test_bundle_is_atomic_complete_and_omits_unfinalized_results(self) -> None:
        module_source = """
from types import SimpleNamespace

class JV_RA_RACE:
    @classmethod
    def SetDataB(cls, raw):
        return SimpleNamespace(
            head=SimpleNamespace(RecordSpec='RA'),
            id=SimpleNamespace(Year='2026', MonthDay='0913', JyoCD='05', RaceNum='10'),
            RaceInfo=SimpleNamespace(Hondai='秋空特別'), JyokenName='3勝クラス',
            Kyori='1600', TrackCD='11', HassoTime='1500',
            TenkoBaba=SimpleNamespace(TenkoCD='1', SibaBabaCD='1', DirtBabaCD='0')
        )

class JV_SE_RACE_UMA:
    @classmethod
    def SetDataB(cls, raw):
        marker = chr(raw[2])
        number = 1 if marker == 'P' else int(marker)
        return SimpleNamespace(
            head=SimpleNamespace(RecordSpec='SE'),
            id=SimpleNamespace(Year='2026', MonthDay='0913', JyoCD='05', RaceNum='10'),
            KettoNum=f'202310123{number}', Umaban=f'{number:02d}', Wakuban=str(number),
            Bamei=f'テストホース{number}', SexCD='1', Barei='03', Futan='570',
            KisyuRyakusyo='試験騎手', ChokyosiRyakusyo='試験調教', Odds='0034',
            Ninki=f'{number:02d}', IJyoCD='0',
            KakuteiJyuni='' if marker == 'P' else f'{number:02d}'
        )
"""

        def fixed(record_type: bytes, marker: bytes, size: int) -> bytes:
            return record_type + marker + (b" " * (size - 5)) + b"\r\n"

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            structure = root / "JVData_Struct.py"
            structure.write_text(module_source, encoding="utf-8")
            ra = fixed(b"RA", b"R", 1272)
            final_se = fixed(b"SE", b"1", 555) + fixed(b"SE", b"2", 555)
            final_output = root / "final-bundle"
            manifest = write_import_bundle(
                ra_source=ra,
                se_source=final_se,
                structure_path=structure,
                target_date="2026-09-13",
                output_dir=final_output,
            )
            self.assertTrue((final_output / "races.csv").is_file())
            self.assertTrue((final_output / "entries/2026-09-13-05-10R.csv").is_file())
            self.assertTrue((final_output / "results.csv").is_file())
            self.assertTrue((final_output / "manifest.json").is_file())
            self.assertEqual(manifest["finalizedRaceCount"], 1)
            self.assertFalse(any(path.suffix == ".dat" for path in final_output.rglob("*")))
            with self.assertRaises(FileExistsError):
                write_import_bundle(
                    ra_source=ra,
                    se_source=final_se,
                    structure_path=structure,
                    target_date="2026-09-13",
                    output_dir=final_output,
                )

            pending_output = root / "pending-bundle"
            pending_manifest = write_import_bundle(
                ra_source=ra,
                se_source=fixed(b"SE", b"P", 555),
                structure_path=structure,
                target_date="2026-09-13",
                output_dir=pending_output,
            )
            self.assertFalse((pending_output / "results.csv").exists())
            self.assertFalse(pending_manifest["resultsIncluded"])
            self.assertEqual(pending_manifest["finalizedRaceCount"], 0)

    def test_rehearses_and_revalidates_a_complete_bundle_without_live_connection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "sample-bundle"
            report_path = root / "sample-report.json"
            with patch("tools.jra_van_bridge.cli._json"):
                status = main([
                    "rehearse-bundle", "--target-date", "2099-09-13",
                    "--output-dir", str(output), "--report", str(report_path),
                ])
            self.assertEqual(status, 0)
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "READY")
            self.assertTrue(report["sampleData"])
            self.assertFalse(report["liveConnectionAttempted"])
            self.assertFalse(report["productionImportEligible"])
            self.assertTrue(report["readyForRaceImport"])
            self.assertTrue(report["readyForResultPreview"])
            self.assertEqual(validate_import_bundle(output)["finalizedRaceCount"], 1)

            results = output / "results.csv"
            results.write_text(results.read_text(encoding="utf-8").replace("3.1", "9.9"), encoding="utf-8", newline="")
            failed_report = root / "failed-report.json"
            with patch("tools.jra_van_bridge.cli._json"):
                failed = main(["validate-bundle", "--input-dir", str(output), "--report", str(failed_report)])
            self.assertEqual(failed, 2)
            failure = json.loads(failed_report.read_text(encoding="utf-8"))
            self.assertEqual(failure["status"], "FAILED")
            self.assertTrue(any("SHA-256" in issue for issue in failure["issues"]))

    def test_compares_bundles_without_importing_and_classifies_result_changes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline = root / "baseline"
            create_sample_rehearsal_bundle(target_date="2099-09-13", output_dir=baseline)

            unchanged = root / "unchanged"
            shutil.copytree(baseline, unchanged)
            same = compare_import_bundles(previous_dir=baseline, current_dir=unchanged)
            self.assertEqual(same["classification"], "UNCHANGED")
            self.assertEqual(same["recommendedAction"], "NO_ACTION")
            self.assertFalse(same["automaticImportAttempted"])

            corrected = root / "corrected"
            shutil.copytree(baseline, corrected)
            result_bytes = (corrected / "results.csv").read_bytes().replace(b"3.1", b"9.9")
            self._rewrite_artifact(corrected, "results.csv", result_bytes)
            correction = compare_import_bundles(previous_dir=baseline, current_dir=corrected)
            self.assertEqual(correction["classification"], "RESULT_CORRECTION_CANDIDATE")
            self.assertEqual(correction["recommendedAction"], "PREVIEW_RESULT_CORRECTION")
            self.assertEqual(correction["changedArtifacts"][0]["path"], "results.csv")

            pending = root / "pending"
            shutil.copytree(baseline, pending)
            self._remove_results(pending)
            available = compare_import_bundles(previous_dir=pending, current_dir=baseline)
            self.assertEqual(available["classification"], "RESULTS_AVAILABLE")
            self.assertEqual(available["recommendedAction"], "PREVIEW_RESULTS")
            regressed = compare_import_bundles(previous_dir=baseline, current_dir=pending)
            self.assertEqual(regressed["status"], "REVIEW_REQUIRED")
            self.assertEqual(regressed["recommendedAction"], "MANUAL_REVIEW_REQUIRED")

    def test_compares_race_changes_and_writes_failure_report_for_different_dates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline = root / "baseline"
            changed = root / "changed"
            other_date = root / "other-date"
            create_sample_rehearsal_bundle(target_date="2099-09-13", output_dir=baseline)
            shutil.copytree(baseline, changed)
            races = (changed / "races.csv").read_bytes().replace("リハーサル特別".encode(), "比較確認特別".encode())
            self._rewrite_artifact(changed, "races.csv", races)
            comparison = compare_import_bundles(previous_dir=baseline, current_dir=changed)
            self.assertEqual(comparison["classification"], "RACE_DATA_CHANGED")
            self.assertEqual(comparison["recommendedAction"], "PREVIEW_RACE_DATA")

            create_sample_rehearsal_bundle(target_date="2099-09-14", output_dir=other_date)
            report = root / "failed-comparison.json"
            with patch("tools.jra_van_bridge.cli._json"):
                status = main([
                    "compare-bundles", "--previous-dir", str(baseline), "--current-dir", str(other_date),
                    "--report", str(report),
                ])
            self.assertEqual(status, 2)
            failure = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(failure["status"], "FAILED")
            self.assertFalse(failure["automaticImportAttempted"])
            self.assertTrue(any("対象日" in issue for issue in failure["issues"]))

    def test_jvlink_readiness_is_safe_and_probe_does_not_initialize_service(self) -> None:
        readiness = JvLinkReadiness(True, 64, "3.14.0", True, True, True)
        self.assertTrue(readiness.ready_for_probe)
        calls: list[str] = []
        result = probe_jvlink(
            readiness=readiness,
            dispatcher=lambda prog_id: calls.append(prog_id) or object(),
            co_initialize=lambda: calls.append("CoInitialize"),
            co_uninitialize=lambda: calls.append("CoUninitialize"),
        )
        self.assertEqual(calls, ["CoInitialize", "JVDTLab.JVLink", "CoUninitialize"])
        self.assertEqual(result["jvInitCalled"], False)
        self.assertEqual(result["liveConnectionAttempted"], False)

    def test_jvlink_probe_reports_missing_dependency_without_dispatch(self) -> None:
        readiness = JvLinkReadiness(True, 64, "3.14.0", True, False, False)
        with self.assertRaisesRegex(JvLinkUnavailableError, "pywin32"):
            probe_jvlink(readiness=readiness, dispatcher=lambda _: self.fail("dispatch must not run"))

    def test_jvlink_probe_hides_raw_com_error_and_always_uninitializes(self) -> None:
        readiness = JvLinkReadiness(True, 64, "3.14.0", True, True, True)
        calls: list[str] = []

        class FakeComError(Exception):
            hresult = -2147221005

        def fail_dispatch(_: str) -> object:
            raise FakeComError("private-path-or-setting")

        with self.assertRaises(JvLinkUnavailableError) as raised:
            probe_jvlink(
                readiness=readiness,
                dispatcher=fail_dispatch,
                co_initialize=lambda: calls.append("CoInitialize"),
                co_uninitialize=lambda: calls.append("CoUninitialize"),
            )
        self.assertEqual(raised.exception.code, "JVLINK_COM_DISPATCH_FAILED")
        self.assertIn("HRESULT -2147221005", str(raised.exception))
        self.assertNotIn("private-path-or-setting", str(raised.exception))
        self.assertEqual(calls, ["CoInitialize", "CoUninitialize"])

    def test_checked_in_sample_matches_converter_output(self) -> None:
        samples = Path(__file__).parents[1] / "samples"
        source = (samples / "decoded-se.jsonl").read_text(encoding="utf-8")
        expected = (samples / "expected-results.csv").read_bytes()
        self.assertEqual(render_csv(parse_json_lines(source)), expected)

    def test_output_is_sorted_and_stable(self) -> None:
        source = json_lines(row(horseNumber=2, finishPosition=2), row(horseNumber=1, finishPosition=1))
        first = render_csv(parse_json_lines(source))
        second = render_csv(parse_json_lines(source))
        self.assertEqual(first, second)
        self.assertEqual(first.decode().splitlines()[1].split(",")[4], "1")
        self.assertEqual(parse_bridge_csv(first.decode()), parse_json_lines(source))

    def test_rejects_unknown_fields_duplicates_and_inconsistent_cancel(self) -> None:
        with self.assertRaisesRegex(BridgeValidationError, "未対応項目: payout"):
            parse_json_lines(json_lines(row(payout=500)))
        with self.assertRaisesRegex(BridgeValidationError, "重複"):
            parse_json_lines(json_lines(row(), row()))
        with self.assertRaisesRegex(BridgeValidationError, "raceCanceledが一致"):
            parse_json_lines(
                json_lines(
                    row(horseNumber=1),
                    row(
                        horseNumber=2,
                        abnormalCode="0",
                        finishPosition=None,
                        popularity=None,
                        finalOdds=None,
                        raceCanceled=True,
                    ),
                )
            )

    def test_rejects_result_fields_for_canceled_or_non_finished_horse(self) -> None:
        with self.assertRaisesRegex(BridgeValidationError, "レース中止時"):
            parse_json_lines(json_lines(row(raceCanceled=True)))
        with self.assertRaisesRegex(BridgeValidationError, "完走以外"):
            parse_json_lines(json_lines(row(abnormalCode="1", finishPosition=None)))

    def test_manifest_has_hashes_and_no_source_rows(self) -> None:
        source = json_lines(row()).encode()
        rows = parse_json_lines(source.decode())
        output = render_csv(rows)
        manifest = build_manifest(rows, source, output, "private/path/decoded-se.jsonl")
        self.assertRegex(manifest["sourceSha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(manifest["outputSha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(manifest["sourceFile"], "decoded-se.jsonl")
        self.assertNotIn("rows", manifest)

    def test_atomic_write_refuses_overwrite_without_force(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "result.csv"
            atomic_write(target, b"first", force=False)
            with self.assertRaises(FileExistsError):
                atomic_write(target, b"second", force=False)
            self.assertEqual(target.read_bytes(), b"first")
            atomic_write(target, b"second", force=True)
            self.assertEqual(target.read_bytes(), b"second")


if __name__ == "__main__":
    unittest.main()
