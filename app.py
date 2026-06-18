from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import date, datetime
from typing import Any

import secrets

from flask import Flask, Response, g, jsonify, redirect, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

from categories import CATEGORY_SET, EXPENSE_CATEGORIES
from db import connect, db_path, init_schema

app = Flask(__name__, static_folder="static", static_url_path="")
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)

INCOME_FREQUENCIES = {"weekly", "bi_weekly", "semi_monthly", "monthly", "annually", "variable"}
MAX_USERS = int(os.environ.get("MAX_USERS", "2"))

_AUTH_EXEMPT = {"/api/health", "/api/auth/login", "/api/auth/logout",
               "/api/auth/register", "/api/auth/me", "/login"}


@app.before_request
def _auth_guard():
    g.uid = current_uid()
    if request.path.startswith("/api/") and request.path not in _AUTH_EXEMPT:
        if g.uid is None:
            return jsonify({"error": "unauthorized"}), 401


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = connect()
        init_schema(g.db)
    return g.db


@app.teardown_appcontext
def close_db(_: BaseException | None) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def validate_ym(y: int, m: int) -> tuple[int, int]:
    if y < 2000 or y > 2100 or m < 1 or m > 12:
        raise ValueError("Invalid year or month")
    return y, m


def parse_month(s: str) -> tuple[int, int]:
    m = re.fullmatch(r"(\d{4})-(\d{2})", (s or "").strip())
    if not m:
        raise ValueError("month must be YYYY-MM")
    y, mo = int(m.group(1)), int(m.group(2))
    return validate_ym(y, mo)


def row_to_tx(r: sqlite3.Row) -> dict[str, Any]:
    cols = set(r.keys())
    return {
        "id": r["id"],
        "amount": float(r["amount"]),
        "date": r["date"],
        "category": r["category"],
        "cost_type": r["cost_type"],
        "purchase": r["purchase"] or "",
        "note": r["note"] or "",
        "payment_method": r["payment_method"] if "payment_method" in cols and r["payment_method"] else "debit",
        "credit_card": r["credit_card"] if "credit_card" in cols else None,
        "tags": r["tags"] if "tags" in cols else None,
        "is_recurring": bool(r["is_recurring"]) if "is_recurring" in cols else False,
    }


def current_uid() -> int | None:
    return session.get("user_id")


def require_auth() -> Response | None:
    if current_uid() is None:
        return jsonify({"error": "unauthorized"}), 401
    return None


def _setting_get(db: sqlite3.Connection, key: str, default: str | None = None, uid: int = 1) -> str | None:
    r = db.execute("SELECT value FROM settings WHERE key = ?", (f"u:{uid}:{key}",)).fetchone()
    return r["value"] if r else default


