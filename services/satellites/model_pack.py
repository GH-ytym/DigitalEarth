"""Bundle a local glTF 2 ZIP into a centred, self-contained GLB without changing its materials."""
from base64 import b64decode
from dataclasses import dataclass
from itertools import product
from html import escape
import json
import math
from pathlib import Path, PurePosixPath
import re
import struct
from urllib.parse import unquote, unquote_to_bytes, urlsplit
import zipfile


@dataclass(frozen=True)
class PackedModel:
    data: bytes
    source_info: dict
    geometry_info: dict


def _safe_path(name):
    path = PurePosixPath(name)
    if not name or "\\" in name or "\x00" in name or path.is_absolute() or ".." in path.parts or ":" in name:
        raise ValueError("Model resources must use paths inside the archive.")
    return path.as_posix()


def _read_uri(archive, base, uri):
    if not isinstance(uri, str):
        raise ValueError("A model resource URI must be a string.")
    if uri.lower().startswith("data:"):
        header, separator, body = uri.partition(",")
        if not separator:
            raise ValueError("Invalid embedded model resource.")
        try:
            return b64decode(body, validate=True) if header.lower().endswith(";base64") else unquote_to_bytes(body)
        except (ValueError, TypeError) as exc:
            raise ValueError("Invalid embedded model resource.") from exc
    parsed = urlsplit(uri)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("External model resources are not supported.")
    relative = _safe_path(unquote(parsed.path))
    name = _safe_path((base / relative).as_posix())
    try:
        return archive.read(name)
    except KeyError as exc:
        raise ValueError(f"Model resource is missing: {name}") from exc


def _append(blob, payload):
    blob.extend(b"\x00" * (-len(blob) % 4))
    offset = len(blob)
    blob.extend(payload)
    return offset


def _matrix(node):
    if "matrix" in node:
        result = node["matrix"]
    else:
        x, y, z, w = node.get("rotation", [0, 0, 0, 1])
        sx, sy, sz = node.get("scale", [1, 1, 1])
        tx, ty, tz = node.get("translation", [0, 0, 0])
        result = [
            (1-2*y*y-2*z*z)*sx, 2*(x*y+w*z)*sx, 2*(x*z-w*y)*sx, 0,
            2*(x*y-w*z)*sy, (1-2*x*x-2*z*z)*sy, 2*(y*z+w*x)*sy, 0,
            2*(x*z+w*y)*sz, 2*(y*z-w*x)*sz, (1-2*x*x-2*y*y)*sz, 0,
            tx, ty, tz, 1,
        ]
    if len(result) != 16 or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in result):
        raise ValueError("Invalid model node transform.")
    return result


def _multiply(a, b):
    return [sum(a[k*4+r]*b[c*4+k] for k in range(4)) for c in range(4) for r in range(4)]


def _positions(document, blob, accessor_id):
    accessor = document["accessors"][accessor_id]
    if accessor.get("type") != "VEC3" or accessor.get("count", 0) <= 0:
        raise ValueError("Model POSITION must be a non-empty VEC3 accessor.")
    # Exact float positions avoid the loose boxes caused by rotating accessor bounds.
    if accessor.get("componentType") == 5126 and "bufferView" in accessor and not accessor.get("sparse"):
        view = document["bufferViews"][accessor["bufferView"]]
        offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        stride = view.get("byteStride", 12)
        end = offset + (accessor["count"]-1)*stride + 12
        if stride < 12 or end > view.get("byteOffset", 0)+view["byteLength"] or end > len(blob):
            raise ValueError("Model POSITION exceeds its buffer view.")
        for index in range(accessor["count"]):
            yield struct.unpack_from("<3f", blob, offset + index*stride)
    else:
        # Compressed, sparse or quantized geometry still supplies glTF POSITION bounds.
        lower, upper = accessor.get("min"), accessor.get("max")
        if not lower or not upper or len(lower) != 3 or len(upper) != 3:
            raise ValueError("Model POSITION requires bounds for normalization.")
        yield from product(*zip(lower, upper))


