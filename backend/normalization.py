"""Conservative transcript presentation rules; action labels are not safety verdicts."""
import re

CONTEXT_TAGS = ("environment_context", "recommended_plugins", "permissions instructions", "app-context", "skills_instructions")


def message_content(text, role):
    if role != "user":
        return "message", text
    cleaned = text
    for tag in CONTEXT_TAGS:
        cleaned = re.sub(r"<" + re.escape(tag) + r">[\s\S]*?</" + re.escape(tag) + r">", "", cleaned)
    cleaned = cleaned.strip()
    if not cleaned or cleaned.startswith("# AGENTS.md instructions for"):
        return "context", text
    return "message", cleaned


def action_category(name, text):
    # Exact Claude tool mappings must precede argument heuristics: writing a
    # script containing "rm" is a file write, not an executed deletion.
    claude_tools = {"Read": "read", "Glob": "read", "Grep": "read",
                    "Write": "file_write", "Edit": "file_write", "MultiEdit": "file_write",
                    "NotebookEdit": "file_write", "WebFetch": "network", "WebSearch": "network"}
    if name in claude_tools:
        return claude_tools[name]
    value = (name or "") + "\n" + text
    if re.search(r"\b(?:Remove-Item|rmdir|unlink|shutil\.rmtree|os\.remove)\b|(?:^|[\s;|&])(?:rm|del)\s|\*\*\* Delete File:", value, re.I):
        return "deletion"
    if name in {"Bash", "PowerShell"}:
        return "shell"
    if re.search(r"apply_patch|write_file|\*\*\* (?:Add|Update) File:", value, re.I):
        return "file_write"
    if re.search(r"read_file|Get-Content|\b(?:cat|rg)\s", value, re.I):
        return "read"
    if re.search(r"web|fetch|http|curl", name or "", re.I):
        return "network"
    if re.search(r"exec|bash|shell|terminal", name or "", re.I):
        return "shell"
    return "other"


def session_type(metadata):
    source = metadata.get("source")
    subagent = source.get("subagent") if isinstance(source, dict) else None
    if metadata.get("thread_source") == "guardian_review" or (isinstance(subagent, dict) and subagent.get("other") == "guardian"):
        return "internal_review"
    return "subagent" if isinstance(source, dict) and "subagent" in source else "conversation"
