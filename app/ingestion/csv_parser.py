"""Parsing and validation of the applicant CSV.

The assignment ships a CSV with seven columns::

    user_id, name, email, monthly_income, credit_score, employment_status, age

Those seven are required.  A few optional columns are accepted as well
(``city``, experience, employer/residency and business evidence, existing EMIs); they
are used by the matcher when they are present and ignored when they are not,
so the file the assignment provides works unchanged.
"""

from __future__ import annotations

import csv
import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

# The columns the assignment requires.
REQUIRED_COLUMNS = [
    "user_id",
    "email",
    "monthly_income",
    "credit_score",
    "employment_status",
    "age",
]

# The columns that are used when a file provides them.
OPTIONAL_COLUMNS = [
    "name",
    "city",
    "employment_years",
    "existing_emi",
    "annual_income",
]
ELIGIBILITY_FACT_FIELDS = [
    'employment_years', 'current_employer_years', 'post_qualification_years', 'business_years',
    'requested_tenure_months', 'profit_after_tax_last_two_years', 'residency_country',
    'employer_group', 'employment_type', 'employer_category', 'state',
]
OPTIONAL_COLUMNS += [field for field in ELIGIBILITY_FACT_FIELDS if field not in OPTIONAL_COLUMNS]

# The canonical employment statuses the matcher understands.
EMPLOYMENT_STATUSES = ["Salaried", "Self-Employed", "Business", "Retired", "Student"]

# Accepted spellings of an employment status, mapped to the canonical name.
EMPLOYMENT_ALIASES = {
    "salaried": "Salaried",
    "salary": "Salaried",
    "employee": "Salaried",
    "employed": "Salaried",
    "working": "Salaried",
    "self-employed": "Self-Employed",
    "self employed": "Self-Employed",
    "selfemployed": "Self-Employed",
    "selfemploy": "Self-Employed",
    "self employ": "Self-Employed",
    "business": "Business",
    "self employed business": "Business",
    "proprietor": "Business",
    "entrepreneur": "Business",
    "retired": "Retired",
    "pensioner": "Retired",
    "student": "Student",
}

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s.]+\.[^@\s]+$")
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

MIN_CREDIT_SCORE = 300
MAX_CREDIT_SCORE = 900
MIN_AGE = 18
MAX_AGE = 70


@dataclass
class RowError:
    """A row that could not be used, with the reason why."""

    row_number: int
    message: str
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class ParseResult:
    """The outcome of parsing a CSV file."""

    rows: list[dict[str, Any]] = field(default_factory=list)
    errors: list[RowError] = field(default_factory=list)
    total_rows: int = 0
    columns: list[str] = field(default_factory=list)
    unique_emails: int = 0
    shared_emails: int = 0

    @property
    def accepted_rows(self) -> int:
        """Number of rows that passed the validation."""
        return len(self.rows)

    @property
    def rejected_rows(self) -> int:
        """Number of rows that were rejected."""
        return len(self.errors)


def normalise_employment_status(value: Any) -> str | None:
    """Map a free text employment status to the canonical name.

    :param value: raw value from the CSV
    :return: canonical status or None when the value is not understood
    """
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    if text in EMPLOYMENT_ALIASES:
        return EMPLOYMENT_ALIASES[text]
    collapsed = text.replace("_", " ").replace("-", " ")
    collapsed = " ".join(collapsed.split())
    if collapsed in EMPLOYMENT_ALIASES:
        return EMPLOYMENT_ALIASES[collapsed]
    for alias, canonical in EMPLOYMENT_ALIASES.items():
        if alias in collapsed:
            return canonical
    return None


