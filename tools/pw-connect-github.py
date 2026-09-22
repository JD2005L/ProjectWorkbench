#!/usr/bin/env python3
"""Authorise GitHub for one Project Workbench user from a shell.

Does exactly what the "connect" link on Settings -> Users does, for people who would
rather run a command: signs in to the dashboard as you, starts GitHub's device flow for
the named user, prints the code that person must enter, and waits.

The authorisation itself cannot be automated, and that is the point of OAuth: whoever is
signed in to github.com when the code is entered is the account that gets authorised. So
the person named here has to enter the code themselves, on any device. This script just
carries the code to them and stores the result.

Usage:  python3 pw-connect-github.py [username]      (default: kevin.charlebois)
"""
import getpass
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

TARGET = sys.argv[1] if len(sys.argv) > 1 else "kevin.charlebois"

# The direct node port first: it carries no proxy headers, so the dashboard treats it as
# a trusted local call and its CSRF guard stands down. Through nginx the same guard
# requires Origin to match Host, hence the header on the fallback.
CANDIDATES = [
    ("http://127.0.0.1:3000/workbench", {}),
    ("https://127.0.0.1/workbench", {"Origin": "https://127.0.0.1"}),
]

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE   # the workbench serves a private-CA certificate
opener = urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=ctx),
    urllib.request.HTTPCookieProcessor(CookieJar()),
)


def call(base, headers, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base + path, data=data, method="POST" if data else "GET")
    for k, v in headers.items():
        req.add_header(k, v)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=30) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read() or b"{}"
        try:
            return json.loads(body)
        except ValueError:
            return {"ok": False, "error": f"HTTP {e.code}"}


def pick_base():
    for base, headers in CANDIDATES:
        try:
            req = urllib.request.Request(base + "/healthz")
            with opener.open(req, timeout=5) as res:
                if res.status == 200:
                    return base, headers
        except Exception:
            continue
    sys.exit("Could not reach the dashboard on 127.0.0.1:3000 or https://127.0.0.1/ from this shell.")


base, headers = pick_base()
print(f"dashboard: {base}")

user = input("your dashboard username [james.levac]: ").strip() or "james.levac"
password = getpass.getpass("your dashboard password: ")
out = call(base, headers, "/api/auth/login", {"username": user, "password": password})
if not out.get("ok"):
    sys.exit(f"login failed: {out.get('error') or out}")
print(f"signed in as {user}")

out = call(base, headers, "/api/github-oauth/start", {"username": TARGET})
if not out.get("ok"):
    sys.exit(f"could not start the authorisation: {out.get('error') or out}")

print()
print("=" * 58)
print(f"  {TARGET} must now open:  {out['verificationUri']}")
print(f"  and enter the code:      {out['userCode']}")
print("=" * 58)
print()
print("They must be signed in to GitHub AS THEMSELVES when they do it —")
print("whoever is signed in there is the account that gets stored.")
print()

interval = max(2.0, out.get("intervalMs", 5000) / 1000)
deadline = time.time() + out.get("expiresInMs", 900000) / 1000
while time.time() < deadline:
    time.sleep(interval)
    res = call(base, headers, "/api/github-oauth/poll", {"username": TARGET})
    if res.get("ok") and res.get("status") == "pending":
        interval = max(interval, res.get("intervalMs", 0) / 1000 or interval)
        print("  waiting…", flush=True)
        continue
    if not res.get("ok"):
        sys.exit(f"\n{res.get('error') or res}")
    print()
    print(f"stored for {res.get('target')} — authorised as GitHub user {res.get('login')}")
    print(f"scopes: {', '.join(res.get('scopes') or []) or '(none reported)'}")
    print(res.get("pushNote", ""))
    print()
    print("The push credential of every project they own has been re-pinned.")
    sys.exit(0)

sys.exit("\nThe code expired before it was authorised. Run this again.")
