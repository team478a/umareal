from __future__ import annotations

import importlib.util
import platform
import struct
import sys
from dataclasses import dataclass
from typing import Any, Callable


JVLINK_PROG_ID = "JVDTLab.JVLink"


class JvLinkUnavailableError(RuntimeError):
    """Raised when the local COM boundary is not ready for a safe probe."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class JvLinkReadiness:
    windows: bool
    architecture_bits: int
    python_version: str
    python_supported: bool
    pywin32_installed: bool
    com_registered: bool

    @property
    def ready_for_probe(self) -> bool:
        return (
            self.windows
            and self.architecture_bits == 64
            and self.python_supported
            and self.pywin32_installed
            and self.com_registered
        )

    def as_public_dict(self) -> dict[str, Any]:
        return {
            "windows": self.windows,
            "architectureBits": self.architecture_bits,
            "pythonVersion": self.python_version,
            "pythonSupported": self.python_supported,
            "pywin32Installed": self.pywin32_installed,
            "comRegistered": self.com_registered,
            "readyForProbe": self.ready_for_probe,
        }


def _pywin32_installed() -> bool:
    try:
        return importlib.util.find_spec("win32com.client") is not None and importlib.util.find_spec("pythoncom") is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def _com_registered() -> bool:
    if sys.platform != "win32":
        return False
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, JVLINK_PROG_ID):
            return True
    except OSError:
        return False


def get_readiness(
    *,
    pywin32_checker: Callable[[], bool] = _pywin32_installed,
    registration_checker: Callable[[], bool] = _com_registered,
) -> JvLinkReadiness:
    return JvLinkReadiness(
        windows=platform.system() == "Windows",
        architecture_bits=struct.calcsize("P") * 8,
        python_version=platform.python_version(),
        python_supported=sys.version_info >= (3, 11),
        pywin32_installed=pywin32_checker(),
        com_registered=registration_checker(),
    )


def probe_jvlink(
    *,
    readiness: JvLinkReadiness | None = None,
    dispatcher: Callable[[str], object] | None = None,
    co_initialize: Callable[[], None] | None = None,
    co_uninitialize: Callable[[], None] | None = None,
) -> dict[str, Any]:
    status = readiness or get_readiness()
    if not status.windows or status.architecture_bits != 64 or not status.python_supported:
        raise JvLinkUnavailableError("UNSUPPORTED_RUNTIME", "Windows 64bit / Python 3.14の実行環境が必要です。")
    if not status.pywin32_installed:
        raise JvLinkUnavailableError(
            "PYWIN32_NOT_INSTALLED",
            "pywin32がありません。pnpm bridge:jra-van:setupを実行してください。",
        )
    if not status.com_registered:
        raise JvLinkUnavailableError(
            "JVLINK_NOT_REGISTERED",
            "JVDTLab.JVLinkがCOM登録されていません。JRA-VAN SDK 5.0.0 64bitのJV-Linkを導入してください。",
        )

    if dispatcher is None or co_initialize is None or co_uninitialize is None:
        import pythoncom
        import win32com.client

        dispatcher = dispatcher or win32com.client.Dispatch
        co_initialize = co_initialize or pythoncom.CoInitialize
        co_uninitialize = co_uninitialize or pythoncom.CoUninitialize

    initialized = False
    try:
        co_initialize()
        initialized = True
        instance = dispatcher(JVLINK_PROG_ID)
        del instance
    except Exception as error:
        hresult = getattr(error, "hresult", None)
        suffix = f" (HRESULT {hresult})" if isinstance(hresult, int) else ""
        raise JvLinkUnavailableError(
            "JVLINK_COM_DISPATCH_FAILED",
            f"JV-Link COMオブジェクトを取得できませんでした{suffix}。",
        ) from error
    finally:
        if initialized:
            co_uninitialize()

    return {
        "progId": JVLINK_PROG_ID,
        "comObjectAvailable": True,
        "jvInitCalled": False,
        "liveConnectionAttempted": False,
        "credentialsRead": False,
    }
