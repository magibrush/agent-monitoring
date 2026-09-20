from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class CustomScenario(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="My scenario", min_length=1, max_length=100)
    conversation: str = Field(min_length=1, max_length=12000)
    tool_name: str = Field(min_length=1, max_length=200)
    tool_input: dict = Field(default_factory=dict)
    recommendation: Literal["allow", "review", "deny"] = "review"
    suspicious: bool = False
    severity: Literal["low", "medium", "high", "critical"] = "high"


class RunConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenarios: list[str] = Field(default_factory=lambda: ["hard-deny", "flag-low", "judge-review"], min_length=1, max_length=40)
    custom: CustomScenario | None = None
    mode: Literal["scripted", "live"] = "scripted"
    transport: Literal["queue", "process"] = "queue"
    count: int = Field(default=12, ge=1, le=10000)
    concurrency: int = Field(default=4, ge=1, le=256)
    workers: int = Field(default=2, ge=1, le=8)
    connections: int = Field(default=1, ge=1, le=32)
    rate: int = Field(default=0, ge=0, le=1000)
    messages: int = Field(default=2, ge=0, le=20)
    review: Literal["approve", "deny", "expire"] = "approve"
    policies: bool = True
    duplicates: bool = False
    post_order: Literal["normal", "before_pre"] = "normal"
    analysis: bool = False
    judge_delay_ms: int = Field(default=0, ge=0, le=10000)
    fault: Literal["none", "retry_once", "unavailable", "worker_offline"] = "none"

    @model_validator(mode="after")
    def bounded(self):
        if self.analysis and self.count > 25:
            raise ValueError("Incident analysis runs are limited to 25 actions. Leave analysis off for load tests.")
        if self.mode == "live" and (self.count > 25 or self.concurrency > 4):
            raise ValueError("Live judge runs are limited to 25 actions and 4 concurrent requests.")
        if self.mode == "live" and (self.fault != "none" or self.judge_delay_ms):
            raise ValueError("Fault injection is available in scripted mode only.")
        if self.transport == "process" and self.concurrency > 32:
            raise ValueError("Real hook processes are limited to 32 concurrent requests. Use queue clients for larger bursts.")
        if self.duplicates and self.transport == "process":
            raise ValueError("Duplicate delivery testing uses queue clients.")
        return self
