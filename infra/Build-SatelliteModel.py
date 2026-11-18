"""Create an original, small glTF 2.0 satellite teaching model; no external assets."""
import json
from pathlib import Path
import struct

root = Path(__file__).resolve().parents[1]
positions, normals, indices = [], [], []
faces = [
    ((1, 0, 0), [(1,-1,-1),(1,1,-1),(1,1,1),(1,-1,1)]),
    ((-1,0,0), [(-1,1,-1),(-1,-1,-1),(-1,-1,1),(-1,1,1)]),
    ((0,1,0), [(1,1,-1),(-1,1,-1),(-1,1,1),(1,1,1)]),
    ((0,-1,0), [(-1,-1,-1),(1,-1,-1),(1,-1,1),(-1,-1,1)]),
    ((0,0,1), [(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]),
    ((0,0,-1), [(-1,1,-1),(1,1,-1),(1,-1,-1),(-1,-1,-1)]),
]
for normal, corners in faces:
    base = len(positions) // 3
    for corner in corners:
        positions.extend(c / 2 for c in corner)
        normals.extend(normal)
    indices.extend(base + i for i in (0,1,2,0,2,3))
pos = struct.pack(f"<{len(positions)}f", *positions)
norm = struct.pack(f"<{len(normals)}f", *normals)
idx = struct.pack(f"<{len(indices)}H", *indices)
binary = pos + norm + idx
binary += b"\0" * (-len(binary) % 4)
materials = [
    {"name":"gold-foil", "pbrMetallicRoughness":{"baseColorFactor":[0.8,0.57,0.2,1],"metallicFactor":0.6,"roughnessFactor":0.55}},
    {"name":"solar-blue", "pbrMetallicRoughness":{"baseColorFactor":[0.06,0.23,0.55,1],"metallicFactor":0.3,"roughnessFactor":0.6}},
    {"name":"silver", "pbrMetallicRoughness":{"baseColorFactor":[0.7,0.76,0.8,1],"metallicFactor":0.65,"roughnessFactor":0.45}},
]
nodes = [
    {"mesh":0,"scale":[1.3,1.1,1.2]},
    {"mesh":1,"translation":[0,-2.1,0],"scale":[1.6,2.6,0.07]},
    {"mesh":1,"translation":[0,2.1,0],"scale":[1.6,2.6,0.07]},
    {"mesh":2,"scale":[0.1,6.2,0.1]},
    {"mesh":2,"translation":[0.95,0,0],"scale":[0.6,0.18,0.18]},
    {"mesh":2,"translation":[1.3,0,0],"scale":[0.12,0.7,0.7]},
]
document = {"asset":{"version":"2.0","generator":"Orbit learning original procedural model"},
    "scene":0,"scenes":[{"nodes":list(range(len(nodes)))}],"nodes":nodes,
    "buffers":[{"byteLength":len(binary)}],
    "bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":len(pos),"target":34962},
        {"buffer":0,"byteOffset":len(pos),"byteLength":len(norm),"target":34962},
        {"buffer":0,"byteOffset":len(pos)+len(norm),"byteLength":len(idx),"target":34963}],
    "accessors":[{"bufferView":0,"componentType":5126,"count":24,"type":"VEC3","min":[-.5,-.5,-.5],"max":[.5,.5,.5]},
        {"bufferView":1,"componentType":5126,"count":24,"type":"VEC3"},
        {"bufferView":2,"componentType":5123,"count":36,"type":"SCALAR"}],
    "materials":materials,"meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1},"indices":2,"material":i}]} for i in range(3)]}
text = json.dumps(document, separators=(",", ":")).encode()
text += b" " * (-len(text) % 4)
glb = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(text) + 8 + len(binary))
glb += struct.pack("<II", len(text), 0x4E4F534A) + text
glb += struct.pack("<II", len(binary), 0x004E4942) + binary
target = root / "frontend/public/models/satellite.glb"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(glb)
print(target)