def _setting_set(db: sqlite3.Connection, key: str, value: str, uid: int = 1) -> None:
    db.execute(
        """
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (f"u:{uid}:{key}", value),
    )


def _clean_income_payments(raw: Any) -> list[dict[str, Any]]:
    payments: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return payments
    for payment in raw:
        if not isinstance(payment, dict):
            continue
        try:
            amount = float(payment.get("amount", 0))
        except (TypeError, ValueError):
            continue
        if amount <= 0:
            continue
        payment_date = str(payment.get("payment_date") or "").strip()
        day_raw = payment.get("day_of_month")
        day_of_month: int | None = None
        if payment_date:
            try:
                datetime.strptime(payment_date, "%Y-%m-%d")
                day_of_month = int(payment_date[-2:])
            except ValueError:
                continue
        else:
            try:
                day_of_month = int(day_raw)
            except (TypeError, ValueError):
                day_of_month = 1
            if day_of_month < 1 or day_of_month > 31:
                continue
        payments.append(
            {
                "amount": round(amount, 2),
                "day_of_month": day_of_month,
                "payment_date": payment_date or None,
            }
        )
    return payments


def _replace_income_payments(db: sqlite3.Connection, stream_id: int, payments: list[dict[str, Any]]) -> None:
    db.execute("DELETE FROM income_payments WHERE income_stream_id = ?", (stream_id,))
    for payment in payments:
        db.execute(
            """
            INSERT INTO income_payments (income_stream_id, amount, day_of_month, payment_date)
            VALUES (?, ?, ?, ?)
            """,
            (
                stream_id,
                payment["amount"],
                payment["day_of_month"],
                payment["payment_date"],
            ),
        )


def _income_stream_payload(db: sqlite3.Connection, stream_id: int) -> dict[str, Any] | None:
    r = db.execute(
        "SELECT id, label, amount, frequency, is_gross FROM income_streams WHERE id = ?",
        (stream_id,),
    ).fetchone()
    if not r:
        return None
    payment_rows = db.execute(
        """
        SELECT id, amount, day_of_month, payment_date
        FROM income_payments
        WHERE income_stream_id = ?
        ORDER BY COALESCE(payment_date, printf('%02d', day_of_month)) ASC, id ASC
        """,
        (stream_id,),
    ).fetchall()
    return {
        "id": r["id"],
        "label": r["label"],
        "amount": float(r["amount"]),
        "frequency": r["frequency"],
        "is_gross": bool(r["is_gross"]),
        "payments": [
            {
                "id": p["id"],
                "amount": float(p["amount"]),
                "day_of_month": p["day_of_month"],
                "payment_date": p["payment_date"],
            }
            for p in payment_rows
        ],
    }


def _get_monthly_salary(db: sqlite3.Connection, uid: int = 1) -> float:
    raw = _setting_get(db, "monthly_salary", "0", uid=uid)
    try:
        val = json.loads(raw or "0")
        return max(0.0, float(val))
    except (json.JSONDecodeError, TypeError, ValueError):
        try:
            return max(0.0, float(raw or 0))
        except (TypeError, ValueError):
            return 0.0


def _get_all_categories(db: sqlite3.Connection, uid: int = 1) -> list[str]:
    """Return full category list: predefined + user custom (excluding hidden)."""
    custom_rows = db.execute(
        "SELECT category FROM custom_categories WHERE user_id = ? ORDER BY category ASC", (uid,)
    ).fetchall()
    custom = [r["category"] for r in custom_rows]
    hidden_rows = db.execute(
        "SELECT category FROM hidden_categories WHERE user_id = ?", (uid,)
    ).fetchall()
    hidden = {r["category"] for r in hidden_rows}
    all_cats = list(dict.fromkeys(list(EXPENSE_CATEGORIES) + custom))
    return [c for c in all_cats if c not in hidden]


def _get_category_budgets(db: sqlite3.Connection, uid: int = 1) -> dict[str, float]:
    raw = _setting_get(db, "category_budgets", "{}", uid=uid)
    try:
        data = json.loads(raw or "{}")
    except json.JSONDecodeError:
        data = {}
    out: dict[str, float] = {}
    for c in _get_all_categories(db, uid=uid):
        try:
            v = float(data.get(c, 0) or 0)
        except (TypeError, ValueError):
            v = 0.0
        out[c] = max(0.0, round(v, 2))
    return out


def _validate_allowed_category(cat: str | None, db: sqlite3.Connection | None = None) -> str | None:
    if not cat or not str(cat).strip():
        return "category required"
    category = str(cat).strip()
    if category in CATEGORY_SET:
        return None
    if db is not None:
        row = db.execute("SELECT 1 FROM custom_categories WHERE category = ?", (category,)).fetchone()
        if row:
            return None
    if db is None:
        db = get_db()
        row = db.execute("SELECT 1 FROM custom_categories WHERE category = ?", (category,)).fetchone()
        if row:
            return None
    return "category must be one of the predefined or custom options"


@app.get("/api/health")
def health() -> Response:
    return jsonify({"ok": True, "db": str(db_path())})


@app.get("/login")
def login_page():
    if current_uid():
        return redirect("/")
    return send_from_directory("static", "login.html")


@app.post("/api/auth/register")
def auth_register() -> Response:
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    if not username or not password:
        return jsonify({"error": "Username and password required"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400
    db = get_db()
    count = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if count >= MAX_USERS:
        return jsonify({"error": f"Registration closed (max {MAX_USERS} users reached)"}), 403
    existing = db.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    if existing:
        return jsonify({"error": "Username already taken"}), 409
    pw_hash = generate_password_hash(password, method="pbkdf2:sha256")
    cur = db.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)", (username, pw_hash))
    uid = cur.lastrowid
    for key, val in (
        ("dashboard_widgets", '{"daily": true, "category": true, "list": true}'),
        ("monthly_salary", "0"), ("category_budgets", "{}"),
        ("rpp_deduction", "0"), ("rrsp_contribution", "0"),
        ("fhsa_contribution", "0"), ("take_home_override", ""),
        ("show_503020_rule", "false"),
    ):
        _setting_set(db, key, val, uid=uid)
    db.commit()
    session["user_id"] = uid
    session["username"] = username
    return jsonify({"id": uid, "username": username}), 201


@app.post("/api/auth/login")
def auth_login() -> Response:
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    db = get_db()
    row = db.execute("SELECT id, password_hash FROM users WHERE username = ?", (username,)).fetchone()
    if not row or not check_password_hash(row["password_hash"], password):
        return jsonify({"error": "Invalid username or password"}), 401
    session["user_id"] = row["id"]
    session["username"] = username
    return jsonify({"id": row["id"], "username": username})


@app.post("/api/auth/logout")
def auth_logout() -> Response:
    session.clear()
    return jsonify({"ok": True})


@app.post("/api/auth/change-password")
def auth_change_password() -> Response:
    uid = current_uid()
    if uid is None:
        return jsonify({"error": "unauthorized"}), 401
    data = request.get_json(silent=True) or {}
    current_pw = data.get("current_password") or ""
    new_pw = data.get("new_password") or ""
    if not current_pw or not new_pw:
        return jsonify({"error": "current_password and new_password required"}), 400
    if len(new_pw) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400
    db = get_db()
    row = db.execute("SELECT password_hash FROM users WHERE id = ?", (uid,)).fetchone()
    if not row or not check_password_hash(row["password_hash"], current_pw):
        return jsonify({"error": "Current password is incorrect"}), 401
    db.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (generate_password_hash(new_pw, method="pbkdf2:sha256"), uid),
    )
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/auth/me")
def auth_me() -> Response:
    uid = current_uid()
    if uid is None:
        return jsonify({"error": "unauthorized"}), 401
    return jsonify({"id": uid, "username": session.get("username", "")})


def _month_range(y: int, m: int) -> tuple[str, str]:
    start = f"{y:04d}-{m:02d}-01"
    if m == 12:
        end = f"{y+1:04d}-01-01"
    else:
        end = f"{y:04d}-{m+1:02d}-01"
    return start, end


@app.get("/api/transactions")
def list_transactions() -> Response:
    uid = g.uid
    try:
        y, m = parse_month(request.args.get("month", ""))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    start, end = _month_range(y, m)
    db = get_db()
    rows = db.execute(
        """
        SELECT id, amount, date, category, cost_type, purchase, note, payment_method, credit_card, tags, is_recurring
        FROM transactions
        WHERE date >= ? AND date < ? AND user_id = ?
        ORDER BY date ASC, id ASC
        """,
        (start, end, uid),
    ).fetchall()
    return jsonify({"month": f"{y:04d}-{m:02d}", "items": [row_to_tx(r) for r in rows]})


@app.post("/api/transactions")
def create_transaction() -> Response:
    uid = g.uid
    data = request.get_json(silent=True) or {}
    err = _validate_tx_body(data, partial=False)
    if err:
        return jsonify({"error": err}), 400
    db = get_db()
    cur = db.execute(
        """
        INSERT INTO transactions (amount, date, category, cost_type, purchase, note, payment_method, credit_card, tags, is_recurring, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            float(data["amount"]),
            data["date"],
            data["category"].strip(),
            data["cost_type"],
            (data.get("purchase") or "").strip(),
            (data.get("note") or "").strip(),
            data.get("payment_method", "debit"),
            data.get("credit_card"),
            data.get("tags"),
            1 if data.get("is_recurring") else 0,
            uid,
        ),
    )
    db.commit()
    rid = cur.lastrowid
    r = db.execute(
        "SELECT id, amount, date, category, cost_type, purchase, note, payment_method, credit_card, tags, is_recurring FROM transactions WHERE id = ?",
        (rid,),
    ).fetchone()
    return jsonify(row_to_tx(r)), 201


@app.put("/api/transactions/<int:tid>")
def update_transaction(tid: int) -> Response:
    data = request.get_json(silent=True) or {}
    err = _validate_tx_body(data, partial=True)
    if err:
        return jsonify({"error": err}), 400
    db = get_db()
    uid = g.uid
    existing = db.execute(
        "SELECT id FROM transactions WHERE id = ? AND user_id = ?", (tid, uid)
    ).fetchone()
    if not existing:
        return jsonify({"error": "not found"}), 404
    fields: list[str] = []
    vals: list[Any] = []
    for key in ("amount", "date", "category", "cost_type", "purchase", "note", "payment_method", "credit_card", "tags", "is_recurring"):
        if key in data:
            fields.append(f"{key} = ?")
            if key == "amount":
                vals.append(float(data[key]))
            elif key == "category":
                vals.append(str(data[key]).strip())
            elif key in ("note", "purchase", "credit_card", "tags"):
                vals.append(str(data.get(key) or "").strip())
            elif key == "is_recurring":
                vals.append(1 if data[key] else 0)
            else:
                vals.append(data[key])
    if not fields:
        return jsonify({"error": "no fields to update"}), 400
    vals.append(tid)
    db.execute(
        f"UPDATE transactions SET {', '.join(fields)} WHERE id = ?", vals
    )
    db.commit()
    r = db.execute(
        "SELECT id, amount, date, category, cost_type, purchase, note, payment_method, credit_card, tags, is_recurring FROM transactions WHERE id = ?",
        (tid,),
    ).fetchone()
    return jsonify(row_to_tx(r))


@app.delete("/api/transactions/<int:tid>")
def delete_transaction(tid: int) -> Response:
    db = get_db()
    cur = db.execute("DELETE FROM transactions WHERE id = ? AND user_id = ?", (tid, g.uid))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@app.get("/api/stats/daily")
