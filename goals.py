"""Savings goals (photos, shared goals, contributions) + investment holdings with live quotes. Additive tables only."""
from __future__ import annotations

import base64
import binascii
import json
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date

from flask import Blueprint, Response, g, jsonify, request

from house import _db, _username, partner_of

bp = Blueprint("goals", __name__)


def _f(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _visible(db, me: int, gid: int):
    """A goal is visible to its owner, and to the linked partner when it is marked shared."""
    pid = partner_of(db, me) or -1
    return db.execute("SELECT * FROM goals WHERE id=? AND (user_id=? OR (shared=1 AND user_id=?))", (gid, me, pid)).fetchone()


# ---------------- goals ----------------
@bp.get("/api/goals")
def goals_list():
    db, me = _db(), g.real_uid
    pid = partner_of(db, me)
    out = []
    for r in db.execute("SELECT * FROM goals WHERE user_id=? OR (shared=1 AND user_id=?) "
                        "ORDER BY completed_at IS NOT NULL, COALESCE(target_date,'9999'), id", (me, pid or -1)).fetchall():
        by = {x["username"]: x["s"] for x in db.execute(
            "SELECT u.username, SUM(c.amount) s FROM goal_contribs c JOIN users u ON u.id=c.user_id WHERE c.goal_id=? GROUP BY c.user_id", (r["id"],))}
        recent = [dict(x) for x in db.execute(
            "SELECT c.id, c.amount, c.contrib_date, c.note, c.from_savings, u.username, (c.user_id=?) AS mine FROM goal_contribs c "
            "JOIN users u ON u.id=c.user_id WHERE c.goal_id=? ORDER BY c.contrib_date DESC, c.id DESC LIMIT 6", (me, r["id"]))]
        ph = db.execute("SELECT updated_at FROM goal_photos WHERE goal_id=?", (r["id"],)).fetchone()
        out.append({"id": r["id"], "name": r["name"], "emoji": r["emoji"], "target_amount": r["target_amount"], "target_date": r["target_date"],
                    "shared": bool(r["shared"]), "mine": r["user_id"] == me, "owner": _username(db, r["user_id"]), "completed": r["completed_at"],
                    "saved": sum(by.values()), "by": by, "recent": recent, "photo": ph[0].replace(" ", "T") if ph else None})
    return jsonify({"goals": out, "partner": bool(pid)})


def _goal_fields(d):
    name = str(d.get("name", "")).strip()[:60]
    return name, str(d.get("emoji") or "🎯")[:8], max(0.0, _f(d.get("target_amount"))), (d.get("target_date") or None), 1 if d.get("shared") else 0


@bp.post("/api/goals")
def goal_create():
    db, me = _db(), g.real_uid
    name, emoji, target, tdate, shared = _goal_fields(request.get_json(silent=True) or {})
    if not name:
        return jsonify({"error": "Give your goal a name"}), 400
    cur = db.execute("INSERT INTO goals (user_id, name, emoji, target_amount, target_date, shared) VALUES (?,?,?,?,?,?)", (me, name, emoji, target, tdate, shared))
    db.commit()
    return jsonify({"ok": True, "id": cur.lastrowid})


@bp.put("/api/goals/<int:gid>")
def goal_update(gid: int):
    db, me = _db(), g.real_uid
    name, emoji, target, tdate, shared = _goal_fields(request.get_json(silent=True) or {})
    if not name:
        return jsonify({"error": "Give your goal a name"}), 400
    db.execute("UPDATE goals SET name=?, emoji=?, target_amount=?, target_date=?, shared=? WHERE id=? AND user_id=?", (name, emoji, target, tdate, shared, gid, me))
    db.commit()
    return jsonify({"ok": True})


@bp.post("/api/goals/<int:gid>/complete")
def goal_complete(gid: int):
    """Mark as bought/done. Its money is released back to your cash savings; log the purchase as a normal expense."""
    db, me = _db(), g.real_uid
    done = bool((request.get_json(silent=True) or {}).get("done", True))
    db.execute("UPDATE goals SET completed_at=? WHERE id=? AND user_id=?", (date.today().isoformat() if done else None, gid, me))
    db.commit()
    return jsonify({"ok": True})


@bp.delete("/api/goals/<int:gid>")
def goal_delete(gid: int):
    db, me = _db(), g.real_uid
    if db.execute("SELECT 1 FROM goals WHERE id=? AND user_id=?", (gid, me)).fetchone():
        for t in ("goal_contribs", "goal_photos"):
            db.execute(f"DELETE FROM {t} WHERE goal_id=?", (gid,))
        db.execute("DELETE FROM goals WHERE id=?", (gid,))
        db.commit()
    return jsonify({"ok": True})


@bp.post("/api/goals/<int:gid>/contribute")
def goal_contribute(gid: int):
    db, me = _db(), g.real_uid
    d = request.get_json(silent=True) or {}
    if not _visible(db, me, gid):
        return jsonify({"error": "Goal not found"}), 404
    amt = _f(d.get("amount"))
    mine = db.execute("SELECT COALESCE(SUM(amount),0) FROM goal_contribs WHERE goal_id=? AND user_id=?", (gid, me)).fetchone()[0]
    if amt == 0:
        return jsonify({"error": "Enter an amount"}), 400
    if mine + amt < -0.005:
        return jsonify({"error": "You can only take out what you've added (" + f"{mine:,.0f}" + ")"}), 400
    db.execute("INSERT INTO goal_contribs (goal_id, user_id, amount, contrib_date, note, from_savings) VALUES (?,?,?,?,?,?)",
               (gid, me, amt, d.get("date") or date.today().isoformat(), str(d.get("note", ""))[:120], 1 if d.get("from_savings", True) else 0))
    db.commit()
    return jsonify({"ok": True})


@bp.delete("/api/goals/contribs/<int:cid>")
def contrib_delete(cid: int):
    db = _db()
    db.execute("DELETE FROM goal_contribs WHERE id=? AND user_id=?", (cid, g.real_uid))
    db.commit()
    return jsonify({"ok": True})


@bp.post("/api/goals/<int:gid>/photo")
def goal_photo_set(gid: int):
    db, me = _db(), g.real_uid
    if not db.execute("SELECT 1 FROM goals WHERE id=? AND user_id=?", (gid, me)).fetchone():
        return jsonify({"error": "Goal not found"}), 404
    m = re.match(r"data:(image/(?:jpeg|png|webp));base64,(.+)$", (request.get_json(silent=True) or {}).get("image", ""), re.S)
    if not m:
        return jsonify({"error": "Please choose a JPG, PNG or WebP image"}), 400
    try:
        raw = base64.b64decode(m.group(2))
    except (binascii.Error, ValueError):
        return jsonify({"error": "Could not read that image"}), 400
    if not raw or len(raw) > 900_000:
        return jsonify({"error": "Image is too large"}), 400
    db.execute("INSERT INTO goal_photos (goal_id, mime, data) VALUES (?,?,?) ON CONFLICT(goal_id) DO UPDATE SET mime=excluded.mime, data=excluded.data, updated_at=datetime('now')",
               (gid, m.group(1), raw))
    db.commit()
    return jsonify({"ok": True})


@bp.get("/api/goals/<int:gid>/photo")
def goal_photo_get(gid: int):
    db = _db()
    if not _visible(db, g.real_uid, gid):
        return "", 404
    row = db.execute("SELECT mime, data FROM goal_photos WHERE goal_id=?", (gid,)).fetchone()
    return Response(row["data"], mimetype=row["mime"], headers={"Cache-Control": "private, max-age=86400"}) if row else ("", 404)


# ---------------- live quotes + holdings ----------------
def _fetch(sym: str):
    """Yahoo Finance chart endpoint (free, ~15-min delayed, no key). Returns None on any failure."""
    try:
        req = urllib.request.Request("https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(sym) + "?range=1d&interval=1d",
                                     headers={"User-Agent": "Mozilla/5.0 (compatible; HouseholdFinance/1.0)", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as r:
            m = json.load(r)["chart"]["result"][0]["meta"]
        p = m.get("regularMarketPrice")
        if p is None:
            return None
        return (sym, float(p), float(m.get("chartPreviousClose") or m.get("previousClose") or p), m.get("currency") or "USD", m.get("longName") or m.get("shortName") or sym)
    except Exception:  # network blocked, bad ticker, rate limit...
        return None


def quotes(db, syms, max_age: int = 60):
    syms = sorted(set(syms))
    cache = {}
    if syms:
        cache = {r["symbol"]: dict(r) for r in db.execute(f"SELECT * FROM quote_cache WHERE symbol IN ({','.join('?' * len(syms))})", syms)}
    now = time.time()
    stale = [s for s in syms if s not in cache or now - cache[s]["fetched_at"] > max_age]
    failed = []
    if stale:
        with ThreadPoolExecutor(max_workers=8) as ex:
            res = list(ex.map(_fetch, stale))
        for s, r in zip(stale, res):
            if not r:
                failed.append(s)
                continue
            db.execute("INSERT INTO quote_cache (symbol, price, prev, currency, name, fetched_at) VALUES (?,?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET "
                       "price=excluded.price, prev=excluded.prev, currency=excluded.currency, name=excluded.name, fetched_at=excluded.fetched_at", (*r, now))
            cache[s] = {"symbol": s, "price": r[1], "prev": r[2], "currency": r[3], "name": r[4], "fetched_at": now}
        db.commit()
    return cache, failed


_SYM = re.compile(r"^[A-Z0-9.\-=^]{1,15}$")


@bp.get("/api/quote")
def quote_lookup():
    sym = request.args.get("symbol", "").strip().upper()
    if not _SYM.match(sym):
        return jsonify({"error": "Enter a ticker like AAPL or VFV.TO"}), 400
    cache, failed = quotes(_db(), [sym], 30)
    if sym in failed or sym not in cache:
        return jsonify({"error": "Couldn't find that ticker (Canadian listings end in .TO, e.g. XEQT.TO)"}), 404
    c = cache[sym]
    return jsonify({"symbol": sym, "name": c["name"], "price": c["price"], "currency": c["currency"]})


@bp.get("/api/holdings")
def holdings_list():
    db, me = _db(), g.real_uid
    pid = partner_of(db, me)
    ids = [me] + ([pid] if pid else [])
    rows = db.execute(f"SELECT h.*, a.name AS account_name, a.account_type FROM holdings h JOIN savings_accounts a ON a.id=h.account_id "
                      f"WHERE h.user_id IN ({','.join('?' * len(ids))}) ORDER BY h.account_id, h.symbol", ids).fetchall()
    cache, failed = quotes(db, [r["symbol"] for r in rows] + (["USDCAD=X"] if rows else []), 60)
    fx = (cache.get("USDCAD=X") or {}).get("price")
    out, asof = [], 0
    for r in rows:
        c = cache.get(r["symbol"])
        price = c["price"] if c else None
        rate = fx if (c and c["currency"] == "USD" and fx) else 1.0
        val = price * r["shares"] * rate if price is not None else None
        day = (price - c["prev"]) * r["shares"] * rate if price is not None else None
        cost = r["avg_cost"] * r["shares"] * (fx if (c and c["currency"] == "USD" and fx) else 1.0) if r["avg_cost"] else None
        asof = max(asof, c["fetched_at"]) if c else asof
        out.append({"id": r["id"], "account_id": r["account_id"], "account_name": r["account_name"], "account_type": r["account_type"], "symbol": r["symbol"],
                    "name": c["name"] if c else r["symbol"], "shares": r["shares"], "avg_cost": r["avg_cost"], "price": price, "currency": c["currency"] if c else None,
                    "change_pct": ((price / c["prev"] - 1) * 100) if c and c["prev"] else None, "value": val, "day_change": day, "cost": cost,
                    "gain": (val - cost) if (val is not None and cost) else None, "own": r["user_id"] == me, "owner": _username(db, r["user_id"])})
    return jsonify({"holdings": out, "as_of": asof or None, "unavailable": sorted(s for s in failed if s != "USDCAD=X")})


def _holding_payload(db, me, d, existing=None):
    sym = str(d.get("symbol", existing["symbol"] if existing else "")).strip().upper()
    if not _SYM.match(sym):
        return None, "Enter a ticker like AAPL or VFV.TO"
    shares = _f(d.get("shares"), -1)
    if shares <= 0:
        return None, "Shares must be above 0"
    cost = d.get("avg_cost")
    cost = _f(cost) if cost not in (None, "") else None
    return (sym, shares, cost), None


@bp.post("/api/holdings")
def holding_add():
    db, me = _db(), g.real_uid
    d = request.get_json(silent=True) or {}
    if not db.execute("SELECT 1 FROM savings_accounts WHERE id=? AND user_id=?", (d.get("account_id"), me)).fetchone():
        return jsonify({"error": "Pick one of your accounts"}), 400
    p, err = _holding_payload(db, me, d)
    if err:
        return jsonify({"error": err}), 400
    db.execute("INSERT INTO holdings (user_id, account_id, symbol, shares, avg_cost) VALUES (?,?,?,?,?)", (me, d["account_id"], *p))
    db.commit()
    return jsonify({"ok": True})


@bp.put("/api/holdings/<int:hid>")
def holding_update(hid: int):
    db, me = _db(), g.real_uid
    row = db.execute("SELECT * FROM holdings WHERE id=? AND user_id=?", (hid, me)).fetchone()
    if not row:
        return jsonify({"error": "Holding not found"}), 404
    p, err = _holding_payload(db, me, request.get_json(silent=True) or {}, row)
    if err:
        return jsonify({"error": err}), 400
    db.execute("UPDATE holdings SET symbol=?, shares=?, avg_cost=? WHERE id=?", (*p, hid))
    db.commit()
    return jsonify({"ok": True})


@bp.delete("/api/holdings/<int:hid>")
def holding_delete(hid: int):
    db = _db()
    db.execute("DELETE FROM holdings WHERE id=? AND user_id=?", (hid, g.real_uid))
    db.commit()
    return jsonify({"ok": True})
