#!/usr/bin/env python3
"""Antes de um commit, procura chaves e senhas nos arquivos preparados e bloqueia se achar."""
import json, re, subprocess, sys

cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "")
if "git commit" not in cmd:
    sys.exit(0)
diff = subprocess.run(["git", "diff", "--cached", "-U0"], capture_output=True, text=True).stdout
padroes = [
    r"sk-[A-Za-z0-9_-]{20,}",            # OpenAI / Anthropic
    r"ghp_[A-Za-z0-9]{30,}",             # GitHub
    r"AKIA[0-9A-Z]{16}",                 # AWS
    r"AIza[0-9A-Za-z_-]{35}",            # Google
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    r"(?i)(senha|password|secret|token)\s*[:=]\s*['\"][^'\"]{8,}",
]
for linha in diff.splitlines():
    if linha.startswith("+") and any(re.search(p, linha) for p in padroes):
        print("Commit bloqueado: parece haver uma chave ou senha no que vai ser salvo. Remova e guarde fora do git.", file=sys.stderr)
        sys.exit(2)