def _normalize(document, blob):
    nodes = document.get("nodes", [])
    scenes = document.get("scenes", [])
    if not scenes:
        raise ValueError("Model must contain a scene.")
    scene = scenes[document.get("scene", 0)]
    roots = scene.get("nodes", [])
    low, high = [math.inf]*3, [-math.inf]*3
    primitive_count = 0
    vertex_count = 0
    identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]

    def visit(node_id, parent, ancestors):
        nonlocal primitive_count, vertex_count
        if node_id in ancestors:
            raise ValueError("Model scene contains a node cycle.")
        node = nodes[node_id]
        transform = _multiply(parent, _matrix(node))
        if "mesh" in node:
            for primitive in document["meshes"][node["mesh"]]["primitives"]:
                if "POSITION" not in primitive.get("attributes", {}):
                    continue
                primitive_count += 1
                for point in _positions(document, blob, primitive["attributes"]["POSITION"]):
                    vertex_count += 1
                    for axis in range(3):
                        value = sum(transform[k*4+axis]*point[k] for k in range(3)) + transform[12+axis]
                        if not math.isfinite(value):
                            raise ValueError("Model positions must be finite.")
                        low[axis] = min(low[axis], value)
                        high[axis] = max(high[axis], value)
        for child in node.get("children", []):
            visit(child, transform, ancestors | {node_id})

    for root in roots:
        visit(root, identity, set())
    if not primitive_count or not all(math.isfinite(v) for v in low+high):
        raise ValueError("Model contains no renderable geometry.")
    dimensions = [high[i]-low[i] for i in range(3)]
    if max(dimensions) <= 0:
        raise ValueError("Model geometry has no extent.")
    centre = [(low[i]+high[i])/2 for i in range(3)]
    scale = 10/max(dimensions)
    node_id = len(nodes)
    nodes.append({"name":"DigitalEarth normalization", "children":roots.copy(),
                  "matrix":[scale,0,0,0, 0,scale,0,0, 0,0,scale,0,
                            *(-value*scale for value in centre),1]})
    scene["nodes"] = [node_id]
    return {"original_bounds":{"min":low,"max":high}, "original_dimensions":dimensions,
            "original_centre":centre, "normalization_scale":scale,
            "normalized_dimensions":[value*scale for value in dimensions],
            "mesh_count":len(document.get("meshes", [])), "primitive_count":primitive_count,
            "position_count":vertex_count, "up_axis":"Y"}


def _source_info(document, archive):
    extras = document.get("asset", {}).get("extras", {})
    author = str(extras.get("author") or "")
    license_name = str(extras.get("license") or "")
    author_url = re.search(r"https?://[^\s)]+", author)
    license_url = re.search(r"https?://[^\s)]+", license_name)
    texts = [archive.read(name).decode("utf-8", errors="replace") for name in archive.namelist()
             if PurePosixPath(name).name.lower() in {"license.txt", "licence.txt"}]
    return {"author":author.split(" (http", 1)[0],
            "author_url":author_url.group(0) if author_url else "",
            "source_url":str(extras.get("source") or ""),
            "license":license_name.split(" (http", 1)[0],
            "license_url":license_url.group(0).replace("http://creativecommons.org/", "https://creativecommons.org/") if license_url else "",
            "title":str(extras.get("title") or ""),
            "license_text":"\n\n".join(texts)}


def validate_glb(data: bytes) -> dict:
    """Check the GLB container and self-contained resources; return its JSON document."""
    if len(data) < 20:
        raise ValueError("Invalid GLB header.")
    magic, version, length = struct.unpack_from("<III", data)
    if magic != 0x46546C67 or version != 2 or length != len(data):
        raise ValueError("Invalid GLB 2 container.")
    offset, chunks = 12, []
    while offset < len(data):
        if offset+8 > len(data):
            raise ValueError("Truncated GLB chunk.")
        size, kind = struct.unpack_from("<II", data, offset)
        offset += 8
        if size % 4 or offset+size > len(data):
            raise ValueError("Invalid GLB chunk size.")
        chunks.append((kind, data[offset:offset+size]))
        offset += size
    if not chunks or chunks[0][0] != 0x4E4F534A:
        raise ValueError("GLB must begin with a JSON chunk.")
    document = json.loads(chunks[0][1])
    if document.get("asset", {}).get("version") != "2.0":
        raise ValueError("GLB must contain a glTF 2.0 document.")
    binary = next((payload for kind, payload in chunks if kind == 0x004E4942), b"")
    buffers = document.get("buffers", [])
    if len(buffers) != 1 or "uri" in buffers[0] or not 0 <= len(binary)-buffers[0]["byteLength"] <= 3:
        raise ValueError("GLB must contain one embedded binary buffer.")
    for view in document.get("bufferViews", []):
        if view.get("buffer", 0) != 0 or view.get("byteOffset", 0) < 0 or view["byteLength"] < 0 or view.get("byteOffset", 0)+view["byteLength"] > buffers[0]["byteLength"]:
            raise ValueError("GLB buffer view exceeds its binary buffer.")
    def check_view(index):
        if type(index) is not int or not 0 <= index < len(document.get("bufferViews", [])):
            raise ValueError("GLB buffer view reference is invalid.")
    for accessor in document.get("accessors", []):
        if "bufferView" in accessor:
            check_view(accessor["bufferView"])
        if "sparse" in accessor:
            for component in ("indices", "values"):
                check_view(accessor["sparse"][component]["bufferView"])
    for image in document.get("images", []):
        if "uri" in image or "bufferView" not in image or not image.get("mimeType"):
            raise ValueError("GLB image is not embedded.")
        check_view(image["bufferView"])
    return document


