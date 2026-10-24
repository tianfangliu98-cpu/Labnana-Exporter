# -*- coding: utf-8 -*-
"""
补齐图片的像素宽高。

扩展早期只从 PNG 的 IHDR 读尺寸，JPEG / WebP 一律读不到，
导致 index.csv 里这些行的「像素宽/高」是空的。

本脚本直接从图片文件头解析尺寸（PNG / JPEG / WebP），
回填 metadata.json、重写 parameters.txt，最后重建索引。

用法：python fix_dimensions.py <目录> [--apply]
"""

import argparse
import csv
import json
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def image_size(data: bytes):
    """返回 (宽, 高)，认不出就返回 None。"""
    # PNG
    if data[:8] == PNG_SIG and len(data) >= 24:
        return struct.unpack(">II", data[16:24])

    # JPEG：扫描段，找 SOF0/SOF2 等起始帧
    if data[:2] == b"\xff\xd8":
        i, n = 2, len(data)
        while i < n - 9:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker == 0xFF:          # 填充字节，跳一个继续找
                i += 1
                continue
            if marker == 0x01 or 0xD0 <= marker <= 0xD7:  # 无长度的独立标记
                i += 2
                continue
            seg_len = struct.unpack(">H", data[i + 2 : i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", data[i + 5 : i + 9])
                return (w, h)
            if seg_len < 2:            # 长度非法，防死循环
                return None
            i += 2 + seg_len
        return None

    # WebP
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        chunk = data[12:16]
        if chunk == b"VP8 " and len(data) >= 30:
            w = struct.unpack("<H", data[26:28])[0] & 0x3FFF
            h = struct.unpack("<H", data[28:30])[0] & 0x3FFF
            return (w, h)
        if chunk == b"VP8L" and len(data) >= 25:
            b = data[21:25]
            bits = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)
            return ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
        if chunk == b"VP8X" and len(data) >= 30:
            w = (data[24] | (data[25] << 8) | (data[26] << 16)) + 1
            h = (data[27] | (data[28] << 8) | (data[29] << 16)) + 1
            return (w, h)
    return None


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


def rebuild_index(root):
    rows = []
    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        f = d / "metadata.json"
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
    ap.add_argument("root")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    root = Path(args.root)
    fixed, failed, already = [], [], 0

    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        mf = d / "metadata.json"
        if not mf.exists():
            continue
        md = json.loads(mf.read_text(encoding="utf-8"))
        if md.get("width") and md.get("height"):
            already += 1
            continue
        imgs = list(d.glob("image.*"))
        if not imgs:
            failed.append((d.name, "无成图"))
            continue
        # 读全文件：有些 JPEG 前面挂着几十 KB 的 C2PA/APP11 段，
        # 只读前 64KB 会够不到 SOF 头
        size = image_size(imgs[0].read_bytes())
        if not size:
            failed.append((d.name, f"认不出格式 {imgs[0].suffix}"))
            continue
        md["width"], md["height"] = int(size[0]), int(size[1])
        fixed.append((d.name, size))
        if args.apply:
            mf.write_text(json.dumps(md, ensure_ascii=False, indent=2), encoding="utf-8")
            (d / "parameters.txt").write_text(parameters_text(md), encoding="utf-8")

    print(f"已有尺寸: {already}")
    print(f"需补齐  : {len(fixed)}")
    for name, size in fixed[:12]:
        print(f"  {name} -> {size[0]}x{size[1]}")
    if len(fixed) > 12:
        print(f"  … 共 {len(fixed)} 件")
    if failed:
        print(f"无法识别: {len(failed)}")
        for name, why in failed[:8]:
            print(f"  {name}: {why}")

    if not args.apply:
        print("\n这是预演。加 --apply 才会写入。")
        return 0

    n = rebuild_index(root)
    print(f"\n✔ 已回填并重建索引：{n} 件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
