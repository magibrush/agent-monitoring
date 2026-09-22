"""Conservative action facts. Signals describe visible intent, not arbitrary program effects."""
import fnmatch
import os
from pathlib import Path
import re

READ_TOOLS = {"read", "read_file"}
WRITE_TOOLS = {"write", "write_file", "edit", "edit_file", "multiedit", "apply_patch"}
SHELL_TOOLS = {"bash", "shell", "exec", "exec_command", "run_command", "powershell", "execute", "run_terminal_cmd"}
NETWORK_TOOLS = {"webfetch", "web_fetch", "fetch", "http_request", "web.run", "web__run"}
DISCOVERY_TOOLS = {"glob", "grep"}


def visible_filenames(text):
    """Literal path/name signals only; never execute or expand shell input."""
    return [token.replace("\\", "/").rsplit("/", 1)[-1]
            for token in re.findall(r"[^\s\"'`;|&<>(){},=]+", text)
            if token and not token.startswith("-")]


def reference_matches(name, patterns):
    # Reverse matching also catches discovery globs such as .env* against .env.
    return any(fnmatch.fnmatchcase(name.lower(), pattern.lower()) or
               fnmatch.fnmatchcase(pattern.lower(), name.lower()) for pattern in patterns)


def sensitive(path):
    parts = str(path).replace("\\", "/").lower().split("/")
    return any(p in {".ssh", ".aws", ".secrets", ".npmrc", ".netrc"} or p == ".env" or p.startswith(".env.") or any(x in p for x in ("secret", "credential", "password", "token")) or p.endswith((".pem", ".key", ".p12", ".pfx")) for p in parts)


def normalize(payload):
    tool = str(payload.get("tool_name") or "").lower()
    args = payload.get("tool_input")
    args = args if isinstance(args, dict) else {}
    activities = {"tool"}
    if tool in READ_TOOLS: activities.add("read")
    if tool in WRITE_TOOLS: activities.add("write")
    if tool in SHELL_TOOLS: activities.add("shell")
    if tool in NETWORK_TOOLS: activities.add("network")
    command = args.get("command", args.get("cmd", ""))
    command = command if isinstance(command, str) else ""
    cwd = args.get("workdir", args.get("cwd", payload.get("cwd")))
    cwd = Path(cwd) if isinstance(cwd, str) and cwd else None
    if cwd is not None and not cwd.is_absolute(): cwd = None
    paths = []
    references = []
    discovery_root = None
    if tool in SHELL_TOOLS:
        references = visible_filenames(command)
    elif tool in DISCOVERY_TOOLS:
        # Grep's pattern is content, whereas Glob's pattern is a filename glob.
        fields = ("pattern",) if tool == "glob" else ("glob", "path")
        for field in fields:
            if isinstance(args.get(field), str):
                references.extend(visible_filenames(args[field]))
        if isinstance(args.get("path"), str):
            discovery_root = Path(args["path"])
            if not discovery_root.is_absolute():
                discovery_root = cwd / discovery_root if cwd else None
        else:
            discovery_root = cwd
    raw = args.get("file_path", args.get("path"))
    if tool in READ_TOOLS | WRITE_TOOLS and isinstance(raw, str) and raw and not any(c in raw for c in ("\x00", "*", "?")):
        path = Path(raw)
        if not path.is_absolute() and cwd is not None: path = cwd / path
        if path.is_absolute():
            try:
                paths = [Path(os.path.abspath(path)), path.resolve()]
            except (OSError, ValueError, RuntimeError): pass
    if any(sensitive(p) for p in paths): activities.add("credentials")
    if "shell" in activities and command:
        # Conservative visible signals only; no claim to parse aliases, scripts or substitutions.
        if re.search(r"(?i)\bgit(?:\.exe)?\b[^\n;&|]*\bpush\b", command): activities.add("git_push")
        if re.search(r"(?i)\b(?:curl|wget|invoke-webrequest|invoke-restmethod)\b|https?://", command): activities.add("network")
        if re.search(r"(?i)(?<![\w.-])\.env(?:\.[\w.-]+)?(?![\w.-])|\.ssh\b|\.aws\b|\.secrets\b|credential|password|secret|token|\.(?:pem|p12|pfx)\b", command): activities.add("credentials")
    return {"tool": tool, "args": args, "activities": activities, "command": command, "cwd": cwd, "paths": paths,
            "filename_references": references, "discovery_root": discovery_root}


def filename_matches(path, patterns):
    return not patterns or any(fnmatch.fnmatchcase(path.name.lower(), pattern.lower()) for pattern in patterns)