def stats_daily() -> Response:
    try:
        y, m = parse_month(request.args.get("month", ""))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    start, end = _month_range(y, m)
    db = get_db()
    uid = g.uid
    rows = db.execute(
        """
        SELECT CAST(substr(date, 9, 2) AS INTEGER) AS day, SUM(amount) AS total
        FROM transactions
        WHERE date >= ? AND date < ? AND user_id = ?
        GROUP BY day
        ORDER BY day
        """,
        (start, end, uid),
    ).fetchall()
    days_in_month = _days_in_month(y, m)
    by_day = {int(r["day"]): float(r["total"]) for r in rows}
    series = [
        {"day": d, "total": round(by_day.get(d, 0.0), 2)} for d in range(1, days_in_month + 1)
    ]
    return jsonify({"month": f"{y:04d}-{m:02d}", "series": series})


@app.get("/api/stats/category")
def stats_category() -> Response:
    try:
        y, m = parse_month(request.args.get("month", ""))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    start, end = _month_range(y, m)
    db = get_db()
    uid = g.uid
    rows = db.execute(
        """
        SELECT category, SUM(amount) AS total
        FROM transactions
        WHERE date >= ? AND date < ? AND user_id = ?
        GROUP BY category
        ORDER BY total DESC
        """,
        (start, end, uid),
    ).fetchall()
    items = [{"category": r["category"], "total": round(float(r["total"]), 2)} for r in rows]
    return jsonify({"month": f"{y:04d}-{m:02d}", "items": items})


@app.get("/api/stats/category-stack")
def stats_category_stack() -> Response:
    """Per-transaction rows for stacked-by-purchase chart."""
    try:
        y, m = parse_month(request.args.get("month", ""))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    start, end = _month_range(y, m)
    db = get_db()
    uid = g.uid
    totals_rows = db.execute(
        """
        SELECT category, SUM(amount) AS total
        FROM transactions
        WHERE date >= ? AND date < ? AND user_id = ?
        GROUP BY category
        ORDER BY total DESC
        """,
        (start, end, uid),
    ).fetchall()
    category_order = [r["category"] for r in totals_rows]
    tx_rows = db.execute(
        """
        SELECT id, date, category, amount, purchase, note
        FROM transactions
        WHERE date >= ? AND date < ? AND user_id = ?
        ORDER BY date ASC, id ASC
        """,
        (start, end, uid),
    ).fetchall()
    txs = [
        {
            "id": r["id"],
            "date": r["date"],
            "category": r["category"],
            "amount": round(float(r["amount"]), 2),
            "purchase": (r["purchase"] or "").strip(),
            "note": (r["note"] or "").strip(),
        }
        for r in tx_rows
    ]
    return jsonify(
        {
            "month": f"{y:04d}-{m:02d}",
            "category_order": category_order,
            "transactions": txs,
        }
    )


@app.get("/api/categories")
def categories() -> Response:
    uid = g.uid
    db = get_db()
    predefined = list(EXPENSE_CATEGORIES)
    custom_rows = db.execute("SELECT category FROM custom_categories WHERE user_id = ? ORDER BY category ASC", (uid,)).fetchall()
    custom = [r["category"] for r in custom_rows]
    hidden_rows = db.execute("SELECT category FROM hidden_categories WHERE user_id = ?", (uid,)).fetchall()
    hidden = {r["category"] for r in hidden_rows}
    all_categories = [c for c in list(dict.fromkeys(predefined + custom)) if c not in hidden]
    return jsonify({"items": all_categories, "custom": custom})


@app.delete("/api/categories/<path:name>")
def delete_custom_category(name: str) -> Response:
    uid = g.uid
    db = get_db()
    if name in CATEGORY_SET:
        db.execute(
            "INSERT OR IGNORE INTO hidden_categories (category, user_id) VALUES (?, ?)", (name, uid)
        )
        db.commit()
        return jsonify({"ok": True})
    cur = db.execute(
        "DELETE FROM custom_categories WHERE category = ? AND user_id = ?", (name, uid)
    )
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "category not found"}), 404
    return jsonify({"ok": True})


@app.post("/api/categories")
def add_custom_category() -> Response:
    data = request.get_json(silent=True) or {}
    if "name" not in data or not data["name"].strip():
        return jsonify({"error": "category name required"}), 400
    name = data["name"].strip()
    if name in CATEGORY_SET:
        return jsonify({"error": "category already exists in predefined categories"}), 400
    
    db = get_db()
    # Check if custom category already exists
    existing = db.execute("SELECT 1 FROM custom_categories WHERE category = ?", (name,)).fetchone()
    if existing:
        return jsonify({"error": "category already exists"}), 400
    
    uid = g.uid
    db.execute("DELETE FROM hidden_categories WHERE category = ? AND user_id = ?", (name, uid))
    db.execute("INSERT OR IGNORE INTO custom_categories (category, user_id) VALUES (?, ?)", (name, uid))
    db.commit()
    return jsonify({"name": name}), 201


@app.get("/api/categories/metadata")
def get_categories_metadata() -> Response:
    db = get_db()
    rows = db.execute(
        "SELECT category, type, notes, renewal_date, group_name FROM category_metadata"
    ).fetchall()
    metadata = {
        r["category"]: {
            "type": r["type"],
            "notes": r["notes"] or "",
            "renewal_date": r["renewal_date"],
            "group_name": r["group_name"],
        }
        for r in rows
    }
    return jsonify({"metadata": metadata})


@app.put("/api/categories/metadata/<category>")
def update_category_metadata(category: str) -> Response:
    if category not in CATEGORY_SET:
        return jsonify({"error": "invalid category"}), 400
    data = request.get_json(silent=True) or {}
    db = get_db()
    
    fields = []
    values = []
    
    if "type" in data:
        if data["type"] not in ("fixed", "variable", "subscription", "debt", "savings"):
            return jsonify({"error": "invalid type"}), 400
        fields.append("type = ?")
        values.append(data["type"])
    
    if "notes" in data:
        fields.append("notes = ?")
        values.append(data["notes"])
    
    if "renewal_date" in data:
        fields.append("renewal_date = ?")
        values.append(data["renewal_date"])
    
    if "group_name" in data:
        fields.append("group_name = ?")
        values.append(data["group_name"])
    
    if not fields:
        return jsonify({"error": "no fields to update"}), 400
    
    values.append(category)
    db.execute(
        f"UPDATE category_metadata SET {', '.join(fields)} WHERE category = ?",
        values
    )
    db.commit()
    
    r = db.execute(
        "SELECT category, type, notes, renewal_date, group_name FROM category_metadata WHERE category = ?",
        (category,)
    ).fetchone()
    
    return jsonify({
        "category": r["category"],
        "type": r["type"],
        "notes": r["notes"] or "",
        "renewal_date": r["renewal_date"],
        "group_name": r["group_name"],
    })


@app.get("/api/credit-cards/cashback-map")
def get_cashback_map() -> Response:
    uid = g.uid
    db = get_db()
    cards = db.execute(
        "SELECT id, nickname, default_cashback_rate FROM credit_cards WHERE user_id = ? ORDER BY id ASC", (uid,)
    ).fetchall()
    result: dict = {}
    for card in cards:
        rates = db.execute(
            "SELECT category, rate FROM credit_card_cashback WHERE card_id = ? AND user_id = ?",
            (card["id"], uid),
        ).fetchall()
        card_rates: dict = {"__default__": float(card["default_cashback_rate"] if card["default_cashback_rate"] is not None else 0)}
        for r in rates:
            card_rates[r["category"]] = float(r["rate"])
        result[card["nickname"]] = card_rates
    return jsonify({"map": result})


