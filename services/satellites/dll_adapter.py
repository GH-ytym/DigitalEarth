import ctypes as C
from datetime import datetime, timezone
from hashlib import sha256
import math
from pathlib import Path

ENGINE_VERSION = "vallado-sgp4-2025-12-30-wgs72-i"
FRAME_VERSION = "teme-gmst-utc-ut1-polar0-1"

def utc(value: str):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=timezone.utc)

def julian(value: datetime):
    return value.timestamp() / 86400 + 2440587.5

class OrbitLibrary:
    def __init__(self, path: Path):
        self.fingerprint = sha256(path.read_bytes()).hexdigest()[:16]
        self.library = C.CDLL(str(path.resolve()))
        self.function = self.library.de_sgp4
        self.function.argtypes = [C.POINTER(C.c_double), C.c_double, C.c_int32,
                                 C.c_double, C.POINTER(C.c_double), C.c_int32, C.POINTER(C.c_int32)]
        self.function.restype = C.c_int

    def propagate(self, record, start: datetime, duration=7200, step=10):
        names = ["MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE",
                 "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT"]
        elements = (C.c_double * 10)(julian(utc(record["EPOCH"])), *(float(record[name]) for name in names))
        count = duration // step + 1
        output = (C.c_double * (count * 4))()
        written = C.c_int32()
        code = self.function(elements, julian(start), count, step, output, count, C.byref(written))
        if code or written.value != count or any(not math.isfinite(value) for value in output):
            raise RuntimeError(f"SGP4 failed (code={code}, rows={written.value}).")
        return [list(output[offset:offset+4]) for offset in range(0, count * 4, 4)]
