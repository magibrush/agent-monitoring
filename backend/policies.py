"""Versioned local rules over conservative action facts; no model calls or inferred approvals."""
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator
from backend.policy_actions import normalize, filename_matches, reference_matches
from sqlalchemy import select, update

from backend.db import PolicyVersion, PolicyState, PolicyChange, Connection, ChatSession, Event, SafetyEvaluation, now
from backend.safety_policy import assess, ROOT

router = APIRouter(prefix="/api/safety/policies")
lock = threading.RLock()
READ_TOOLS = {"read", "read_file"}
WRITE_TOOLS = {"write", "write_file", "edit", "edit_file", "multiedit"}
SUFFIXES = {".md", ".rst", ".txt", ".py", ".js", ".jsx", ".ts", ".tsx", ".css", ".html"}


def store():
    from backend.main import SessionLocal
    return SessionLocal()


def linked(path):
    return any(p.is_symlink() or getattr(p, "is_junction", lambda: False)() for p in (path, *path.parents))


class Rule(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1, max_length=60)
    name: str = Field(min_length=1, max_length=100)
    connection_id: str = Field(min_length=1, max_length=36)
    root: str = Field(min_length=1, max_length=500)
    operation: Literal["read", "write"] = "read"
    effect: Literal["allow", "review", "deny"] = "allow"
    extensions: list[str] = Field(default_factory=lambda: [".md"], max_length=10)
    expires_at: str | None = None

    @model_validator(mode="after")
    def validate_scope(self):
        path = Path(self.root)
        if not path.is_absolute() or path == Path(path.anchor) or str(path).startswith(("\\\\", "//")):
            raise ValueError("Choose an absolute local project directory, not a drive root or network share.")
        if not path.is_dir() or linked(path):
            raise ValueError("Project directory must exist and cannot contain symbolic links or junctions.")
        self.root = str(path.resolve())
        self.extensions = sorted(set(x.lower() for x in self.extensions))
        if self.effect == "allow" and (self.operation != "read" or not self.extensions or not set(self.extensions) <= SUFFIXES):
            raise ValueError("Fast approvals only support structured reads of selected document/source extensions.")
        if self.effect == "allow" and Path(self.root).is_relative_to(ROOT / "data"):
            raise ValueError("Relay's data directory is excluded from fast approvals.")
        if any(not x.startswith(".") or not x[1:].isalnum() for x in self.extensions):
            raise ValueError("Use file extensions such as .md, not wildcards or expressions.")
        if self.expires_at:
            try:
                expires = datetime.fromisoformat(self.expires_at.replace("Z", "+00:00"))
                if expires.tzinfo is None:
                    raise ValueError()
                self.expires_at = expires.astimezone(timezone.utc).isoformat()
            except ValueError:
                raise ValueError("Expiry must include a timezone.") from None
        return self


