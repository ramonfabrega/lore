#!/usr/bin/env python3
"""denials.py — what happens when a tool call is denied, measured from your own transcripts.

Reads Claude Code transcripts (~/.claude/projects/**/*.jsonl) and reports every
denied tool call, split by WHY it was denied and by WHAT the session did next.

Zero dependencies, stdlib only, read-only. Nothing leaves the machine.
Deliberately not Bun (lore's convention) — this one runs on other people's laptops.

    python3 denials.py                 # the report
    python3 denials.py --since 2026-08-01
    python3 denials.py --json > rows.json

The load-bearing field is `toolDenialKind`, set on the user record that carries
the denied tool_result. Four values:

    automode-blocked      the auto-mode classifier refused
    user-rejected         a human pressed no
    automode-unavailable  auto mode could not rule
    permission-rule       a settings.json permission rule

Counts are the easy half. The half that matters — which reshapes were the
sanctioned kind and which defeated the reason — needs a human read of the
pairs this prints. See docs/DENIALS-RUNBOOK.md.
"""

import argparse
import json
import os
import re
import sys
from collections import Counter

NEEDLE = b"toolDenialKind"
WS = re.compile(r"\s+")
TOKEN = re.compile(r"[A-Za-z0-9_.:/-]{6,}")
SPLIT = re.compile(r"&&|\|\||;|\n")
# path noise every command in one tree shares — never evidence of a shared target
BORING = {"users", "home", "code", "claude", "worktrees", "projects", "2>&1",
          "tail", "head", "grep", "echo", "false", "true", "null", "usr/bin"}


def norm(s):
    return WS.sub(" ", str(s or "")).strip()


def statements(cmd):
    return [p.strip() for p in SPLIT.split(norm(cmd)) if p.strip()]


def programs(cmd):
    out = set()
    for st in statements(cmd):
        for word in st.split():
            if "=" in word and not word.startswith("-"):
                continue  # VAR=value prefix, not the program
            out.add(os.path.basename(word.lstrip("(")))
            break
    return out


def tokens(cmd):
    return {t.lower() for t in TOKEN.findall(norm(cmd))} - BORING


def repo_of(cwd):
    """Fold a worktree back into the checkout that owns it, then name it."""
    cwd = str(cwd or "")
    cut = cwd.split("/.claude/worktrees/")[0]
    return os.path.basename(cut) or "?"


def find_files(root):
    for dirpath, _dirs, names in os.walk(root):
        for n in names:
            if n.endswith(".jsonl"):
                yield os.path.join(dirpath, n)


def has_needle(path):
    """Cheap binary prefilter — full JSON parse only for files that can match."""
    try:
        with open(path, "rb") as fh:
            tail = b""
            while True:
                chunk = fh.read(1 << 20)
                if not chunk:
                    return False
                if NEEDLE in tail + chunk:
                    return True
                tail = chunk[-len(NEEDLE):]
    except OSError:
        return False


def text_of(rec):
    c = (rec.get("message") or {}).get("content")
    if isinstance(c, str):
        return c
    if not isinstance(c, list):
        return ""
    return " ".join(b.get("text", "") for b in c
                    if isinstance(b, dict) and b.get("type") == "text").strip()


def blocks_of(rec, kind):
    c = (rec.get("message") or {}).get("content")
    if not isinstance(c, list):
        return []
    return [b for b in c if isinstance(b, dict) and b.get("type") == kind]


def input_target(inp):
    """The one string worth comparing: a command, else a path, else the payload."""
    if not isinstance(inp, dict):
        return ""
    for k in ("command", "file_path", "path", "url", "query"):
        if inp.get(k):
            return str(inp[k])
    return json.dumps(inp, ensure_ascii=False)[:300]


