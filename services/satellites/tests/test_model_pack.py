import json
from pathlib import Path
import struct
from tempfile import TemporaryDirectory
import unittest
import zipfile

from model_pack import pack_model_zip, validate_glb


class ModelPackTests(unittest.TestCase):
    def make_archive(self, path, buffer_uri="mesh.bin"):
        geometry = struct.pack("<9f", 0,0,0, 2,0,0, 0,1,0)
        document = {"asset":{"version":"2.0","extras":{"author":"Test author","license":"CC-BY-4.0","title":"Triangle"}},
            "scene":0,"scenes":[{"nodes":[0]}],
            "nodes":[{"translation":[10,20,30],"scale":[2,2,2],"mesh":0}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}],
            "buffers":[{"uri":buffer_uri,"byteLength":len(geometry)}],
            "bufferViews":[{"buffer":0,"byteLength":len(geometry)}],
            "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[2,1,0]}],
            "images":[{"uri":"textures/color.png"}],"materials":[{"name":"Preserved"}]}
        with zipfile.ZipFile(path,"w") as archive:
            archive.writestr("scene.gltf",json.dumps(document))
            archive.writestr("mesh.bin",geometry)
            archive.writestr("textures/color.png",b"\x89PNG\r\n\x1a\n"+b"test image bytes")
            archive.writestr("license.txt","Test attribution")

    def test_resources_and_transformed_geometry_are_embedded_and_centred(self):
        with TemporaryDirectory() as directory:
            path=Path(directory)/"source.zip"
            self.make_archive(path)
            packed=pack_model_zip(path)
        document=validate_glb(packed.data)
        self.assertEqual(document["materials"],[{"name":"Preserved"}])
        self.assertNotIn("uri",document["buffers"][0])
        self.assertNotIn("uri",document["images"][0])
        self.assertEqual(document["images"][0]["mimeType"],"image/png")
        self.assertEqual(packed.geometry_info["original_bounds"],{"min":[10,20,30],"max":[14,22,30]})
        self.assertEqual(packed.geometry_info["normalized_dimensions"],[10,5,0])
        root=document["nodes"][document["scenes"][0]["nodes"][0]]["matrix"]
        centre=packed.geometry_info["original_centre"]
        self.assertEqual([root[i]*centre[j]+root[12+j] for j,i in enumerate([0,5,10])],[0,0,0])
        self.assertEqual(packed.source_info["license_text"],"Test attribution")
        self.assertIn("Test author",document["asset"]["copyright"])

    def test_external_and_out_of_directory_dependencies_are_rejected(self):
        with TemporaryDirectory() as directory:
            for uri in ("https://example.com/mesh.bin","../mesh.bin","%2e%2e/mesh.bin","C:/mesh.bin"):
                with self.subTest(uri=uri):
                    path=Path(directory)/"source.zip"
                    self.make_archive(path,uri)
                    with self.assertRaises(ValueError):
                        pack_model_zip(path)

    def test_glb_length_and_embedded_resource_ranges_are_checked(self):
        with TemporaryDirectory() as directory:
            path=Path(directory)/"source.zip"
            self.make_archive(path)
            packed=pack_model_zip(path)
        with self.assertRaises(ValueError):
            validate_glb(packed.data[:-1])
        broken=bytearray(packed.data)
        struct.pack_into("<I",broken,12,len(broken))
        with self.assertRaises(ValueError):
            validate_glb(bytes(broken))
        document=validate_glb(packed.data)
        json_size=struct.unpack_from("<I",packed.data,12)[0]
        binary=packed.data[20+json_size:]
        for invalid in ("buffer_extent","accessor_reference","external_image"):
            bad=json.loads(json.dumps(document))
            if invalid == "buffer_extent":
                bad["bufferViews"][0]["byteLength"] = bad["buffers"][0]["byteLength"]+1
            elif invalid == "accessor_reference":
                bad["accessors"][0]["bufferView"] = 999
            else:
                bad["images"][0]["uri"] = "https://example.com/image.png"
            raw=json.dumps(bad).encode()
            raw+=b" "*(-len(raw)%4)
            chunks=struct.pack("<II",len(raw),0x4E4F534A)+raw+binary
            container=struct.pack("<III",0x46546C67,2,12+len(chunks))+chunks
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                validate_glb(container)


if __name__ == "__main__":
    unittest.main()