def legacy_match(version, payload, connection_id, hard=None):
    hard = hard or assess(payload)
    if hard["decision"] == "deny":
        return {"decision": "deny", "rule_ids": [], "reason": "Built-in prohibition", "version": version.id}
    tool, args = str(payload.get("tool_name", "")).lower(), payload.get("tool_input", {})
    operation = "read" if tool in READ_TOOLS else "write" if tool in WRITE_TOOLS else None
    matches = []
    if operation and isinstance(args, dict):
        raw = args.get("file_path", args.get("path"))
        if isinstance(raw, str) and raw and not any(c in raw for c in ("\x00", "*", "?")):
            path = Path(raw)
            cwd = Path(str(payload.get("cwd") or ""))
            if not path.is_absolute() and cwd.is_absolute():
                path = cwd / path
            if path.is_absolute():
                try:
                    resolved = path.resolve()
                    for rule in version.rules:
                        if rule["connection_id"] != connection_id or rule["operation"] != operation:
                            continue
                        if rule.get("expires_at") and rule["expires_at"] <= now():
                            continue
                        root = Path(rule["root"])
                        if not resolved.is_relative_to(root) or (rule["extensions"] and resolved.suffix.lower() not in rule["extensions"]):
                            continue
                        if rule["effect"] == "allow":
                            # Reject opaque arguments, alternate paths, links, device/ADS paths and sensitive names.
                            keys = set(args)
                            valid = keys <= {"file_path", "path", "offset", "limit"} and len(keys & {"file_path", "path"}) == 1
                            valid = valid and all(type(args[k]) is int and args[k] > 0 for k in ("offset", "limit") if k in args)
                            sensitive = any(x.startswith(".") or any(word in x.lower() for word in ("secret", "credential", "password", "token")) for x in resolved.parts)
                            if not valid or sensitive or resolved.is_relative_to(ROOT / "data") or not path.is_file() or linked(path) or linked(root) or ":" in str(path)[len(path.anchor):]:
                                continue
                        matches.append(rule)
                except (OSError, ValueError, RuntimeError):
                    pass
    if not matches:
        return {"decision": "none", "rule_ids": [], "reason": "No matching rule", "version": version.id}
    winner = min(matches, key=lambda r: ({"deny": 0, "review": 1, "allow": 2}[r["effect"]], r["id"]))
    return {"decision": winner["effect"], "rule_ids": [r["id"] for r in matches], "reason": winner["name"], "version": version.id}