def parse_file(path, rows):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            recs = []
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    recs.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        return

    by_tool_id = {}
    denied_ids = {}
    for r in recs:
        for b in blocks_of(r, "tool_use"):
            by_tool_id[b.get("id")] = b
        if r.get("toolDenialKind"):
            for b in blocks_of(r, "tool_result"):
                denied_ids[b.get("tool_use_id")] = r["toolDenialKind"]

    for i, r in enumerate(recs):
        kind = r.get("toolDenialKind")
        if not kind:
            continue
        res = (blocks_of(r, "tool_result") or [None])[0]
        src = by_tool_id.get(res.get("tool_use_id")) if res else None
        raw = r.get("toolUseResult")
        if not isinstance(raw, str):
            raw = (res or {}).get("content", "")
        if not isinstance(raw, str):
            raw = json.dumps(raw)[:600]
        m = re.search(r"Reason:\s*(.*?)(?:\s*If you have other tasks|$)", raw, re.S)

        # what came next: the next assistant tool_use, plus any text before it
        nxt, nxt_text = None, ""
        for n in recs[i + 1:]:
            if n.get("type") != "assistant":
                continue
            if not nxt_text:
                nxt_text = text_of(n)
            tus = blocks_of(n, "tool_use")
            if tus:
                nxt = tus[0]
                break

        # did a human speak before any further tool call?
        human_first = False
        for n in recs[i + 1:]:
            if n.get("type") == "user":
                if not blocks_of(n, "tool_result") and not n.get("isMeta"):
                    human_first = True
                    break
            elif n.get("type") == "assistant" and blocks_of(n, "tool_use"):
                break

        rows.append({
            "kind": kind,
            "ts": r.get("timestamp", ""),
            "session": r.get("sessionId", ""),
            "cwd": r.get("cwd", ""),
            "repo": repo_of(r.get("cwd")),
            "tool": (src or {}).get("name", "?"),
            "cmd": input_target((src or {}).get("input")),
            "reason": norm(m.group(1))[:240] if m else "",
            "nextTool": (nxt or {}).get("name", ""),
            "nextCmd": input_target((nxt or {}).get("input")) if nxt else "",
            "nextDenied": denied_ids.get((nxt or {}).get("id"), "") if nxt else "",
            "nextText": norm(nxt_text)[:600],
            "humanFirst": human_first,
            "file": path,
        })


def response_shape(row):
    """What the session did after the denial. One label per row."""
    if row["humanFirst"]:
        return "stopped, handed to the human"
    if not row["nextCmd"]:
        return "no further tool call"
    a, b = norm(row["cmd"]), norm(row["nextCmd"])
    if a == b:
        return "RETRIED VERBATIM"
    if row["nextTool"] != row["tool"]:
        return "switched tool (%s)" % row["nextTool"]
    if len(statements(a)) > 1 and any(st in statements(b) for st in statements(a)):
        return "split the compound, ran the allowed part"
    if programs(a) & programs(b):
        return "same program, reshaped"
    if tokens(a) & tokens(b):
        return "different program, same target (READ THIS)"
    return "dropped it, moved on"


def bar(n, total, width=28):
    filled = 0 if not total else int(round(width * n / total))
    return "#" * filled + "." * (width - filled)


def section(title):
    print("\n" + title)
    print("-" * len(title))


