"""
End-to-end behavioral check for qsafevault-server.
Covers:
1) POST /v1/sessions
2) GET  /v1/sessions/resolve?pin=...
3) Verify expected preconditions (offer_not_set / offer_not_set)
4) POST offer
5) GET offer (matches)
6) POST answer
7) GET answer (matches, expires)
8) GET answer again (session_expired)
9) DELETE session
10) GET resolve after expiry (session_expired or pin_not_found)

Usage:
  python automate.py
  python automate.py --base https://qsafevault-server.vercel.app/api
  python automate.py --base https://qsafevault-server.vercel.app/api --no-verify --verbose
"""
import argparse, base64, json, os, re, sys, textwrap, requests, urllib3
from dataclasses import dataclass
from typing import Any, Dict
from colorama import Fore, Style, init as colorama_init

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
colorama_init(autoreset=True)

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
PIN_RE = re.compile(r"^\d{6}$")

#helper
def b64(data: bytes) -> str: return base64.b64encode(data).decode()
def rand_bytes(n: int) -> bytes: return os.urandom(n)
def ok(msg): print(Fore.GREEN + f"✅ {msg}")
def warn(msg): print(Fore.YELLOW + f"⚠️  {msg}")
def fail(msg): print(Fore.RED + f"❌ {msg}")
def step(n, title): print(Style.BRIGHT + f"\n=== STEP {n}: {title} ===")

def make_env(session_id: str, ct_len=32) -> Dict[str, Any]:
    nonce, ct = rand_bytes(12), rand_bytes(ct_len)
    return {"v": 1, "sessionId": session_id, "nonceB64": b64(nonce), "ctB64": b64(ct)}

def pretty(obj): return json.dumps(obj, indent=2, sort_keys=True) if isinstance(obj, (dict, list)) else str(obj)

#client
class QClient:
    def __init__(self, base: str, verify: bool, verbose: bool):
        self.base, self.verify, self.verbose = base.rstrip("/"), verify, verbose
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": "qsafevault-e2e/1.0", "Accept": "application/json"})

    def _req(self, method, path, **kw):
        url = f"{self.base}/v1{path}"
        if self.verbose:
            print(f"\n>>> {method} {url}")
            if "json" in kw: print("Payload:", pretty(kw["json"]))
        r = self.s.request(method, url, timeout=10, verify=self.verify, **kw)
        if self.verbose:
            print(f"<<< Status: {r.status_code}")
            try: print("Body:", pretty(r.json()))
            except Exception: print("Body:", r.text)
        return r

#logic
def run(base, verify, verbose):
    print(f"=== qsafevault-server E2E ===\nBase: {base.rstrip('/')}/v1 (verify TLS: {verify})\n")
    c = QClient(base, verify, verbose)

    step(1, "Create Session")
    r = c._req("POST", "/sessions"); j = r.json()
    assert r.status_code == 200
    sid, pin = j["sessionId"], j["pin"]
    ok(f"Created session {sid} (PIN {pin})")

    step(2, "Resolve PIN")
    r = c._req("GET", "/sessions/resolve", params={"pin": pin}); j2 = r.json()
    assert r.status_code == 200 and j2["sessionId"] == sid
    ok("PIN resolved correctly")

    step(3, "Check Preconditions")
    r1 = c._req("GET", f"/sessions/{sid}/offer"); assert r1.status_code == 404; warn("offer_not_set (404)")
    r2 = c._req("POST", f"/sessions/{sid}/answer", json={"envelope": make_env(sid)}); assert r2.status_code == 409; warn("offer_not_set (409)")

    step(4, "Post Offer")
    offer = make_env(sid, 48)
    r = c._req("POST", f"/sessions/{sid}/offer", json={"envelope": offer})
    assert r.status_code == 200; ok("Offer posted")

    step(5, "Get Offer")
    r = c._req("GET", f"/sessions/{sid}/offer"); j = r.json()
    assert j["envelope"] == offer; ok("Offer retrieved and matches")

    step(6, "Post Answer")
    ans = make_env(sid, 64)
    r = c._req("POST", f"/sessions/{sid}/answer", json={"envelope": ans})
    assert r.status_code == 200; ok("Answer posted")

    step(7, "Get Answer (first)")
    r = c._req("GET", f"/sessions/{sid}/answer"); j = r.json()
    assert j["envelope"] == ans; ok("Answer matches; session now expired")

    step(8, "Get Answer (again)")
    r = c._req("GET", f"/sessions/{sid}/answer"); j = r.json()
    assert r.status_code == 410 and j["error"] == "session_expired"; warn("session_expired (410)")

    step(9, "Delete Session")
    r = c._req("DELETE", f"/sessions/{sid}")
    assert r.status_code == 204; ok("Session deleted")

    step(10, "Resolve After Expiry")
    r = c._req("GET", "/sessions/resolve", params={"pin": pin}); j = r.json()
    assert r.status_code in (404, 410)
    warn(f"{j['error']} ({r.status_code})")
    print(Style.BRIGHT + Fore.GREEN + "\n🎉 SUCCESS: All checks passed!\n")

#cli, run with python automate.py --base https://qsafevault-server.vercel.app/api --no-verify --verbose
if __name__ == "__main__":
    p = argparse.ArgumentParser(description="E2E behavior test for qsafevault-server routes.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
        Examples:
          python automate.py
          python automate.py --base https://qsafevault-server.vercel.app/api
          python automate.py --base https://qsafevault-server.vercel.app/api --no-verify --verbose
        """))
    p.add_argument("--base", default="https://qsafevault-server.vercel.app/api")
    p.add_argument("--no-verify", action="store_true")
    p.add_argument("--verbose", action="store_true")
    a = p.parse_args()

    try:
        run(a.base, not a.no_verify, a.verbose)
    except AssertionError as e:
        fail(str(e)); sys.exit(1)
    except requests.RequestException as e:
        fail(f"HTTP ERROR: {e}"); sys.exit(2)
