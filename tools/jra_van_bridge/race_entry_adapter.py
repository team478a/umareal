from __future__ import annotations

import csv
import io
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable
from uuid import NAMESPACE_URL, uuid5

from .bridge import BridgeValidationError, sha256_bytes
from .sdk_adapter import load_sdk_structure


SDK_RA_RECORD_BYTES = 1272
SDK_SE_RECORD_BYTES = 555
CATALOG_FORMAT_VERSION = "UMAREAL_JRA_VAN_RACE_ENTRY_V1"

VENUES = {
    "01": "札幌",
    "02": "函館",
    "03": "福島",
    "04": "新潟",
    "05": "東京",
    "06": "中山",
    "07": "中京",
    "08": "京都",
    "09": "阪神",
    "10": "小倉",
}
TRACKS = {
    "10": ("TURF", "STRAIGHT"),
    "11": ("TURF", "LEFT"),
    "12": ("TURF", "LEFT"),
    "13": ("TURF", "LEFT"),
    "14": ("TURF", "LEFT"),
    "15": ("TURF", "LEFT"),
    "16": ("TURF", "LEFT"),
    "17": ("TURF", "RIGHT"),
    "18": ("TURF", "RIGHT"),
    "19": ("TURF", "RIGHT"),
    "20": ("TURF", "RIGHT"),
    "21": ("TURF", "RIGHT"),
    "22": ("TURF", "RIGHT"),
    "23": ("DIRT", "LEFT"),
    "24": ("DIRT", "RIGHT"),
    "25": ("DIRT", "LEFT"),
    "26": ("DIRT", "RIGHT"),
    "29": ("DIRT", "STRAIGHT"),
}
GOING = {"0": "UNKNOWN", "1": "GOOD", "2": "YIELDING", "3": "SOFT", "4": "HEAVY"}
WEATHER = {"0": "未確認", "1": "晴", "2": "曇", "3": "雨", "4": "小雨", "5": "雪", "6": "小雪"}
SEX = {"1": "MALE", "2": "FEMALE", "3": "GELDING"}
ENTRY_STATUS = {
    "0": "ACTIVE",
    "1": "SCRATCHED",
    "2": "EXCLUDED",
    "3": "EXCLUDED",
    "4": "STOPPED",
    "5": "EXCLUDED",
    "6": "ACTIVE",
    "7": "ACTIVE",
}

RACE_HEADERS = (
    "raceDate",
    "venue",
    "number",
    "name",
    "raceClass",
    "distance",
    "surface",
    "direction",
    "startsAt",
    "going",
    "weather",
    "status",
    "expertId",
)
ENTRY_HEADERS = (
    "horseId",
    "number",
    "gate",
    "horseName",
    "sex",
    "age",
    "carriedWeight",
    "jockey",
    "trainer",
    "winOdds",
    "popularity",
    "status",
)


@dataclass(frozen=True, slots=True)
class RaceCsvRow:
    raceDate: str
    venue: str
    number: int
    name: str
    raceClass: str
    distance: int
    surface: str
    direction: str
    startsAt: str
    going: str
    weather: str
    status: str = "SCHEDULED"
    expertId: str = ""


@dataclass(frozen=True, slots=True)
class EntryCsvRow:
    horseId: str
    number: int
    gate: int
    horseName: str
    sex: str
    age: int
    carriedWeight: str
    jockey: str
    trainer: str
    winOdds: str
    popularity: str
    status: str


def _raw(value: Any) -> str:
    return str(value).strip()


def _integer(value: Any, field: str, *, minimum: int, maximum: int) -> int:
    raw = _raw(value)
    if not raw.isdigit():
        raise ValueError(f"{field}が数値ではありません。")
    parsed = int(raw)
    if not minimum <= parsed <= maximum:
        raise ValueError(f"{field}は{minimum}〜{maximum}である必要があります。")
    return parsed


def _safe_text(value: Any, field: str, *, maximum: int, fallback: str | None = None) -> str:
    text = _raw(value) or fallback or ""
    if not text:
        raise ValueError(f"{field}が空です。")
    if len(text) > maximum:
        raise ValueError(f"{field}は{maximum}文字以内である必要があります。")
    if text[0] in "=+-@\t\r" or any(ord(character) < 32 for character in text):
        raise ValueError(f"{field}に数式または制御文字は使用できません。")
    return text


def _race_date(identifier: Any) -> str:
    year = _raw(identifier.Year)
    month_day = _raw(identifier.MonthDay)
    if len(year) != 4 or not year.isdigit() or len(month_day) != 4 or not month_day.isdigit():
        raise ValueError("開催年月日が不正です。")
    value = f"{year}-{month_day[:2]}-{month_day[2:]}"
    datetime.strptime(value, "%Y-%m-%d")
    return value


def _race_key(identifier: Any) -> tuple[str, str, int]:
    venue_code = _raw(identifier.JyoCD)
    if venue_code not in VENUES:
        raise ValueError(f"中央10場以外の競馬場コードです: {venue_code or '(空)'}")
    return (
        _race_date(identifier),
        venue_code,
        _integer(identifier.RaceNum, "RaceNum", minimum=1, maximum=12),
    )