@app.get("/api/credit-cards")
def get_credit_cards() -> Response:
    uid = g.uid
    db = get_db()
    rows = db.execute(
        "SELECT id, nickname, card_type, last_four, default_cashback_rate FROM credit_cards WHERE user_id = ? ORDER BY id ASC", (uid,)
    ).fetchall()
    cards = [
        {
            "id": r["id"],
            "nickname": r["nickname"],
            "card_type": r["card_type"],
            "last_four": r["last_four"],
            "default_cashback_rate": float(r["default_cashback_rate"] if r["default_cashback_rate"] is not None else 0),
        }
        for r in rows
    ]
    return jsonify({"cards": cards})


@app.post("/api/credit-cards")
def create_credit_card() -> Response:
    data = request.get_json(silent=True) or {}
    required = ["nickname", "card_type"]
    for k in required:
        if k not in data:
            return jsonify({"error": f"missing field: {k}"}), 400
    if data["card_type"] not in ("Visa", "Mastercard", "Amex", "Other"):
        return jsonify({"error": "invalid card_type"}), 400
    db = get_db()
    uid = g.uid
    cur = db.execute(
        """
        INSERT INTO credit_cards (nickname, card_type, last_four, user_id)
        VALUES (?, ?, ?, ?)
        """,
        (data["nickname"].strip(), data["card_type"], data.get("last_four", "").strip(), uid),
    )
    db.commit()
    rid = cur.lastrowid
    r2 = db.execute(
        "SELECT id, nickname, card_type, last_four, default_cashback_rate FROM credit_cards WHERE id = ?",
        (rid,),
    ).fetchone()
    return jsonify(
        {
            "id": r2["id"],
            "nickname": r2["nickname"],
            "card_type": r2["card_type"],
            "last_four": r2["last_four"],
            "default_cashback_rate": float(r2["default_cashback_rate"] if r2["default_cashback_rate"] is not None else 0),
        }
    ), 201


@app.put("/api/credit-cards/<int:card_id>")
def update_credit_card(card_id: int) -> Response:
    data = request.get_json(silent=True) or {}
    db = get_db()
    uid = g.uid
    existing = db.execute(
        "SELECT id FROM credit_cards WHERE id = ? AND user_id = ?", (card_id, uid)
    ).fetchone()
    if not existing:
        return jsonify({"error": "not found"}), 404
    fields = []
    values = []
    for key in ("nickname", "card_type", "last_four"):
        if key in data:
            fields.append(f"{key} = ?")
            values.append(data[key].strip() if key != "card_type" else data[key])
    if not fields:
        return jsonify({"error": "no fields to update"}), 400
    values.append(card_id)
    db.execute(
        f"UPDATE credit_cards SET {', '.join(fields)} WHERE id = ?", values
    )
    db.commit()
    r = db.execute(
        "SELECT id, nickname, card_type, last_four, default_cashback_rate FROM credit_cards WHERE id = ?",
        (card_id,),
    ).fetchone()
    return jsonify(
        {
            "id": r["id"],
            "nickname": r["nickname"],
            "card_type": r["card_type"],
            "last_four": r["last_four"],
            "default_cashback_rate": float(r["default_cashback_rate"] if r["default_cashback_rate"] is not None else 0),
        }
    )


@app.get("/api/credit-cards/<int:card_id>/cashback")
def get_card_cashback(card_id: int) -> Response:
    uid = g.uid
    db = get_db()
    card = db.execute(
        "SELECT id, default_cashback_rate FROM credit_cards WHERE id = ? AND user_id = ?", (card_id, uid)
    ).fetchone()
    if not card:
        return jsonify({"error": "not found"}), 404
    rates = db.execute(
        "SELECT category, rate FROM credit_card_cashback WHERE card_id = ? AND user_id = ? ORDER BY category ASC",
        (card_id, uid),
    ).fetchall()
    return jsonify({
        "default_rate": float(card["default_cashback_rate"] if card["default_cashback_rate"] is not None else 0),
        "rates": [{"category": r["category"], "rate": float(r["rate"])} for r in rates],
    })


@app.put("/api/credit-cards/<int:card_id>/cashback")
def update_card_cashback(card_id: int) -> Response:
    uid = g.uid
    data = request.get_json(silent=True) or {}
    db = get_db()
    if not db.execute("SELECT 1 FROM credit_cards WHERE id = ? AND user_id = ?", (card_id, uid)).fetchone():
        return jsonify({"error": "not found"}), 404
    if "default_rate" in data:
        db.execute(
            "UPDATE credit_cards SET default_cashback_rate = ? WHERE id = ? AND user_id = ?",
            (max(0.0, float(data["default_rate"])), card_id, uid),
        )
    if "rates" in data:
        db.execute("DELETE FROM credit_card_cashback WHERE card_id = ? AND user_id = ?", (card_id, uid))
        for r in data["rates"]:
            cat = (r.get("category") or "").strip()
            if cat:
                db.execute(
                    "INSERT INTO credit_card_cashback (card_id, category, rate, user_id) VALUES (?, ?, ?, ?)",
                    (card_id, cat, max(0.0, float(r.get("rate", 0))), uid),
                )
    db.commit()
    return jsonify({"ok": True})


@app.delete("/api/credit-cards/<int:card_id>")
def delete_credit_card(card_id: int) -> Response:
    db = get_db()
    cur = db.execute("DELETE FROM credit_cards WHERE id = ? AND user_id = ?", (card_id, g.uid))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@app.get("/api/debts")
def get_debts() -> Response:
    uid = g.uid
    db = get_db()
    rows = db.execute(
        "SELECT id, name, balance, interest_rate, minimum_payment FROM debts WHERE user_id = ? ORDER BY id ASC", (uid,)
    ).fetchall()
    debts = [
        {
            "id": r["id"],
            "name": r["name"],
            "balance": float(r["balance"]),
            "interest_rate": float(r["interest_rate"]),
            "minimum_payment": float(r["minimum_payment"]),
        }
        for r in rows
    ]
    return jsonify({"debts": debts})


@app.post("/api/debts")
def create_debt() -> Response:
    data = request.get_json(silent=True) or {}
    required = ["name", "balance", "interest_rate", "minimum_payment"]
    for k in required:
        if k not in data:
            return jsonify({"error": f"missing field: {k}"}), 400
    db = get_db()
    uid = g.uid
    cur = db.execute(
        """
        INSERT INTO debts (name, balance, interest_rate, minimum_payment, user_id)
        VALUES (?, ?, ?, ?, ?)
        """,
        (data["name"].strip(), float(data["balance"]), float(data["interest_rate"]), float(data["minimum_payment"]), uid),
    )
    db.commit()
    rid = cur.lastrowid
    r = db.execute(
        "SELECT id, name, balance, interest_rate, minimum_payment FROM debts WHERE id = ?",
        (rid,),
    ).fetchone()
    return jsonify(
        {
            "id": r["id"],
            "name": r["name"],
            "balance": float(r["balance"]),
            "interest_rate": float(r["interest_rate"]),
            "minimum_payment": float(r["minimum_payment"]),
        }
    ), 201


