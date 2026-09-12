#!/usr/bin/env python3
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import threading


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: test_native_theme_capture.py CONTROL SUBJECT FRESH_OUTPUT")
    control, subject = [Path(value).resolve(strict=True) for value in sys.argv[1:3]]
    root = Path(sys.argv[3])
    root.mkdir(mode=0o700)
    os.chown(root, -1, os.getgid())
    root = root.resolve(strict=True)
    received = []
    connections = []
    runs = []
    body = b'{"source":"native-canary","background":"#121218"}'

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            data = self.rfile.read(int(self.headers["Content-Length"]))
            received.append({"path": self.path, "body": base64.b64encode(data).decode()})
            response = b'{"received":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *_args):
            pass

    class Server(HTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connections.append(address)
            return connection, address

    server = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()

    def run(name, executable, path, capture=True, broad_directory=False, scheme="http"):
        case = root / name
        case.mkdir(mode=0o700)
        for part in ("home", "tmp", "capture"):
            (case / part).mkdir(mode=0o700)
        if broad_directory:
            (case / "capture").chmod(0o755)
        env = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(case / "home"),
            "CFFIXED_USER_HOME": str(case / "home"),
            "TMPDIR": str(case / "tmp"),
        }
        if capture:
            env["CMUX_TEST_THEME_CAPTURE_DIRECTORY"] = str(case / "capture")
        argv = [str(executable), f"{scheme}://127.0.0.1:{server.server_port}{path}", str(case / "main.json")]
        child = subprocess.Popen(argv, cwd=case, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        timed_out = False
        try:
            stdout, stderr = child.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            timed_out = True
            child.kill()
            stdout, stderr = child.communicate()
        (case / "stdout").write_bytes(stdout)
        (case / "stderr").write_bytes(stderr)
        record = {"name": name, "argv": argv, "env": env, "pid": child.pid, "exit": child.returncode, "timedOut": timed_out}
        runs.append(record)
        (case / "run.json").write_text(json.dumps(record, indent=2) + "\n")
        assert not timed_out, f"{name}: canary exceeded its process deadline"
        return case, child.returncode, stdout

    try:
        _, code, output = run("plain-control", control, "/api/theme")
        assert code == 0, output
        assert len(received) == 1 and received[0]["body"] == base64.b64encode(body).decode(), received
        assert json.loads(output) == {"status": 200, "body": base64.b64encode(b'{"received":true}').decode()}

        for name, path, scheme in (
            ("root-theme", "/api/theme", "http"),
            ("token-theme", "/fixture-token/api/theme?ignored=1", "http"),
            ("https-theme", "/fixture-token/api/theme", "https"),
        ):
            before = len(received)
            connections_before = len(connections)
            case, code, output = run(name, subject, path, scheme=scheme)
            assert code == 0, (name, code, (case / "stderr").read_text())
            assert len(received) == before, f"{name}: unguarded theme POST reached the owned receiver"
            assert len(connections) == connections_before, f"{name}: capture opened a transport connection"
            assert json.loads(output) == {"status": 200, "body": base64.b64encode(b'{"captured":true}').decode()}
            marker = json.loads((case / "main.json").read_text())
            bootstrap = json.loads((case / "capture/bootstrap.json").read_text())
            assert marker["captureReadyAtMain"] and marker["pid"] == bootstrap["pid"], (marker, bootstrap)
            requests = [json.loads(p.read_text()) for p in (case / "capture").glob("*.request.json")]
            completions = [json.loads(p.read_text()) for p in (case / "capture").glob("*.complete.json")]
            assert len(requests) == len(completions) == 1, (requests, completions)
            request = requests[0]
            assert request["method"] == "POST" and request["url"].endswith(path), request
            assert request["contentType"] == "application/json", request
            assert request["body"] == base64.b64encode(body).decode(), request
            assert completions[0]["requestId"] == request["requestId"], (request, completions)

        before = len(received)
        connections_before = len(connections)
        case, code, _ = run("missing-capture-input", subject, "/api/theme", capture=False)
        assert code == 78 and not (case / "main.json").exists(), (code, list(case.iterdir()))
        assert len(received) == before, "missing bootstrap input reached the receiver"
        assert len(connections) == connections_before, "missing bootstrap input opened a connection"
        assert "native theme capture" in (case / "stderr").read_text()

        case, code, _ = run("broad-capture-directory", subject, "/api/theme", broad_directory=True)
        assert code == 78 and not (case / "main.json").exists(), (code, list(case.iterdir()))
        assert len(received) == before, "broken bootstrap input reached the receiver"
        assert len(connections) == connections_before, "broken bootstrap input opened a connection"
        assert "native theme capture" in (case / "stderr").read_text()

        before = len(received)
        case, code, output = run("unrelated-route", subject, "/not-theme")
        assert code == 0 and len(received) == before + 1, (code, received)
        assert json.loads(output) == {"status": 200, "body": base64.b64encode(b'{"received":true}').decode()}
        assert not list((case / "capture").glob("*.request.json"))
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
        receipt = {
            "control": {"path": str(control), "sha256": hashlib.sha256(control.read_bytes()).hexdigest()},
            "subject": {"path": str(subject), "sha256": hashlib.sha256(subject.read_bytes()).hexdigest()},
            "runs": runs,
            "received": received,
            "connections": connections,
        }
        (root / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