def _to_number(value: Any) -> float | None:
    """Parse a number, tolerating thousands separators."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "").replace("₹", "").replace("rs.", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _to_int(value: Any) -> int | None:
    """Parse an integer, tolerating thousands separators."""
    number = _to_number(value)
    return None if number is None else int(number)


def validate_row(row: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    """Validate and normalise one row.

    :param row: the raw row of the CSV
    :return: the normalised row and an error message, or (None, None)
    """
    user_id = str(row.get("user_id") or "").strip()
    if not user_id:
        return None, "user_id is missing"

    email = str(row.get("email") or "").strip().lower()
    if not email:
        return None, "email is missing"
    if not EMAIL_PATTERN.match(email):
        return None, f"email '{email}' is not a valid address"

    monthly_income = _to_number(row.get("monthly_income"))
    if monthly_income is None:
        return None, "monthly_income is missing or not a number"
    if monthly_income <= 0:
        return None, f"monthly_income {monthly_income} is not positive"

    credit_score = _to_int(row.get("credit_score"))
    if credit_score is None:
        return None, "credit_score is missing or not a number"
    if not MIN_CREDIT_SCORE <= credit_score <= MAX_CREDIT_SCORE:
        return None, (
            f"credit_score {credit_score} is outside the accepted range "
            f"{MIN_CREDIT_SCORE}-{MAX_CREDIT_SCORE}"
        )

    employment_status = normalise_employment_status(row.get("employment_status"))
    if employment_status is None:
        return None, (
            f"employment_status '{row.get('employment_status')}' is not one of "
            f"{', '.join(EMPLOYMENT_STATUSES)}"
        )

    age = _to_int(row.get("age"))
    if age is None:
        return None, "age is missing or not a number"
    if not MIN_AGE <= age <= MAX_AGE:
        return None, f"age {age} is outside the accepted range {MIN_AGE}-{MAX_AGE}"

    normalised: dict[str, Any] = {
        "user_id": user_id,
        "email": email,
        "monthly_income": monthly_income,
        "credit_score": credit_score,
        "employment_status": employment_status,
        "age": age,
    }

    name = row.get("name")
    if name is not None and str(name).strip():
        normalised["name"] = str(name).strip()

    city = row.get("city")
    if city is not None and str(city).strip():
        normalised["city"] = str(city).strip()

    for optional, caster in (
        ("employment_years", _to_number),
        ("existing_emi", _to_number),
        ("annual_income", _to_number),
    ):
        if row.get(optional) not in (None, ""):
            value = caster(row.get(optional))
            if value is not None:
                normalised[optional] = value

    for field in ['employment_years','current_employer_years','post_qualification_years','business_years','requested_tenure_months']:
        if row.get(field) not in (None, ''):
            value = _to_number(row[field])
            if value is None or not math.isfinite(value) or value < 0:
                return None, f'{field} must be a non-negative number'
            if field == 'requested_tenure_months' and (value <= 0 or not value.is_integer()):
                return None, 'requested_tenure_months must be a positive integer'
            normalised[field] = value
    for field in ['residency_country','employer_group','employment_type','employer_category','state']:
        if row.get(field) not in (None, ''):
            normalised[field] = str(row[field]).strip()
    if row.get('profit_after_tax_last_two_years') not in (None, ''):
        try:
            values = row['profit_after_tax_last_two_years']
            if isinstance(values, str):
                values = json.loads(values)
            if not isinstance(values, list) or len(values) != 2 or any(isinstance(v, bool) or not isinstance(v, (int,float)) or not math.isfinite(v) for v in values):
                raise ValueError('expected two yearly profits')
            normalised['profit_after_tax_last_two_years'] = values
        except (TypeError, ValueError):
            return None, 'profit_after_tax_last_two_years must be a JSON array of two numbers'
    return normalised, None


def parse_csv(path: Path | str, max_rows: int | None = None) -> ParseResult:
    """Parse and validate a CSV file.

    :param path: path of the CSV file
    :param max_rows: stop after this many data rows
    :return: the parse result
    """
    result = ParseResult()
    file_path = Path(path)

    with file_path.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        columns = [column.strip() for column in (reader.fieldnames or [])]
        result.columns = columns

        missing = [column for column in REQUIRED_COLUMNS if column not in columns]
        if missing:
            raise ValueError(
                f"the file is missing the required column(s): {', '.join(missing)}"
            )

        seen_ids: set[str] = set()
        email_counts: dict[str, int] = {}
        for row_number, raw_row in enumerate(reader, start=2):
            if max_rows is not None and result.total_rows >= max_rows:
                break
            result.total_rows += 1
            cleaned = {
                (key.strip() if key else key): value
                for key, value in raw_row.items()
                if key is not None
            }
            normalised, error = validate_row(cleaned)
            if error is not None:
                result.errors.append(RowError(row_number, error, cleaned))
                continue
            if normalised["user_id"] in seen_ids:
                result.errors.append(
                    RowError(
                        row_number,
                        f"user_id '{normalised['user_id']}' appears more than once",
                        cleaned,
                    )
                )
                continue
            seen_ids.add(normalised["user_id"])
            result.rows.append(normalised)
            email_counts[normalised["email"]] = email_counts.get(normalised["email"], 0) + 1

    # Several applicants may share an address - the applicant file of the
    # assignment does exactly that - so a shared address is reported but not
    # rejected.  The user id identifies the applicant.
    result.unique_emails = len(email_counts)
    result.shared_emails = sum(1 for count in email_counts.values() if count > 1)

    return result


def iter_rows(path: Path | str, chunk_size: int = 1000) -> Iterator[list[dict[str, Any]]]:
    """Stream the valid rows of a CSV file in chunks.

    The ingestion worker uses this to keep the memory footprint of a large
    upload flat.

    :param path: path of the CSV file
    :param chunk_size: number of rows per chunk
    :return: an iterator over chunks of validated rows
    """
    result = parse_csv(path)
    chunk: list[dict[str, Any]] = []
    for row in result.rows:
        chunk.append(row)
        if len(chunk) >= chunk_size:
            yield chunk
            chunk = []
    if chunk:
        yield chunk
