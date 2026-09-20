"""Observe the runner's lifetime without using an inherited stdin pipe."""
import os


class Owner:
    def __init__(self, pid):
        self.pid = pid
        self.handle = None
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            self.kernel.OpenProcess.restype = wintypes.HANDLE
            self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            self.kernel.WaitForSingleObject.restype = wintypes.DWORD
            self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            self.kernel.CloseHandle.restype = wintypes.BOOL
            # SYNCHRONIZE permits waiting only; this handle cannot terminate or
            # modify the parent. Keeping it open also prevents PID reuse races.
            self.handle = self.kernel.OpenProcess(0x00100000, False, pid)

    def alive(self):
        if os.name == "nt":
            return bool(self.handle and self.kernel.WaitForSingleObject(self.handle, 0) == 258)
        return os.getppid() == self.pid

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None
