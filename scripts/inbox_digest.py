#!/usr/bin/env python3
"""SpeakToAlex inbox digest.

Lists every stored message in the private GitHub inbox repo
(alexyapsl/SpeakToAlex-inbox) and prints a plain-text digest, oldest first.

Usage: py scripts/inbox_digest.py
Output:
  TOTAL <n>
  - <received HKT> | <branch>/<label> | urg <n>/10 [FLAGS] | <message>
or "INBOX EMPTY" when there is nothing stored.
"""
import base64
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(ROOT, "SpeakToAlexInbox.env")
OWNER = "alexyapsl"
REPO = "SpeakToAlex-inbox"
BRANCH = "main"
HKT = timezone(timedelta(hours=8))
MAX_MSG_CHARS = 300


def read_token():
    with open(ENV_FILE, encoding="utf-8") as handle:
        return handle.read().strip()


def gh(url, token):
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "speaktoalex-digest",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def main():
    token = read_token()
    tree = gh(
        f"https://api.github.com/repos/{OWNER}/{REPO}/git/trees/{BRANCH}?recursive=1",
        token,
    )
    paths = sorted(
        entry["path"]
        for entry in tree.get("tree", [])
        if entry["path"].startswith("inbox/") and entry["path"].endswith(".json")
    )

    records = []
    for path in paths:
        obj = gh(
            f"https://api.github.com/repos/{OWNER}/{REPO}/contents/{path}", token
        )
        content = base64.b64decode(obj["content"]).decode("utf-8")
        records.append(json.loads(content))

    records.sort(key=lambda r: r.get("received_at", ""))

    if not records:
        print("INBOX EMPTY")
        return

    print(f"TOTAL {len(records)}")
    for rec in records:
        ts = rec.get("received_at", "")
        try:
            local = (
                datetime.fromisoformat(ts.replace("Z", "+00:00"))
                .astimezone(HKT)
                .strftime("%Y-%m-%d %H:%M HKT")
            )
        except Exception:
            local = ts
        urgency = (rec.get("urgency") or {}).get("rounded")
        branch = rec.get("branch") or "?"
        labels = rec.get("labels") or {}
        label = labels.get("work_area") or labels.get("personal_fun") or "-"
        flags = []
        if rec.get("decision") == "whatsapp":
            flags.append("WHATSAPP")
        if rec.get("needs_review"):
            flags.append("review")
        routing_status = rec.get("routing_status")
        if routing_status and routing_status != "routed":
            flags.append(routing_status)
        if rec.get("channel") == "chat":
            flags.append(f"chat/{rec.get('follow_ups_used', 0)}fu")
        flag_str = f" [{' '.join(flags)}]" if flags else ""
        message = " ".join((rec.get("message") or "").split())
        if len(message) > MAX_MSG_CHARS:
            message = message[: MAX_MSG_CHARS - 1] + "…"
        print(f"- {local} | {branch}/{label} | urg {urgency}/10{flag_str} | {message}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # surface failure to the cron agent
        print(f"DIGEST ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
