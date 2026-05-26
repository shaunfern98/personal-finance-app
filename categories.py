"""Canonical expense categories (order preserved for UI)."""

EXPENSE_CATEGORIES: tuple[str, ...] = (
    "Gym",
    "Phone",
    "OSAP",
    "iCloud",
    "Spotify",
    "Groceries",
    "Amazon Prime",
    "Eating Out",
    "Therapy",
    "Gas",
    "Haircut",
    "Clothing",
    "Joint Savings",
    "Date Money",
    "Lifestyle Hobbies",
    "Fuck Around Money",
)

CATEGORY_SET = frozenset(EXPENSE_CATEGORIES)
