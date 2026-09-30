#!/usr/bin/env python3
"""End-to-end test of a polling job from the terminal, without a browser.

Sends the POST, follows the job through its stages and prints the final result.
Sends the body as UTF-8 (curl from Git Bash on Windows turns Hebrew into '?????').

Examples:
  python poll_test.py --start https://x.app.n8n.cloud/webhook/fit \
                      --status https://x.app.n8n.cloud/webhook/fit-status \
                      --body '{"name": "בדיקה", "docs": 60}'
  python poll_test.py --start ... --status ... --body @case1.json --expect-status 400

Exit code: 0 when the job ends as expected, 1 otherwise.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8")
    except AttributeError:
        pass


def call(url, body=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json; charset=utf-8"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", "replace")
        try:
            return err.code, json.loads(raw)
        except ValueError:
            return err.code, raw


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--start", required=True, help="POST webhook URL")
    p.add_argument("--status", required=True, help="GET status webhook URL (jobId is added as a query param)")
    p.add_argument("--body", required=True, help="JSON body, or @path/to/file.json")
    p.add_argument("--interval", type=float, default=2.0, help="seconds between status checks (default 2)")
    p.add_argument("--cap", type=float, default=90.0, help="give up after this many seconds (default 90)")
    p.add_argument("--expect-status", type=int, default=200, help="expected HTTP status of the POST (use 400 for validation tests)")
    args = p.parse_args()

    raw = open(args.body[1:], encoding="utf-8").read() if args.body.startswith("@") else args.body
    body = json.loads(raw)

    code, job = call(args.start, body)
    print(f"POST -> {code} {json.dumps(job, ensure_ascii=False)}")
    if code != args.expect_status:
        print(f"FAIL: expected HTTP {args.expect_status}")
        return 1
    if code != 200:
        return 0  # a validation test: the expected error came back
    job_id = (job or {}).get("jobId") if isinstance(job, dict) else None
    if not job_id:
        print("FAIL: response has no jobId")
        return 1

    started = time.time()
    seen = []
    sep = "&" if "?" in args.status else "?"
    while time.time() - started < args.cap:
        time.sleep(args.interval)
        code, status = call(f"{args.status}{sep}jobId={urllib.parse.quote(job_id)}")
        if code != 200 or not isinstance(status, dict):
            print(f"  {time.time() - started:5.1f}s  status check failed: HTTP {code}")
            continue
        mark = (status.get("status"), status.get("stage"))
        if not seen or seen[-1] != mark:
            seen.append(mark)
            print(f"  {time.time() - started:5.1f}s  status={mark[0]}  stage={mark[1]}")
        if status.get("status") != "pending":
            print(json.dumps(status, ensure_ascii=False, indent=2))
            ok = status.get("status") == "done"
            print("OK" if ok else f"FAIL: job ended with status={status.get('status')}")
            return 0 if ok else 1
    print(f"FAIL: still pending after {args.cap:.0f}s (check the n8n execution for a node that threw)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
