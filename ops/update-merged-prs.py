#!/usr/bin/env python3
"""Generate MERGED-PRS.md showcasing all merged external open-source PRs.

Fetches merged pull requests authored by `--author` outside their own repos using `gh api graphql`,
groups and ranks them for resume/portfolio presentation, and writes `MERGED-PRS.md`.

Usage:
  python3 ops/update-merged-prs.py [--author sarthakdev143-lite] [--out MERGED-PRS.md] [--only-if-prs-changed]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

GSOC_ORGS = {
    "owasp",
    "dependencytrack",
    "openwisp",
    "apache",
    "kornia",
    "openrefine",
    "sugarlabs",
    "layer5io",
    "asyncapi",
    "wagtail",
    "django",
    "rocketchat",
    "zulip",
    "jenkinsci",
    "astropy",
    "freecodecamp",
    "sympy",
    "scipy",
    "numpy",
    "pandas-dev",
    "scikit-learn",
    "openmrs",
    "oppia",
    "processing",
    "beeware",
    "learningequality",
    "circuitverse",
    "publiclab",
    "networkx",
    "matplotlib",
    "jabref",
    "keploy",
    "checkstyle",
    "defectdojo",
    "meshery",
    "prometheus",
    "open-telemetry",
    "cncf",
    "kubernetes",
    "mozilla",
    "python",
    "psf",
    "gnome",
    "kde",
    "blender",
    "godotengine",
    "inkscape",
    "libreoffice",
    "wikimedia",
    "git",
    "llvm",
    "tensorflow",
    "pytorch",
    "scikit-image",
    "nodejs",
    "electron",
    "webpack",
    "babel",
    "eslint",
    "prettier",
    "storybookjs",
    "stdlib-js",
    "apicurio",
    "grafana",
    "keycloak",
}

SEARCH_QUERY = """
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on PullRequest {
        number
        title
        url
        mergedAt
        additions
        deletions
        changedFiles
        repository {
          nameWithOwner
          url
          stargazerCount
          description
          primaryLanguage {
            name
          }
          owner {
            login
          }
          isPrivate
        }
        closingIssuesReferences(first: 3) {
          nodes {
            number
            url
          }
        }
      }
    }
  }
}
"""

PR_URL_RE = re.compile(r"https://github\.com/[^/\s)]+/[^/\s)]+/pull/\d+")


def gh_graphql(query: str, q: str, cursor: str | None = None) -> dict:
    cmd = ["gh", "api", "graphql", "-f", f"query={query}", "-f", f"q={q}"]
    if cursor is not None:
        cmd.extend(["-f", f"cursor={cursor}"])
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=60)
    if out.returncode != 0:
        raise RuntimeError(f"gh api graphql failed (exit {out.returncode}): {out.stderr.strip()}")
    data = json.loads(out.stdout)
    if data.get("errors"):
        raise RuntimeError(f"GraphQL errors: {data['errors']}")
    return data


def is_gsoc_repo(owner_login: str) -> bool:
    return owner_login.strip().lower() in GSOC_ORGS


def fetch_merged_prs(author: str, min_stars: int) -> list[dict]:
    search_q = f"is:pr is:merged author:{author} -user:{author} sort:updated-desc"
    by_url: dict[str, dict] = {}
    cursor: str | None = None

    while True:
        payload = gh_graphql(SEARCH_QUERY, search_q, cursor=cursor)
        search = (payload.get("data") or {}).get("search") or {}
        for node in search.get("nodes") or []:
            if not node or not node.get("url") or not node.get("mergedAt"):
                continue
            repo = node.get("repository") or {}
            if repo.get("isPrivate"):
                continue
            owner = ((repo.get("owner") or {}).get("login")) or repo.get("nameWithOwner", "").partition("/")[0]
            stars = int(repo.get("stargazerCount") or 0)
            if not is_gsoc_repo(owner) and stars < min_stars:
                continue
            by_url[node["url"]] = node
        page = search.get("pageInfo") or {}
        if not page.get("hasNextPage") or not page.get("endCursor"):
            break
        cursor = page["endCursor"]

    prs = list(by_url.values())
    prs.sort(key=lambda p: p.get("mergedAt") or "", reverse=True)
    return prs


def escape_cell(text: str) -> str:
    return " ".join(text.replace("|", "\\|").split())


def fmt_stars(stars: int) -> str:
    if stars >= 1000:
        return f"{stars / 1000:.1f}k"
    return str(stars)


def fmt_diff(pr: dict) -> str:
    adds = int(pr.get("additions") or 0)
    dels = int(pr.get("deletions") or 0)
    files = int(pr.get("changedFiles") or 0)
    unit = "file" if files == 1 else "files"
    return f"`+{adds} / -{dels}` · {files} {unit}"


def render_markdown(author: str, prs: list[dict]) -> str:
    unique_repos: dict[str, dict] = {}
    lang_counts: Counter[str] = Counter()
    total_adds = 0
    total_dels = 0
    gsoc_count = 0

    for pr in prs:
        repo = pr["repository"]
        full_name = repo["nameWithOwner"]
        unique_repos[full_name] = repo
        lang = ((repo.get("primaryLanguage") or {}).get("name")) or "Other"
        lang_counts[lang] += 1
        total_adds += int(pr.get("additions") or 0)
        total_dels += int(pr.get("deletions") or 0)
        owner = ((repo.get("owner") or {}).get("login")) or full_name.partition("/")[0]
        if is_gsoc_repo(owner):
            gsoc_count += 1

    orgs = {((r.get("owner") or {}).get("login")) or name.partition("/")[0] for name, r in unique_repos.items()}
    combined_stars = sum(int(r.get("stargazerCount") or 0) for r in unique_repos.values())
    latest_merge = (prs[0]["mergedAt"][:10]) if prs else "—"
    langs_str = ", ".join(lang for lang, _ in lang_counts.most_common()) or "—"

    lines: list[str] = [
        "# Open Source Contributions — Merged PRs",
        "",
        f"Curated showcase of merged external pull requests authored by [@{author}](https://github.com/{author}).",
        "",
        "## At a Glance",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| **Merged PRs** | {len(prs)} |",
        f"| **GSoC Org PRs** | {gsoc_count} |",
        f"| **Organizations** | {len(orgs)} |",
        f"| **Repositories** | {len(unique_repos)} |",
        f"| **Languages** | {escape_cell(langs_str)} |",
        f"| **Combined Stars** | {combined_stars:,} ({fmt_stars(combined_stars)}) |",
        f"| **Lines Changed** | `+{total_adds:,} / -{total_dels:,}` |",
        f"| **Latest Merge** | {latest_merge} |",
        "",
        "## Merged Pull Requests",
        "",
        "| Date | Track | Repository | Language | Stars | Pull Request | Diff |",
        "|---|---|---|---|---:|---|---|",
    ]

    for pr in prs:
        repo = pr["repository"]
        full_name = repo["nameWithOwner"]
        owner = ((repo.get("owner") or {}).get("login")) or full_name.partition("/")[0]
        track = "**GSoC**" if is_gsoc_repo(owner) else "OSS"
        lang = ((repo.get("primaryLanguage") or {}).get("name")) or "—"
        stars = fmt_stars(int(repo.get("stargazerCount") or 0))
        title = escape_cell(pr["title"])
        pr_link = f"[#{pr['number']} — {title}]({pr['url']})"
        repo_link = f"[{full_name}]({repo['url']})"
        date_str = pr["mergedAt"][:10]
        lines.append(
            f"| {date_str} | {track} | {repo_link} | {escape_cell(lang)} | {stars} | {pr_link} | {fmt_diff(pr)} |"
        )

    # Group by organization for portfolio highlights
    by_org: dict[str, list[dict]] = defaultdict(list)
    for pr in prs:
        repo = pr["repository"]
        owner = ((repo.get("owner") or {}).get("login")) or repo["nameWithOwner"].partition("/")[0]
        by_org[owner].append(pr)

    def org_sort_key(item: tuple[str, list[dict]]) -> tuple[int, int, int, str]:
        org, org_prs = item
        max_stars = max(int(p["repository"].get("stargazerCount") or 0) for p in org_prs)
        return (0 if is_gsoc_repo(org) else 1, -len(org_prs), -max_stars, org.lower())

    lines.extend(["", "## Highlights by Organization", ""])
    for org, org_prs in sorted(by_org.items(), key=org_sort_key):
        tag = " *(GSoC Organization)*" if is_gsoc_repo(org) else ""
        lines.append(f"### {org}{tag}")
        lines.append("")

        by_repo: dict[str, list[dict]] = defaultdict(list)
        for pr in org_prs:
            by_repo[pr["repository"]["nameWithOwner"]].append(pr)

        for full_name, repo_prs in sorted(
            by_repo.items(),
            key=lambda kv: (-int(kv[1][0]["repository"].get("stargazerCount") or 0), kv[0].lower()),
        ):
            repo = repo_prs[0]["repository"]
            stars = fmt_stars(int(repo.get("stargazerCount") or 0))
            lang = ((repo.get("primaryLanguage") or {}).get("name")) or "—"
            desc = " ".join((repo.get("description") or "").split())
            if len(desc) > 160:
                desc = desc[:157].rstrip() + "..."
            header = f"**[{full_name}]({repo['url']})** · {stars} stars · {lang}"
            if desc:
                header += f" — {desc}"
            lines.append(header)
            lines.append("")
            for pr in repo_prs:
                issues = [
                    f"[#{iss['number']}]({iss['url']})"
                    for iss in ((pr.get("closingIssuesReferences") or {}).get("nodes") or [])
                    if iss and iss.get("number") and iss.get("url")
                ]
                issue_note = f" (closes {', '.join(issues)})" if issues else ""
                clean_title = " ".join(pr["title"].split())
                lines.append(
                    f"- {pr['mergedAt'][:10]} — [#{pr['number']}: {clean_title}]({pr['url']}) ({fmt_diff(pr)}){issue_note}"
                )
            lines.append("")

    lines.append(
        "*Automatically maintained by [ops/update-merged-prs.py](ops/update-merged-prs.py) via [.github/workflows/daily-ops.yml](.github/workflows/daily-ops.yml).*"
    )
    lines.append("")
    return "\n".join(lines)


def existing_pr_urls(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return set(PR_URL_RE.findall(path.read_text(encoding="utf-8")))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--author", default="sarthakdev143-lite")
    ap.add_argument("--out", default="MERGED-PRS.md")
    ap.add_argument("--min-stars", type=int, default=10)
    ap.add_argument("--only-if-prs-changed", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    prs = fetch_merged_prs(args.author, args.min_stars)
    out_path = Path(args.out)

    if args.only_if_prs_changed and not args.force and out_path.exists():
        current_urls = {p["url"] for p in prs}
        if current_urls == existing_pr_urls(out_path):
            print("MERGED-PRS.md unchanged (no new merged PRs)")
            return 0

    content = render_markdown(args.author, prs)
    out_path.write_text(content, encoding="utf-8")
    print(f"wrote {out_path} ({len(prs)} merged PRs)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
