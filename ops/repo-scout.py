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


AI_BAN_RE = re.compile(
    r"(?i)"
    r"do not accept unsolicited pull requests"
    r"|no unsolicited prs? from autonomous"
    r"|do not allow autonomous agents"
    r"|purely ai[- ]generated contributions are not welcome"
    r"|does not accept (?:fully )?ai[- ]generated pull requests"
    r"|never create a pr"
    r"|autonomous workflows[^.\n]{0,60}not human contributors"
    r"|ai[- ]written[^.\n]{0,60}won't be answered"
)


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


def has_ai_ban(repo: str) -> bool:
    """Detect explicit repository bans on autonomous/unsolicited AI pull requests."""
    for path in ("AI_POLICY.md", ".github/AI_POLICY.md", "AGENTS.md", "CONTRIBUTING.md", ".github/CONTRIBUTING.md"):
        raw = gh(["api", f"repos/{repo}/contents/{path}", "--jq", ".content"])
        if not raw:
            continue
        try:
            text = base64.b64decode(raw.strip()).decode("utf-8", "ignore")
        except Exception:
            continue
        if AI_BAN_RE.search(text):
            return True
    return False


def load_list(path: str) -> list[str]:
    try:
        with open(path, encoding="utf-8") as fh:
            return [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]
    except FileNotFoundError:
        return []


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


def discover_gsoc_orgs(orgs: list[str], min_stars: int, limit: int) -> list[str]:
    """Discover active repositories across curated GSoC organizations carrying live labeled issues."""
    if not orgs:
        return []
    seen: dict[str, int] = {}
    labels = ('label:"help wanted"', 'label:"good first issue"', "label:bug")
    for i in range(0, len(orgs), 5):
        org_clause = " ".join(f"org:{o}" for o in orgs[i : i + 5])
        for lbl in labels:
            q = f"{lbl} is:issue is:open archived:false {org_clause}"
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
        out = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
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
    ap.add_argument("--denied", default="ops/denied-repos.txt")
    ap.add_argument("--gsoc-orgs", default="ops/gsoc-orgs.txt")
    ap.add_argument("--gsoc-min-stars", type=int, default=100)
    ap.add_argument("--gsoc-min-rate", type=int, default=35)
    ap.add_argument("--gsoc-limit", type=int, default=40)
    ap.add_argument("--max-total", type=int, default=45)
    ap.add_argument("--min-rate", type=int, default=40, help="merge-rate floor for automatic inclusion")
    ap.add_argument("--min-supply", type=int, default=5, help="labeled-issue floor for automatic inclusion")
    args = ap.parse_args()

    pinned = load_list(args.pinned)
    denied = set(load_list(args.denied))
    gsoc_orgs = load_list(args.gsoc_orgs)
    gsoc_org_set = {o.lower() for o in gsoc_orgs}
    skip_set = set(pinned) | denied

    if args.discover:
        gsoc_repos = [r for r in discover_gsoc_orgs(gsoc_orgs, args.gsoc_min_stars, args.gsoc_limit) if r not in skip_set]
        seen_gsoc = set(gsoc_repos)
        general_repos = [
            r for r in discover(args.min_stars, args.limit) if r not in skip_set and r not in seen_gsoc
        ]
        repos = gsoc_repos + general_repos
        print(
            f"discovered {len(gsoc_repos)} GSoC org repos (stars>={args.gsoc_min_stars}) + "
            f"{len(general_repos)} general repos (stars>={args.min_stars})",
            flush=True,
        )
    else:
        repos = args.repos.split() if args.repos.strip() else DEFAULT_REPOS
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=args.since_days)

    rows = []
    for repo in repos:
        total, merged = outside_merge_stats(repo, since)
        cla = has_cla(repo)
        ai_ban = has_ai_ban(repo)
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
                "ai_ban": ai_ban,
                "verdict": verdict(rate, supply),
            }
        )
        print(
            f"{repo:45} outside={total:3} merged={merged:3} rate={rate:4} "
            f"gfi={gfi:4} hw={hw:4} bug={bug:4} cla={'yes' if cla else 'no':3} "
            f"ai_ban={'yes' if ai_ban else 'no':3} {verdict(rate, supply)}",
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
        if not pinned:
            print(f"warning: {args.pinned} not found or empty; pinned set is empty")
        if not denied:
            print(f"warning: {args.denied} not found or empty; no deny list")

        eligible = [
            r
            for r in rows
            if r["supply"] >= args.min_supply
            and not r.get("cla")
            and not r.get("ai_ban")
            and r["repo"] not in pinned
            and r["repo"] not in denied
        ]
        gsoc_picked = [
            r["repo"]
            for r in eligible
            if r["repo"].partition("/")[0].lower() in gsoc_org_set and r["rate"] >= args.gsoc_min_rate
        ]
        general_picked = [
            r["repo"]
            for r in eligible
            if r["repo"].partition("/")[0].lower() not in gsoc_org_set and r["rate"] >= args.min_rate
        ]

        room = max(0, args.max_total - len(pinned))
        gsoc_quota = (room + 1) // 2
        general_quota = room // 2
        chosen = gsoc_picked[:gsoc_quota] + general_picked[:general_quota]
        if len(chosen) < room:
            chosen_set = set(chosen)
            backfill = [r for r in (gsoc_picked[gsoc_quota:] + general_picked[general_quota:]) if r not in chosen_set]
            chosen.extend(backfill[: room - len(chosen)])
        allow = pinned + chosen[:room]

        with open(args.apply_config, encoding="utf-8") as fh:
            cfg = json.load(fh)
        before = list((cfg.get("repos") or {}).get("allow") or [])
        cfg.setdefault("repos", {})["allow"] = allow
        cfg.setdefault("repos", {})["deny"] = sorted(denied)
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
