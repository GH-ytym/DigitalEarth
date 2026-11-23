"""ORB1: little-endian decimetre ECEF, signed second differences as zigzag varints."""
import struct

HEADER = struct.Struct("<4sIii")


def encode(rows, step):
    if not rows or len(rows) > 20000 or step <= 0:
        raise ValueError("Invalid orbit block dimensions")
    start = int(rows[0][0])
    out = bytearray(HEADER.pack(b"ORB1", len(rows), start, step))
    previous = [0, 0, 0]
    velocity = [0, 0, 0]
    for i, (dt, *point) in enumerate(rows):
        if dt != start + i * step or len(point) != 3:
            raise ValueError("Irregular orbit samples")
        for axis, position in enumerate(point):
            value = round(position * 10)
            delta = value - previous[axis]
            residual = delta - velocity[axis]
            previous[axis], velocity[axis] = value, delta
            word = 2 * residual if residual >= 0 else -2 * residual - 1
            while word >= 128:
                out.append((word & 127) | 128)
                word >>= 7
            out.append(word)
    return bytes(out)