@app.put("/api/debts/<int:debt_id>")
def update_debt(debt_id: int) -> Response:
    data = request.get_json(silent=True) or {}
    db = get_db()
    uid = g.uid
    existing = db.execute(
        "SELECT id FROM debts WHERE id = ? AND user_id = ?", (debt_id, uid)
    ).fetchone()
    if not existing:
        return jsonify({"error": "not found"}), 404
    fields = []
    values = []
    for key in ("name", "balance", "interest_rate", "minimum_payment"):
        if key in data:
            fields.append(f"{key} = ?")
            values.append(float(data[key]) if key != "name" else data[key].strip())
    if not fields:
        return jsonify({"error": "no fields to update"}), 400
    values.append(debt_id)
    db.execute(
        f"UPDATE debts SET {', '.join(fields)} WHERE id = ?", values
    )
    db.commit()
    r = db.execute(
        "SELECT id, name, balance, interest_rate, minimum_payment FROM debts WHERE id = ?",
        (debt_id,),
    ).fetchone()
    return jsonify(
        {
            "id": r["id"],
            "name": r["name"],
            "balance": float(r["balance"]),
            "interest_rate": float(r["interest_rate"]),
            "minimum_payment": float(r["minimum_payment"]),
        }
    )


@app.delete("/api/debts/<int:debt_id>")
def delete_debt(debt_id: int) -> Response:
    db = get_db()
    cur = db.execute("DELETE FROM debts WHERE id = ? AND user_id = ?", (debt_id, g.uid))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@app.get("/api/goals")
def get_goals() -> Response:
    uid = g.uid
    db = get_db()
    rows = db.execute(
        "SELECT id, name, target_amount, current_amount, monthly_contribution FROM savings_goals WHERE user_id = ? ORDER BY id ASC", (uid,)
    ).fetchall()
    goals = [
        {
            "id": r["id"],
            "name": r["name"],
            "target_amount": float(r["target_amount"]),
            "current_amount": float(r["current_amount"]),
            "monthly_contribution": float(r["monthly_contribution"]),
        }
        for r in rows
    ]
    return jsonify({"goals": goals})


@app.post("/api/goals")
def create_goal() -> Response:
    data = request.get_json(silent=True) or {}
    required = ["name", "target_amount", "monthly_contribution"]
    for k in required:
        if k not in data:
            return jsonify({"error": f"missing field: {k}"}), 400
    db = get_db()
    uid = g.uid
    cur = db.execute(
        """
        INSERT INTO savings_goals (name, target_amount, current_amount, monthly_contribution, user_id)
        VALUES (?, ?, ?, ?, ?)
        """,
        (data["name"].strip(), float(data["target_amount"]), 0, float(data["monthly_contribution"]), uid),
    )
    db.commit()
    rid = cur.lastrowid
    r = db.execute(
        "SELECT id, name, target_amount, current_amount, monthly_contribution FROM savings_goals WHERE id = ?",
        (rid,),
    ).fetchone()
    return jsonify(
        {
            "id": r["id"],
            "name": r["name"],
            "target_amount": float(r["target_amount"]),
            "current_amount": float(r["current_amount"]),
            "monthly_contribution": float(r["monthly_contribution"]),
        }
    ), 201


@app.put("/api/goals/<int:goal_id>")
def update_goal(goal_id: int) -> Response:
    data = request.get_json(silent=True) or {}
    db = get_db()
    uid = g.uid
    existing = db.execute(
        "SELECT id FROM savings_goals WHERE id = ? AND user_id = ?", (goal_id, uid)
    ).fetchone()
    if not existing:
        return jsonify({"error": "not found"}), 404
    fields = []
    values = []
    for key in ("name", "target_amount", "current_amount", "monthly_contribution"):
        if key in data:
            fields.append(f"{key} = ?")
            values.append(float(data[key]) if key != "name" else data[key].strip())
    if not fields:
        return jsonify({"error": "no fields to update"}), 400
    values.append(goal_id)
    db.execute(
        f"UPDATE savings_goals SET {', '.join(fields)} WHERE id = ?", values
    )
    db.commit()
    r = db.execute(
        "SELECT id, name, target_amount, current_amount, monthly_contribution FROM savings_goals WHERE id = ?",
        (goal_id,),
    ).fetchone()
    return jsonify(
        {
            "id": r["id"],
            "name": r["name"],
            "target_amount": float(r["target_amount"]),
            "current_amount": float(r["current_amount"]),
            "monthly_contribution": float(r["monthly_contribution"]),
        }
    )


@app.delete("/api/goals/<int:goal_id>")
def delete_goal(goal_id: int) -> Response:
    db = get_db()
    cur = db.execute("DELETE FROM savings_goals WHERE id = ? AND user_id = ?", (goal_id, g.uid))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@app.get("/api/recurring-expenses")
def get_recurring_expenses() -> Response:
    uid = g.uid
    db = get_db()
    rows = db.execute(
        "SELECT id, name, amount, category, cost_type, start_date, end_date, frequency, day_of_month FROM recurring_expenses WHERE user_id = ? ORDER BY id ASC", (uid,)
    ).fetchall()
    expenses = [
        {
            "id": r["id"],
            "name": r["name"],
            "amount": float(r["amount"]),
            "category": r["category"],
            "cost_type": r["cost_type"],
            "start_date": r["start_date"],
            "end_date": r["end_date"],
            "frequency": r["frequency"],
            "day_of_month": r["day_of_month"],
        }
        for r in rows
    ]
    return jsonify({"expenses": expenses})


def _generate_transaction_dates(start_date: str, end_date: str, frequency: str, day_of_month: int | None = None) -> list[str]:
    from datetime import timedelta
    import calendar

    dates: list[str] = []
    start_date_obj = datetime.strptime(start_date, "%Y-%m-%d")
    end_date_obj = datetime.strptime(end_date, "%Y-%m-%d")
    if end_date_obj < start_date_obj:
        return dates
    current_date = start_date_obj

    def add_months(dt: datetime, months: int) -> datetime:
        month_index = dt.month - 1 + months
        year = dt.year + month_index // 12
        month = month_index % 12 + 1
        day = min(dt.day, calendar.monthrange(year, month)[1])
        return dt.replace(year=year, month=month, day=day)

    while current_date <= end_date_obj:
        dates.append(current_date.strftime("%Y-%m-%d"))
        if frequency == "monthly":
            current_date = add_months(current_date, 1)
        elif frequency == "quarterly":
            current_date = add_months(current_date, 3)
        elif frequency == "annually":
            current_date = add_months(current_date, 12)
        else:
            break

        if day_of_month:
            max_day = calendar.monthrange(current_date.year, current_date.month)[1]
            current_date = current_date.replace(day=min(day_of_month, max_day))

    return dates


