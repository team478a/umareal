from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

from .bridge import BridgeRow, BridgeValidationError, parse_mapping, validate_rows


SDK_SE_RECORD_BYTES = 555


def _number(value: Any, field: str) -> int | None:
    raw = str(value).strip()
    if not raw or set(raw) == {"0"}:
        return None
    if not raw.isdigit():
        raise ValueError(f"{field}が数値ではありません。")
    return int(raw)


def _odds(value: Any) -> str | None:
    raw = str(value).strip()
    if not raw or set(raw) == {"0"}:
        return None
    if not raw.isdigit():
        raise ValueError("Oddsが数値ではありません。")
    amount = int(raw)
    return f"{amount // 10}.{amount % 10}"


def map_sdk_se(record: Any, *, race_canceled: bool) -> BridgeRow:
    record_type = str(record.head.RecordSpec).strip()
    abnormal_code = str(record.IJyoCD).strip()
    finished = abnormal_code in {"0", "6", "7"} and not race_canceled
    month_day = str(record.id.MonthDay).strip()
    if len(month_day) != 4 or not month_day.isdigit():
        raise ValueError("MonthDayはMMDD形式である必要があります。")

    finish_position = _number(record.KakuteiJyuni, "KakuteiJyuni") if finished else None
    popularity = _number(record.Ninki, "Ninki") if finished else None
    final_odds = _odds(record.Odds) if finished else None
    return parse_mapping(
        {
            "recordType": record_type,
            "raceDate": f"{str(record.id.Year).strip()}-{month_day[:2]}-{month_day[2:]}",
            "venueCode": str(record.id.JyoCD).strip(),
            "raceNumber": _number(record.id.RaceNum, "RaceNum"),
            "horseNumber": _number(record.Umaban, "Umaban"),
            "abnormalCode": abnormal_code,
            "finishPosition": finish_position,
            "popularity": popularity,
            "finalOdds": final_odds,
            "raceCanceled": race_canceled,
        }
    )


def load_sdk_structure(path: Path) -> ModuleType:
    resolved = path.resolve()
    if not resolved.is_file() or resolved.name != "JVData_Struct.py":
        raise ValueError("SDK 5.0.0のJVData_Struct.pyを指定してください。")
    spec = importlib.util.spec_from_file_location("umareal_jvdata_struct", resolved)
    if spec is None or spec.loader is None:
        raise ValueError("JVData_Struct.pyを読み込めません。")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(spec.name, None)
        raise
    return module


def decode_sdk_se_records(source: bytes, structure_path: Path, *, race_canceled: bool) -> list[BridgeRow]:
    module = load_sdk_structure(structure_path)
    if not hasattr(module, "JV_SE_RACE_UMA") or not hasattr(module.JV_SE_RACE_UMA, "SetDataB"):
        raise ValueError("JV_SE_RACE_UMA.SetDataBが見つかりません。")
    records = source.splitlines(keepends=True)
    rows: list[BridgeRow] = []
    issues: list[str] = []
    if not records:
        raise BridgeValidationError(["SEレコードがありません。"])
    for index, raw in enumerate(records, start=1):
        try:
            if len(raw) != SDK_SE_RECORD_BYTES:
                raise ValueError(f"レコード長は{SDK_SE_RECORD_BYTES}バイトである必要があります。")
            if raw[:2] != b"SE":
                raise ValueError("SE以外のJV-Dataレコードは入力できません。")
            record = module.JV_SE_RACE_UMA.SetDataB(raw)
            rows.append(map_sdk_se(record, race_canceled=race_canceled))
        except Exception as error:
            issues.append(f"{index}レコード目: {error}")
    if issues:
        raise BridgeValidationError(issues)
    return validate_rows(rows)


def decode_sdk_final_se_groups(
    source: bytes,
    structure_path: Path,
    *,
    target_date: str,
) -> dict[tuple[str, str, int], list[BridgeRow]]:
    """Return only races whose complete SE group has final finish information."""
    module = load_sdk_structure(structure_path)
    if not hasattr(module, "JV_SE_RACE_UMA") or not hasattr(module.JV_SE_RACE_UMA, "SetDataB"):
        raise ValueError("JV_SE_RACE_UMA.SetDataBが見つかりません。")
    records = source.splitlines(keepends=True)
    if not records:
        raise BridgeValidationError(["SEレコードがありません。"])

    decoded: dict[tuple[str, str, int], list[Any]] = {}
    issues: list[str] = []
    for index, raw in enumerate(records, start=1):
        try:
            if len(raw) != SDK_SE_RECORD_BYTES:
                raise ValueError(f"レコード長は{SDK_SE_RECORD_BYTES}バイトである必要があります。")
            if raw[:2] != b"SE":
                raise ValueError("SE以外のJV-Dataレコードは入力できません。")
            record = module.JV_SE_RACE_UMA.SetDataB(raw)
            month_day = str(record.id.MonthDay).strip()
            if len(month_day) != 4 or not month_day.isdigit():
                raise ValueError("MonthDayはMMDD形式である必要があります。")
            race_date = f"{str(record.id.Year).strip()}-{month_day[:2]}-{month_day[2:]}"
            if race_date != target_date:
                continue
            race_number = _number(record.id.RaceNum, "RaceNum")
            if race_number is None:
                raise ValueError("RaceNumが空です。")
            key = (race_date, str(record.id.JyoCD).strip(), race_number)
            decoded.setdefault(key, []).append(record)
        except Exception as error:
            issues.append(f"{index}レコード目: {error}")
    if issues:
        raise BridgeValidationError(issues)

    finalized: dict[tuple[str, str, int], list[BridgeRow]] = {}
    for key, group in sorted(decoded.items()):
        finish_positions = [
            _number(record.KakuteiJyuni, "KakuteiJyuni")
            for record in group
            if str(record.IJyoCD).strip() in {"0", "6", "7"}
        ]
        ready = bool(finish_positions) and all(position is not None for position in finish_positions) and 1 in finish_positions
        if not ready:
            continue
        finalized[key] = validate_rows(map_sdk_se(record, race_canceled=False) for record in group)
    return finalized
