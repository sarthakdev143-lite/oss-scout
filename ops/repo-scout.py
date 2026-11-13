#!/usr/bin/env python3
"""Rank candidate repos by outside-contributor merge rate plus labeled-issue supply.

Volume follows merge rate, not effort: a repo that merges 5% of outside PRs is worthless to
contribute to no matter how prestigious. Needs an authenticated `gh` CLI (GH_TOKEN).

Usage:
  python3 ops/repo-scout.py [--repos "a/b c/d"] [--since-days 90] [--summary PATH]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys

DEFAULT_REPOS = """
OWASP/OWASP-Hunting OWASP/SecurityShepherd OWASP/wstg OWASP/owasp-mastg
zulip/zulip zulip/zulip-desktop oppia/oppia
jenkinsci/jenkins jenkinsci/git-plugin jenkinsci/credentials-plugin
RocketChat/Rocket.Chat RocketChat/Rocket.Chat.js.SDK
processing/p5.js processing/p5.js-web-editor
wagtail/wagtail wagtail/wagtail.org
openmrs/openmrs-core openmrs/openmrs-module-webservices.rest
django/django django/code.djangoproject.com
CircuitVerse/CircuitVerse publiclab/plots2 sugarlabs/musicblocks-v4
OpenRefine/OpenRefine scikit-learn/scikit-learn pandas-dev/pandas laurent22/joplin
astropy/astropy sympy/sympy beeware/briefcase freeCodeCamp/freeCodeCamp
networkx/networkx scipy/scipy numpy/numpy
""".split()

QUERY = """
query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(first:100,states:[OPEN,MERGED,CLOSED],orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{ mergedAt createdAt authorAssociation }
    }
  }
}
"""

OUTSIDE = {"NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER"}


def gh(args: list[str]) -> str | None:
    try:
        out = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=90)
    except Exception:
        return None
    if out.returncode != 0:
        return None
    return out.stdout


def outside_merge_stats(repo: str, since: dt.datetime) -> tuple[int, int]:
    owner, _, name = repo.partition("/")
    raw = gh(["api", "graphql", "-f", f"query={QUERY}", "-f", f"owner={owner}", "-f", f"name={name}"])
    if not raw:
        return -1, -1
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return -1, -1
    nodes = (((data.get("data") or {}).get("repository") or {}).get("pullRequests") or {}).get("nodes") or []
    total = merged = 0
    for node in nodes:
        if (node.get("authorAssociation") or "") not in OUTSIDE:
            continue
        created = node.get("createdAt") or ""
        try:
            ts = dt.datetime.fromisoformat(created.replace("Z", "+00:00"))
        except ValueError:
            continue
        if ts < since:
            continue
        total += 1
        if node.get("mergedAt"):
            merged += 1
    return total, merged


def label_count(repo: str, label: str) -> int:
    q = f"repo:{repo}+is:issue+is:open+label:%22{label.replace(' ', '+')}%22"
    raw = gh(["api", f"search/issues?q={q}", "--jq", ".total_count"])
    try:
        return int((raw or "").strip())
    except ValueError:
        return -1


def verdict(rate: int, supply: int) -> str:
    if rate < 0:
        return "UNKNOWN"
    if rate >= 50 and supply >= 10:
        return "STRONG"
    if rate >= 30 and supply >= 5:
        return "USABLE"
    return "WEAK"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repos", default="", help="space separated owner/repo list")
    ap.add_argument("--since-days", type=int, default=90)
    ap.add_argument("--summary", default="", help="markdown summary file to append to")
    args = ap.parse_args()

    repos = (args.repos.split() if args.repos.strip() else DEFAULT_REPOS)
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=args.since_days)

    rows = []
    for repo in repos:
        total, merged = outside_merge_stats(repo, since)
        gfi = label_count(repo, "good first issue")
        hw = label_count(repo, "help wanted")
        bug = label_count(repo, "bug")
        supply = sum(c for c in (gfi, hw, bug) if c > 0)
        rate = round(100 * merged / total) if total > 0 else -1
        rows.append(
            {
                "repo": repo,
                "outside": total,
                "merged": merged,
                "rate": rate,
                "gfi": gfi,
                "hw": hw,
                "bug": bug,
                "supply": supply,
                "verdict": verdict(rate, supply),
            }
        )
        print(
            f"{repo:45} outside={total:3} merged={merged:3} rate={rate:4} "
            f"gfi={gfi:4} hw={hw:4} bug={bug:4} {verdict(rate, supply)}",
            flush=True,
        )

    rows.sort(key=lambda r: (r["rate"], r["supply"]), reverse=True)
    lines = [
        "| repo | outside PRs | merged | merge rate | gfi | hw | bug | verdict |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        rate = "-" if r["rate"] < 0 else f"{r['rate']}%"
        lines.append(
            f"| {r['repo']} | {r['outside']} | {r['merged']} | {rate} | "
            f"{r['gfi']} | {r['hw']} | {r['bug']} | {r['verdict']} |"
        )
    table = "\n".join(lines)
    print("\n" + table)
    if args.summary:
        with open(args.summary, "a", encoding="utf-8") as fh:
            fh.write("\n" + table + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