def _validate_recurring_body(data: dict[str, Any]) -> str | None:
    required = ["name", "amount", "category", "cost_type", "start_date", "end_date", "frequency"]
    for k in required:
        if k not in data:
            return f"missing field: {k}"
    try:
        if float(data["amount"]) < 0:
            return "amount must be >= 0"
    except (TypeError, ValueError):
        return "amount must be a number"
    for key in ("start_date", "end_date"):
        try:
            datetime.strptime(str(data[key]), "%Y-%m-%d")
        except ValueError:
            return f"{key} must be YYYY-MM-DD"
    if datetime.strptime(str(data["end_date"]), "%Y-%m-%d") < datetime.strptime(str(data["start_date"]), "%Y-%m-%d"):
        return "end_date must be on or after start_date"
    if data["frequency"] not in ("monthly", "quarterly", "annually"):
        return "frequency must be monthly, quarterly, or annually"
    if data["cost_type"] not in ("fixed", "variable"):
        return "cost_type must be fixed or variable"
    err = _validate_allowed_category(data.get("category"))
    if err:
        return err
    if "day_of_month" in data and data["day_of_month"] not in (None, ""):
        try:
            day = int(data["day_of_month"])
        except (TypeError, ValueError):
            return "day_of_month must be a number"
        if day < 1 or day > 31:
            return "day_of_month must be between 1 and 31"
    return None


