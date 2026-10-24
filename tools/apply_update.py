# -*- coding: utf-8 -*-
"""
把新导出的压缩包「增量并入」已有目录。

场景：之前某批作品导出时缺成图（接口没给 imageUrl），后来用「按 ID 导出」补回来了。
这时不该重排整个目录，只需要把缺的文件补进去、元数据补齐。

匹配依据是 metadata.json 里的作品 ID，不是文件夹名 ——
所以旧目录不管用日期命名还是序号命名都能对上。

用法：
  python apply_update.py <新包.zip 或目录> --into <已有目录> [--dry-run]
"""

import argparse
import csv
import json
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

META = "metadata.json"
PARAM = "parameters.txt"


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,.1f} {unit}" if unit != "B" else f"{n:,.0f} B"
        n /= 1024


def read_zip_json(zf, name):
    try:
        return json.loads(zf.read(name).decode("utf-8-sig"))
    except Exception:
        return None


def scan_zip(zp):
    """返回 {id: {'folder': 名, 'image': (成员名, 大小), 'refs': {号: (成员名, 大小)}, 'meta': dict}}"""
    works, folder_ids = {}, {}
    with zipfile.ZipFile(zp) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            raw = info.filename.replace("\\", "/")
            if "/" not in raw:
                continue
            folder, rest = raw.split("/", 1)
            if rest.lower() == META:
                md = read_zip_json(zf, raw)
                if md and md.get("id"):
                    folder_ids[folder] = str(md["id"])
                    works.setdefault(str(md["id"]), {
                        "folder": folder, "image": None, "refs": {}, "meta": md,
                    })["meta"] = md

        for info in zf.infolist():
            if info.is_dir():
                continue
            raw = info.filename.replace("\\", "/")
            if "/" not in raw:
                continue
            folder, rest = raw.split("/", 1)
            wid = folder_ids.get(folder)
            if not wid:
                continue
            low = rest.lower()
            w = works[wid]
            if low.startswith("image."):
                if w["image"] is None or info.file_size > w["image"][1]:
                    w["image"] = (raw, info.file_size)
            elif low.startswith("ref_") and "." in low:
                try:
                    no = int(rest.split("_")[1].split(".")[0])
                except Exception:
                    continue
                prev = w["refs"].get(no)
                if prev is None or info.file_size > prev[1]:
                    w["refs"][no] = (raw, info.file_size)
    return works


def merge_meta(old, new):
    out = dict(old or {})
    for k, v in (new or {}).items():
        if v is None or v == "" or v == []:
            continue
        out[k] = v
    return out


def parameters_text(md):
    lines = [md.get("prompt") or "(无提示词)"]
    parts = []
    if md.get("model"):
        parts.append(f"Model: {md['model']}")
    if md.get("imageSize"):
        parts.append(f"Size: {md['imageSize']}")
    if md.get("aspectRatio"):
        parts.append(f"Aspect ratio: {md['aspectRatio']}")
    if md.get("quality"):
        parts.append(f"Quality: {md['quality']}")
    if md.get("width") and md.get("height"):
        parts.append(f"Pixels: {md['width']}x{md['height']}")
    if md.get("batchCount") and md["batchCount"] > 1:
        parts.append(f"Batch: {md['batchCount']}")
    if md.get("remixSourceImageId"):
        parts.append(f"Source image: {md['remixSourceImageId']}")
    if md.get("referenceImageUrls"):
        parts.append(f"Reference images: {len(md['referenceImageUrls'])}")
    if parts:
        lines.append(", ".join(parts))
    return "\n".join(lines) + "\n"


def index_by_id(root):
    idx, used = {}, set()
    for d in root.iterdir():
        if not d.is_dir():
            continue
        used.add(d.name)
        f = d / META
        if not f.exists():
            continue
        try:
            md = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if md.get("id"):
            idx[str(md["id"])] = d
    return idx, used


def folder_name_for(md, used):
    ts = md.get("createdAt")
    if isinstance(ts, (int, float)):
        base = datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d_%H%M")
    else:
        base = md.get("id", "unknown")[:12]
    name, n = base, 2
    while name in used:
        name = f"{base}_{n}"
        n += 1
    used.add(name)
    return name