def map_sdk_ra(record: Any) -> RaceCsvRow:
    if _raw(record.head.RecordSpec) != "RA":
        raise ValueError("RA以外のJV-Dataレコードは入力できません。")
    race_date, venue_code, race_number = _race_key(record.id)
    track_code = _raw(record.TrackCD)
    if track_code not in TRACKS:
        raise ValueError(f"未対応のトラックコードです: {track_code or '(空)'}")
    surface, direction = TRACKS[track_code]
    start = _raw(record.HassoTime)
    if len(start) != 4 or not start.isdigit() or int(start[:2]) > 23 or int(start[2:]) > 59:
        raise ValueError("HassoTimeは有効なHHMM形式である必要があります。")
    starts_at = f"{race_date}T{start[:2]}:{start[2:]}:00+09:00"
    datetime.fromisoformat(starts_at)
    going_code = _raw(record.TenkoBaba.SibaBabaCD if surface == "TURF" else record.TenkoBaba.DirtBabaCD)
    weather_code = _raw(record.TenkoBaba.TenkoCD)
    if going_code not in GOING:
        raise ValueError(f"未対応の馬場状態コードです: {going_code or '(空)'}")
    if weather_code not in WEATHER:
        raise ValueError(f"未対応の天候コードです: {weather_code or '(空)'}")
    return RaceCsvRow(
        raceDate=race_date,
        venue=VENUES[venue_code],
        number=race_number,
        name=_safe_text(record.RaceInfo.Hondai, "Hondai", maximum=100, fallback=f"第{race_number}競走"),
        raceClass=_safe_text(record.JyokenName, "JyokenName", maximum=60),
        distance=_integer(record.Kyori, "Kyori", minimum=400, maximum=5000),
        surface=surface,
        direction=direction,
        startsAt=starts_at,
        going=GOING[going_code],
        weather=WEATHER[weather_code],
    )


def _tenths(value: Any, field: str, *, minimum: int, maximum: int, optional: bool = False) -> str:
    raw = _raw(value)
    if not raw or set(raw) == {"0"}:
        if optional:
            return ""
        raise ValueError(f"{field}が空です。")
    if not raw.isdigit():
        raise ValueError(f"{field}が数値ではありません。")
    amount = int(raw)
    if not minimum * 10 <= amount <= maximum * 10:
        raise ValueError(f"{field}が範囲外です。")
    return f"{amount // 10}.{amount % 10}"


def stable_horse_uuid(ketto_number: Any) -> str:
    value = _raw(ketto_number)
    if len(value) != 10 or not value.isdigit() or set(value) == {"0"}:
        raise ValueError("KettoNumは10桁の血統登録番号である必要があります。")
    return str(uuid5(NAMESPACE_URL, f"https://jra-van.jp/horse/{value}"))


def map_sdk_entry(record: Any) -> tuple[tuple[str, str, int], EntryCsvRow]:
    if _raw(record.head.RecordSpec) != "SE":
        raise ValueError("SE以外のJV-Dataレコードは入力できません。")
    key = _race_key(record.id)
    sex_code = _raw(record.SexCD)
    status_code = _raw(record.IJyoCD)
    if sex_code not in SEX:
        raise ValueError(f"未対応の性別コードです: {sex_code or '(空)'}")
    if status_code not in ENTRY_STATUS:
        raise ValueError(f"未対応の異常区分コードです: {status_code or '(空)'}")
    popularity_value = _raw(record.Ninki)
    popularity = "" if not popularity_value or set(popularity_value) == {"0"} else str(
        _integer(popularity_value, "Ninki", minimum=1, maximum=18)
    )
    return key, EntryCsvRow(
        horseId=stable_horse_uuid(record.KettoNum),
        number=_integer(record.Umaban, "Umaban", minimum=1, maximum=18),
        gate=_integer(record.Wakuban, "Wakuban", minimum=1, maximum=8),
        horseName=_safe_text(record.Bamei, "Bamei", maximum=80),
        sex=SEX[sex_code],
        age=_integer(record.Barei, "Barei", minimum=2, maximum=30),
        carriedWeight=_tenths(record.Futan, "Futan", minimum=30, maximum=80),
        jockey=_safe_text(record.KisyuRyakusyo, "KisyuRyakusyo", maximum=60),
        trainer=_safe_text(record.ChokyosiRyakusyo, "ChokyosiRyakusyo", maximum=60),
        winOdds=_tenths(record.Odds, "Odds", minimum=1, maximum=99999, optional=True),
        popularity=popularity,
        status=ENTRY_STATUS[status_code],
    )


