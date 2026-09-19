from datetime import datetime, timedelta, timezone
from backend import analytics


def test_recent_range_moves_per_request_but_is_consistent_inside_request(monkeypatch):
    class Clock(datetime):
        current = datetime(2026, 9, 19, 12, tzinfo=timezone.utc)

        @classmethod
        def now(cls, tz=None):
            return cls.current

    monkeypatch.setattr(analytics, "datetime", Clock)
    first = analytics.Filters(last_seconds=3600)
    start, end = analytics.bounds(first)
    assert end - start == timedelta(hours=1)
    Clock.current += timedelta(minutes=5)
    assert analytics.bounds(first) == (start, end)
    next_start, next_end = analytics.bounds(analytics.Filters(last_seconds=3600))
    assert next_start == start + timedelta(minutes=5)
    assert next_end == end + timedelta(minutes=5)


def test_clicked_bucket_and_explicit_range_override_relative_window():
    start, end = analytics.bounds(analytics.Filters(last_seconds=3600,
        start="2026-09-19T11:00:00Z", end="2026-09-19T11:05:00Z"))
    assert end - start == timedelta(minutes=5)
    assert start == datetime(2026, 9, 19, 11, tzinfo=timezone.utc)
