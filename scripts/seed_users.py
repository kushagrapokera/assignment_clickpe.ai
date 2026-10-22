#!/usr/bin/env python3
"""Generate a sample applicant CSV and load it into the database.

The assignment ships a 10 000 row sample file; this script generates an
equivalent file locally (same column contract) so the pipeline can be
exercised without downloading anything.

Usage::

    python3 scripts/seed_users.py --rows 10000
    python3 scripts/seed_users.py --rows 10000 --load
"""

from __future__ import annotations

import argparse
import csv
import logging
import random
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.session import get_database  # noqa: E402

logger = logging.getLogger("seed_users")

CSV_COLUMNS = [
    "user_id",
    "name",
    "email",
    "monthly_income",
    "credit_score",
    "employment_status",
    "age",
]

EMPLOYMENT_STATUSES = [
    "Salaried",
    "Self-Employed",
    "Salaried",
    "Salaried",
    "Self-Employed",
    "Salaried",
    "Salaried",
    "Self-Employed",
    "Business",
]
FIRST_NAMES = [
    "Aarav", "Diya", "Vivaan", "Ananya", "Aditya", "Isha", "Arjun", "Kavya",
    "Rohan", "Meera", "Karan", "Sneha", "Rahul", "Pooja", "Vikram", "Nisha",
]
LAST_NAMES = [
    "Sharma", "Verma", "Patel", "Reddy", "Nair", "Iyer", "Singh", "Gupta",
    "Mehta", "Joshi", "Desai", "Kulkarni",
]


def generate_rows(count: int, seed: int = 20260101) -> list[dict[str, object]]:
    """Build a deterministic set of applicant rows.

    The shape mirrors the applicant file of the assignment: the user id is
    unique, while a number of applicants share an email address.
    """
    rng = random.Random(seed)
    rows = []
    shared_pool = [f"shared{i}@example.com" for i in range(max(1, count // 8))]
    for index in range(count):
        employment = rng.choice(EMPLOYMENT_STATUSES)
        if employment == "Salaried":
            income = rng.randint(25, 300) * 1000
        elif employment == "Self-Employed":
            income = rng.randint(20, 250) * 1000
        else:
            income = rng.randint(40, 400) * 1000
        # Every eighth applicant shares an address with the others, the way
        # the assignment file does.
        email = (
            shared_pool[index % len(shared_pool)]
            if index % 8 == 0
            else f"applicant{index}@example.com"
        )
        rows.append(
            {
                "user_id": str(uuid.uuid4()),
                "name": f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}",
                "email": email,
                "monthly_income": income,
                "credit_score": rng.randint(550, 820),
                "employment_status": employment,
                "age": rng.randint(21, 60),
            }
        )
    return rows


def write_csv(rows: list[dict[str, object]], path: Path) -> None:
    """Write the rows to a CSV file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    logger.info("wrote %s rows to %s", len(rows), path)


def load_into_database(rows: list[dict[str, object]]) -> int:
    """Insert the rows into the `users` table."""
    database = get_database()
    with database.transaction() as connection:
        with connection.cursor() as cursor:
            cursor.executemany(
                """
                INSERT INTO users (user_id, name, email, monthly_income,
                                   credit_score, employment_status, age)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (user_id) DO UPDATE SET
                    name = EXCLUDED.name,
                    email = EXCLUDED.email,
                    monthly_income = EXCLUDED.monthly_income,
                    credit_score = EXCLUDED.credit_score,
                    employment_status = EXCLUDED.employment_status,
                    age = EXCLUDED.age,
                    updated_at = NOW()
                """,
                [
                    (
                        row["user_id"],
                        row["name"],
                        row["email"],
                        row["monthly_income"],
                        row["credit_score"],
                        row["employment_status"],
                        row["age"],
                    )
                    for row in rows
                ],
            )
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=10000, help="number of applicants")
    parser.add_argument(
        "--out",
        default="samples/users.csv",
        help="where the CSV file is written",
    )
    parser.add_argument(
        "--load", action="store_true", help="also insert the rows into the database"
    )
    parser.add_argument("--seed", type=int, default=20260101, help="random seed")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    rows = generate_rows(args.rows, args.seed)
    write_csv(rows, Path(args.out))

    if args.load:
        count = load_into_database(rows)
        logger.info("loaded %s applicants into the database", count)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
