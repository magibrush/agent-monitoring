"""Bounded routing hints, not a shell parser or an authorization decision.

Only visible tool intent is inspected. Matches are leads for the judge, never
proof of abuse. No match still goes to the judge: aliases and helpers can hide
effects that a word list cannot discover.
"""
import re

MAX_TEXT = 24000
SIGNALS = (
    ("destructive", "high", r"\b(?:rm|rmdir|del|erase|remove-item|delete-file|unlink|shred|mkfs|format-volume)\b|\b(?:drop\s+(?:table|database)|truncate\s+table)\b", "The command may delete files or data."),
    ("history_rewrite", "high", r"\bgit\s+(?:[^\n;&|]{0,120}\s)?push\b[^\n;&|]{0,300}(?:\s-(?:[A-Za-z]*f[A-Za-z]*)(?=\s|$)|\s--force(?:-with-lease|-if-includes)?(?:=|\s|$))|\bgit\s+(?:[^\n;&|]{0,120}\s)?(?:reset\s+--hard|clean\s+-[A-Za-z]*[fdx])\b", "Git may rewrite shared history or discard local work."),
    ("network_transfer", "medium", r"\b(?:curl|wget|invoke-webrequest|invoke-restmethod|scp|sftp|rsync|nc|netcat)\b|\b(?:fetch|requests\.(?:post|put)|urllib\.request|https?\.request)\s*\(", "The command can transfer data over the network."),
    ("credential_access", "high", r"(?:\.ssh[/\\]|\.aws[/\\]|\.env(?:\b|\.)|id_(?:rsa|ed25519)\b|credentials\b|(?:api[_-]?key|access[_-]?token|secret[_-]?key)\b)", "The action references a location or name commonly used for credentials."),
    ("privilege_persistence", "high", r"\b(?:sudo|su|runas|chmod|chown|set-acl|icacls|schtasks|crontab|new-service|register-scheduledtask)\b|currentversion[/\\]run\b|authorized_keys\b", "The command may change privileges or persistent access."),
    ("obfuscated_execution", "high", r"\b(?:eval|invoke-expression|iex)\b|-(?:enc|encodedcommand)\b|\bbase64\b[^\n]{0,120}(?:--decode|-d)|(?:curl|wget)[^\n]{0,300}\|\s*(?:sh|bash|pwsh|powershell)\b", "The command may decode or run indirectly supplied instructions."),
)
COMPILED = [(category, severity, re.compile(pattern, re.I), reason) for category, severity, pattern, reason in SIGNALS]


def triage(payload):
    tool = str(payload.get("tool_name", ""))[:200].lower()
    args = payload.get("tool_input")
    texts = []
    truncated = False
    remaining = MAX_TEXT
    # Inspect known action fields only. New file contents, conversation text,
    # descriptions, and quoted documentation are not shell commands.
    if isinstance(args, dict):
        for key in ("command", "cmd", "script", "code"):
            value = args.get(key)
            if isinstance(value, str):
                texts.append(value[:remaining])
                truncated = truncated or len(value) > remaining
                remaining = max(0, remaining - len(value))
        if any(part in tool for part in ("read", "write", "edit", "file", "delete")):
            for key in ("file_path", "path", "target"):
                value = args.get(key)
                if isinstance(value, str):
                    texts.append(value[:remaining])
                    truncated = truncated or len(value) > remaining
                    remaining = max(0, remaining - len(value))
    text = "\n".join(texts)
    signals = [{"category": category, "severity": severity, "reason": reason}
               for category, severity, pattern, reason in COMPILED if pattern.search(text)]
    if any(part in tool for part in ("delete", "remove_file")) and not any(s["category"] == "destructive" for s in signals):
        signals.append({"category": "destructive", "severity": "high", "reason": "The tool name indicates a deletion operation."})
    if any(part in tool for part in ("web_fetch", "http_request", "upload")) and not any(s["category"] == "network_transfer" for s in signals):
        signals.append({"category": "network_transfer", "severity": "medium", "reason": "The tool name indicates a network request or upload."})
    return {"route": "judge", "signals": signals, "truncated": truncated,
            "reason": "Potentially sensitive effects need context." if signals else "No explicit policy matched; unknown effects still need assessment.",
            "limitations": "Text patterns are routing hints, not proof of intent. They do not parse shell programs or establish safety."}
