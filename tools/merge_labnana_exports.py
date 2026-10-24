#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 Labnana 导出器产生的多次压缩包合并成一套按作品归拢的目录。

典型场景：
  第一次导出只拿到成图（参考图那批因为域名白名单 bug 全失败了），
  第二次用「跳过成图」补了参考图 —— 于是同一条作品被劈在两个包里。

本脚本按「作品 ID」把各包内容对回去，每个作品一个文件夹，
成图、参考图、metadata、parameters 全在一起。

只依赖 Python 标准库。

用法：
  python merge_labnana_exports.py <包目录或zip...> -o <输出目录>
  python merge_labnana_exports.py <...> -o <输出目录> --dry-run
  python merge_labnana_exports.py <...> -o <输出目录> --zip
"""

import argparse
import csv
import json
import os
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

FOLDER_RE = re.compile(r"^(\d{4})_(.+)$")
REF_RE = re.compile(r"^ref_(\d+)\.(\w+)$", re.IGNORECASE)


def log(msg):
    print(msg, flush=True)


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,.1f} {unit}" if unit != "B" else f"{n:,.0f} B"
        n /= 1024
    return f"{n:.1f} GB"


def collect_zips(paths, pattern="Labnana-export-*.zip"):
    zips = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            found = sorted(p.glob(pattern))
            if not found:
                # 目录里没有符合命名规则的，退回扫全部 zip，靠内容识别兜底
                found = sorted(p.glob("*.zip")) + sorted(p.glob("*.ZIP"))
            zips.extend(found)
        elif p.is_file() and p.suffix.lower() == ".zip":
            zips.append(p)
        else:
            log(f"  ! 跳过（既不是 zip 也不是目录）：{raw}")
    # 去重且保持顺序
    seen, out = set(), []
    for z in zips:
        key = str(z.resolve()).lower()
        if key not in seen:
            seen.add(key)
            out.append(z)
    return out


def classify(rest):
    """返回 (种类, 参考图序号)。"""
    low = rest.lower()
    if low.startswith("image."):
        return "image", None
    m = REF_RE.match(rest)
    if m:
        return "ref", int(m.group(1))
    if low == "metadata.json":
        return "metadata", None
    if low == "parameters.txt":
        return "parameters", None
    return "other", None


def read_json_in_zip(zf, name):
    try:
        with zf.open(name) as fh:
            return json.loads(fh.read().decode("utf-8-sig"))
    except Exception:
        return None


def merge_dict(base, incoming):
    """浅合并：只覆盖有实际值的字段。"""
    if not isinstance(incoming, dict):
        return base
    out = dict(base)
    for k, v in incoming.items():
        if v is None or v == "" or v == []:
            continue
        if k == "raw":
            out[k] = v if not isinstance(v, dict) else {**(out.get(k) or {}), **v}
            continue
        out[k] = v
    return out


def parameters_text(md):
    """与扩展 lib/png.js 的 buildParametersText 保持同一格式。"""
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
    refs = md.get("referenceImageUrls") or []
    if refs:
        parts.append(f"Reference images: {len(refs)}")
    if parts:
        lines.append(", ".join(parts))
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description="合并 Labnana 导出压缩包")
    ap.add_argument("inputs", nargs="+", help="zip 文件或包含 zip 的目录")
    ap.add_argument("-o", "--out", required=True, help="输出目录")
    ap.add_argument("--dry-run", action="store_true", help="只统计，不写文件")
    ap.add_argument("--zip", action="store_true", help="合并后再打成一个 zip（超过 1.6GB 自动分卷）")
    ap.add_argument("--naming", choices=["date", "seq"], default="date",
                    help="输出文件夹命名：date=按生成时间（默认），seq=序号_作品ID")
    args = ap.parse_args()

    zips = collect_zips(args.inputs)
    if not zips:
        log("没有找到任何 zip")
        return 1
    log(f"发现 {len(zips)} 个压缩包：")
    total_bytes = 0
    for z in zips:
        total_bytes += z.stat().st_size
        log(f"  {human(z.stat().st_size):>12}  {z.name}")
    log(f"合计 {human(total_bytes)}\n")

    # ---------- 扫描 ----------
    works = {}   # id -> dict
    scanned = {}  # zip 名 -> 识别到的条目数
    for zp in zips:
        log(f"扫描 {zp.name} …")
        try:
            zf = zipfile.ZipFile(zp)
        except zipfile.BadZipFile:
            log("  ! 不是有效的 zip（可能是改名的 RAR/7z），已跳过")
            continue

        matched = 0
        scanned[zp.name] = 0

        with zf:
            # 第一遍：从 metadata.json 里读作品 ID。
            # 目录名可能是「0001_<id>」也可能是「2026-10-24_1351」，
            # 后者不带 ID，所以不能只靠名字解析。
            folder_ids = {}
            for info in zf.infolist():
                if info.is_dir():
                    continue
                raw = info.filename.replace("\\", "/")
                if "/" not in raw:
                    continue
                folder, rest = raw.split("/", 1)
                if rest.lower() == "metadata.json":
                    md0 = read_json_in_zip(zf, raw)
                    if md0 and md0.get("id"):
                        folder_ids[folder] = str(md0["id"])

            # 第二遍：收集内容
            for info in zf.infolist():
                if info.is_dir():
                    continue
                raw = info.filename.replace("\\", "/")
                if "/" not in raw:
                    continue  # 顶层的 index.csv / README.txt 之类，跳过
                folder, rest = raw.split("/", 1)

                wid = folder_ids.get(folder)
                if not wid:
                    m = FOLDER_RE.match(folder)
                    if not m:
                        continue
                    wid = m.group(2)
                matched += 1
                kind, ref_no = classify(rest)

                w = works.setdefault(wid, {
                    "id": wid,
                    "image": None,
                    "refs": {},
                    "meta": {},
                    "others": [],
                    "sources": set(),
                })
                w["sources"].add(zp.name)

                if kind == "image":
                    if w["image"] is None or info.file_size > w["image"]["size"]:
                        w["image"] = {"zip": zp, "name": raw, "size": info.file_size}
                elif kind == "ref":
                    prev = w["refs"].get(ref_no)
                    if prev is None or info.file_size > prev["size"]:
                        w["refs"][ref_no] = {"zip": zp, "name": raw, "size": info.file_size}
                elif kind == "metadata":
                    md = read_json_in_zip(zf, raw)
                    if md:
                        w["meta"] = merge_dict(w["meta"], md)
                elif kind == "parameters":
                    pass  # 稍后统一重新生成，保证格式一致
                else:
                    w["others"].append({"zip": zp, "name": raw, "rest": rest, "size": info.file_size})

        scanned[zp.name] = matched

    empty = [name for name, n in scanned.items() if n == 0]
    if empty:
        log(f"  ! 以下包内没有识别到作品结构，已忽略：{', '.join(empty)}")

    # ---------- 排序 ----------
    def sort_key(w):
        ts = w["meta"].get("createdAt")
        if isinstance(ts, (int, float)):
            return (0, ts, w["id"])
        return (1, 0, w["id"])

    ordered = sorted(works.values(), key=sort_key)

    with_image = sum(1 for w in ordered if w["image"])
    with_refs = sum(1 for w in ordered if w["refs"])
    total_refs = sum(len(w["refs"]) for w in ordered)

    log(f"\n=== 统计 ===")
    log(f"  作品总数     : {len(ordered)}")
    log(f"  有 成图      : {with_image}")
    log(f"  有 参考图    : {with_refs}")
    log(f"  参考图总数   : {total_refs}")
    log(f"  只有参考图   : {sum(1 for w in ordered if w['refs'] and not w['image'])}")
    log(f"  只有成图     : {sum(1 for w in ordered if w['image'] and not w['refs'])}")
    log(f"  两边都没有   : {sum(1 for w in ordered if not w['image'] and not w['refs'])}")

    if args.dry_run:
        log("\n--dry-run：未写入任何文件")
        return 0

    # ---------- 写出 ----------
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    log(f"\n写入 {out} …")

    index_rows = []
    used_names = set()

    def folder_name(i, w):
        if args.naming == "seq":
            base = f"{i:04d}_{w['id']}"
        else:
            ts = w["meta"].get("createdAt")
            if isinstance(ts, (int, float)):
                base = datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d_%H%M")
            else:
                base = f"{i:04d}"
        name, n = base, 2
        while name in used_names:
            name = f"{base}_{n}"
            n += 1
        used_names.add(name)
        return name

    for i, w in enumerate(ordered, 1):
        folder = folder_name(i, w)
        dest = out / folder
        dest.mkdir(exist_ok=True)

        md = dict(w["meta"])
        md.setdefault("id", w["id"])

        if w["image"]:
            ext = Path(w["image"]["name"]).suffix
            with zipfile.ZipFile(w["image"]["zip"]) as zf, zf.open(w["image"]["name"]) as src, \
                    open(dest / f"image{ext}", "wb") as dst:
                dst.write(src.read())

        ref_count = 0
        for no in sorted(w["refs"]):
            r = w["refs"][no]
            ext = Path(r["name"]).suffix
            with zipfile.ZipFile(r["zip"]) as zf, zf.open(r["name"]) as src, \
                    open(dest / f"ref_{no:02d}{ext}", "wb") as dst:
                dst.write(src.read())
            ref_count += 1

        for o in w["others"]:
            name = o["rest"].split("/", 1)[-1]
            with zipfile.ZipFile(o["zip"]) as zf, zf.open(o["name"]) as src, \
                    open(dest / name, "wb") as dst:
                dst.write(src.read())

        (dest / "metadata.json").write_text(
            json.dumps(md, ensure_ascii=False, indent=2), encoding="utf-8")
        (dest / "parameters.txt").write_text(parameters_text(md), encoding="utf-8")

        index_rows.append({
            "序号": i,
            "作品ID": w["id"],
            "文件夹": folder,
            "模型": md.get("model", ""),
            "尺寸档位": md.get("imageSize", ""),
            "宽高比": md.get("aspectRatio", ""),
            "像素宽": md.get("width", ""),
            "像素高": md.get("height", ""),
            "参考图数量": ref_count,
            "创建时间": (datetime.fromtimestamp(md["createdAt"] / 1000, tz=timezone.utc)
                         .isoformat().replace("+00:00", "Z")
                         if isinstance(md.get("createdAt"), (int, float)) else ""),
            "提示词": md.get("prompt", ""),
        })

        if i % 100 == 0:
            log(f"  已处理 {i}/{len(ordered)}")

    # ---------- 索引 ----------
    cols = list(index_rows[0].keys()) if index_rows else []
    with open(out / "index.csv", "w", encoding="utf-8-sig", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=cols)
        wr.writeheader()
        wr.writerows(index_rows)
    (out / "index.json").write_text(
        json.dumps(index_rows, ensure_ascii=False, indent=2), encoding="utf-8")

    (out / "README.txt").write_text(
        "Labnana 导出合并结果\n"
        "====================\n\n"
        f"合并自 {len(zips)} 个压缩包，共 {len(ordered)} 件作品。\n"
        f"其中 {with_refs} 件带参考图，{with_image} 件有成图。\n\n"
        "每个文件夹 = 一件作品：\n"
        "  image.*        最终成图\n"
        "  ref_01.* ...   参考图，按生成顺序编号（没有就是这件没用参考图）\n"
        "  metadata.json  完整元数据\n"
        "  parameters.txt 提示词 + 参数\n\n"
        "文件夹名里的数字是按创建时间重排的序号，后面那串才是作品 ID。\n"
        "index.csv 里有序号与 ID 的对应关系。\n",
        encoding="utf-8")

    log(f"\n✔ 完成：{len(ordered)} 件作品已合并到 {out}")

    # ---------- 可选：重新打包 ----------
    if args.zip:
        part_limit = 1_600 * 1024 * 1024
        base = out.name or "merged"
        part_no, written, zf, cur_size = 1, 0, None, 0

        def open_part():
            p = out.parent / f"{base}-part{part_no}.zip"
            return zipfile.ZipFile(p, "w", zipfile.ZIP_STORED, allowZip64=True)

        zf = open_part()
        for row in index_rows:
            folder = row["文件夹"]
            for f in sorted((out / folder).iterdir()):
                d = f.stat().st_size
                if cur_size + d > part_limit:
                    zf.close()
                    part_no += 1
                    zf = open_part()
                    cur_size = 0
                zf.write(f, f"{folder}/{f.name}")
                cur_size += d
                written += d
        for extra in ("index.csv", "index.json", "README.txt"):
            p = out / extra
            if p.exists():
                zf.write(p, extra)
        zf.close()
        log(f"✔ 已额外打包为 {part_no} 个 zip（{human(written)}）")

    return 0


if __name__ == "__main__":
    sys.exit(main())
