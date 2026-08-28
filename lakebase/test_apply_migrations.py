from apply_migrations import pending_migrations

def test_returns_unapplied_in_sorted_order():
    all_files = ["002_search.sql", "001_northpeak_schema.sql"]
    assert pending_migrations(set(), all_files) == [
        "001_northpeak_schema.sql", "002_search.sql",
    ]

def test_skips_already_applied():
    all_files = ["001_northpeak_schema.sql", "002_search.sql"]
    applied = {"001_northpeak_schema.sql"}
    assert pending_migrations(applied, all_files) == ["002_search.sql"]

def test_empty_when_all_applied():
    files = ["001_northpeak_schema.sql"]
    assert pending_migrations(set(files), files) == []
