"""Credit-card overview (monthly spend, photo, statement/due tracking) + household calendar (events, card dues, goal dates) + iPhone .ics feed."""
from __future__ import annotations

import base64
import binascii
import calendar as pycal
import re
import secrets
from datetime import date, datetime, timedelta, timezone

from flask import Blueprint, Response, g, jsonify, request

from house import _db, _username, partner_of

bp = Blueprint("cards", __name__)
_today = date.today  # replaceable in tests


def _f(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _day(v):
    try:
        n = int(v)
        return n if 1 <= n <= 31 else None
    except (TypeError, ValueError):
        return None


def _shift(y: int, m: int, n: int):
    t = y * 12 + (m - 1) + n
    return t // 12, t % 12 + 1


def _clamp(y: int, m: int, d: int) -> date:
    return date(y, m, min(d, pycal.monthrange(y, m)[1]))


# ---------------- credit cards ----------------
def _meta(db, cid: int) -> dict:
    r = db.execute("SELECT * FROM card_meta WHERE card_id=?", (cid,)).fetchone()
    return dict(r) if r else {"statement_day": None, "due_day": None, "credit_limit": None, "paid_due": None}


def _spend(db, uid, nick, a: str, b: str) -> float:
    return db.execute("SELECT COALESCE(SUM(amount),0) FROM transactions WHERE user_id=? AND payment_method='credit' AND credit_card=? AND date>? AND date<=?",
                      (uid, nick, a, b)).fetchone()[0]


def card_state(db, c, meta: dict, today: date) -> dict:
    """Statement logic: the previous cycle's spend is the balance due on the due date; spend since the statement is still building."""
    uid, nick, sd, dd, paid = c["user_id"], c["nickname"], meta["statement_day"], meta["due_day"], meta["paid_due"]
    y, m = today.year, today.month
    due = None
    if sd:
        this = _clamp(y, m, sd)
        last = this if today >= this else _clamp(*_shift(y, m, -1), sd)
        prev, nxt = _clamp(*_shift(last.year, last.month, -1), sd), _clamp(*_shift(last.year, last.month, 1), sd)
        stmt, cur = _spend(db, uid, nick, prev.isoformat(), last.isoformat()), _spend(db, uid, nick, last.isoformat(), today.isoformat())
        due_for = lambda s: _clamp(s.year, s.month, dd) if (dd and dd > sd) else (_clamp(*_shift(s.year, s.month, 1), dd) if dd else None)
        owed, kind, is_paid = stmt, "statement", False
        if dd:
            d_last = due_for(last)
            if paid and paid >= d_last.isoformat():
                due, owed, kind, is_paid = due_for(nxt), cur, "cycle", True
            else:
                due = d_last
    else:
        cur = owed = _spend(db, uid, nick, (today.replace(day=1) - timedelta(days=1)).isoformat(), today.isoformat())
        kind, is_paid = "month", False
        if dd:
            this = _clamp(y, m, dd)
            due = this if this >= today else _clamp(*_shift(y, m, 1), dd)
    first = _clamp(*_shift(y, m, -5), 1)
    by = {r[0]: r[1] for r in db.execute("SELECT substr(date,1,7), SUM(amount) FROM transactions WHERE user_id=? AND payment_method='credit' AND credit_card=? AND date>=? GROUP BY 1",
                                         (uid, nick, first.isoformat()))}
    months = []
    for n in range(-5, 1):
        yy, mm = _shift(y, m, n)
        months.append({"m": f"{yy}-{mm:02d}", "amt": by.get(f"{yy}-{mm:02d}", 0.0)})
    return {"due_date": due.isoformat() if due else None, "due_in": (due - today).days if due else None, "overdue": bool(due and due < today and kind == "statement" and not is_paid),
            "owed": owed, "owed_kind": kind, "cycle_spend": cur, "paid": is_paid, "months": months}


@bp.get("/api/cards/overview")
def cards_overview():
    db, me, today = _db(), g.real_uid, _today()
    pid = partner_of(db, me)
    out = []
    for c in db.execute("SELECT * FROM credit_cards WHERE user_id IN (?,?) ORDER BY user_id<>?, id", (me, pid or -1, me)).fetchall():
        meta = _meta(db, c["id"])
        ph = db.execute("SELECT updated_at FROM card_photos WHERE card_id=?", (c["id"],)).fetchone()
        out.append(dict({"id": c["id"], "nickname": c["nickname"], "card_type": c["card_type"], "last_four": c["last_four"], "own": c["user_id"] == me, "owner": _username(db, c["user_id"]),
                         "photo": ph[0].replace(" ", "T") if ph else None, "statement_day": meta["statement_day"], "due_day": meta["due_day"], "credit_limit": meta["credit_limit"]},
                        **card_state(db, c, meta, today)))
    return jsonify({"cards": out, "partner": bool(pid)})


def _own_card(db, cid):
    return db.execute("SELECT * FROM credit_cards WHERE id=? AND user_id=?", (cid, g.real_uid)).fetchone()


@bp.put("/api/cards/<int:cid>/meta")
def card_meta_set(cid: int):
    db, d = _db(), request.get_json(silent=True) or {}
    if not _own_card(db, cid):
        return jsonify({"error": "Card not found"}), 404
    db.execute("INSERT INTO card_meta (card_id, user_id, statement_day, due_day, credit_limit) VALUES (?,?,?,?,?) ON CONFLICT(card_id) DO UPDATE SET "
               "statement_day=excluded.statement_day, due_day=excluded.due_day, credit_limit=excluded.credit_limit",
               (cid, g.real_uid, _day(d.get("statement_day")), _day(d.get("due_day")), _f(d.get("credit_limit"))))
    db.commit()
    return jsonify({"ok": True})


@bp.post("/api/cards/<int:cid>/paid")
def card_paid(cid: int):
    db, c = _db(), _own_card(_db(), cid)
    if not c:
        return jsonify({"error": "Card not found"}), 404
    meta = _meta(db, cid)
    if (request.get_json(silent=True) or {}).get("paid", True):
        st = card_state(db, c, dict(meta, paid_due=None), _today())  # the bill currently due, ignoring any earlier 'paid' mark
        if not st["due_date"] or st["owed_kind"] != "statement":
            return jsonify({"error": "Set a statement day and due day first"}), 400
        val = st["due_date"]
    else:
        val = None
    db.execute("INSERT INTO card_meta (card_id, user_id, paid_due) VALUES (?,?,?) ON CONFLICT(card_id) DO UPDATE SET paid_due=excluded.paid_due", (cid, g.real_uid, val))
    db.commit()
    return jsonify({"ok": True})


@bp.post("/api/cards/<int:cid>/photo")
def card_photo_set(cid: int):
    db = _db()
    if not _own_card(db, cid):
        return jsonify({"error": "Card not found"}), 404
    m = re.match(r"data:(image/(?:jpeg|png|webp));base64,(.+)$", (request.get_json(silent=True) or {}).get("image", ""), re.S)
    if not m:
        return jsonify({"error": "Please choose a JPG, PNG or WebP image"}), 400
    try:
        raw = base64.b64decode(m.group(2))
    except (binascii.Error, ValueError):
        return jsonify({"error": "Could not read that image"}), 400
    if not raw or len(raw) > 700_000:
        return jsonify({"error": "Image is too large"}), 400
    db.execute("INSERT INTO card_photos (card_id, mime, data) VALUES (?,?,?) ON CONFLICT(card_id) DO UPDATE SET mime=excluded.mime, data=excluded.data, updated_at=datetime('now')", (cid, m.group(1), raw))
    db.commit()
    return jsonify({"ok": True})


@bp.get("/api/cards/<int:cid>/photo")
def card_photo_get(cid: int):
    db, me = _db(), g.real_uid
    c = db.execute("SELECT user_id FROM credit_cards WHERE id=?", (cid,)).fetchone()
    if not c or c["user_id"] not in (me, partner_of(db, me)):
        return "", 404
    row = db.execute("SELECT mime, data FROM card_photos WHERE card_id=?", (cid,)).fetchone()
    return Response(row["data"], mimetype=row["mime"], headers={"Cache-Control": "private, max-age=86400"}) if row else ("", 404)


# ---------------- calendar ----------------
def _occurrences(start: date, repeat: str, a: date, b: date):
    if repeat == "monthly":
        y, m, out = a.year, a.month, []
        while date(y, m, 1) <= b:
            d = _clamp(y, m, start.day)
            if start <= d and a <= d <= b:
                out.append(d)
            y, m = _shift(y, m, 1)
        return out
    if repeat == "yearly":
        return [d for d in (_clamp(yy, start.month, start.day) for yy in range(a.year, b.year + 1)) if start <= d and a <= d <= b]
    return [start] if a <= start <= b else []


def _visible_events(db, me, pid):
    return db.execute("SELECT * FROM events WHERE user_id=? OR (shared=1 AND user_id=?) ORDER BY event_date", (me, pid or -1)).fetchall()


@bp.get("/api/calendar/events")
def calendar_events():
    db, me, today = _db(), g.real_uid, _today()
    try:
        a, b = date.fromisoformat(request.args["from"]), date.fromisoformat(request.args["to"])
    except (KeyError, ValueError):
        return jsonify({"error": "from/to dates required"}), 400
    if b < a or (b - a).days > 120:
        return jsonify({"error": "Range too large"}), 400
    pid = partner_of(db, me)
    items = []
    for e in _visible_events(db, me, pid):
        for d in _occurrences(date.fromisoformat(e["event_date"]), e["repeat"], a, b):
            items.append({"date": d.isoformat(), "kind": "event", "title": e["title"], "id": e["id"], "note": e["note"], "repeat": e["repeat"], "remind_days": e["remind_days"],
                          "shared": bool(e["shared"]), "mine": e["user_id"] == me, "owner": _username(db, e["user_id"]), "event_date": e["event_date"]})
    for c in db.execute("SELECT * FROM credit_cards WHERE user_id IN (?,?)", (me, pid or -1)).fetchall():
        meta = _meta(db, c["id"])
        if not meta["due_day"]:
            continue
        st = card_state(db, c, meta, today)
        y, m = a.year, a.month
        while date(y, m, 1) <= b:
            d = _clamp(y, m, meta["due_day"])
            if a <= d <= b:
                cur_due = st["due_date"] == d.isoformat()
                items.append({"date": d.isoformat(), "kind": "card", "title": f"{c['nickname']} bill due", "card_id": c["id"], "mine": c["user_id"] == me, "owner": _username(db, c["user_id"]),
                              "paid": bool(meta["paid_due"] and d.isoformat() <= meta["paid_due"]), "overdue": bool(cur_due and st["overdue"]), "amount": st["owed"] if (cur_due and st["owed_kind"] == "statement") else None})
            y, m = _shift(y, m, 1)
    for gl in db.execute("SELECT * FROM goals WHERE completed_at IS NULL AND target_date IS NOT NULL AND (user_id=? OR (shared=1 AND user_id=?))", (me, pid or -1)).fetchall():
        if a.isoformat() <= gl["target_date"] <= b.isoformat():
            items.append({"date": gl["target_date"], "kind": "goal", "title": f"{gl['name']} target date", "emoji": gl["emoji"], "mine": gl["user_id"] == me})
    items.sort(key=lambda x: (x["date"], x["kind"]))
    return jsonify({"items": items, "partner": bool(pid)})


def _event_fields(d):
    title = str(d.get("title", "")).strip()[:80]
    try:
        ed = date.fromisoformat(d.get("event_date", "")).isoformat()
    except ValueError:
        ed = None
    rem = d.get("remind_days")
    rem = int(rem) if str(rem).lstrip("-").isdigit() and 0 <= int(rem) <= 14 else 1
    return title, ed, d.get("repeat") if d.get("repeat") in ("monthly", "yearly") else "none", rem, str(d.get("note", ""))[:300], 1 if d.get("shared") else 0


@bp.post("/api/calendar/events")
def event_create():
    title, ed, rep, rem, note, shared = _event_fields(request.get_json(silent=True) or {})
    if not title or not ed:
        return jsonify({"error": "A title and a date are required"}), 400
    db = _db()
    db.execute("INSERT INTO events (user_id, title, event_date, repeat, remind_days, note, shared) VALUES (?,?,?,?,?,?,?)", (g.real_uid, title, ed, rep, rem, note, shared))
    db.commit()
    return jsonify({"ok": True})


@bp.put("/api/calendar/events/<int:eid>")
def event_update(eid: int):
    title, ed, rep, rem, note, shared = _event_fields(request.get_json(silent=True) or {})
    if not title or not ed:
        return jsonify({"error": "A title and a date are required"}), 400
    db = _db()
    db.execute("UPDATE events SET title=?, event_date=?, repeat=?, remind_days=?, note=?, shared=? WHERE id=? AND user_id=?", (title, ed, rep, rem, note, shared, eid, g.real_uid))
    db.commit()
    return jsonify({"ok": True})


@bp.delete("/api/calendar/events/<int:eid>")
def event_delete(eid: int):
    db = _db()
    db.execute("DELETE FROM events WHERE id=? AND user_id=?", (eid, g.real_uid))
    db.commit()
    return jsonify({"ok": True})


# ---------------- iPhone / Apple Calendar subscription feed ----------------
def _token(db, uid, rotate=False) -> str:
    row = db.execute("SELECT token FROM cal_tokens WHERE user_id=?", (uid,)).fetchone()
    if row and not rotate:
        return row[0]
    tok = secrets.token_urlsafe(24)
    db.execute("INSERT INTO cal_tokens (user_id, token) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET token=excluded.token", (uid, tok))
    db.commit()
    return tok


def _urls(tok: str):
    host, proto = request.headers.get("X-Forwarded-Host") or request.host, request.headers.get("X-Forwarded-Proto") or request.scheme
    return {"https": f"{proto}://{host}/cal/{tok}.ics", "webcal": f"webcal://{host}/cal/{tok}.ics"}


@bp.get("/api/calendar/feed")
def feed_info():
    db = _db()
    return jsonify(_urls(_token(db, g.real_uid)))


@bp.post("/api/calendar/feed/regenerate")
def feed_regen():
    db = _db()
    return jsonify(_urls(_token(db, g.real_uid, rotate=True)))


def _esc(s) -> str:
    return str(s).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\r", "").replace("\n", "\\n")


def _fold(line: str) -> str:
    b, out, first = line.encode(), [], True
    while len(b) > (75 if first else 74):
        cut = 75 if first else 74
        while (b[cut] & 0xC0) == 0x80:
            cut -= 1
        out.append(("" if first else " ") + b[:cut].decode())
        b, first = b[cut:], False
    return "\r\n".join(out + [("" if first else " ") + b.decode()])


def _alarm(days: int, text: str):
    trig = "-PT15H" if days <= 1 else f"-P{days - 1}DT15H"  # 9:00 the morning that many days before an all-day event
    return ["BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{_esc(text)}", f"TRIGGER:{trig}", "END:VALARM"]


def build_ics(db, uid: int, today: date) -> str:
    pid = partner_of(db, uid)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Household Finance//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Our Finances",
         "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H", "X-APPLE-CALENDAR-COLOR:#86b8e8"]

    def ev(uidstr, start: date, summary, desc="", rrule=None, remind=None):
        L.extend(["BEGIN:VEVENT", f"UID:{uidstr}@household-finance", f"DTSTAMP:{stamp}", f"DTSTART;VALUE=DATE:{start:%Y%m%d}", f"DTEND;VALUE=DATE:{start + timedelta(days=1):%Y%m%d}", f"SUMMARY:{_esc(summary)}"])
        if desc:
            L.append(f"DESCRIPTION:{_esc(desc)}")
        if rrule:
            L.append("RRULE:" + rrule)
        if remind is not None:
            L.extend(_alarm(remind, summary))
            L.extend(["BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{_esc(summary)}", "TRIGGER:PT9H", "END:VALARM"] if uidstr.startswith("card-") else [])
        L.append("END:VEVENT")

    for c in db.execute("SELECT * FROM credit_cards WHERE user_id=?", (uid,)).fetchall():
        dd = _meta(db, c["id"])["due_day"]
        if dd:
            ev(f"card-{c['id']}", _clamp(today.year, today.month, dd), f"💳 {c['nickname']} bill due", "Pay your credit card statement.", "FREQ=MONTHLY;BYMONTHDAY=" + (str(dd) if dd <= 28 else "-1"), remind=2)
    for e in _visible_events(db, uid, pid):
        rr = {"monthly": "FREQ=MONTHLY", "yearly": "FREQ=YEARLY"}.get(e["repeat"])
        ev(f"event-{e['id']}", date.fromisoformat(e["event_date"]), e["title"], e["note"], rr, remind=e["remind_days"] if e["remind_days"] else None)
    for gl in db.execute("SELECT * FROM goals WHERE completed_at IS NULL AND target_date IS NOT NULL AND (user_id=? OR (shared=1 AND user_id=?))", (uid, pid or -1)).fetchall():
        ev(f"goal-{gl['id']}", date.fromisoformat(gl["target_date"]), f"{gl['emoji']} {gl['name']} — target date")
    L.append("END:VCALENDAR")
    return "\r\n".join(_fold(x) for x in L) + "\r\n"


@bp.get("/cal/<token>.ics")
def feed_ics(token: str):
    """Public but unguessable URL (so Apple Calendar can subscribe without a login). Contains titles/dates only, never amounts."""
    db = _db()
    row = db.execute("SELECT user_id FROM cal_tokens WHERE token=?", (token,)).fetchone()
    if not row:
        return "", 404
    return Response(build_ics(db, row[0], _today()), mimetype="text/calendar", headers={"Cache-Control": "no-cache", "Content-Disposition": 'inline; filename="finances.ics"'})
