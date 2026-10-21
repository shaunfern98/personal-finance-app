"""Partner sharing (read-only) + house fund. Additive: new tables only, existing data untouched."""
from __future__ import annotations

import base64
import binascii
import json
import re
import sqlite3
from datetime import date

from flask import Blueprint, Response, g, jsonify, request, session

from db import connect, init_schema

bp = Blueprint("house", __name__)

ACCOUNT_TYPES = ("TFSA", "FHSA", "RRSP", "Non-registered", "Cash / HISA", "Other")


def init_house_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS partner_links (
            user_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
            PRIMARY KEY (user_id, partner_id), CHECK (user_id <> partner_id));
        CREATE TABLE IF NOT EXISTS house_goal (
            user_id INTEGER PRIMARY KEY, target_amount REAL NOT NULL DEFAULT 0,
            target_date TEXT, tracking_start TEXT, starting_cash REAL NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS savings_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
            account_type TEXT NOT NULL DEFAULT 'Other', balance REAL NOT NULL DEFAULT 0,
            counts_toward_house INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS savings_deposits (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('extra', 'invest')), amount REAL NOT NULL CHECK (amount > 0),
            deposit_date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS user_photos (
            user_id INTEGER NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, kind));
        CREATE TABLE IF NOT EXISTS goals (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '🎯',
            target_amount REAL NOT NULL DEFAULT 0, target_date TEXT, shared INTEGER NOT NULL DEFAULT 0, completed_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS goal_contribs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, user_id INTEGER NOT NULL, amount REAL NOT NULL,
            contrib_date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', from_savings INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS goal_photos (
            goal_id INTEGER PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS holdings (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, account_id INTEGER NOT NULL, symbol TEXT NOT NULL,
            shares REAL NOT NULL, avg_cost REAL);
        CREATE TABLE IF NOT EXISTS quote_cache (
            symbol TEXT PRIMARY KEY, price REAL NOT NULL, prev REAL, currency TEXT, name TEXT, fetched_at REAL NOT NULL);
        """
    )


def _db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = connect()
        init_schema(g.db)
    init_house_schema(g.db)
    return g.db


def is_linked(db: sqlite3.Connection, a: int, b: int) -> bool:
    """True only when each user has linked the other."""
    n = db.execute(
        "SELECT COUNT(*) FROM partner_links WHERE (user_id=? AND partner_id=?) OR (user_id=? AND partner_id=?)",
        (a, b, b, a),
    ).fetchone()[0]
    return n == 2


def partner_of(db: sqlite3.Connection, uid: int) -> int | None:
    for r in db.execute("SELECT partner_id FROM partner_links WHERE user_id=?", (uid,)).fetchall():
        if is_linked(db, uid, r[0]):
            return r[0]
    return None


def _username(db, uid):
    r = db.execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()
    return r[0] if r else ""


def _setting(db, uid, key, default=""):
    r = db.execute("SELECT value FROM settings WHERE key=?", (f"u:{uid}:{key}",)).fetchone()
    return r[0] if r else default


def _income(db, uid) -> float:
    for key in ("take_home_override", "monthly_salary"):
        raw = _setting(db, uid, key)
        try:
            v = float(json.loads(raw)) if raw else 0.0
        except (ValueError, TypeError):
            try:
                v = float(raw)
            except (ValueError, TypeError):
                v = 0.0
        if v > 0:
            return v
    return 0.0


def _next(m: str) -> str:
    y, mo = int(m[:4]), int(m[5:7])
    return f"{y + (mo == 12)}-{(mo % 12) + 1:02d}"


def _holdings_value(db, uid: int) -> float:
    """Value (CAD) of holdings in house-counted accounts, from the last cached prices (refreshed when the Investing tab loads)."""
    rows = db.execute("SELECT h.symbol, h.shares FROM holdings h JOIN savings_accounts a ON a.id=h.account_id WHERE h.user_id=? AND a.counts_toward_house=1", (uid,)).fetchall()
    if not rows:
        return 0.0
    c = {r["symbol"]: r for r in db.execute(f"SELECT symbol, price, currency FROM quote_cache WHERE symbol IN ({','.join('?' * (len(rows) + 1))})", [r["symbol"] for r in rows] + ["USDCAD=X"])}
    fx = c["USDCAD=X"]["price"] if "USDCAD=X" in c else 1.0
    return sum(r["shares"] * c[r["symbol"]]["price"] * (fx if c[r["symbol"]]["currency"] == "USD" else 1.0) for r in rows if r["symbol"] in c)


def _person(db, uid: int, cur: str, sel: str = "") -> dict:
    goal = db.execute("SELECT * FROM house_goal WHERE user_id=?", (uid,)).fetchone()
    start = (goal["tracking_start"] if goal else None) or cur
    income = _income(db, uid)
    sav = {r[0] for r in db.execute("SELECT category FROM category_metadata WHERE type='savings'")}
    spent: dict[str, float] = {}
    for r in db.execute(
        "SELECT substr(date,1,7) m, category, SUM(amount) a FROM transactions WHERE user_id=? "
        "AND substr(date,1,7)>=? AND substr(date,1,7)<? GROUP BY m, category", (uid, start, cur)):
        spent.setdefault(r["m"], 0.0)
        if r["category"] not in sav:  # savings-type categories (e.g. Joint Savings) count as saved, not spent
            spent[r["m"]] += r["a"]
    ms = {"s": 0.0, "v": 0.0}
    for r in db.execute("SELECT category, SUM(amount) a FROM transactions WHERE user_id=? AND substr(date,1,7)=? GROUP BY category", (uid, sel or cur)):
        ms["v" if r["category"] in sav else "s"] += r["a"]
    months, m = [], start
    while m < cur:
        if m in spent:
            months.append(income - spent[m])
        m = _next(m)
    dep = lambda k: db.execute(
        "SELECT COALESCE(SUM(amount),0) FROM savings_deposits WHERE user_id=? AND kind=?", (uid, k)).fetchone()[0]
    alloc = db.execute("SELECT COALESCE(SUM(c.amount),0) FROM goal_contribs c JOIN goals gl ON gl.id=c.goal_id "
                       "WHERE c.user_id=? AND c.from_savings=1 AND gl.completed_at IS NULL", (uid,)).fetchone()[0]
    cash = (goal["starting_cash"] if goal else 0) + sum(months) + dep("extra") - dep("invest") - alloc
    inv = db.execute(
        "SELECT COALESCE(SUM(balance),0) FROM savings_accounts WHERE user_id=? AND counts_toward_house=1", (uid,)).fetchone()[0] + _holdings_value(db, uid)
    last = months[-3:]
    return {"username": _username(db, uid), "cash": cash, "invested": inv, "total": cash + inv,
            "avg_monthly": sum(last) / len(last) if last else 0.0, "months_counted": len(months), "income_used": income,
            "month_spent": ms["s"], "month_to_savings": ms["v"], "goal_alloc": alloc}


@bp.get("/api/house")
def house_summary():
    db, me = _db(), g.real_uid
    pid = partner_of(db, me)
    ids = [me] + ([pid] if pid else [])
    q = ",".join("?" * len(ids))
    goal = db.execute("SELECT * FROM house_goal WHERE user_id=?", (me,)).fetchone()
    return jsonify({
        "me": me, "partner_id": pid, "partner_name": _username(db, pid) if pid else None,
        "viewing_partner": g.uid != me,
        "goal": dict(goal) if goal else {"target_amount": 0, "target_date": None, "tracking_start": None, "starting_cash": 0},
        "people": [dict(_person(db, i, date.today().strftime("%Y-%m"), (request.args.get("month") or "")[:7]), id=i) for i in ids],
        "accounts": [dict(r) for r in db.execute(f"SELECT * FROM savings_accounts WHERE user_id IN ({q}) ORDER BY id", ids)],
        "deposits": [dict(r) for r in db.execute(
            f"SELECT * FROM savings_deposits WHERE user_id IN ({q}) ORDER BY deposit_date DESC, id DESC LIMIT 20", ids)],
        "account_types": ACCOUNT_TYPES,
    })


def _num(v, lo=0.0):
    try:
        return max(lo, float(v))
    except (TypeError, ValueError):
        return lo


@bp.put("/api/house/goal")
def put_goal():
    d, db = request.get_json(silent=True) or {}, _db()
    db.execute(
        "INSERT INTO house_goal (user_id, target_amount, target_date, tracking_start, starting_cash) VALUES (?,?,?,?,?) "
        "ON CONFLICT(user_id) DO UPDATE SET target_amount=excluded.target_amount, target_date=excluded.target_date, "
        "tracking_start=excluded.tracking_start, starting_cash=excluded.starting_cash",
        (g.uid, _num(d.get("target_amount")), d.get("target_date") or None,
         (d.get("tracking_start") or date.today().strftime("%Y-%m"))[:7], _num(d.get("starting_cash"), -1e12)))
    db.commit()
    return jsonify({"ok": True})


@bp.post("/api/house/accounts")
def add_account():
    d, db = request.get_json(silent=True) or {}, _db()
    name = str(d.get("name", "")).strip()[:60]
    if not name:
        return jsonify({"error": "Name is required"}), 400
    t = d.get("account_type") if d.get("account_type") in ACCOUNT_TYPES else "Other"
    db.execute("INSERT INTO savings_accounts (user_id, name, account_type, balance) VALUES (?,?,?,?)",
               (g.uid, name, t, _num(d.get("balance"), -1e12)))
    db.commit()
    return jsonify({"ok": True})


@bp.put("/api/house/accounts/<int:aid>")
def update_account(aid: int):
    d, db = request.get_json(silent=True) or {}, _db()
    if "balance" in d:
        db.execute("UPDATE savings_accounts SET balance=? WHERE id=? AND user_id=?", (_num(d["balance"], -1e12), aid, g.uid))
    if "counts_toward_house" in d:
        db.execute("UPDATE savings_accounts SET counts_toward_house=? WHERE id=? AND user_id=?", (1 if d["counts_toward_house"] else 0, aid, g.uid))
    db.commit()
    return jsonify({"ok": True})


@bp.delete("/api/house/accounts/<int:aid>")
def delete_account(aid: int):
    db = _db()
    db.execute("DELETE FROM holdings WHERE account_id=? AND user_id=?", (aid, g.uid))
    db.execute("DELETE FROM savings_accounts WHERE id=? AND user_id=?", (aid, g.uid))
    db.commit()
    return jsonify({"ok": True})


@bp.post("/api/house/deposits")
def add_deposit():
    d, db = request.get_json(silent=True) or {}, _db()
    amt = _num(d.get("amount"))
    if amt <= 0 or d.get("kind") not in ("extra", "invest"):
        return jsonify({"error": "Enter an amount above 0"}), 400
    db.execute("INSERT INTO savings_deposits (user_id, kind, amount, deposit_date, note) VALUES (?,?,?,?,?)",
               (g.uid, d["kind"], amt, d.get("deposit_date") or date.today().isoformat(), str(d.get("note", ""))[:200]))
    db.commit()
    return jsonify({"ok": True})


@bp.delete("/api/house/deposits/<int:did>")
def delete_deposit(did: int):
    db = _db()
    db.execute("DELETE FROM savings_deposits WHERE id=? AND user_id=?", (did, g.uid))
    db.commit()
    return jsonify({"ok": True})


# ---- partner linking / view switching ----
@bp.get("/api/partner")
def partner_status():
    db, me = _db(), g.real_uid
    out = [r[0] for r in db.execute("SELECT partner_id FROM partner_links WHERE user_id=?", (me,))]
    pid = partner_of(db, me)
    return jsonify({"linked": bool(pid), "pending": bool(out) and not pid,
                    "partner_name": _username(db, pid) if pid else None, "viewing_partner": g.uid != me})


@bp.post("/api/partner/link")
def partner_link():
    d, db = request.get_json(silent=True) or {}, _db()
    row = db.execute("SELECT id FROM users WHERE username=?", (str(d.get("username", "")).strip(),)).fetchone()
    if not row or row[0] == g.real_uid:
        return jsonify({"error": "No matching user found"}), 400
    db.execute("INSERT OR IGNORE INTO partner_links (user_id, partner_id) VALUES (?,?)", (g.real_uid, row[0]))
    db.commit()
    return jsonify({"ok": True})


@bp.delete("/api/partner/link")
def partner_unlink():
    db = _db()
    db.execute("DELETE FROM partner_links WHERE user_id=?", (g.real_uid,))
    db.commit()
    session.pop("view_uid", None)
    return jsonify({"ok": True})


@bp.post("/api/partner/view")
def partner_view():
    d, db = request.get_json(silent=True) or {}, _db()
    if d.get("who") == "partner":
        pid = partner_of(db, g.real_uid)
        if not pid:
            return jsonify({"error": "Not linked yet"}), 400
        session["view_uid"] = pid
    else:
        session.pop("view_uid", None)
    return jsonify({"ok": True})


@bp.get("/api/household/transactions")
def household_transactions():
    """Read-only month view for 'me', 'partner' or 'both' (partner data only when mutually linked)."""
    db, me = _db(), g.real_uid
    pid = partner_of(db, me)
    who = request.args.get("who", "me")
    ids = {"me": [me], "partner": [pid] if pid else [], "both": [me] + ([pid] if pid else [])}.get(who, [me])
    month = (request.args.get("month") or date.today().strftime("%Y-%m"))[:7]
    if not ids:
        return jsonify({"items": []})
    q = ",".join("?" * len(ids))
    rows = db.execute(
        f"SELECT t.*, u.username AS owner FROM transactions t JOIN users u ON u.id = t.user_id "
        f"WHERE t.user_id IN ({q}) AND substr(t.date,1,7)=? ORDER BY t.date DESC, t.id DESC", ids + [month]).fetchall()
    keys = ("id", "amount", "date", "category", "cost_type", "purchase", "note", "payment_method", "credit_card")
    return jsonify({"items": [dict({k: r[k] for k in keys}, is_recurring=bool(r["is_recurring"]), owner=r["owner"], own=r["user_id"] == me) for r in rows]})


# ---- profile photos: 'avatar' (one per person) and 'couple' (shared once linked) ----
def _photo_ver(db, uid, kind):
    r = db.execute("SELECT updated_at FROM user_photos WHERE user_id=? AND kind=?", (uid, kind)).fetchone()
    return r[0].replace(" ", "T") if r else None


@bp.get("/api/photos")
def photos_meta():
    db, me = _db(), g.real_uid
    pid = partner_of(db, me)
    out = {"me": {"id": me, "name": _username(db, me), "v": _photo_ver(db, me, "avatar")}, "partner": None,
           "couple": _photo_ver(db, me, "couple") or (_photo_ver(db, pid, "couple") if pid else None)}
    if pid:
        out["partner"] = {"id": pid, "name": _username(db, pid), "v": _photo_ver(db, pid, "avatar")}
    return jsonify(out)


@bp.get("/api/photo/<kind>")
def photo_get(kind: str):
    if kind not in ("avatar", "couple"):
        return "", 404
    db, me = _db(), g.real_uid
    pid = partner_of(db, me)
    uid = request.args.get("uid", type=int) or me
    if kind == "avatar" and uid not in (me, pid):
        return "", 404
    row = db.execute("SELECT mime, data FROM user_photos WHERE user_id=? AND kind=?", (uid if kind == "avatar" else me, kind)).fetchone()
    if not row and kind == "couple" and pid:
        row = db.execute("SELECT mime, data FROM user_photos WHERE user_id=? AND kind='couple'", (pid,)).fetchone()
    if not row:
        return "", 404
    return Response(row["data"], mimetype=row["mime"], headers={"Cache-Control": "private, max-age=86400"})


@bp.post("/api/photo/<kind>")
def photo_set(kind: str):
    if kind not in ("avatar", "couple"):
        return jsonify({"error": "Unknown photo type"}), 404
    m = re.match(r"data:(image/(?:jpeg|png|webp));base64,(.+)$", (request.get_json(silent=True) or {}).get("image", ""), re.S)
    if not m:
        return jsonify({"error": "Please choose a JPG, PNG or WebP image"}), 400
    try:
        raw = base64.b64decode(m.group(2), validate=False)
    except (binascii.Error, ValueError):
        return jsonify({"error": "Could not read that image"}), 400
    if not raw or len(raw) > 600_000:
        return jsonify({"error": "Image is too large"}), 400
    db = _db()
    db.execute("INSERT INTO user_photos (user_id, kind, mime, data) VALUES (?,?,?,?) ON CONFLICT(user_id, kind) DO UPDATE SET "
               "mime=excluded.mime, data=excluded.data, updated_at=datetime('now')", (g.real_uid, kind, m.group(1), raw))
    db.commit()
    return jsonify({"ok": True})


@bp.delete("/api/photo/<kind>")
def photo_delete(kind: str):
    db = _db()
    db.execute("DELETE FROM user_photos WHERE user_id=? AND kind=?", (g.real_uid, kind))
    db.commit()
    return jsonify({"ok": True})
