from __future__ import annotations

import csv
import hashlib
import io
import json
import os
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable

from . import BRIDGE_VERSION, FORMAT_VERSION


HEADERS = (
    "recordType",
    "raceDate",
    "venueCode",
    "raceNumber",
    "horseNumber",
    "abnormalCode",
    "finishPosition",
    "popularity",
    "finalOdds",
    "raceCanceled",
)
VENUE_CODES = frozenset(f"{number:02d}" for number in range(1, 11))
ABNORMAL_CODES = frozenset(str(number) for number in range(8))
FINISHED_ABNORMAL_CODES = frozenset({"0", "6", "7"})
REQUIRED_JSON_FIELDS = frozenset(HEADERS)


class BridgeValidationError(ValueError):
    """Raised when decoded SDK data cannot safely enter the bridge contract."""

    def __init__(self, issues: list[str]):
        self.issues = issues
        super().__init__("\n".join(issues))


@dataclass(frozen=True, slots=True)
class BridgeRow:
    record_type: str
    race_date: str
    venue_code: str
    race_number: int
    horse_number: int
    abnormal_code: str
    finish_position: int | None
    popularity: int | None
    final_odds: str | None
    race_canceled: bool

    @property
    def race_key(self) -> tuple[str, str, int]:
        return (self.race_date, self.venue_code, self.race_number)

    @property
    def sort_key(self) -> tuple[str, str, int, int]:
        return (*self.race_key, self.horse_number)

    def as_csv_row(self) -> list[str]:
        return [
            self.record_type,
            self.race_date,
            self.venue_code,
            str(self.race_number),
            str(self.horse_number),
            self.abnormal_code,
            "" if self.finish_position is None else str(self.finish_position),
            "" if self.popularity is None else str(self.popularity),
            "" if self.final_odds is None else self.final_odds,
            "true" if self.race_canceled else "false",
        ]


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _integer(value: Any, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field}は{minimum}〜{maximum}の整数で指定してください。")
    if value < minimum or value > maximum:
        raise ValueError(f"{field}は{minimum}〜{maximum}の範囲で指定してください。")
    return value


def _nullable_integer(value: Any, field: str) -> int | None:
    if value is None:
        return None
    return _integer(value, field, 1, 18)


