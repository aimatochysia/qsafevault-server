"""
End-to-end test for bidirectional relay sync functionality.

Tests the complete relay workflow including:
1. Single-direction transfer with acknowledgment
2. Bidirectional transfer using the same PIN
3. Session lifecycle with completed state
4. Acknowledgment after completion

Usage:
  python test/relay-e2e.py
  python test/relay-e2e.py --base http://localhost:3000/api
  python test/relay-e2e.py --base http://localhost:3000/api --verbose
"""

import argparse
import base64
import json
import sys
import time
from typing import Any, Dict

try:
    import requests
    from colorama import Fore, Style, init as colorama_init
except ImportError:
    print("Error: Required packages not installed. Install with: pip install requests colorama")
    sys.exit(1)

colorama_init(autoreset=True)

def ok(msg): print(Fore.GREEN + f"✅ {msg}")
def warn(msg): print(Fore.YELLOW + f"⚠️  {msg}")
def fail(msg): print(Fore.RED + f"❌ {msg}")
def step(n, title): print(Style.BRIGHT + f"\n=== STEP {n}: {title} ===")
def pretty(obj): return json.dumps(obj, indent=2) if isinstance(obj, (dict, list)) else str(obj)

class RelayClient:
    def __init__(self, base: str, verbose: bool):
        self.base = base.rstrip("/")
        self.verbose = verbose
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": "qsafevault-relay-e2e/1.0",
            "Accept": "application/json",
            "Content-Type": "application/json"
        })
    
    def _req(self, method, path, **kw):
        url = f"{self.base}{path}"
        if self.verbose:
            print(f"\n>>> {method} {url}")
            if "json" in kw:
                print("Payload:", pretty(kw["json"]))
        r = self.s.request(method, url, timeout=10, **kw)
        if self.verbose:
            print(f"<<< Status: {r.status_code}")
            try:
                print("Body:", pretty(r.json()))
            except Exception:
                print("Body:", r.text)
        return r
    
    def send_chunk(self, pin, password_hash, chunk_index, total_chunks, data):
        """Send a chunk to the relay server."""
        return self._req("POST", "/relay", json={
            "action": "send",
            "pin": pin,
            "passwordHash": password_hash,
            "chunkIndex": chunk_index,
            "totalChunks": total_chunks,
            "data": data
        })
    
    def receive_chunk(self, pin, password_hash):
        """Receive a chunk from the relay server."""
        return self._req("POST", "/relay", json={
            "action": "receive",
            "pin": pin,
            "passwordHash": password_hash
        })
    
    def acknowledge(self, pin, password_hash):
        """Acknowledge receipt of all chunks."""
        return self._req("POST", "/relay", json={
            "action": "ack",
            "pin": pin,
            "passwordHash": password_hash
        })
    
    def ack_status(self, pin, password_hash):
        """Check acknowledgment status."""
        return self._req("POST", "/relay", json={
            "action": "ack-status",
            "pin": pin,
            "passwordHash": password_hash
        })

def test_single_direction_with_ack(client: RelayClient):
    """Test single-direction transfer with acknowledgment."""
    step(1, "Single-direction transfer with acknowledgment")
    
    pin = "123456"
    password_hash = "hash_a_to_b"
    
    # Send 2 chunks
    print("Sending chunk 0...")
    r = client.send_chunk(pin, password_hash, 0, 2, "chunk_0_data")
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "waiting"
    ok("Chunk 0 sent")
    
    print("Sending chunk 1...")
    r = client.send_chunk(pin, password_hash, 1, 2, "chunk_1_data")
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "waiting"
    ok("Chunk 1 sent")
    
    # Receive chunks
    print("Receiving chunk 0...")
    r = client.receive_chunk(pin, password_hash)
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "chunkAvailable"
    assert j["chunk"]["chunkIndex"] == 0
    assert j["chunk"]["data"] == "chunk_0_data"
    ok("Chunk 0 received")
    
    print("Receiving chunk 1...")
    r = client.receive_chunk(pin, password_hash)
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "chunkAvailable"
    assert j["chunk"]["chunkIndex"] == 1
    assert j["chunk"]["data"] == "chunk_1_data"
    ok("Chunk 1 received")
    
    # All chunks delivered
    print("Checking completion status...")
    r = client.receive_chunk(pin, password_hash)
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "done"
    ok("All chunks delivered (status: done)")
    
    # Check acknowledgment status before ack
    print("Checking ack status before acknowledgment...")
    r = client.ack_status(pin, password_hash)
    assert r.status_code == 200
    j = r.json()
    assert j["acknowledged"] == False
    ok("Not yet acknowledged (as expected)")
    
    # Send acknowledgment
    print("Sending acknowledgment...")
    r = client.acknowledge(pin, password_hash)
    assert r.status_code == 200
    ok("Acknowledgment sent")
    
    # Verify acknowledgment status
    print("Checking ack status after acknowledgment...")
    r = client.ack_status(pin, password_hash)
    assert r.status_code == 200
    j = r.json()
    assert j["acknowledged"] == True
    ok("Acknowledgment confirmed")
    
    print(Style.BRIGHT + Fore.GREEN + "✓ Single-direction test passed!\n")

