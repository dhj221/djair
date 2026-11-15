#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
众和航空 · 客票索引构建器
------------------------------------------------------------
扫描 tickets/orders/**/*.json，生成：
  tickets/index.json          站点索引（前端列表用，不含证件信息）
  tickets/public/<YYYY>/<订单号>.json   面向访客的脱敏档案

幂等：内容没变化就不写文件，避免 Actions 反复提交。

用法：
  python scripts/build_ticket_index.py            # 默认扫描 tickets/
  python scripts/build_ticket_index.py --dir tickets
"""
import argparse
import datetime
import json
import pathlib
import re
import sys

SENSITIVE_KEYS = {"idNo", "birth", "nationality", "issuer", "customerKey", "customerCode"}


def display_name(cn: str, en: str) -> str:
    cn = (cn or "").strip()
    en = (en or "").strip()
    return cn or en or "—"


def mask_id_no(id_type: str, id_no: str) -> str:
    s = (id_no or "").strip()
    if not s:
        return ""
    if id_type in ("护照", "其它证件"):
        return s if len(s) <= 4 else s[:2] + "*" * max(2, len(s) - 4) + s[-2:]
    return s if len(s) <= 6 else s[:3] + "*" * max(3, len(s) - 6) + s[-3:]


def digest(order: dict) -> dict:
    ps = order.get("passengers") or []
    segs = order.get("segments") or []
    flights = [f for s in segs for f in (s.get("flights") or [])]
    first = flights[0] if flights else {}
    last = flights[-1] if flights else {}
    s0 = segs[0] if segs else {}
    return {
        "orderNo": order.get("orderNo"),
        "issuedAt": order.get("issuedAt"),
        "status": order.get("status") or "PAID",
        "name": display_name(ps[0].get("nameCn"), ps[0].get("nameEn")) if ps else "—",
        "pax": len(ps),
        "from": first.get("fromCity") or s0.get("fromCity") or "",
        "to": last.get("toCity") or s0.get("toCity") or "",
        "depDate": first.get("depDate") or s0.get("date") or "",
        "airlines": " + ".join([f.get("no") or "" for f in flights if f.get("no")]),
        "total": order.get("total"),
        "roundTrip": bool((order.get("roundTripRate") or 1) < 1),
    }


def public_doc(order: dict) -> dict:
    """去掉一切可直接识别身份的字段，只保留查票所需信息。"""
    doc = {k: v for k, v in order.items() if k not in SENSITIVE_KEYS and k != "storage"}
    doc["passengers"] = [
        {
            "nameCn": p.get("nameCn") or "",
            "nameEn": p.get("nameEn") or "",
            "idType": p.get("idType") or "",
            "idNoMask": p.get("idNoMask") or mask_id_no(p.get("idType"), p.get("idNo")),
            "type": p.get("type"),
            "typeName": p.get("typeName"),
            "rate": p.get("rate"),
            "ticketNo": p.get("ticketNo"),
        }
        for p in (order.get("passengers") or [])
    ]
    return doc


def write_if_changed(path: pathlib.Path, text: str) -> bool:
    try:
        if path.exists() and path.read_text("utf-8") == text:
            return False
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, "utf-8")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="tickets", help="客票目录（默认 tickets）")
    args = ap.parse_args()

    root = pathlib.Path(args.dir)
    orders_dir = root / "orders"
    if not orders_dir.exists():
        print(f"[index] 未找到 {orders_dir}，跳过")
        return 0

    orders, written_public, bad = [], 0, 0

    # 1) 逐单处理：生成索引条目 + 公开档
    for p in sorted(orders_dir.rglob("*.json")):
        if not re.match(r"^PE\d{17}\.json$", p.name):
            continue
        try:
            order = json.loads(p.read_text("utf-8"))
        except Exception as e:  # noqa: BLE001
            print(f"[index] 跳过无法解析的文件：{p}（{e}）", file=sys.stderr)
            bad += 1
            continue
        order_no = order.get("orderNo") or p.stem
        orders.append(digest(order))
        year = str(order_no)[2:6]
        pub = root / "public" / year / f"{order_no}.json"
        if write_if_changed(pub, json.dumps(public_doc(order), ensure_ascii=False, indent=2)):
            written_public += 1

    # 2) 清理已不存在订单的公开档
    pub_root = root / "public"
    if pub_root.exists():
        live = {o["orderNo"] for o in orders}
        for p in pub_root.rglob("*.json"):
            if p.stem not in live:
                p.unlink()
                print(f"[index] 清理失效公开档：{p}")

    # 3) 索引
    orders.sort(key=lambda o: str(o.get("issuedAt") or ""), reverse=True)
    index = {
        "schema": 1,
        "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "count": len(orders),
        "orders": orders,
    }
    changed = write_if_changed(root / "index.json", json.dumps(index, ensure_ascii=False, indent=2))

    print(f"[index] 订单 {len(orders)} 条，公开档更新 {written_public} 个，"
          f"索引{'已更新' if changed else '无变化'}，异常 {bad} 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())
