"""Database connection helper — PostgreSQL via psycopg2."""

import os

import psycopg2

DEFAULT_TEST_DATABASE_URL = "postgresql://aiteam:aiteam_test@127.0.0.1:5433/aiteam_test"


def get_database_url() -> str:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL is required for Team Panel database connections")
    return database_url


def create_connection(database_url: str | None = None) -> psycopg2.extensions.connection:
    url = database_url or get_database_url()
    conn = psycopg2.connect(url)
    conn.autocommit = False
    return conn


def create_test_connection() -> psycopg2.extensions.connection:
    test_url = os.environ.get(
        "TEST_DATABASE_URL",
        DEFAULT_TEST_DATABASE_URL,
    )
    conn = psycopg2.connect(test_url)
    conn.autocommit = False
    return conn