def _odds(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError("finalOddsは整数または小数1桁で指定してください。")
    raw = str(value)
    try:
        parsed = Decimal(raw)
    except InvalidOperation as error:
        raise ValueError("finalOddsは整数または小数1桁で指定してください。") from error
    if parsed < 0 or parsed > Decimal("9999999.9") or parsed.as_tuple().exponent < -1:
        raise ValueError("finalOddsは0〜9999999.9の整数または小数1桁で指定してください。")
    return format(parsed, "f")


def parse_mapping(value: Any) -> BridgeRow:
    if not isinstance(value, dict):
        raise ValueError("JSONオブジェクトを指定してください。")
    fields = frozenset(value)
    missing = sorted(REQUIRED_JSON_FIELDS - fields)
    unknown = sorted(fields - REQUIRED_JSON_FIELDS)
    if missing or unknown:
        details = []
        if missing:
            details.append(f"不足項目: {', '.join(missing)}")
        if unknown:
            details.append(f"未対応項目: {', '.join(unknown)}")
        raise ValueError(" / ".join(details))

    record_type = value["recordType"]
    if record_type != "SE":
        raise ValueError("recordTypeは馬毎レース情報を示すSEだけを指定してください。")

    race_date = value["raceDate"]
    if not isinstance(race_date, str):
        raise ValueError("raceDateはYYYY-MM-DD形式で指定してください。")
    try:
        if date.fromisoformat(race_date).isoformat() != race_date:
            raise ValueError
    except ValueError as error:
        raise ValueError("raceDateは実在する日付をYYYY-MM-DD形式で指定してください。") from error

    venue_code = value["venueCode"]
    if venue_code not in VENUE_CODES:
        raise ValueError("venueCodeは中央競馬の01〜10を文字列で指定してください。")
    abnormal_code = value["abnormalCode"]
    if abnormal_code not in ABNORMAL_CODES:
        raise ValueError("abnormalCodeは0〜7を文字列で指定してください。")
    race_canceled = value["raceCanceled"]
    if not isinstance(race_canceled, bool):
        raise ValueError("raceCanceledはtrueまたはfalseで指定してください。")

    finish_position = _nullable_integer(value["finishPosition"], "finishPosition")
    popularity = _nullable_integer(value["popularity"], "popularity")
    final_odds = _odds(value["finalOdds"])
    if race_canceled and any(item is not None for item in (finish_position, popularity, final_odds)):
        raise ValueError("レース中止時は着順、人気、確定単勝をnullにしてください。")
    if not race_canceled and abnormal_code in FINISHED_ABNORMAL_CODES and finish_position is None:
        raise ValueError("完走扱いの馬にはfinishPositionが必要です。")
    if not race_canceled and abnormal_code not in FINISHED_ABNORMAL_CODES:
        if any(item is not None for item in (finish_position, popularity, final_odds)):
            raise ValueError("完走以外の馬は着順、人気、確定単勝をnullにしてください。")

    return BridgeRow(
        record_type=record_type,
        race_date=race_date,
        venue_code=venue_code,
        race_number=_integer(value["raceNumber"], "raceNumber", 1, 12),
        horse_number=_integer(value["horseNumber"], "horseNumber", 1, 18),
        abnormal_code=abnormal_code,
        finish_position=finish_position,
        popularity=popularity,
        final_odds=final_odds,
        race_canceled=race_canceled,
    )


def parse_json_lines(source: str) -> list[BridgeRow]:
    rows: list[BridgeRow] = []
    issues: list[str] = []
    for line_number, line in enumerate(source.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
            rows.append(parse_mapping(value))
        except (json.JSONDecodeError, ValueError) as error:
            issues.append(f"{line_number}行目: {error}")
    if not rows and not issues:
        issues.append("データ行がありません。")
    if issues:
        raise BridgeValidationError(issues)
    return validate_rows(rows)


def parse_bridge_csv(source: str) -> list[BridgeRow]:
    try:
        values = list(csv.reader(io.StringIO(source.lstrip("\ufeff"))))
    except csv.Error as error:
        raise BridgeValidationError([f"CSVを解析できません: {error}"]) from error
    if not values:
        raise BridgeValidationError(["CSVが空です。"])
    if tuple(values[0]) != HEADERS:
        raise BridgeValidationError([f"見出しは次の順序にしてください: {','.join(HEADERS)}"])

    rows: list[BridgeRow] = []
    issues: list[str] = []
    for line_number, values_row in enumerate(values[1:], start=2):
        if len(values_row) != len(HEADERS):
            issues.append(f"{line_number}行目: 列数が見出しと一致しません。")
            continue
        mapping: dict[str, Any] = dict(zip(HEADERS, values_row, strict=True))
        try:
            mapping["raceNumber"] = int(mapping["raceNumber"])
            mapping["horseNumber"] = int(mapping["horseNumber"])
            mapping["finishPosition"] = int(mapping["finishPosition"]) if mapping["finishPosition"] else None
            mapping["popularity"] = int(mapping["popularity"]) if mapping["popularity"] else None
            mapping["finalOdds"] = mapping["finalOdds"] or None
            if mapping["raceCanceled"] not in {"true", "false"}:
                raise ValueError("raceCanceledはtrueまたはfalseで指定してください。")
            mapping["raceCanceled"] = mapping["raceCanceled"] == "true"
            rows.append(parse_mapping(mapping))
        except ValueError as error:
            issues.append(f"{line_number}行目: {error}")
    if not rows and not issues:
        issues.append("データ行がありません。")
    if issues:
        raise BridgeValidationError(issues)
    return validate_rows(rows)


def validate_rows(rows: Iterable[BridgeRow]) -> list[BridgeRow]:
    ordered = sorted(rows, key=lambda row: row.sort_key)
    issues: list[str] = []
    seen: set[tuple[str, str, int, int]] = set()
    race_canceled: dict[tuple[str, str, int], bool] = {}
    for row in ordered:
        if row.sort_key in seen:
            issues.append(
                f"{row.race_date}/{row.venue_code}/{row.race_number}Rの馬番{row.horse_number}が重複しています。"
            )
        seen.add(row.sort_key)
        previous = race_canceled.setdefault(row.race_key, row.race_canceled)
        if previous != row.race_canceled:
            issues.append(
                f"{row.race_date}/{row.venue_code}/{row.race_number}RでraceCanceledが一致しません。"
            )
    if not ordered:
        issues.append("データ行がありません。")
    if issues:
        raise BridgeValidationError(issues)
    return ordered


def render_csv(rows: Iterable[BridgeRow]) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(HEADERS)
    writer.writerows(row.as_csv_row() for row in validate_rows(rows))
    return output.getvalue().encode("utf-8")


def build_summary(rows: list[BridgeRow], output_bytes: bytes) -> dict[str, Any]:
    races = sorted({row.race_key for row in rows})
    dates = sorted({row.race_date for row in rows})
    return {
        "bridgeVersion": BRIDGE_VERSION,
        "formatVersion": FORMAT_VERSION,
        "rowCount": len(rows),
        "raceCount": len(races),
        "targetDateFrom": dates[0],
        "targetDateTo": dates[-1],
        "outputSha256": sha256_bytes(output_bytes),
    }


def build_manifest(
    rows: list[BridgeRow],
    input_bytes: bytes,
    output_bytes: bytes,
    input_name: str,
    *,
    source_kind: str = "DECODED_SE_JSONL",
) -> dict[str, Any]:
    return {
        **build_summary(rows, output_bytes),
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "sourceKind": source_kind,
        "sourceFile": Path(input_name).name,
        "sourceSha256": sha256_bytes(input_bytes),
    }


def atomic_write(path: Path, content: bytes, *, force: bool) -> None:
    path = path.resolve()
    if path.exists() and not force:
        raise FileExistsError(f"既存ファイルを上書きしません: {path}（必要な場合は--forceを指定）")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
