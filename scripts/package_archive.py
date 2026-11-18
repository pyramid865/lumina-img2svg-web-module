"""Package the module into a .lumina-workshop archive (manifest v1, UI-only).

Members mirror the official seed package: manifest.json, ui/index.html,
assets/icon.png, README.md, LICENSE. Nothing else ships.
"""
import hashlib
import json
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist-package"

MEMBERS = [
    "manifest.json",
    "ui/index.html",
    "assets/icon.png",
    "README.md",
    "LICENSE",
]


def main() -> int:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    module_id = manifest["id"]
    OUT.mkdir(exist_ok=True)
    asset = OUT / f"{module_id.replace('.', '-')}-{version}.lumina-workshop"

    missing = [m for m in MEMBERS if not (ROOT / m).exists()]
    if missing:
        print("MISSING MEMBERS:", missing)
        return 1

    with zipfile.ZipFile(asset, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for member in MEMBERS:
            z.write(ROOT / member, member)

    data = asset.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    manifest_sha = hashlib.sha256((ROOT / "manifest.json").read_bytes()).hexdigest()
    print(json.dumps({
        "asset": asset.name,
        "assetBytes": len(data),
        "sha256": sha,
        "manifestSha256": manifest_sha,
        "fileCount": len(MEMBERS),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
