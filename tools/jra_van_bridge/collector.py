from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Protocol


class JvLinkCollectionError(RuntimeError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


class JvLinkClient(Protocol):
    def JVInit(self, sid: str) -> Any: ...
    def JVOpen(self, dataspec: str, from_time: str, option: int, read_count: int, download_count: int, last_time: str) -> Any: ...
    def JVStatus(self) -> Any: ...
    def JVGets(self, buffer: bytearray, buffer_size: int, file_name: bytearray) -> Any: ...
    def JVClose(self) -> Any: ...


@dataclass(frozen=True, slots=True)
class CollectionSummary:
    records: list[bytes]
    read_count: int
    download_count: int
    ignored_record_count: int


@dataclass(frozen=True, slots=True)
class RaceCollectionSummary:
    ra_records: list[bytes]
    se_records: list[bytes]
    read_count: int
    download_count: int
    ignored_record_count: int


def _open_result(value: Any) -> tuple[int, int, int]:
    if isinstance(value, (list, tuple)):
        if len(value) < 3:
            raise JvLinkCollectionError("JVOPEN_INVALID_RESPONSE", "JVOpenの戻り値が不足しています。")
        return int(value[0]), int(value[1] or 0), int(value[2] or 0)
    return int(value), 0, 0


def collect_race_records(
    client: JvLinkClient,
    *,
    sid: str,
    from_time: str,
    timeout_seconds: int,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    maximum_records: int = 100_000,
) -> RaceCollectionSummary:
    if not sid or len(sid.encode("ascii", errors="ignore")) != len(sid) or len(sid) > 64:
        raise JvLinkCollectionError("SID_INVALID", "SIDは64バイト以内の半角文字で指定してください。")
    if len(from_time) != 14 or not from_time.isdigit():
        raise JvLinkCollectionError("FROM_TIME_INVALID", "from_timeはYYYYMMDDHHMMSS形式で指定してください。")
    if timeout_seconds < 1 or timeout_seconds > 1800:
        raise JvLinkCollectionError("TIMEOUT_INVALID", "timeout_secondsは1〜1800秒で指定してください。")

    init_code = int(client.JVInit(sid))
    if init_code != 0:
        raise JvLinkCollectionError("JVINIT_FAILED", f"JVInitに失敗しました (code {init_code})。")

    opened = False
    collection_error: BaseException | None = None
    try:
        open_code, read_count, download_count = _open_result(client.JVOpen("RACE", from_time, 2, 0, 0, ""))
        if open_code == -1:
            raise JvLinkCollectionError("NO_DATA", "対象となる今週データがありません。")
        if open_code != 0:
            raise JvLinkCollectionError("JVOPEN_FAILED", f"JVOpenに失敗しました (code {open_code})。")
        opened = True

        deadline = monotonic() + timeout_seconds
        while download_count > 0:
            status = int(client.JVStatus())
            if status < 0:
                raise JvLinkCollectionError("JVSTATUS_FAILED", f"JVStatusに失敗しました (code {status})。")
            if status >= download_count:
                break
            if monotonic() >= deadline:
                raise JvLinkCollectionError("DOWNLOAD_TIMEOUT", "JV-Linkのダウンロード完了を待機中にタイムアウトしました。")
            sleep(0.3)

        ra_records: list[bytes] = []
        se_records: list[bytes] = []
        ignored = 0
        while True:
            result = client.JVGets(bytearray(110_000), 110_000, bytearray())
            if not isinstance(result, (list, tuple)) or len(result) < 2:
                raise JvLinkCollectionError("JVGETS_INVALID_RESPONSE", "JVGetsの戻り値が不足しています。")
            return_code = int(result[0])
            if return_code > 0:
                raw = result[1].tobytes() if hasattr(result[1], "tobytes") else bytes(result[1])
                raw = raw[:return_code]
                if raw[:2] == b"RA":
                    ra_records.append(raw)
                elif raw[:2] == b"SE":
                    se_records.append(raw)
                else:
                    ignored += 1
                if len(ra_records) + len(se_records) > maximum_records:
                    raise JvLinkCollectionError("RECORD_LIMIT_EXCEEDED", "RA/SEレコード数が安全上限を超えました。")
            elif return_code == -1:
                continue
            elif return_code == 0:
                break
            else:
                raise JvLinkCollectionError("JVGETS_FAILED", f"JVGetsに失敗しました (code {return_code})。")
        if not ra_records and not se_records:
            raise JvLinkCollectionError("NO_RACE_RECORDS", "レース詳細（RA）と馬毎レース情報（SE）がありません。")
        return RaceCollectionSummary(ra_records, se_records, read_count, download_count, ignored)
    except BaseException as error:
        collection_error = error
        raise
    finally:
        if opened:
            try:
                client.JVClose()
            except Exception as error:
                if collection_error is None:
                    raise JvLinkCollectionError("JVCLOSE_FAILED", "JVCloseに失敗しました。") from error
                collection_error.add_note("JVCloseにも失敗しました。元の収集エラーを優先します。")


def collect_se_records(
    client: JvLinkClient,
    *,
    sid: str,
    from_time: str,
    timeout_seconds: int,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    maximum_records: int = 100_000,
) -> CollectionSummary:
    collected = collect_race_records(
        client,
        sid=sid,
        from_time=from_time,
        timeout_seconds=timeout_seconds,
        monotonic=monotonic,
        sleep=sleep,
        maximum_records=maximum_records,
    )
    if not collected.se_records:
        raise JvLinkCollectionError("NO_SE_RECORDS", "馬毎レース情報（SE）がありません。")
    return CollectionSummary(
        collected.se_records,
        collected.read_count,
        collected.download_count,
        collected.ignored_record_count + len(collected.ra_records),
    )