def test_bidirectional_same_pin(client: RelayClient):
    """Test bidirectional transfer using the same PIN."""
    step(2, "Bidirectional transfer with same PIN")
    
    pin = "789012"
    password_hash_a = "hash_device_a"
    password_hash_b = "hash_device_b"
    
    # Direction A→B
    print("Direction A→B: Sending chunk...")
    r = client.send_chunk(pin, password_hash_a, 0, 1, "data_from_a")
    assert r.status_code == 200
    ok("Chunk sent A→B")
    
    print("Direction A→B: Receiving chunk...")
    r = client.receive_chunk(pin, password_hash_a)
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "chunkAvailable"
    assert j["chunk"]["data"] == "data_from_a"
    ok("Chunk received A→B")
    
    print("Direction A→B: Completing transfer...")
    r = client.receive_chunk(pin, password_hash_a)
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "done"
    ok("Transfer A→B completed")
    
    print("Direction A→B: Acknowledging...")
    r = client.acknowledge(pin, password_hash_a)
    assert r.status_code == 200
    ok("Transfer A→B acknowledged")
    
    # Verify A→B acknowledgment
    r = client.ack_status(pin, password_hash_a)
    assert r.status_code == 200
    j = r.json()
    assert j["acknowledged"] == True
    ok("A→B acknowledgment verified")
    
    # Direction B→A (same PIN, different passwordHash)
    print("\nDirection B→A: Sending chunk...")
    r = client.send_chunk(pin, password_hash_b, 0, 1, "data_from_b")
    assert r.status_code == 200
    ok("Chunk sent B→A")
    
    print("Direction B→A: Receiving chunk...")
    r = client.receive_chunk(pin, password_hash_b)
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "chunkAvailable"
    assert j["chunk"]["data"] == "data_from_b"
    ok("Chunk received B→A")
    
    print("Direction B→A: Completing transfer...")
    r = client.receive_chunk(pin, password_hash_b)
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "done"
    ok("Transfer B→A completed")
    
    print("Direction B→A: Acknowledging...")
    r = client.acknowledge(pin, password_hash_b)
    assert r.status_code == 200
    ok("Transfer B→A acknowledged")
    
    # Verify B→A acknowledgment
    r = client.ack_status(pin, password_hash_b)
    assert r.status_code == 200
    j = r.json()
    assert j["acknowledged"] == True
    ok("B→A acknowledgment verified")
    
    # Ensure both directions are independently tracked
    r = client.ack_status(pin, password_hash_a)
    assert r.status_code == 200
    j = r.json()
    assert j["acknowledged"] == True
    ok("A→B acknowledgment still valid")
    
    print(Style.BRIGHT + Fore.GREEN + "✓ Bidirectional test passed!\n")

def test_ack_after_completion(client: RelayClient):
    """Test that acknowledgment works after session completion."""
    step(3, "Acknowledgment after completion")
    
    pin = "345678"
    password_hash = "hash_test"
    
    # Send and receive single chunk
    print("Sending chunk...")
    r = client.send_chunk(pin, password_hash, 0, 1, "test_data")
    assert r.status_code == 200
    
    print("Receiving chunk...")
    r = client.receive_chunk(pin, password_hash)
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "chunkAvailable"
    
    print("Completing transfer...")
    r = client.receive_chunk(pin, password_hash)
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "done"
    ok("Transfer completed")
    
    # Wait a moment to simulate delay before acknowledgment
    print("Waiting 2 seconds before acknowledgment...")
    time.sleep(2)
    
    # Session should still be available for acknowledgment
    print("Sending acknowledgment after delay...")
    r = client.acknowledge(pin, password_hash)
    assert r.status_code == 200
    ok("Acknowledgment sent after delay")
    
    # Verify acknowledgment
    r = client.ack_status(pin, password_hash)
    assert r.status_code == 200
    j = r.json()
    assert j["acknowledged"] == True
    ok("Acknowledgment verified")
    
    print(Style.BRIGHT + Fore.GREEN + "✓ Ack after completion test passed!\n")

def test_waiting_status(client: RelayClient):
    """Test that receiver gets 'waiting' status when chunks not yet sent."""
    step(4, "Waiting status test")
    
    pin = "901234"
    password_hash = "hash_wait"
    
    # Try to receive before any chunks are sent
    print("Attempting to receive without any chunks sent...")
    r = client.receive_chunk(pin, password_hash)
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "expired"  # No session exists yet
    ok("Returns 'expired' when no session exists")
    
    # Send first chunk of 2
    print("Sending chunk 0 of 2...")
    r = client.send_chunk(pin, password_hash, 0, 2, "chunk_0")
    assert r.status_code == 200
    
    # Receive first chunk
    print("Receiving chunk 0...")
    r = client.receive_chunk(pin, password_hash)
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "chunkAvailable"
    
    # Try to receive again (chunk 1 not sent yet)
    print("Attempting to receive chunk 1 (not sent yet)...")
    r = client.receive_chunk(pin, password_hash)
    assert r.status_code == 200
    j = r.json()
    assert j["status"] == "waiting"
    ok("Returns 'waiting' when chunk not available")
    
    print(Style.BRIGHT + Fore.GREEN + "✓ Waiting status test passed!\n")

def run_tests(base: str, verbose: bool):
    print("=== Relay E2E Tests ===")
    print(f"Base URL: {base}")
    print()
    
    client = RelayClient(base, verbose)
    
    try:
        test_single_direction_with_ack(client)
        test_bidirectional_same_pin(client)
        test_ack_after_completion(client)
        test_waiting_status(client)
        
        print(Style.BRIGHT + Fore.GREEN + "\n🎉 ALL TESTS PASSED!\n")
        return 0
    except AssertionError as e:
        fail(f"Test failed: {e}")
        import traceback
        traceback.print_exc()
        return 1
    except requests.RequestException as e:
        fail(f"HTTP error: {e}")
        return 2
    except Exception as e:
        fail(f"Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        return 3

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="E2E test for relay sync functionality"
    )
    parser.add_argument(
        "--base",
        default="http://localhost:3000/api",
        help="Base URL for the API (default: http://localhost:3000/api)"
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose output"
    )
    
    args = parser.parse_args()
    sys.exit(run_tests(args.base, args.verbose))