def _decode(
    source: bytes,
    *,
    size: int,
    record_type: bytes,
    factory: Any,
    mapper: Any,
    target_date: str | None = None,
) -> list[Any]:
    records = source.splitlines(keepends=True)
    if not records:
        raise BridgeValidationError([f"{record_type.decode()}レコードがありません。"])
    rows: list[Any] = []
    issues: list[str] = []
    for index, raw in enumerate(records, start=1):
        try:
            if len(raw) != size:
                raise ValueError(f"レコード長は{size}バイトである必要があります。")
            if raw[:2] != record_type:
                raise ValueError(f"{record_type.decode()}以外のJV-Dataレコードは入力できません。")
            record = factory(raw)
            if target_date is not None and _race_date(record.id) != target_date:
                continue
            rows.append(mapper(record))
        except Exception as error:
            issues.append(f"{index}レコード目: {error}")
    if issues:
        raise BridgeValidationError(issues)
    return rows


def decode_sdk_ra_records(
    source: bytes,
    structure_path: Path,
    *,
    target_date: str | None = None,
) -> list[RaceCsvRow]:
    module = load_sdk_structure(structure_path)
    if not hasattr(module, "JV_RA_RACE") or not hasattr(module.JV_RA_RACE, "SetDataB"):
        raise ValueError("JV_RA_RACE.SetDataBが見つかりません。")
    rows = _decode(
        source,
        size=SDK_RA_RECORD_BYTES,
        record_type=b"RA",
        factory=module.JV_RA_RACE.SetDataB,
        mapper=map_sdk_ra,
        target_date=target_date,
    )
    if not rows:
        raise BridgeValidationError(["対象日のRAレコードがありません。"])
    return validate_races(rows)


def decode_sdk_entry_groups(
    source: bytes,
    structure_path: Path,
    *,
    target_date: str,
) -> dict[tuple[str, str, int], list[EntryCsvRow]]:
    module = load_sdk_structure(structure_path)
    if not hasattr(module, "JV_SE_RACE_UMA") or not hasattr(module.JV_SE_RACE_UMA, "SetDataB"):
        raise ValueError("JV_SE_RACE_UMA.SetDataBが見つかりません。")
    mapped = _decode(
        source,
        size=SDK_SE_RECORD_BYTES,
        record_type=b"SE",
        factory=module.JV_SE_RACE_UMA.SetDataB,
        mapper=map_sdk_entry,
        target_date=target_date,
    )
    groups: dict[tuple[str, str, int], list[EntryCsvRow]] = {}
    for key, row in mapped:
        groups.setdefault(key, []).append(row)
    if not groups:
        raise BridgeValidationError(["対象日のSEレコードがありません。"])
    return {key: validate_entries(rows) for key, rows in sorted(groups.items())}


def decode_sdk_entry_records(
    source: bytes,
    structure_path: Path,
    *,
    race_date: str,
    venue_code: str,
    race_number: int,
) -> list[EntryCsvRow]:
    target = (race_date, venue_code, race_number)
    rows = decode_sdk_entry_groups(source, structure_path, target_date=race_date).get(target, [])
    if not rows:
        raise BridgeValidationError(["指定したレースのSEレコードがありません。"])
    return validate_entries(rows)


def validate_races(rows: Iterable[RaceCsvRow]) -> list[RaceCsvRow]:
    sorted_rows = sorted(rows, key=lambda row: (row.raceDate, row.venue, row.number))
    keys: set[tuple[str, str, int]] = set()
    for row in sorted_rows:
        key = (row.raceDate, row.venue, row.number)
        if key in keys:
            raise BridgeValidationError([f"レースが重複しています: {row.raceDate} {row.venue} {row.number}R"])
        keys.add(key)
    return sorted_rows


def validate_entries(rows: Iterable[EntryCsvRow]) -> list[EntryCsvRow]:
    sorted_rows = sorted(rows, key=lambda row: row.number)
    numbers: set[int] = set()
    horses: set[str] = set()
    for row in sorted_rows:
        if row.number in numbers:
            raise BridgeValidationError([f"馬番が重複しています: {row.number}"])
        if row.horseId in horses:
            raise BridgeValidationError([f"血統登録番号由来の馬IDが重複しています: {row.horseId}"])
        numbers.add(row.number)
        horses.add(row.horseId)
    return sorted_rows


def _render(headers: tuple[str, ...], rows: Iterable[Any]) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow(asdict(row))
    return buffer.getvalue().encode("utf-8")


def render_races_csv(rows: Iterable[RaceCsvRow]) -> bytes:
    return _render(RACE_HEADERS, validate_races(rows))


def render_entries_csv(rows: Iterable[EntryCsvRow]) -> bytes:
    return _render(ENTRY_HEADERS, validate_entries(rows))


def build_catalog_manifest(*, kind: str, rows: list[Any], input_bytes: bytes, output_bytes: bytes, input_name: str) -> dict[str, object]:
    if kind not in {"RACES", "ENTRIES"}:
        raise ValueError("manifest種別が不正です。")
    return {
        "formatVersion": CATALOG_FORMAT_VERSION,
        "kind": kind,
        "recordCount": len(rows),
        "sourceFile": Path(input_name).name,
        "sourceSha256": sha256_bytes(input_bytes),
        "outputSha256": sha256_bytes(output_bytes),
    }