def rebuild_index(root):
    rows = []
    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        f = d / META
        if not f.exists():
            continue
        md = json.loads(f.read_text(encoding="utf-8"))
        ts = md.get("createdAt")
        rows.append({
            "序号": len(rows) + 1,
            "作品ID": md.get("id", ""),
            "文件夹": d.name,
            "模型": md.get("model", ""),
            "尺寸档位": md.get("imageSize", ""),
            "宽高比": md.get("aspectRatio", ""),
            "像素宽": md.get("width", ""),
            "像素高": md.get("height", ""),
            "参考图数量": len(md.get("referenceImageUrls") or []),
            "创建时间": (datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
                         .isoformat().replace("+00:00", "Z")
                         if isinstance(ts, (int, float)) else ""),
            "提示词": md.get("prompt", ""),
        })
    if not rows:
        return 0
    cols = list(rows[0].keys())
    with open(root / "index.csv", "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    (root / "index.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="+", help="新导出的 zip 或包含 zip 的目录")
    ap.add_argument("--into", required=True, help="要并入的已有目录")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    target = Path(args.into)
    if not target.is_dir():
        print(f"目标目录不存在: {target}")
        return 1

    sources = []
    for s in args.sources:
        p = Path(s)
        if p.is_dir():
            sources.extend(sorted(p.glob("Labnana-export-*.zip")) or sorted(p.glob("*.zip")))
        elif p.is_file():
            sources.append(p)
    if not sources:
        print("没有找到输入包")
        return 1

    print(f"并入 {len(sources)} 个包 -> {target}\n")

    idx, used = index_by_id(target)
    print(f"目标目录已索引 {len(idx)} 件作品")

    stat = {"new_folder": 0, "image": 0, "ref": 0, "meta": 0}
    image_bytes = 0
    created = []

    for zp in sources:
        works = scan_zip(zp)
        print(f"\n{zp.name}: {len(works)} 件")

        with zipfile.ZipFile(zp) as zf:
            for wid, w in works.items():
                dest = idx.get(wid)
                if dest is None:
                    name = folder_name_for(w["meta"], used)
                    dest = target / name
                    created.append(name)
                    stat["new_folder"] += 1

                if not args.dry_run:
                    dest.mkdir(exist_ok=True)

                # 成图
                if w["image"]:
                    existing_img = list(dest.glob("image.*"))
                    if not existing_img:
                        if not args.dry_run:
                            data = zf.read(w["image"][0])
                            ext = Path(w["image"][0]).suffix
                            (dest / f"image{ext}").write_bytes(data)
                        stat["image"] += 1
                        image_bytes += w["image"][1]

                # 参考图
                for no, (member, size) in sorted(w["refs"].items()):
                    if any(dest.glob(f"ref_{no:02d}.*")):
                        continue
                    if not args.dry_run:
                        data = zf.read(member)
                        ext = Path(member).suffix
                        (dest / f"ref_{no:02d}{ext}").write_bytes(data)
                    stat["ref"] += 1

                # 元数据
                mf = dest / META
                old = {}
                if mf.exists():
                    try:
                        old = json.loads(mf.read_text(encoding="utf-8"))
                    except Exception:
                        old = {}
                merged = merge_meta(old, w["meta"])
                if merged != old:
                    stat["meta"] += 1
                    if not args.dry_run:
                        mf.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
                if not args.dry_run:
                    (dest / PARAM).write_text(parameters_text(merged), encoding="utf-8")

    print("\n=== 结果 ===")
    print(f"  新增文件夹 : {stat['new_folder']}")
    print(f"  补入成图   : {stat['image']}  ({human(image_bytes)})")
    print(f"  补入参考图 : {stat['ref']}")
    print(f"  更新元数据 : {stat['meta']}")
    if created:
        print(f"  新建目录   : {created[:5]}{' …' if len(created) > 5 else ''}")

    if args.dry_run:
        print("\n--dry-run：未写入任何文件")
        return 0

    n = rebuild_index(target)
    print(f"\n✔ 已重建索引：{n} 件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