class PolicyRule(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: Literal[2] = 2
    id: str = Field(min_length=1, max_length=60)
    name: str = Field(min_length=1, max_length=100)
    enabled: bool = True
    connection_ids: list[str] = Field(default_factory=list, max_length=100)
    activity: Literal["read", "write", "shell", "git_push", "credentials", "network", "tool"]
    roots: list[str] = Field(default_factory=list, max_length=20)
    extensions: list[str] = Field(default_factory=list, max_length=20)
    filenames: list[str] = Field(default_factory=list, max_length=20)
    tool_name: str = Field(default="", max_length=200)
    command_contains: str = Field(default="", max_length=500)
    effect: Literal["allow", "review", "deny", "judge"]
    expires_at: str | None = None

    @model_validator(mode="after")
    def validate_scope(self):
        self.name = self.name.strip()
        if not self.name: raise ValueError("Give the rule a name.")
        self.connection_ids = sorted(set(self.connection_ids))
        if any(not x or len(x) > 36 for x in self.connection_ids): raise ValueError("Choose valid connections.")
        self.extensions = sorted(set(x.strip().lower() for x in self.extensions))
        if any(not x.startswith(".") or not x[1:].isalnum() for x in self.extensions):
            raise ValueError("Use extensions such as .md, not expressions.")
        self.filenames = sorted(set(x.strip() for x in self.filenames))
        if any(not x or len(x) > 200 or any(c in x for c in ("/", "\\", "\x00", ":")) for x in self.filenames):
            raise ValueError("Filename patterns match names only, for example .env* or *.pem.")
        if (self.extensions or self.filenames) and self.activity not in {"read", "write", "credentials"}:
            raise ValueError("Filename conditions apply to file access only.")
        if self.command_contains and self.activity not in {"shell", "git_push", "credentials", "network", "tool"}:
            raise ValueError("Command text conditions apply to command activities.")
        self.tool_name = self.tool_name.strip().lower()
        if self.activity == "tool" and not self.tool_name:
            raise ValueError("Choose the exact tool name for a specific-tool rule.")
        roots = []
        for value in self.roots:
            path = Path(value)
            if not path.is_absolute() or str(path).startswith(("\\\\", "//")):
                raise ValueError("Folders must be absolute local paths.")
            roots.append(os.path.abspath(path))
        self.roots = sorted(set(roots))
        if self.effect == "allow":
            if self.activity != "read" or not self.roots or self.command_contains:
                raise ValueError("Auto-allow requires a structured file read within selected folders. Shell and other tools can be blocked, reviewed, or sent to the judge.")
            for root in self.roots:
                Rule(id=self.id, name=self.name, connection_id="validation", root=root, extensions=self.extensions)
        if self.expires_at:
            try:
                expires = datetime.fromisoformat(self.expires_at.replace("Z", "+00:00"))
                if expires.tzinfo is None: raise ValueError()
                self.expires_at = expires.astimezone(timezone.utc).isoformat()
            except ValueError:
                raise ValueError("Expiry must include a timezone.") from None
        return self


def editable_rule(rule):
    if rule.get("schema_version") == 2:
        return rule
    return {"schema_version": 2, "id": rule["id"], "name": rule["name"], "enabled": True,
            "connection_ids": [rule["connection_id"]], "activity": rule["operation"], "roots": [rule["root"]],
            "extensions": rule["extensions"], "filenames": [], "tool_name": "", "command_contains": "",
            "effect": rule["effect"], "expires_at": rule.get("expires_at")}


def rule_matches(rule, facts, connection_id, payload):
    if not rule["enabled"] or rule.get("expires_at") and rule["expires_at"] <= now(): return False
    if rule["connection_ids"] and connection_id not in rule["connection_ids"]: return False
    # Restrictive filename rules cover visible shell/discovery references too.
    # These signals must never qualify a command for automatic approval.
    reference_match = (rule["effect"] != "allow" and rule["activity"] in {"read", "credentials"}
                       and bool(rule["filenames"]) and any(
                           reference_matches(name, rule["filenames"]) and
                           (not rule["extensions"] or Path(name).suffix.lower() in rule["extensions"])
                           for name in facts.get("filename_references", [])))
    if rule["activity"] not in facts["activities"] and not reference_match: return False
    if rule["activity"] == "tool" and not rule["tool_name"]: return False
    if rule["tool_name"] and rule["tool_name"] != facts["tool"]: return False
    if rule["command_contains"] and rule["command_contains"].casefold() not in facts["command"].casefold(): return False
    file_scope = bool(facts["paths"])
    targets = facts["paths"] if file_scope else [] if facts["activities"] & {"read", "write"} else [facts["cwd"]] if facts["cwd"] is not None else []
    if reference_match and facts.get("discovery_root") is not None:
        targets = [facts["discovery_root"]]
    if rule["roots"] and not any(p.is_relative_to(Path(root)) for p in targets for root in rule["roots"]): return False
    if rule["extensions"] or rule["filenames"]:
        if not reference_match and not any((not rule["extensions"] or p.suffix.lower() in rule["extensions"]) and filename_matches(p, rule["filenames"]) for p in facts["paths"]): return False
    if rule["effect"] == "allow":
        # Reuse the proven file-read approval boundary, including strict tool arguments.
        for root in rule["roots"]:
            old = {"id": rule["id"], "name": rule["name"], "connection_id": connection_id, "root": root,
                   "operation": "read", "effect": "allow", "extensions": rule["extensions"], "expires_at": rule.get("expires_at")}
            from types import SimpleNamespace
            if legacy_match(SimpleNamespace(id=0, rules=[old]), payload, connection_id)["decision"] == "allow": return True
        return False
    return True


def match(version, payload, connection_id, hard=None, facts=None):
    hard = hard or assess(payload)
    if hard["decision"] == "deny":
        return {"decision": "deny", "rule_ids": [], "reason": "Built-in prohibition", "version": version.id,
                "findings": hard.get("findings", [])}
    facts = facts or normalize(payload)
    matches = []
    for stored in version.rules:
        if stored.get("schema_version") != 2:
            from types import SimpleNamespace
            if legacy_match(SimpleNamespace(id=version.id, rules=[stored]), payload, connection_id, hard)["decision"] != "none":
                matches.append(editable_rule(stored))
        elif rule_matches(stored, facts, connection_id, payload):
            matches.append(stored)
    if not matches:
        return {"decision": "none", "rule_ids": [], "reason": "No matching rule", "version": version.id}
    winner = min(matches, key=lambda r: ({"deny": 0, "review": 1, "judge": 2, "allow": 3}[r["effect"]], r["id"]))
    return {"decision": winner["effect"], "rule_ids": [r["id"] for r in matches], "reason": winner["name"], "version": version.id,
            "activity": sorted(facts["activities"]), "tool": facts["tool"]}

def evaluate(db, payload, connection_id, hard):
    state = db.get(PolicyState, 1)
    output = dict(hard)
    if not state:
        return output
    facts = normalize(payload)
    for field, id_ in (("policy", state.active_id), ("trial", state.trial_id)):
        if id_:
            output[field] = match(db.get(PolicyVersion, id_), payload, connection_id, hard, facts)
    candidate = output.get("policy", {})
    if hard["decision"] != "deny" and candidate.get("decision") in {"allow", "review", "deny"}:
        output["decision"] = candidate["decision"]
        output["findings"] = [*hard["findings"], {"id": f"policy-v{candidate['version']}", "reason": candidate["reason"]}]
    return output


def state_for(db):
    state = db.get(PolicyState, 1)
    if not state:
        state = PolicyState(id=1, revision=0); db.add(state); db.flush()
    return state


def require_revision(db, revision):
    state_for(db)
    if db.execute(update(PolicyState).where(PolicyState.id == 1, PolicyState.revision == revision).values(revision=revision+1)).rowcount != 1:
        raise HTTPException(409, "Policies changed in another window. Refresh before saving.")
    return db.get(PolicyState, 1)


def overlaps(rules):
    warnings = []
    rules = [editable_rule(r) for r in rules]
    for i, a in enumerate(rules):
        for b in rules[i+1:]:
            if not a["enabled"] or not b["enabled"] or a["effect"] == b["effect"]: continue
            if a["connection_ids"] and b["connection_ids"] and not set(a["connection_ids"]) & set(b["connection_ids"]): continue
            if a["tool_name"] and b["tool_name"] and a["tool_name"] != b["tool_name"]: continue
            activities_overlap = a["activity"] == b["activity"] or "tool" in {a["activity"], b["activity"]} or {a["activity"], b["activity"]} <= {"shell", "git_push", "network", "credentials"} or "credentials" in {a["activity"], b["activity"]}
            if not activities_overlap: continue
            roots_overlap = not a["roots"] or not b["roots"] or any(Path(x).is_relative_to(y) or Path(y).is_relative_to(x) for x in a["roots"] for y in b["roots"])
            extensions_overlap = not a["extensions"] or not b["extensions"] or bool(set(a["extensions"]) & set(b["extensions"]))
            if roots_overlap and extensions_overlap:
                winner = min((a, b), key=lambda r: ({"deny": 0, "review": 1, "judge": 2, "allow": 3}[r["effect"]], r["id"]))
                warnings.append({"rule_ids": [a["id"], b["id"]], "winner_id": winner["id"]})
    return warnings


def conflicts(rules):
    names = {r["id"]: r["name"] for r in rules}
    return [f"{names[p['rule_ids'][0]]} may overlap {names[p['rule_ids'][1]]}. Block wins over Ask me, then Judge, then Allow." for p in overlaps(rules)]


def rule_changes(before, after):
    old = {r["id"]: editable_rule(r) for r in before}
    new = {r["id"]: editable_rule(r) for r in after}
    return [{"kind": "added" if key not in old else "removed" if key not in new else "changed",
             "id": key, "name": (new.get(key) or old[key])["name"], "before": old.get(key), "after": new.get(key)}
            for key in dict.fromkeys([*new, *old]) if old.get(key) != new.get(key)]


@router.get("")
def overview():
    with store() as db:
        state = db.get(PolicyState, 1)
        versions = list(db.scalars(select(PolicyVersion).order_by(PolicyVersion.id.desc()).limit(100)))
        if state:
            for required_id in (state.active_id, state.paused_id, state.trial_id, state.draft_id):
                if required_id and all(v.id != required_id for v in versions):
                    required = db.get(PolicyVersion, required_id)
                    if required: versions.append(required)
        changes = list(db.scalars(select(PolicyChange).order_by(PolicyChange.id.desc()).limit(100)))
        stats = {}
        for rules, recommendation, source in db.execute(select(SafetyEvaluation.rules, SafetyEvaluation.result["recommendation"].as_string(), SafetyEvaluation.result["source"].as_string()).where(SafetyEvaluation.rules["trial"]["version"].as_integer().is_not(None)).order_by(SafetyEvaluation.created_at.desc()).limit(1000)):
            trial = rules.get("trial")
            if not trial:
                continue
            item = stats.setdefault(trial["version"], {"sampled": 0, "allow": 0, "review": 0, "deny": 0, "judge": 0, "none": 0, "compared": 0, "different": 0})
            item["sampled"] += 1; item[trial["decision"]] += 1
            if source == "judge" and recommendation and trial["decision"] not in {"none", "judge"}:
                item["compared"] += 1; item["different"] += recommendation != trial["decision"]
        ever_active = set(db.scalars(select(PolicyChange.version_id).where(PolicyChange.action.in_(["activate", "rollback"]))))
        baselines = {}
        published = list(db.scalars(select(PolicyChange).where(PolicyChange.action.in_(["activate", "rollback"])).order_by(PolicyChange.id)))
        previous = None
        applied_at = {}
        for change in published:
            applied_at[change.version_id] = change.created_at
            if change.version_id not in baselines:
                baselines[change.version_id] = previous.rules if previous else []
            previous = db.get(PolicyVersion, change.version_id)
        if state and state.draft_id:
            active = db.get(PolicyVersion, state.active_id or state.paused_id) if state.active_id or state.paused_id else None
            baselines[state.draft_id] = active.rules if active else []
        return {"revision": state.revision if state else 0, "active_id": state.active_id if state else None, "paused_id": state.paused_id if state else None, "trial_id": state.trial_id if state else None, "draft_id": state.draft_id if state else None,
            "versions": [{"id": v.id, "name": v.name, "rules": [editable_rule(r) for r in v.rules], "ever_active": v.id in ever_active, "applied_at": applied_at.get(v.id), "created_at": v.created_at, "previewed_at": v.previewed_at, "preview_result": {k: value for k, value in v.preview_result.items() if k != "items"} if v.preview_result else None, "changes": rule_changes(baselines.get(v.id, []), v.rules), "trial_started_at": v.trial_started_at, "conflicts": conflicts(v.rules), "overlaps": overlaps(v.rules), "trial": stats.get(v.id)} for v in versions],
            "changes": [{"action": c.action, "version_id": c.version_id, "created_at": c.created_at, "actor": c.actor} for c in changes]}


class NewVersion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int
    name: str = Field(min_length=1, max_length=100)
    rules: list[PolicyRule | Rule] = Field(max_length=50)


def validate_rules(db, rules):
    if len({r.id for r in rules}) != len(rules):
        raise HTTPException(422, "Rule IDs must be unique.")
    if any(not db.get(Connection, id_) for r in rules for id_ in (r.connection_ids if isinstance(r, PolicyRule) else [r.connection_id])):
        raise HTTPException(422, "Choose an existing connection for every rule.")


@router.put("/draft")
def save_draft(body: NewVersion):
    with lock, store() as db:
        state = require_revision(db, body.revision)
        validate_rules(db, body.rules)
        rules = [r.model_dump() for r in body.rules]
        draft = db.get(PolicyVersion, state.draft_id) if state.draft_id else None
        unchanged = draft and draft.rules == rules and draft.name == body.name.strip()
        if not unchanged:
            frozen = draft and (draft.previewed_at or draft.trial_started_at or draft.id == state.active_id or db.scalar(
                select(PolicyChange.id).where(PolicyChange.version_id == draft.id, PolicyChange.action.in_(["activate", "rollback"]))))
            if state.trial_id == state.draft_id:
                state.trial_id = None
            if not draft or frozen:
                draft = PolicyVersion(name=body.name.strip(), rules=rules)
                db.add(draft); db.flush()
                state.draft_id = draft.id
            else:
                draft.name = body.name.strip(); draft.rules = rules
            db.add(PolicyChange(version_id=draft.id, action="save"))
        db.commit()
        return {"id": draft.id, "revision": state.revision}


@router.delete("/draft")
def discard_draft(revision: int):
    with lock, store() as db:
        state = require_revision(db, revision)
        if state.draft_id:
            db.add(PolicyChange(version_id=state.draft_id, action="discard"))
            if state.trial_id == state.draft_id:
                state.trial_id = None
            state.draft_id = None
        db.commit()
        return {"revision": state.revision}


class RestoreDraft(BaseModel):
    revision: int
    version_id: int


@router.post("/draft/restore", status_code=201)
def restore_draft(body: RestoreDraft):
    with lock, store() as db:
        state = require_revision(db, body.revision)
        if state.draft_id:
            raise HTTPException(409, "Discard the current draft before restoring another version.")
        original = db.get(PolicyVersion, body.version_id)
        if not original or not db.scalar(select(PolicyChange.id).where(PolicyChange.version_id == body.version_id, PolicyChange.action.in_(["activate", "rollback"]))):
            raise HTTPException(409, "Choose a previously applied version.")
        draft = PolicyVersion(name="Working draft", rules=original.rules)
        db.add(draft); db.flush(); state.draft_id = draft.id
        db.add(PolicyChange(version_id=draft.id, action="restore")); db.commit()
        return {"id": draft.id, "revision": state.revision}


@router.post("/versions", status_code=201)
def save(body: NewVersion):
    with lock, store() as db:
        state = require_revision(db, body.revision)
        if len({r.id for r in body.rules}) != len(body.rules):
            raise HTTPException(422, "Rule IDs must be unique.")
        if any(not db.get(Connection, id_) for r in body.rules for id_ in (r.connection_ids if isinstance(r, PolicyRule) else [r.connection_id])):
            raise HTTPException(422, "Choose an existing connection for every rule.")
        version = PolicyVersion(name=body.name.strip(), rules=[r.model_dump() for r in body.rules])
        db.add(version); db.flush()
        state.draft_id = version.id
        db.add(PolicyChange(version_id=version.id, action="save")); db.commit()
        return {"id": version.id}


def result_item(job, session, connection, version, result, unavailable=None):
    try:
        saved_tool = json.loads(job.snapshot.get("action", "{}")).get("tool_name")
    except (ValueError, TypeError, AttributeError):
        saved_tool = None
    rules = [editable_rule(r) for r in version.rules if r["id"] in result.get("rule_ids", [])]
    matched = []
    activity_labels = {"read": "File read", "write": "File write", "shell": "Shell command", "git_push": "Git push", "credentials": "Sensitive-file access", "network": "Network request", "tool": "Specific tool"}
    for rule in rules:
        conditions = ["Activity: " + activity_labels.get(rule["activity"], rule["activity"]),
                      "Tool: " + (saved_tool or result.get("tool") or "Unknown tool"),
                      ("Matched selected connection: " if rule["connection_ids"] else "All connections: ") + connection.name]
        for key, label in (("roots", "Folders"), ("extensions", "Extensions"), ("filenames", "Filenames")):
            if rule.get(key): conditions.append(label + ": " + ", ".join(rule[key]))
        if rule.get("command_contains"): conditions.append("Command contains: " + rule["command_contains"])
        if rule.get("tool_name"): conditions.append("Required tool: " + rule["tool_name"])
        matched.append({"id": rule["id"], "name": rule["name"], "effect": rule["effect"], "conditions": conditions})
    winner = min(rules, key=lambda r: ({"deny": 0, "review": 1, "judge": 2, "allow": 3}[r["effect"]], r["id"])) if rules else None
    builtin = result.get("reason") == "Built-in prohibition"
    explanation = unavailable or ("A built-in prohibition takes priority over custom rules." if builtin else
        "No enabled rule matched this request. Normal safety evaluation continues." if not winner else
        f"Matched {winner['name']}.")
    if winner and len(rules) > 1:
        labels = {"deny": "Block", "review": "Ask me", "judge": "Send to judge", "allow": "Automatic approval"}
        lower = list(dict.fromkeys(labels[r["effect"]] for r in rules if r["effect"] != winner["effect"]))
        if lower:
            explanation += f" {labels[winner['effect']]} takes priority over {', '.join(lower)}."
        if sum(r["effect"] == winner["effect"] for r in rules) > 1:
            explanation += " Matching rules with the same decision are ordered by rule ID; this selects the recorded rule without changing the decision."
    if builtin:
        # Old live trials may not have frozen individual findings. Do not substitute
        # the historical active policy's findings or recompute today's assessment.
        evidence = result.get("findings", [])
        explanation += " " + " ".join(f["reason"] for f in evidence if f.get("reason"))
    return {"evaluation_id": job.id, "tool": saved_tool or job.snapshot.get("tool_name") or result.get("tool") or "Unknown tool",
            "title": session.title, "connection_id": connection.id, "connection_name": connection.name,
            "occurred_at": job.created_at, "created_at": job.created_at, "action": job.snapshot.get("action", ""),
            "previous_decision": (job.result or {}).get("recommendation"), "previous_source": (job.result or {}).get("source"),
            "decision": result["decision"], "reason": result.get("reason", explanation), "explanation": explanation,
            "rule_ids": result.get("rule_ids", []), "matched_rules": matched, "winner_id": winner["id"] if winner else None,
            "builtin": builtin, "unavailable_reason": unavailable}


def evaluation_rows(db, limit, version_id=None):
    query = select(SafetyEvaluation, ChatSession, Connection).select_from(SafetyEvaluation).join(Event, SafetyEvaluation.event_id == Event.id).join(ChatSession, Event.session_id == ChatSession.id).join(Connection, ChatSession.connection_id == Connection.id)
    if version_id is None:
        query = query.where(SafetyEvaluation.debug_result.is_(None))
    else:
        query = query.where(SafetyEvaluation.rules["trial"]["version"].as_integer() == version_id)
    return db.execute(query.order_by(SafetyEvaluation.created_at.desc(), SafetyEvaluation.id.desc()).limit(limit)).all()


@router.get("/versions/{id_}/results")
def results(id_: int, mode: Literal["past", "live"] = "past", decision: Literal["all", "allow", "review", "deny", "judge", "none", "unavailable"] = "all", q: str = Query(default="", max_length=500), offset: int = Query(default=0, ge=0), limit: int = Query(default=20, ge=1, le=100)):
    with store() as db:
        version = db.get(PolicyVersion, id_)
        if not version: raise HTTPException(404, "Policy version not found.")
        if mode == "past":
            snapshot = version.preview_result or {}
            items = snapshot.get("items", [])
            rerun = "items" not in snapshot
        else:
            items = [result_item(job, session, connection, version, job.rules["trial"]) for job, session, connection in evaluation_rows(db, 1000, id_)]
            rerun = False
        counts = {k: sum(item["decision"] == k for item in items) for k in ("allow", "review", "deny", "judge", "none", "unavailable")}
        filtered = [item for item in items if (decision == "all" or item["decision"] == decision) and (not q.strip() or q.strip().casefold() in json.dumps(item, ensure_ascii=False).casefold())]
        return {"items": filtered[offset:offset+limit], "total": len(filtered), "sampled": len(items), "counts": counts,
                "offset": offset, "limit": limit, "cap": 500 if mode == "past" else 1000,
                "tested_at": version.previewed_at if mode == "past" else version.trial_started_at, "rerun_required": rerun}


@router.post("/versions/{id_}/preview")
def preview(id_: int, revision: int | None = None):
    with lock, store() as db:
        state = state_for(db)
        require_revision(db, state.revision if revision is None else revision)
        version = db.get(PolicyVersion, id_)
        if not version:
            raise HTTPException(404, "Policy version not found.")
        rows = evaluation_rows(db, 500)
        counts = {k: 0 for k in ("allow", "review", "deny", "judge", "none", "unavailable")}
        examples = []; items = []
        for job, session, connection in rows:
            try:
                if job.snapshot.get("action_truncated"):
                    raise ValueError()
                payload = json.loads(job.snapshot["action"])
                if not isinstance(payload, dict) or "[REDACTED" in job.snapshot["action"]:
                    raise ValueError()
                result = match(version, payload, connection.id)
                result["tool"] = payload.get("tool_name")
                items.append(result_item(job, session, connection, version, result))
                counts[result["decision"]] += 1
                if result["decision"] != "none" and len(examples) < 10:
                    examples.append({"evaluation_id": job.id, "tool": payload.get("tool_name"), "decision": result["decision"], "reason": result["reason"], "rule_ids": result["rule_ids"], "previous_decision": (job.result or {}).get("recommendation")})
            except (ValueError, KeyError, TypeError, OSError, RuntimeError):
                counts["unavailable"] += 1
                items.append(result_item(job, session, connection, version, {"decision": "unavailable"}, "Saved input is redacted, truncated, or unavailable; this request cannot be tested reliably."))
        result = {"sampled": len(rows), "counts": counts, "examples": examples, "conflicts": conflicts(version.rules), "items": items}
        version.preview_result = result
        version.previewed_at = now(); db.add(PolicyChange(version_id=id_, action="preview")); db.commit()
        return {k: value for k, value in result.items() if k != "items"}


class Transition(BaseModel):
    revision: int
    action: Literal["trial", "activate", "rollback", "stop_trial", "disable", "resume"]
    version_id: int | None = None


@router.post("/transition")
def transition(body: Transition):
    with lock, store() as db:
        state = require_revision(db, body.revision)
        version = db.get(PolicyVersion, body.version_id) if body.version_id else None
        if body.action in {"trial", "activate", "rollback"} and not version:
            raise HTTPException(404, "Policy version not found.")
        if body.action == "trial":
            state.trial_id = version.id; version.trial_started_at = now()
        elif body.action == "activate":
            state.active_id = version.id
            state.paused_id = None
            if state.draft_id == version.id:
                state.draft_id = None
            if state.trial_id == version.id:
                state.trial_id = None
        elif body.action == "rollback":
            if not db.scalar(select(PolicyChange.id).where(PolicyChange.version_id == version.id, PolicyChange.action.in_(["activate", "rollback"]))):
                raise HTTPException(409, "Rollback requires a previously active version.")
            state.active_id = version.id
            state.paused_id = None
            if state.draft_id == version.id:
                state.draft_id = None
            if state.trial_id == version.id:
                state.trial_id = None
        elif body.action == "stop_trial":
            state.trial_id = None
        elif body.action == "resume":
            if not state.paused_id:
                raise HTTPException(409, "No paused rules to resume.")
            state.active_id = state.paused_id
            state.paused_id = None
        else:
            if state.active_id:
                state.paused_id = state.active_id
            state.active_id = None
        db.add(PolicyChange(version_id=body.version_id, action=body.action)); db.commit()
        return {"revision": state.revision}