def pack_model_zip(path: Path) -> PackedModel:
    """Read a ZIP without extracting files, preserving material/image references in a GLB."""
    with zipfile.ZipFile(path) as archive:
        names = [info.filename for info in archive.infolist() if not info.is_dir()]
        if len(names) != len(set(names)):
            raise ValueError("Duplicate archive resources are not supported.")
        for name in names:
            _safe_path(name)
        if sum(info.file_size for info in archive.infolist()) > 128*1024*1024:
            raise ValueError("Model archive is too large.")
        entries = [name for name in names if name.lower().endswith(".gltf")]
        if len(entries) != 1:
            raise ValueError("Model ZIP must contain exactly one glTF entry.")
        entry = entries[0]
        document = json.loads(archive.read(entry))
        if document.get("asset", {}).get("version") != "2.0":
            raise ValueError("Only glTF 2.0 models are supported.")
        source = _source_info(document, archive)
        base = PurePosixPath(entry).parent
        blob = bytearray()
        offsets = []
        for buffer in document.get("buffers", []):
            payload = _read_uri(archive, base, buffer["uri"])
            if buffer["byteLength"] < 0 or len(payload) < buffer["byteLength"]:
                raise ValueError("Model buffer is truncated.")
            offsets.append(_append(blob, payload[:buffer["byteLength"]]))
        for view in document.get("bufferViews", []):
            old_buffer = view.get("buffer", 0)
            if not 0 <= old_buffer < len(offsets):
                raise ValueError("Model buffer index is invalid.")
            original_size = document["buffers"][old_buffer]["byteLength"]
            if view.get("byteOffset", 0) < 0 or view["byteLength"] < 0 or view.get("byteOffset", 0)+view["byteLength"] > original_size:
                raise ValueError("Model buffer view exceeds its source buffer.")
            view["byteOffset"] = offsets[old_buffer] + view.get("byteOffset", 0)
            view["buffer"] = 0
        geometry = _normalize(document, blob)
        views = document.setdefault("bufferViews", [])
        for image in document.get("images", []):
            if "uri" not in image:
                continue
            payload = _read_uri(archive, base, image.pop("uri"))
            if payload.startswith(b"\x89PNG\r\n\x1a\n"):
                mime = "image/png"
            elif payload.startswith(b"\xff\xd8\xff"):
                mime = "image/jpeg"
            elif payload.startswith(b"RIFF") and payload[8:12] == b"WEBP":
                mime = "image/webp"
            else:
                raise ValueError("Model image must be a PNG, JPEG or WebP resource.")
            image["bufferView"] = len(views)
            image["mimeType"] = mime
            views.append({"buffer":0,"byteOffset":_append(blob, payload),"byteLength":len(payload)})
        document["buffers"] = [{"byteLength":len(blob)}]
        document["asset"]["copyright"] = escape(f'{source["title"]} by {source["author"]}. '
            f'Source: {source["source_url"]}. License: {source["license"]} ({source["license_url"]}).')
        raw_json = json.dumps(document, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        raw_json += b" " * (-len(raw_json) % 4)
        blob.extend(b"\x00" * (-len(blob) % 4))
        chunks = struct.pack("<II", len(raw_json), 0x4E4F534A) + raw_json
        chunks += struct.pack("<II", len(blob), 0x004E4942) + blob
        result = struct.pack("<III", 0x46546C67, 2, 12+len(chunks)) + chunks
        validate_glb(result)
        return PackedModel(result, source, geometry)
