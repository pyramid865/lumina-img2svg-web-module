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
    # Registry 规则：assetName 必须是 "{moduleId}-{version}.lumina-workshop"，
    # moduleId 里的点号原样保留（community.img2svg.web-0.1.1…）。
    # 早期版本错误地把 moduleId 的点号换成连字符，
    # 与 registry 的 assetName 规则不符（会被 inspect_package 打回）。
    asset = OUT / f"{module_id}-{version}.lumina-workshop"
    expected = f"{module_id}-{version}.lumina-workshop"
    assert asset.name == expected, f"assetName 不符合 registry 规则: {asset.name}"

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
