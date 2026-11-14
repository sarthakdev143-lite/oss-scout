#!/usr/bin/env python3
"""Rank candidate repos by outside-contributor merge rate plus labeled-issue supply.

Volume follows merge rate, not effort: a repo that merges 5% of outside PRs is worthless to
contribute to no matter how prestigious. Needs an authenticated `gh` CLI (GH_TOKEN).

Usage:
  python3 ops/repo-scout.py [--repos "a/b c/d"] [--since-days 90] [--summary PATH]
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
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

DISCOVER_QUERY = """
query($q:String!){
  search(query:$q,type:ISSUE,first:60){
    nodes{ ... on Issue { repository { nameWithOwner stargazerCount } } }
  }
}
"""

DISCOVER_SEARCHES = [
    'label:"help wanted" is:issue is:open archived:false language:Python',
    'label:"help wanted" is:issue is:open archived:false language:TypeScript',
    'label:"help wanted" is:issue is:open archived:false language:JavaScript',
    'label:"help wanted" is:issue is:open archived:false language:Java',
    'label:"good first issue" is:issue is:open archived:false language:Python',
    'label:"good first issue" is:issue is:open archived:false language:TypeScript',
    'label:"good first issue" is:issue is:open archived:false language:JavaScript',
    'label:bug is:issue is:open archived:false language:Python',
    'label:bug is:issue is:open archived:false language:TypeScript',
    'label:bug is:issue is:open archived:false language:Java',
]


def has_cla(repo: str) -> bool:
    """A CLA/DCO gate means the contribution cannot land without a legal step the owner has not
    taken. Cheaper to exclude the repo here than to discover it at submission time."""
    for path in ("CLA.md", "docs/CLA.md", ".github/CLA.md", "CONTRIBUTING.md", ".github/CONTRIBUTING.md"):
        raw = gh(["api", f"repos/{repo}/contents/{path}", "--jq", ".content"])
        if not raw:
            continue
        try:
            text = base64.b64decode(raw.strip()).decode("utf-8", "ignore")
        except Exception:
            continue
        if re.search(r"(?i)contributor license agreement|cla-assistant|easycla", text):
            return True
    return False


def discover(min_stars: int, limit: int) -> list[str]:
    """Repos that currently carry live labeled issues, filtered by stars. Issue-search first, so
    every candidate arrives with actual work available rather than just being popular."""
    seen: dict[str, int] = {}
    for q in DISCOVER_SEARCHES:
        raw = gh(["api", "graphql", "-f", f"query={DISCOVER_QUERY}", "-f", f"q={q}"])
        if not raw:
            continue
        try:
            nodes = json.loads(raw)["data"]["search"]["nodes"]
        except (json.JSONDecodeError, KeyError, TypeError):
            continue
        for node in nodes:
            repo = (node or {}).get("repository") or {}
            name = repo.get("nameWithOwner")
            stars = repo.get("stargazerCount") or 0
            if not name or stars < min_stars:
                continue
            seen[name] = max(seen.get(name, 0), stars)
    ranked = sorted(seen.items(), key=lambda kv: kv[1], reverse=True)
    return [name for name, _ in ranked[:limit]]


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
    # GraphQL search (1 point each) instead of REST search, which is capped at ~30 requests/min
    # and silently returned nothing for most repos in the first run.
    q = f'repo:{repo} is:issue is:open label:"{label}"'
    query = 'query($q:String!){search(query:$q,type:ISSUE,first:1){issueCount}}'
    raw = gh(["api", "graphql", "-f", f"query={query}", "-f", f"q={q}"])
    if not raw:
        return -1
    try:
        return int(json.loads(raw)["data"]["search"]["issueCount"])
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
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
    ap.add_argument("--discover", action="store_true", help="build the candidate list from live labeled issues")
    ap.add_argument("--min-stars", type=int, default=200)
    ap.add_argument("--limit", type=int, default=40, help="max discovered repos to rank")
    ap.add_argument("--apply-config", default="", help="rewrite this config's repos.allow from pinned + the ranking")
    ap.add_argument("--pinned", default="ops/pinned-repos.txt")
    ap.add_argument("--max-total", type=int, default=30)
    ap.add_argument("--min-rate", type=int, default=40, help="merge-rate floor for automatic inclusion")
    ap.add_argument("--min-supply", type=int, default=5, help="labeled-issue floor for automatic inclusion")
    args = ap.parse_args()

    if args.discover:
        repos = discover(args.min_stars, args.limit)
        print(f"discovered {len(repos)} repos with live labeled issues (stars>={args.min_stars})", flush=True)
    else:
        repos = args.repos.split() if args.repos.strip() else DEFAULT_REPOS
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=args.since_days)

    rows = []
    for repo in repos:
        total, merged = outside_merge_stats(repo, since)
        cla = has_cla(repo)
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
                "cla": cla,
                "verdict": verdict(rate, supply),
            }
        )
        print(
            f"{repo:45} outside={total:3} merged={merged:3} rate={rate:4} "
            f"gfi={gfi:4} hw={hw:4} bug={bug:4} cla={'yes' if cla else 'no':3} {verdict(rate, supply)}",
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

    if args.apply_config:
        pinned: list[str] = []
        try:
            with open(args.pinned, encoding="utf-8") as fh:
                pinned = [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]
        except FileNotFoundError:
            print(f"warning: {args.pinned} not found; pinned set is empty")

        picked = [
            r["repo"]
            for r in rows
            if r["rate"] >= args.min_rate
            and r["supply"] >= args.min_supply
            and not r.get("cla")
            and r["repo"] not in pinned
        ]
        room = max(0, args.max_total - len(pinned))
        allow = pinned + picked[:room]

        with open(args.apply_config, encoding="utf-8") as fh:
            cfg = json.load(fh)
        before = list((cfg.get("repos") or {}).get("allow") or [])
        cfg.setdefault("repos", {})["allow"] = allow
        with open(args.apply_config, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
            fh.write("\n")

        added = [r for r in allow if r not in before]
        removed = [r for r in before if r not in allow]
        print(f"\nconfig updated: {len(allow)} repos (pinned {len(pinned)}, discovered {len(allow) - len(pinned)})")
        print(f"  added:   {', '.join(added) if added else '(none)'}")
        print(f"  removed: {', '.join(removed) if removed else '(none)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