@app.post("/api/recurring-expenses")
def create_recurring_expense() -> Response:
    data = request.get_json(silent=True) or {}
    err = _validate_recurring_body(data)
    if err:
        return jsonify({"error": err}), 400
    db = get_db()
    day_of_month = int(data.get("day_of_month") or str(data["start_date"])[-2:])
    uid = g.uid
    cur = db.execute(
        """
        INSERT INTO recurring_expenses (name, amount, category, cost_type, start_date, end_date, frequency, day_of_month, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (data["name"].strip(), float(data["amount"]), data["category"], data["cost_type"], data["start_date"], data["end_date"], data["frequency"], day_of_month, uid),
    )
    db.commit()
    rid = cur.lastrowid
    
    transaction_dates = _generate_transaction_dates(
        data["start_date"], 
        data["end_date"], 
        data["frequency"], 
        day_of_month
    )
    
    for date in transaction_dates:
        db.execute(
            """
            INSERT INTO transactions (amount, date, category, cost_type, purchase, note, payment_method, credit_card, tags, is_recurring, recurring_expense_id, user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (float(data["amount"]), date, data["category"], data["cost_type"], data["name"].strip(), "Auto-generated from recurring expense", "debit", None, None, 1, rid, uid)
        )
    db.commit()
    
    r = db.execute(
        "SELECT id, name, amount, category, cost_type, start_date, end_date, frequency, day_of_month FROM recurring_expenses WHERE id = ?",
        (rid,),
    ).fetchone()
    return jsonify(
        {
            "id": r["id"],
            "name": r["name"],
            "amount": float(r["amount"]),
            "category": r["category"],
            "cost_type": r["cost_type"],
            "start_date": r["start_date"],
            "end_date": r["end_date"],
            "frequency": r["frequency"],
            "day_of_month": r["day_of_month"],
            "generated_transactions_count": len(transaction_dates),
        }
    ), 201


@app.delete("/api/recurring-expenses/<int:expense_id>")
def delete_recurring_expense(expense_id: int) -> Response:
    uid = g.uid
    db = get_db()
    db.execute("DELETE FROM transactions WHERE recurring_expense_id = ? AND user_id = ?", (expense_id, uid))
    cur = db.execute("DELETE FROM recurring_expenses WHERE id = ? AND user_id = ?", (expense_id, uid))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@app.post("/api/import/json")
def import_json() -> Response:
    uid = g.uid
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "No JSON body"}), 400
    db = get_db()
    counts: dict[str, int] = {}

    txs = data.get("transactions", [])
    for t in txs:
        try:
            db.execute(
                """INSERT OR IGNORE INTO transactions
                   (amount, date, category, cost_type, purchase, note,
                    payment_method, credit_card, tags, is_recurring, user_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (float(t["amount"]), t["date"], t.get("category"), t.get("cost_type"),
                 t.get("purchase"), t.get("note"), t.get("payment_method","debit"),
                 t.get("credit_card"), t.get("tags"), int(t.get("is_recurring", 0)), uid),
            )
        except Exception:
            pass
    counts["transactions"] = len(txs)

    for s in data.get("income_streams", []):
        try:
            db.execute(
                """INSERT INTO income_streams (label, amount, frequency, is_gross, user_id)
                   VALUES (?,?,?,?,?)""",
                (s.get("label",""), float(s.get("amount",0)),
                 s.get("frequency","monthly"), int(s.get("is_gross",1)), uid),
            )
        except Exception:
            pass
    counts["income_streams"] = len(data.get("income_streams", []))

    for cc in data.get("credit_cards", []):
        try:
            db.execute(
                "INSERT OR IGNORE INTO credit_cards (name, last_four, limit, user_id) VALUES (?,?,?,?)",
                (cc.get("name",""), cc.get("last_four",""), cc.get("limit"), uid),
            )
        except Exception:
            pass
    counts["credit_cards"] = len(data.get("credit_cards", []))

    for d in data.get("debts", []):
        try:
            db.execute(
                """INSERT INTO debts (name, balance, interest_rate, minimum_payment, user_id)
                   VALUES (?,?,?,?,?)""",
                (d.get("name",""), float(d.get("balance",0)),
                 float(d.get("interest_rate",0)), float(d.get("minimum_payment",0)), uid),
            )
        except Exception:
            pass
    counts["debts"] = len(data.get("debts", []))

    for g_obj in data.get("savings_goals", []):
        try:
            db.execute(
                """INSERT INTO savings_goals (name, target_amount, current_amount, user_id)
                   VALUES (?,?,?,?)""",
                (g_obj.get("name",""), float(g_obj.get("target_amount",0)),
                 float(g_obj.get("current_amount",0)), uid),
            )
        except Exception:
            pass
    counts["savings_goals"] = len(data.get("savings_goals", []))

    for key, val in (data.get("settings") or {}).items():
        try:
            bare_key = key.split(":", 2)[-1] if key.startswith("u:") else key
            _setting_set(db, bare_key, val, uid=uid)
        except Exception:
            pass

    db.commit()
    return jsonify({"ok": True, "imported": counts})


@app.get("/api/export/json")
def export_json() -> Response:
    uid = g.uid
    db = get_db()
    transactions = db.execute("SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC", (uid,)).fetchall()
    income_streams = db.execute("SELECT * FROM income_streams WHERE user_id = ? ORDER BY id ASC", (uid,)).fetchall()
    category_metadata = db.execute("SELECT * FROM category_metadata").fetchall()
    credit_cards = db.execute("SELECT * FROM credit_cards WHERE user_id = ? ORDER BY id ASC", (uid,)).fetchall()
    debts = db.execute("SELECT * FROM debts WHERE user_id = ? ORDER BY id ASC", (uid,)).fetchall()
    savings_goals = db.execute("SELECT * FROM savings_goals WHERE user_id = ? ORDER BY id ASC", (uid,)).fetchall()
    settings = db.execute("SELECT key, value FROM settings WHERE key LIKE ?", (f"u:{uid}:%",)).fetchall()
    
    data = {
        "transactions": [dict(r) for r in transactions],
        "income_streams": [dict(r) for r in income_streams],
        "category_metadata": [dict(r) for r in category_metadata],
        "credit_cards": [dict(r) for r in credit_cards],
        "debts": [dict(r) for r in debts],
        "savings_goals": [dict(r) for r in savings_goals],
        "settings": {r["key"]: r["value"] for r in settings},
        "exported_at": datetime.now().isoformat(),
    }
    
    response = Response(json.dumps(data, indent=2), mimetype="application/json")
    response.headers["Content-Disposition"] = f'attachment; filename="ledger_export_{datetime.now().strftime("%Y%m%d")}.json"'
    return response


@app.get("/api/export/csv")
def export_csv() -> Response:
    try:
        db = get_db()
        # Use specific column names instead of SELECT * to avoid potential issues
        uid = g.uid
        transactions = db.execute("""
            SELECT id, date, category, cost_type, purchase, amount, note,
                   payment_method, credit_card, tags, is_recurring
            FROM transactions
            WHERE user_id = ?
            ORDER BY date DESC, id DESC
        """, (uid,)).fetchall()
        
        def escape_csv_field(value):
            """Escape a field for CSV output"""
            if value is None:
                return ""
            # Convert to string and replace any double quotes with two double quotes
            str_value = str(value).replace('"', '""')
            # If the field contains a comma, quote, or newline, wrap in quotes
            if any(char in str_value for char in [',', '"', '\n', '\r']):
                return f'"{str_value}"'
            return str_value
        
        output = "id,date,category,cost_type,purchase,amount,note,payment_method,credit_card,tags,is_recurring\n"
        for tx in transactions:
            row = [
                escape_csv_field(tx["id"]),
                escape_csv_field(tx["date"]),
                escape_csv_field(tx["category"]),
                escape_csv_field(tx["cost_type"]),
                escape_csv_field(tx["purchase"]),
                escape_csv_field(tx["amount"]),
                escape_csv_field(tx["note"] or ""),
                escape_csv_field(tx.get("payment_method", "debit")),
                escape_csv_field(tx.get("credit_card", "")),
                escape_csv_field(tx.get("tags", "")),
                escape_csv_field(tx.get("is_recurring", 0))
            ]
            output += ",".join(row) + "\n"
        
        response = Response(output, mimetype="text/csv")
        response.headers["Content-Disposition"] = f'attachment; filename="ledger_transactions_{datetime.now().strftime("%Y%m%d")}.csv"'
        return response
    except Exception as e:
        # Return error as JSON for better debugging
        return jsonify({"error": f"CSV export failed: {str(e)}"}), 500


@app.get("/api/budget")
def get_budget() -> Response:
    uid = g.uid
    db = get_db()
    salary = _get_monthly_salary(db, uid=uid)
    allocations = _get_category_budgets(db, uid=uid)
    total_budget = round(sum(allocations.values()), 2)
    investing_savings = round(salary - total_budget, 2)
    return jsonify(
        {
            "salary": salary,
            "allocations": allocations,
            "total_budget": total_budget,
            "investing_savings": investing_savings,
        }
    )


@app.put("/api/budget")
def put_budget() -> Response:
    data = request.get_json(silent=True) or {}
    try:
        salary = float(data.get("salary", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "salary must be a number"}), 400
    if salary < 0:
        return jsonify({"error": "salary must be >= 0"}), 400
    allocs_in = data.get("allocations")
    if not isinstance(allocs_in, dict):
        return jsonify({"error": "allocations must be an object"}), 400
    uid = g.uid
    db = get_db()
    out: dict[str, float] = {}
    for c in _get_all_categories(db, uid=uid):
        raw = allocs_in.get(c, 0)
        try:
            v = float(raw)
        except (TypeError, ValueError):
            return jsonify({"error": f"invalid amount for {c}"}), 400
        if v < 0:
            return jsonify({"error": f"budget for {c} must be >= 0"}), 400
        out[c] = round(v, 2)
    _setting_set(db, "monthly_salary", json.dumps(round(salary, 2)), uid=uid)
    _setting_set(db, "category_budgets", json.dumps(out), uid=uid)
    db.commit()
    total_budget = round(sum(out.values()), 2)
    investing_savings = round(salary - total_budget, 2)
    return jsonify(
        {
            "salary": round(salary, 2),
            "allocations": out,
            "total_budget": total_budget,
            "investing_savings": investing_savings,
        }
    )


@app.get("/api/stats/budget-status")
def budget_status() -> Response:
    try:
        y, m = parse_month(request.args.get("month", ""))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    start, end = _month_range(y, m)
    uid = g.uid
    db = get_db()
    all_cats = _get_all_categories(db, uid=uid)
    budgets = _get_category_budgets(db, uid=uid)
    rows = db.execute(
        """
        SELECT category, SUM(amount) AS total
        FROM transactions
        WHERE date >= ? AND date < ? AND user_id = ?
        GROUP BY category
        """,
        (start, end, uid),
    ).fetchall()
    spent: dict[str, float] = {r["category"]: float(r["total"]) for r in rows}
    items: list[dict[str, Any]] = []
    total_budget = 0.0
    total_remaining = 0.0
    for c in all_cats:
        b = budgets.get(c, 0.0)
        s = spent.get(c, 0.0)
        rem = b - s
        total_budget += b
        total_remaining += rem
        items.append(
            {
                "category": c,
                "budget": b,
                "spent": round(s, 2),
                "remaining": round(rem, 2),
                "over": s > b + 1e-9,
            }
        )
    spent_tracked = sum(spent.get(c, 0.0) for c in all_cats)
    return jsonify(
        {
            "month": f"{y:04d}-{m:02d}",
            "items": items,
            "totals": {
                "budget": round(total_budget, 2),
                "spent": round(spent_tracked, 2),
                "remaining": round(total_remaining, 2),
            },
        }
    )


@app.get("/api/settings/dashboard")
def get_dashboard_settings() -> Response:
    uid = g.uid
    db = get_db()
    raw = _setting_get(db, "dashboard_widgets", '{"daily": true, "category": true, "list": true}', uid=uid)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {"daily": True, "category": True, "list": True}
    return jsonify(data)


@app.get("/api/income/streams")
def get_income_streams() -> Response:
    uid = g.uid
    db = get_db()
    rows = db.execute(
        "SELECT id FROM income_streams WHERE user_id = ? ORDER BY id ASC", (uid,)
    ).fetchall()
    streams = [_income_stream_payload(db, r["id"]) for r in rows]
    return jsonify({"streams": streams})


@app.post("/api/income/streams")
def create_income_stream() -> Response:
    data = request.get_json(silent=True) or {}
    required = ["label", "amount", "frequency"]
    for k in required:
        if k not in data:
            return jsonify({"error": f"missing field: {k}"}), 400
    if data["frequency"] not in INCOME_FREQUENCIES:
        return jsonify({"error": "invalid frequency"}), 400
    try:
        amount = float(data["amount"])
        if amount < 0:
            return jsonify({"error": "amount must be >= 0"}), 400
    except (TypeError, ValueError):
        return jsonify({"error": "amount must be a number"}), 400
    db = get_db()
    uid = g.uid
    cur = db.execute(
        """
        INSERT INTO income_streams (label, amount, frequency, is_gross, user_id)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            data["label"].strip(),
            amount,
            data["frequency"],
            1 if data.get("is_gross", True) else 0,
            uid,
        ),
    )
    rid = cur.lastrowid
    _replace_income_payments(db, rid, _clean_income_payments(data.get("payments", [])))
    db.commit()
    return jsonify(_income_stream_payload(db, rid)), 201


