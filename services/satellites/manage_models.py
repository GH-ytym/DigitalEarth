"""Manage model assets without changing orbit results or restarting the API."""
import argparse
import json
import sys

from config import Settings
from model_pack import pack_model_zip
from model_store import ModelRegistry
from storage import Store


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list")
    upload = commands.add_parser("import")
    upload.add_argument("archive")
    upload.add_argument("--slug", required=True)
    upload.add_argument("--name")
    upload.add_argument("--set-default", action="store_true")
    upload.add_argument("--scale", type=float, default=1)
    upload.add_argument("--minimum-pixel-size", type=float, default=40)
    upload.add_argument("--maximum-scale", type=float, default=5000000)
    default = commands.add_parser("set-default")
    default.add_argument("asset_id")
    activate = commands.add_parser("activate")
    activate.add_argument("asset_id")
    activate.add_argument("version_id")
    binding = commands.add_parser("bind")
    binding.add_argument("norad_id", type=int)
    choice = binding.add_mutually_exclusive_group(required=True)
    choice.add_argument("--asset")
    choice.add_argument("--default", action="store_true")
    args = parser.parse_args()
    registry = ModelRegistry(Store(Settings()))
    registry.initialize()
    if args.command == "import":
        from pathlib import Path
        packed = pack_model_zip(Path(args.archive))
        result = registry.register(args.slug,args.name or packed.source_info["title"],packed.data,
            packed.source_info,packed.geometry_info,
            dict(scale=args.scale,minimum_pixel_size=args.minimum_pixel_size,maximum_scale=args.maximum_scale),
            make_default=args.set_default)
    elif args.command == "set-default":
        registry.set_default(args.asset_id)
        result = dict(default_asset_id=args.asset_id)
    elif args.command == "activate":
        registry.activate_version(args.asset_id,args.version_id)
        result = dict(asset_id=args.asset_id,version_id=args.version_id)
    elif args.command == "bind":
        registry.bind(args.norad_id,args.asset)
        result = dict(norad_id=args.norad_id,asset_id=args.asset,binding="default" if args.default else "override")
    else:
        result = registry.list_assets()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(result,ensure_ascii=False,indent=2,default=str))


if __name__ == "__main__":
    main()