def main():
    ap = argparse.ArgumentParser(
        description="Measure denied tool calls in Claude Code transcripts.")
    ap.add_argument("--dir", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--since", default="", help="YYYY-MM-DD (UTC, inclusive)")
    ap.add_argument("--until", default="", help="YYYY-MM-DD (UTC, exclusive)")
    ap.add_argument("--kind", default="", help="only this toolDenialKind")
    ap.add_argument("--top", type=int, default=12)
    ap.add_argument("--json", action="store_true", help="emit rows as JSON, no report")
    args = ap.parse_args()

    if not os.path.isdir(args.dir):
        sys.exit("no transcript dir at %s" % args.dir)

    files = list(find_files(args.dir))
    hits = [f for f in files if has_needle(f)]
    rows = []
    for f in hits:
        parse_file(f, rows)
    rows.sort(key=lambda r: r["ts"])
    if args.since:
        rows = [r for r in rows if r["ts"][:10] >= args.since]
    if args.until:
        rows = [r for r in rows if r["ts"][:10] < args.until]
    if args.kind:
        rows = [r for r in rows if r["kind"] == args.kind]

    if args.json:
        json.dump(rows, sys.stdout, indent=1)
        return
    if not rows:
        sys.exit("no denied tool calls found in %s" % args.dir)

    span = "%s .. %s" % (rows[0]["ts"][:10], rows[-1]["ts"][:10])
    print("denials.py — %d denied tool calls, %s" % (len(rows), span))
    print("%d transcripts scanned, %d carried a denial (%d subagent)"
          % (len(files), len(hits), sum(1 for f in hits if "/subagents/" in f)))

    section("WHY it was denied")
    kinds = Counter(r["kind"] for r in rows)
    for k, n in kinds.most_common():
        print("  %-22s %5d  %s" % (k, n, bar(n, len(rows))))

    section("WHAT the session did next, per kind")
    print("  %-22s %6s %11s %11s %11s"
          % ("kind", "n", "stopped", "verbatim", "re-denied"))
    for k, n in kinds.most_common():
        sub = [r for r in rows if r["kind"] == k]
        stopped = sum(1 for r in sub if r["humanFirst"])
        verbatim = sum(1 for r in sub
                       if r["nextCmd"] and norm(r["nextCmd"]) == norm(r["cmd"]))
        redenied = sum(1 for r in sub if r["nextDenied"])

        def pct(x):
            return "%d (%d%%)" % (x, round(100.0 * x / n))

        print("  %-22s %6d %11s %11s %11s" % (k, n, pct(stopped), pct(verbatim), pct(redenied)))
    print("\n  stopped   = a human spoke before any further tool call")
    print("  verbatim  = the very next tool call was byte-identical (thrash)")
    print("  re-denied = the very next tool call was denied too")

    blocked = [r for r in rows if r["kind"] == "automode-blocked"]
    label = "automode-blocked"
    if not blocked:
        blocked, label = rows, "all denials"

    section("Response shape (%s, n=%d)" % (label, len(blocked)))
    shapes = Counter(response_shape(r) for r in blocked)
    switched = Counter()
    for s in list(shapes):
        m = re.match(r"switched tool \((.*)\)$", s)
        if m:
            switched[m.group(1)] = shapes.pop(s)
    if switched:
        shapes["switched to another tool"] = sum(switched.values())
    for s, n in shapes.most_common():
        print("  %5d  %2d%%  %s" % (n, round(100.0 * n / len(blocked)), s))
    if switched:
        print("         via %s" % ", ".join("%s x%d" % (k, v) for k, v in switched.most_common(8)))

    section("Where they land (%s)" % label)
    for k, n in Counter(r["repo"] for r in blocked).most_common(args.top):
        print("  %5d  %s" % (n, k))
    print()
    for k, n in Counter(r["tool"] for r in blocked).most_common(6):
        print("  %5d  tool: %s" % (n, k))
    print()
    heads = Counter(" ".join(norm(r["cmd"]).split()[:2])
                    for r in blocked if r["tool"] == "Bash")
    for k, n in heads.most_common(args.top):
        print("  %5d  $ %s" % (n, k[:70]))

    section("Stated reasons (%s)" % label)
    reasons = Counter(re.sub(r"[0-9a-f-]{16,}", "<id>", r["reason"])[:70]
                      for r in blocked if r["reason"])
    for k, n in reasons.most_common(args.top):
        print("  %5d  %s" % (n, k))

    routes = [r for r in blocked
              if response_shape(r) == "different program, same target (READ THIS)"]
    section("Route-around candidates — %d, JUDGMENT REQUIRED" % len(routes))
    print("  A different program aimed at the same target. Most are the sanctioned")
    print("  reshape (head for cat, wc -c for stat). Some defeat the REASON rather")
    print("  than the mechanism. Only reading them tells you which — nothing printed")
    print("  here is a verdict.\n")
    for r in routes[:args.top]:
        print("  %s  %s" % (r["ts"][:10], r["repo"]))
        print("     x  %s" % norm(r["cmd"])[:150])
        print("     -> %s" % norm(r["nextCmd"])[:150])
        if r["reason"]:
            print("     why %s" % r["reason"][:110])
        print()

    stops = [r for r in blocked if r["humanFirst"]]
    if stops:
        quoted = sum(1 for r in stops if re.search(r"`[^`]{6,}`|```", r["nextText"]))
        banged = sum(1 for r in stops if re.search(r"`!\s|the `!` prefix", r["nextText"]))
        section("Handover quality (the %d stops)" % len(stops))
        print("  %d of %d closing messages quote a runnable command" % (quoted, len(stops)))
        print("  %d name the `!` prefix (runs it in-session, output comes back)" % banged)
        for r in stops[:5]:
            print("\n  %s  %s\n     x  %s\n     >  %s"
                  % (r["ts"][:10], r["repo"], norm(r["cmd"])[:110],
                     (r["nextText"] or "(no text)")[:300]))


if __name__ == "__main__":
    main()
