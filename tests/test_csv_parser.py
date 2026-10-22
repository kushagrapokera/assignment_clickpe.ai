"""Tests for the applicant file parser.

The file of the assignment has seven columns; the parser accepts them and
reports every row it cannot use.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.ingestion.csv_parser import (
    EMPLOYMENT_ALIASES,
    normalise_employment_status,
    parse_csv,
    validate_row,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SAMPLE_CSV = PROJECT_ROOT / "samples" / "users_small.csv"

VALID_ROW = {
    "user_id": "b35de23e-755f-4c6a-81d8-f7dd99ce53ef",
    "name": "Dhruv Iyengar",
    "email": "dhruv.iyengar@example.com",
    "monthly_income": "131000",
    "credit_score": "725",
    "employment_status": "Self-Employed",
    "age": "37",
}


def test_a_valid_row_is_normalised():
    row, error = validate_row(VALID_ROW)
    assert error is None
    assert row["email"] == "dhruv.iyengar@example.com"
    assert row["monthly_income"] == 131000
    assert row["credit_score"] == 725
    assert row["age"] == 37
    assert row["employment_status"] == "Self-Employed"


@pytest.mark.parametrize(
    "field,value",
    [
        ("user_id", ""),
        ("email", ""),
        ("email", "not-an-address"),
        ("monthly_income", "abc"),
        ("monthly_income", "0"),
        ("credit_score", "100"),
        ("credit_score", "1000"),
        ("age", "12"),
        ("age", "90"),
        ("employment_status", "Astronaut"),
    ],
)
def test_a_broken_row_is_rejected_with_a_reason(field, value):
    row = dict(VALID_ROW)
    row[field] = value
    parsed, error = validate_row(row)
    assert parsed is None
    assert error, "a broken row has to come with a reason"


def test_employment_statuses_are_normalised():
    assert normalise_employment_status("Self-Employed") == "Self-Employed"
    assert normalise_employment_status("self employed") == "Self-Employed"
    assert normalise_employment_status("SELFEMPLOYED") == "Self-Employed"
    assert normalise_employment_status("Salaried") == "Salaried"
    assert normalise_employment_status("Business") == "Business"
    assert normalise_employment_status("Retired") == "Retired"
    assert normalise_employment_status("") is None
    assert set(EMPLOYMENT_ALIASES.values()) >= {
        "Salaried",
        "Self-Employed",
        "Business",
        "Retired",
        "Student",
    }


def test_the_optional_columns_are_kept_when_they_are_present():
    row = dict(VALID_ROW, city="Pune", employment_years="4", existing_emi="5000")
    parsed, error = validate_row(row)
    assert error is None
    assert parsed["city"] == "Pune"
    assert parsed["employment_years"] == 4
    assert parsed["existing_emi"] == 5000


def test_the_optional_columns_are_simply_absent_when_they_are_not():
    parsed, error = validate_row(VALID_ROW)
    assert error is None
    assert "city" not in parsed
    assert "employment_years" not in parsed


def test_a_file_without_the_required_columns_is_refused():
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as handle:
        handle.write("user_id,email\n1,a@b.c\n")
        path = Path(handle.name)
    with pytest.raises(ValueError) as error:
        parse_csv(path)
    assert "required column" in str(error.value)


def test_the_sample_file_loads_without_a_single_rejected_row():
    if not SAMPLE_CSV.exists():
        pytest.skip("the sample file is not there")
    result = parse_csv(SAMPLE_CSV)
    assert result.total_rows > 0
    assert result.rejected_rows == 0
    assert result.accepted_rows == result.total_rows
    # The sample file of the assignment reuses a few addresses, which is
    # allowed - the user id identifies the applicant.
    assert result.shared_emails >= 0
    assert result.unique_emails <= result.total_rows
