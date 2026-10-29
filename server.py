#!/usr/bin/env python3
"""Local Redfish tree explorer.

Serves the explorer UI, every DMTF mockup under ./vendor, the DMTF JSON schemas,
and (optionally) a read-only proxy to a live BMC. Stdlib only.

    python3 server.py                                   # mockups only
    python3 server.py --target https://10.0.0.5 --user admin --insecure

The explorer addresses resources as /rf/<source>/redfish/v1/..., where <source>
is a mockup directory name or "live". The proxy forwards GET and nothing else,
so nothing done in the explorer can change state on real hardware.
"""

import argparse
import base64
import getpass
import json
import mimetypes
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
DMTF = HERE / "vendor" / "Redfish-Publications"
SCHEMA_NAME = re.compile(r"^[A-Za-z0-9_.-]+\.json$")

# Missing resources get a Redfish error body, as a BMC would send, so scripts
# that parse .error.message work against the mockups too.
NOT_FOUND_ID = "Base.1.5.ResourceMissingAtURI"


def redfish_not_found(uri: str | None) -> dict:
    """The 404 body. A static host serves the same 404 body for every URI, so it
    calls this with None and the message says "the requested URI"."""
    info = {
        "@odata.type": "#Message.v1_1_1.Message",
        "MessageId": NOT_FOUND_ID,
        "Message": f"The resource at the URI {uri} was not found." if uri
                   else "The resource at the requested URI was not found.",
        "MessageArgs": [uri] if uri else [],
        "Severity": "Critical",
        "Resolution": "Place a valid resource at the URI or correct the URI and resubmit the request.",
    }
    return {"error": {"code": NOT_FOUND_ID, "message": info["Message"], "@Message.ExtendedInfo": [info]}}


# Mockups that are about liquid cooling sort first in the source picker.
FEATURED = ("public-cooling-unit", "public-liquid-cooled-server")


def discover_mockups(root: Path) -> dict:
    """Map mockup name -> (path, title, description) for each short-form mockup."""
    found = {}
    if not root.is_dir():
        return found
    for d in sorted(root.iterdir()):
        if not (d / "index.json").is_file():
            continue
        title, desc = d.name, ""
        cfg = d / "explorer_config.json"
        if cfg.is_file():
            try:
                c = json.loads(cfg.read_text(encoding="utf-8"))
                title, desc = c.get("name", title), c.get("description", "")
            except (OSError, ValueError):
                pass
        found[d.name] = (d, title, desc)
    return found


class Live:
    """Read-only GET proxy to one Redfish service."""

    def __init__(self, target, user, password, insecure, timeout=20):
        self.target = target.rstrip("/")
        self.timeout = timeout
        self.ctx = ssl._create_unverified_context() if insecure else ssl.create_default_context()
        self.headers = {"Accept": "application/json"}
        if user:
            token = base64.b64encode(f"{user}:{password}".encode()).decode()
            self.headers["Authorization"] = f"Basic {token}"

    def get(self, path):
        req = urllib.request.Request(self.target + path, headers=self.headers, method="GET")
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=self.timeout) as r:
                return r.status, r.headers.get("Content-Type", "application/json"), r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Content-Type", "application/json"), e.read()
        except (urllib.error.URLError, OSError) as e:
            body = json.dumps({"error": f"proxy: {e}"}).encode()
            return HTTPStatus.BAD_GATEWAY, "application/json", body


class Handler(BaseHTTPRequestHandler):
    mockups: dict = {}
    schemas: Path = DMTF / "json-schema"
    live: Live | None = None

    def log_message(self, fmt, *args):
        if os.environ.get("RFV_QUIET") is None:
            super().log_message(fmt, *args)

    def send_body(self, status, ctype, body: bytes, cache=False):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, obj):
        self.send_body(status, "application/json", json.dumps(obj).encode())

    def send_file(self, path: Path, cache=False):
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_body(HTTPStatus.OK, ctype, path.read_bytes(), cache)

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path in ("/", "/index.html"):
            return self.send_file(STATIC / "index.html")
        if path.startswith("/static/"):
            f = (STATIC / path[len("/static/"):]).resolve()
            if f.is_relative_to(STATIC) and f.is_file():
                return self.send_file(f)
        elif path == "/api/sources":
            return self.send_json(HTTPStatus.OK, self.sources())
        elif path.startswith("/schemas/"):
            name = path[len("/schemas/"):]
            f = self.schemas / name
            if SCHEMA_NAME.match(name) and f.is_file():
                return self.send_file(f, cache=True)
        elif path.startswith("/rf/"):
            source, _, rest = path[len("/rf/"):].partition("/")
            return self.redfish(source, "/" + rest)
        self.send_json(HTTPStatus.NOT_FOUND, {"error": f"not found: {path}"})

    def sources(self):
        out = []
        if self.live:
            out.append({"id": "live", "title": f"Live: {self.live.target}", "description": ""})
        names = sorted(self.mockups, key=lambda n: (n not in FEATURED, FEATURED.index(n) if n in FEATURED else 0, n))
        for name in names:
            _, title, desc = self.mockups[name]
            out.append({"id": name, "title": title, "description": desc})
        return out

    def redfish(self, source, rf_path):
        if source == "live" and self.live:
            # Pass the query string (e.g. $expand) through to live services.
            # The mockups are plain files, so they ignore it.
            query = urlsplit(self.path).query
            status, ctype, body = self.live.get(rf_path + (f"?{query}" if query else ""))
            return self.send_body(status, ctype, body)
        if source not in self.mockups:
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": f"unknown source: {source}"})
        root = self.mockups[source][0]
        rel = rf_path.rstrip("/")
        if rel != "/redfish/v1" and not rel.startswith("/redfish/v1/"):
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "paths start at /redfish/v1"})
        rel = rel[len("/redfish/v1"):].lstrip("/")
        d = (root / rel).resolve()
        if not d.is_relative_to(root.resolve()):
            return self.send_json(HTTPStatus.FORBIDDEN, {"error": "outside mockup"})
        for name in ("index.json", "index.xml"):
            if (d / name).is_file():
                return self.send_file(d / name)
        self.send_json(HTTPStatus.NOT_FOUND, redfish_not_found(rf_path))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--mockups", type=Path, default=DMTF / "mockups", help="directory of short-form mockups")
    ap.add_argument("--schemas", type=Path, default=DMTF / "json-schema")
    ap.add_argument("--target", help="live Redfish service, e.g. https://10.0.0.5")
    ap.add_argument("--user", help="BMC user; password from $REDFISH_PASSWORD or a prompt")
    ap.add_argument("--insecure", action="store_true", help="skip TLS verification (self-signed BMC certs)")
    args = ap.parse_args()

    Handler.mockups = discover_mockups(args.mockups)
    Handler.schemas = args.schemas
    if args.target:
        password = ""
        if args.user:
            password = os.environ.get("REDFISH_PASSWORD") or getpass.getpass(f"Password for {args.user}: ")
        Handler.live = Live(args.target, args.user, password, args.insecure)

    if not Handler.mockups and not Handler.live:
        sys.exit("No mockups found and no --target given. Run scripts/fetch-dmtf.sh first.")
    if not args.schemas.is_dir():
        print("warning: no schema directory; property descriptions will be missing", file=sys.stderr)

    srv = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f"{len(Handler.mockups)} mockups{' + live' if Handler.live else ''}; "
          f"open http://{args.bind}:{args.port}/")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
