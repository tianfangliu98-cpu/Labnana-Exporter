# -*- coding: utf-8 -*-
"""
把已有的导出目录按「生成日期」重命名。

不需要重新下载：生成时间就存在每个文件夹的 metadata.json 里（createdAt，毫秒时间戳）。
重命名后仍然按时间先后排列，只是名字变成人类可读的日期。

用法：
  python rename_by_date.py <目录> [--apply]
  不加 --apply 就是预演，只打印前若干个新名字。
"""

import argparse
import csv
import json
import sys
from datetime import datetime
from pathlib import Path


def fmt(ts):
    """毫秒时间戳 -> 本地时间 'YYYY-MM-DD_HHMM'。"""
    return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d_%H%M")


def short_code(pid):
    """作品 ID 末 4 位，用来区分同一分钟的不同作品，保证跨批次不撞名。"""
    code = "".join(c for c in str(pid or "").lower() if c.isalnum())
    return code[-4:] if len(code) >= 4 else "0000"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--apply", action="store_true", help="真正执行重命名")
    args = ap.parse_args()

    root = Path(args.root)
    if not root.is_dir():
        print(f"目录不存在: {root}")
        return 1

    dirs = [d for d in root.iterdir() if d.is_dir()]
    print(f"扫描 {len(dirs)} 个文件夹…")

    plan = []
    no_meta, no_time = [], []
    for d in dirs:
        f = d / "metadata.json"
        if not f.exists():
            no_meta.append(d.name)
            continue
        try:
            md = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            no_meta.append(d.name)
            continue
        ts = md.get("createdAt")
        if not isinstance(ts, (int, float)):
            no_time.append(d.name)
            continue
        plan.append({"dir": d, "ts": ts, "id": md.get("id") or "", "old": d.name})

    print(f"  可重命名: {len(plan)}")
    if no_meta:
        print(f"  缺 metadata.json: {len(no_meta)}  {no_meta[:3]}")
    if no_time:
        print(f"  缺 createdAt: {len(no_time)}  {no_time[:3]}")

    # 按时间升序，同一分钟用 _2 _3 区分
    plan.sort(key=lambda x: (x["ts"], x["id"]))
    used = {}
    for item in plan:
        base = f"{fmt(item['ts'])}_{short_code(item['id'])}"
        n = used.get(base, 0) + 1
        used[base] = n
        item["new"] = base if n == 1 else f"{base}_{n}"

    # 同名冲突（如果目标名已被别的非计划文件夹占用）
    existing = {d.name for d in dirs}
    clash = [i for i in plan if i["new"] in existing and i["new"] != i["old"]]
    if clash:
        print(f"  ! 目标名与现有文件夹冲突: {len(clash)} 个，将追加后缀")
        for i in clash:
            k = 2
            while f"{i['new']}_{k}" in existing:
                k += 1
            i["new"] = f"{i['new']}_{k}"

    print("\n=== 前 8 个 / 后 4 个 ===")
    for i in plan[:8] + (["..."] if len(plan) > 12 else []) + plan[-4:]:
        if i == "...":
            print("  ...")
            continue
        print(f"  {i['old']:<30} ->  {i['new']}")
    print(f"\n  日期范围: {fmt(plan[0]['ts'])} ~ {fmt(plan[-1]['ts'])}")

    if not args.apply:
        print("\n这是预演。加 --apply 才会真正改名。")
        return 0

    # ---- 两段式改名，避免 A->B 时 B 被另一条规则占用 ----
    tmp_map = []
    for idx, i in enumerate(plan):
        tmp = i["dir"].with_name(f"__tmp_{idx:04d}__")
        i["dir"].rename(tmp)
        tmp_map.append((tmp, i["new"]))

    for tmp, new in tmp_map:
        tmp.rename(root / new)

    # 记录映射，便于回滚与检索
    map_path = root / "rename-map.csv"
    with open(map_path, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["新文件夹", "原文件夹", "作品ID", "生成时间"])
        for i in plan:
            w.writerow([i["new"], i["old"], i["id"], fmt(i["ts"])])

    # 同步 index.csv 里的「文件夹」列
    idx_path = root / "index.csv"
    if idx_path.exists():
        rows = list(csv.DictReader(open(idx_path, encoding="utf-8-sig")))
        id2new = {i["id"]: i["new"] for i in plan}
        for r in rows:
            wid = r.get("作品ID")
            if wid in id2new:
                r["文件夹"] = id2new[wid]
        cols = list(rows[0].keys())
        with open(idx_path, "w", encoding="utf-8-sig", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
        print(f"已同步 index.csv 的文件夹列")

    print(f"\n✔ 已重命名 {len(plan)} 个文件夹")
    print(f"  映射表: {map_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
