#!/usr/bin/env python3
"""Stdio bridge so MCP clients that only launch local servers (e.g. Claude Desktop) can use the DOGGS MCP endpoint.

Standard library only; copy this single file to the machine running the MCP client.
Configure with environment variables:
  DOGGS_URL    e.g. http://192.168.178.150:8383   (required)
  DOGGS_TOKEN  the EXTERNAL_API_TOKEN of the DOGGS server (required)
"""
import json
import os
import sys
import urllib.error
import urllib.request

URL = os.environ.get("DOGGS_URL", "").rstrip("/") + "/api/external/v1/mcp"
TOKEN = os.environ.get("DOGGS_TOKEN", "")


def forward(message):
    request = urllib.request.Request(URL, data=json.dumps(message).encode(), method="POST", headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read()
            return json.loads(body) if body.strip() else None
    except urllib.error.HTTPError as error:
        body = error.read()
        try:
            reply = json.loads(body)
            if isinstance(message, dict) and "id" in message and isinstance(reply, dict): reply["id"] = message["id"]
            return reply if isinstance(message, dict) and "id" in message else None
        except ValueError: problem = f"DOGGS returned HTTP {error.code}"
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        problem = f"DOGGS is not reachable at {URL}: {error}"
    if isinstance(message, dict) and "id" in message:
        return {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": problem}}
    return None


def main():
    if not URL.startswith("http") or not TOKEN:
        sys.stderr.write("Set DOGGS_URL and DOGGS_TOKEN.\n")
        sys.exit(1)
    for line in sys.stdin:
        if not line.strip(): continue
        try: message = json.loads(line)
        except ValueError:
            print(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}), flush=True)
            continue
        response = forward(message)
        if response is not None: print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