@app.put("/api/income/streams/<int:stream_id>")
def update_income_stream(stream_id: int) -> Response:
    data = request.get_json(silent=True) or {}
    db = get_db()
    uid = g.uid
    existing = db.execute(
        "SELECT id FROM income_streams WHERE id = ? AND user_id = ?", (stream_id, uid)
    ).fetchone()
    if not existing:
        return jsonify({"error": "not found"}), 404
    fields: list[str] = []
    vals: list[Any] = []
    for key in ("label", "amount", "frequency", "is_gross"):
        if key in data:
            if key == "frequency" and data[key] not in INCOME_FREQUENCIES:
                return jsonify({"error": "invalid frequency"}), 400
            fields.append(f"{key} = ?")
            if key == "amount":
                try:
                    vals.append(float(data[key]))
                except (TypeError, ValueError):
                    return jsonify({"error": "amount must be a number"}), 400
            elif key == "is_gross":
                vals.append(1 if data[key] else 0)
            else:
                vals.append(data[key])
    if not fields and "payments" not in data:
        return jsonify({"error": "no fields to update"}), 400
    if fields:
        vals.append(stream_id)
        db.execute(
            f"UPDATE income_streams SET {', '.join(fields)} WHERE id = ?", vals
        )
    if "payments" in data:
        _replace_income_payments(db, stream_id, _clean_income_payments(data.get("payments", [])))
    db.commit()
    return jsonify(_income_stream_payload(db, stream_id))


@app.delete("/api/income/streams/<int:stream_id>")
def delete_income_stream(stream_id: int) -> Response:
    uid = g.uid
    db = get_db()
    cur = db.execute("DELETE FROM income_streams WHERE id = ? AND user_id = ?", (stream_id, uid))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@app.get("/api/income/settings")
def get_income_settings() -> Response:
    uid = g.uid
    db = get_db()
    return jsonify(
        {
            "rpp_deduction": float(_setting_get(db, "rpp_deduction", "0", uid=uid) or "0"),
            "rrsp_contribution": float(_setting_get(db, "rrsp_contribution", "0", uid=uid) or "0"),
            "fhsa_contribution": float(_setting_get(db, "fhsa_contribution", "0", uid=uid) or "0"),
            "take_home_override": _setting_get(db, "take_home_override", "", uid=uid) or "",
        }
    )


@app.put("/api/income/settings")
def update_income_settings() -> Response:
    data = request.get_json(silent=True) or {}
    db = get_db()
    uid = g.uid
    if "rpp_deduction" in data:
        try:
            val = float(data["rpp_deduction"])
            if val < 0:
                return jsonify({"error": "rpp_deduction must be >= 0"}), 400
            _setting_set(db, "rpp_deduction", str(val), uid=uid)
        except (TypeError, ValueError):
            return jsonify({"error": "rpp_deduction must be a number"}), 400
    if "rrsp_contribution" in data:
        try:
            val = float(data["rrsp_contribution"])
            if val < 0:
                return jsonify({"error": "rrsp_contribution must be >= 0"}), 400
            _setting_set(db, "rrsp_contribution", str(val), uid=uid)
        except (TypeError, ValueError):
            return jsonify({"error": "rrsp_contribution must be a number"}), 400
    if "fhsa_contribution" in data:
        try:
            val = float(data["fhsa_contribution"])
            if val < 0:
                return jsonify({"error": "fhsa_contribution must be >= 0"}), 400
            _setting_set(db, "fhsa_contribution", str(val), uid=uid)
        except (TypeError, ValueError):
            return jsonify({"error": "fhsa_contribution must be a number"}), 400
    if "take_home_override" in data:
        _setting_set(db, "take_home_override", str(data["take_home_override"]), uid=uid)
    db.commit()
    return jsonify({
        "rpp_deduction": float(_setting_get(db, "rpp_deduction", "0", uid=uid) or "0"),
        "rrsp_contribution": float(_setting_get(db, "rrsp_contribution", "0", uid=uid) or "0"),
        "fhsa_contribution": float(_setting_get(db, "fhsa_contribution", "0", uid=uid) or "0"),
        "take_home_override": _setting_get(db, "take_home_override", "", uid=uid) or "",
    })


@app.put("/api/settings/dashboard")
def put_dashboard_settings() -> Response:
    uid = g.uid
    data = request.get_json(silent=True) or {}
    allowed = {"daily", "category", "list"}
    out: dict[str, bool] = {}
    for k in allowed:
        if k in data:
            out[k] = bool(data[k])
    if not out:
        return jsonify({"error": "expected keys: daily, category, list"}), 400
    db = get_db()
    raw = _setting_get(db, "dashboard_widgets", '{"daily": true, "category": true, "list": true}', uid=uid)
    base = {}
    try:
        base = json.loads(raw)
    except json.JSONDecodeError:
        base = {}
    base.update(out)
    _setting_set(db, "dashboard_widgets", json.dumps(base), uid=uid)
    db.commit()
    return jsonify(base)


@app.get("/")
def index() -> Response:
    if not current_uid():
        return redirect("/login")
    return send_from_directory(app.static_folder, "index.html")


@app.get("/<path:filename>")
def static_files(filename):
    # Only serve static files, not API routes
    if filename.startswith("api/"):
        return jsonify({"error": "not found"}), 404
    return send_from_directory(app.static_folder, filename)


def _days_in_month(y: int, m: int) -> int:
    if m == 12:
        nxt = date(y + 1, 1, 1)
    else:
        nxt = date(y, m + 1, 1)
    cur = date(y, m, 1)
    return (nxt - cur).days


def _validate_tx_body(data: dict[str, Any], partial: bool) -> str | None:
    req = ["amount", "date", "category", "cost_type"]
    if not partial:
        for k in req:
            if k not in data:
                return f"missing field: {k}"
    if "amount" in data or not partial:
        amt = data.get("amount")
        try:
            if float(amt) < 0:
                return "amount must be >= 0"
        except (TypeError, ValueError):
            return "amount must be a number"
    if "date" in data or not partial:
        d = str(data.get("date", "")).strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
            return "date must be YYYY-MM-DD"
        try:
            datetime.strptime(d, "%Y-%m-%d")
        except ValueError:
            return "invalid date"
    if "category" in data or not partial:
        err = _validate_allowed_category(data.get("category"))
        if err:
            return err
    if "cost_type" in data or not partial:
        ct = data.get("cost_type")
        if ct not in ("fixed", "variable"):
            return "cost_type must be fixed or variable"
    if "purchase" in data or not partial:
        p = str(data.get("purchase", "")).strip()
        if len(p) > 500:
            return "purchase is too long (max 500 characters)"
    if "note" in data or not partial:
        n = str(data.get("note", "")).strip()
        if len(n) > 2000:
            return "note is too long"
    if "payment_method" in data:
        pm = data.get("payment_method")
        if pm not in ("cash", "debit", "credit"):
            return "payment_method must be cash, debit, or credit"
    if "credit_card" in data:
        cc = str(data.get("credit_card", "")).strip()
        if len(cc) > 100:
            return "credit_card is too long (max 100 characters)"
    if "tags" in data:
        tags = str(data.get("tags", "")).strip()
        if len(tags) > 500:
            return "tags is too long (max 500 characters)"
    return None


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
