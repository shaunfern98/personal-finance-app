import os
import sqlite3
from pathlib import Path

from categories import EXPENSE_CATEGORIES

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DEFAULT_DB_PATH = DATA_DIR / "finance.db"


def db_path() -> Path:
    target = Path(os.environ.get("FINANCE_DB", str(DEFAULT_DB_PATH)))
    if not target.exists() and DEFAULT_DB_PATH.exists() and target != DEFAULT_DB_PATH:
        import shutil
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(DEFAULT_DB_PATH, target)
    return target


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path(), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            amount REAL NOT NULL CHECK(amount >= 0),
            date TEXT NOT NULL,
            category TEXT NOT NULL,
            cost_type TEXT NOT NULL CHECK(cost_type IN ('fixed', 'variable')),
            purchase TEXT NOT NULL DEFAULT '',
            note TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            payment_method TEXT DEFAULT 'debit',
            credit_card TEXT DEFAULT NULL,
            tags TEXT DEFAULT NULL,
            is_recurring INTEGER DEFAULT 0,
            recurring_expense_id INTEGER DEFAULT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);

        CREATE TABLE IF NOT EXISTS income_streams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            amount REAL NOT NULL CHECK(amount >= 0),
            frequency TEXT NOT NULL CHECK(frequency IN ('weekly', 'bi_weekly', 'semi_monthly', 'monthly', 'annually', 'variable')),
            is_gross INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS income_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            income_stream_id INTEGER NOT NULL,
            amount REAL NOT NULL CHECK(amount >= 0),
            day_of_month INTEGER CHECK(day_of_month BETWEEN 1 AND 31),
            payment_date TEXT DEFAULT NULL,
            FOREIGN KEY (income_stream_id) REFERENCES income_streams(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS custom_categories (
            category TEXT PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS category_metadata (
            category TEXT PRIMARY KEY,
            type TEXT NOT NULL CHECK(type IN ('fixed', 'variable', 'subscription', 'debt', 'savings')),
            notes TEXT DEFAULT '',
            renewal_date TEXT DEFAULT NULL,
            group_name TEXT DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS credit_cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nickname TEXT NOT NULL,
            card_type TEXT NOT NULL CHECK(card_type IN ('Visa', 'Mastercard', 'Amex', 'Other')),
            last_four TEXT DEFAULT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS debts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            balance REAL NOT NULL CHECK(balance >= 0),
            interest_rate REAL NOT NULL CHECK(interest_rate >= 0),
            minimum_payment REAL NOT NULL CHECK(minimum_payment >= 0),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS savings_goals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            target_amount REAL NOT NULL CHECK(target_amount >= 0),
            current_amount REAL NOT NULL DEFAULT 0,
            monthly_contribution REAL NOT NULL CHECK(monthly_contribution >= 0),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS recurring_expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            amount REAL NOT NULL CHECK(amount >= 0),
            category TEXT NOT NULL,
            cost_type TEXT NOT NULL CHECK(cost_type IN ('fixed', 'variable')),
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            frequency TEXT NOT NULL CHECK(frequency IN ('monthly', 'quarterly', 'annually')),
            day_of_month INTEGER CHECK(day_of_month BETWEEN 1 AND 31),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS hidden_categories (
            category TEXT NOT NULL,
            user_id INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (category, user_id)
        );

        CREATE TABLE IF NOT EXISTS credit_card_cashback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id INTEGER NOT NULL,
            category TEXT NOT NULL,
            rate REAL NOT NULL DEFAULT 0 CHECK(rate >= 0),
            user_id INTEGER NOT NULL DEFAULT 1,
            UNIQUE(card_id, category)
        );
        """
    )
    _ensure_column(conn, "income_payments", "payment_date", "TEXT DEFAULT NULL")
    _ensure_column(conn, "income_payments", "day_of_month", "INTEGER CHECK(day_of_month BETWEEN 1 AND 31)")
    _ensure_column(conn, "credit_cards", "cashback_percent", "REAL DEFAULT 0 CHECK(cashback_percent >= 0)")
    _ensure_column(conn, "credit_cards", "default_cashback_rate", "REAL NOT NULL DEFAULT 1")
    for tbl in ("transactions", "income_streams", "custom_categories",
                "category_metadata", "credit_cards", "debts",
                "savings_goals", "recurring_expenses"):
        _ensure_column(conn, tbl, "user_id", "INTEGER NOT NULL DEFAULT 1")
    _migrate_settings_for_users(conn)
    for key, val in (
        ("u:1:dashboard_widgets", '{"daily": true, "category": true, "list": true}'),
        ("u:1:monthly_salary", "0"),
        ("u:1:category_budgets", "{}"),
        ("u:1:rpp_deduction", "0"),
        ("u:1:rrsp_contribution", "0"),
        ("u:1:fhsa_contribution", "0"),
        ("u:1:take_home_override", ""),
        ("u:1:show_503020_rule", "false"),
    ):
        cur = conn.execute("SELECT 1 FROM settings WHERE key = ?", (key,))
        if cur.fetchone() is None:
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?)", (key, val)
            )
    _migrate_transactions_purchase(conn)
    _migrate_category_metadata(conn)
    _migrate_income_streams(conn)
    conn.commit()


def _migrate_settings_for_users(conn: sqlite3.Connection) -> None:
    """Convert bare setting keys (no u:N: prefix) to u:1: scoped keys."""
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    for row in rows:
        key, value = row["key"], row["value"]
        if not key.startswith("u:"):
            new_key = f"u:1:{key}"
            exists = conn.execute("SELECT 1 FROM settings WHERE key = ?", (new_key,)).fetchone()
            if not exists:
                conn.execute("INSERT INTO settings (key, value) VALUES (?, ?)", (new_key, value))
            conn.execute("DELETE FROM settings WHERE key = ?", (key,))


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    cols = [row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _migrate_income_streams(conn: sqlite3.Connection) -> None:
    cols = {row[1] for row in conn.execute("PRAGMA table_info(income_streams)").fetchall()}
    if "income_payments" not in [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS income_payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                income_stream_id INTEGER NOT NULL,
                amount REAL NOT NULL CHECK(amount >= 0),
                day_of_month INTEGER CHECK(day_of_month BETWEEN 1 AND 31),
                FOREIGN KEY (income_stream_id) REFERENCES income_streams(id) ON DELETE CASCADE
            )
            """
        )
    if "frequency" in cols:
        rows = conn.execute("SELECT frequency FROM income_streams").fetchall()
        has_variable = any(row[0] == "variable" for row in rows)
        if not has_variable:
            conn.execute("UPDATE income_streams SET frequency = 'monthly' WHERE frequency NOT IN ('weekly', 'bi_weekly', 'semi_monthly', 'monthly', 'annually', 'variable')")


def _migrate_category_metadata(conn: sqlite3.Connection) -> None:
    for cat in EXPENSE_CATEGORIES:
        cur = conn.execute("SELECT 1 FROM category_metadata WHERE category = ?", (cat,))
        if cur.fetchone() is None:
            cat_type = "variable"
            if cat in ("OSAP",):
                cat_type = "debt"
            elif cat in ("Gym", "Phone", "Spotify", "Amazon Prime", "Therapy"):
                cat_type = "subscription"
            elif cat in ("Joint Savings",):
                cat_type = "savings"
            elif cat in ("Groceries", "Gas", "Haircut", "Clothing"):
                cat_type = "fixed"
            
            conn.execute(
                """
                INSERT INTO category_metadata (category, type, notes, renewal_date, group_name)
                VALUES (?, ?, '', NULL, NULL)
                """,
                (cat, cat_type)
            )


def _migrate_transactions_purchase(conn: sqlite3.Connection) -> None:
    cols = {row[1] for row in conn.execute("PRAGMA table_info(transactions)").fetchall()}
    if "purchase" not in cols:
        conn.execute(
            "ALTER TABLE transactions ADD COLUMN purchase TEXT NOT NULL DEFAULT ''"
        )
    if "payment_method" not in cols:
        conn.execute(
            "ALTER TABLE transactions ADD COLUMN payment_method TEXT DEFAULT 'debit'"
        )
    if "credit_card" not in cols:
        conn.execute(
            "ALTER TABLE transactions ADD COLUMN credit_card TEXT DEFAULT NULL"
        )
    if "tags" not in cols:
        conn.execute(
            "ALTER TABLE transactions ADD COLUMN tags TEXT DEFAULT NULL"
        )
    if "is_recurring" not in cols:
        conn.execute(
            "ALTER TABLE transactions ADD COLUMN is_recurring INTEGER NOT NULL DEFAULT 0"
        )
