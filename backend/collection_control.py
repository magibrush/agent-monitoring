"""Coordinate imports without holding application-wide locks."""
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from weakref import WeakValueDictionary


class ImportInterrupted(Exception):
    pass


@dataclass
class Collection:
    lock: threading.Lock = field(default_factory=threading.Lock)
    stop: threading.Event = field(default_factory=threading.Event)
    mutations: threading.Lock = field(default_factory=threading.Lock)


_guard = threading.Lock()
_collections = WeakValueDictionary()


def collection(id_):
    with _guard:
        return _collections.setdefault(id_, Collection())


@contextmanager
def interrupt_collection(id_):
    state = collection(id_)
    with state.mutations:
        state.stop.set()
        try:
            with state.lock:
                yield
        finally:
            state.stop.clear()


def check_interrupted(db):
    stop = db.info.get("import_stop")
    if stop is not None and stop.is_set():
        raise ImportInterrupted()
