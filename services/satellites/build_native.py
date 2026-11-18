from pathlib import Path
import struct
import subprocess
import sys

root = Path(__file__).resolve().parent
if sys.platform != "win32" or struct.calcsize("P") != 8:
    raise SystemExit("Build on Windows with an x64 Python interpreter.")
(root / "build").mkdir(exist_ok=True)
subprocess.run([
    sys.executable, "-m", "ziglang", "c++", "-target", "x86_64-windows-gnu",
    "-std=c++17", "-shared", "-O2", "-Wno-dangling-else",
    str(root / "native/orbit.cpp"), str(root / "native/vendor/SGP4.cpp"),
    "-o", str(root / "build/satellites.dll"),
], cwd=root, check=True)
print(root / "build/satellites.dll")
