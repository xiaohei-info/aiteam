# client.py
from abc import ABC, abstractmethod

class MulticaClient(ABC):
    @abstractmethod
    def list_issues(self) -> dict: ...
    @abstractmethod
    def set_metadata(self, key, k, v): ...
    @abstractmethod
    def set_status(self, key, status): ...
    @abstractmethod
    def assign(self, key, agent): ...
    @abstractmethod
    def runs(self, key) -> list: ...
    @abstractmethod
    def squad_members(self, squad_id) -> list: ...

class FakeMulticaClient(MulticaClient):
    def __init__(self, issues=None, members=None, run_log=None):
        self.issues = issues or {}
        self.members = members or []
        self.run_log = run_log or {}     # key -> list of run dicts
    def list_issues(self):
        return {k: dict(v) for k, v in self.issues.items()}
    def set_metadata(self, key, k, v):
        self.issues[key][k] = v
    def set_status(self, key, status):
        self.issues[key]["status"] = status
    def assign(self, key, agent):
        self.issues[key]["assignee"] = agent
    def runs(self, key):
        return list(self.run_log.get(key, []))
    def squad_members(self, squad_id):
        return list(self.members)
