#!/usr/bin/env python3
"""Hook process evidence must preserve argv boundaries without exposing environment values."""

from __future__ import annotations

import json
import os
import select
import subprocess
import unittest


class HookProcessArgvTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.cli = os.environ["CMUX_CLI_BIN"]
        cls.env = {
            **os.environ,
            "CMUX_SOCKET_PATH": f"/tmp/cmux-argv-no-socket-{os.getpid()}.sock",
            "CMUX_CLI_SENTRY_DISABLED": "1",
        }

    def invoke(self, *pids: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [self.cli, "hooks", "process-argv", *pids],
            capture_output=True,
            text=True,
            env=self.env,
            timeout=15,
            check=False,
        )

    def test_preserves_exact_arguments_and_excludes_environment(self) -> None:
        script = "printf 'ready\\n'; IFS= read -r value"
        arguments = [
            "/bin/sh", "-c", script, "",
            "Explain --allow-all-tools without using tools",
            "--allow-all-tools", "quotes ' \" and \u2603",
        ]
        with subprocess.Popen(
            arguments,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, "ARGV_PROBE_SECRET": "environment-only-secret"},
        ) as child:
            try:
                self.assertTrue(select.select([child.stdout], [], [], 15)[0])
                self.assertEqual(child.stdout.readline().strip(), "ready")
                result = self.invoke(str(child.pid))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(
                    json.loads(result.stdout),
                    [{"pid": child.pid, "argv": arguments}],
                )
                self.assertNotIn("environment-only-secret", result.stdout)
            finally:
                child.terminate()
                child.wait(timeout=10)

    def test_missing_processes_have_explicit_unavailable_arguments(self) -> None:
        result = self.invoke("2147483647")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [{"pid": 2147483647, "argv": None}],
        )

    def test_invalid_utf8_does_not_return_partial_arguments(self) -> None:
        script = "printf 'ready\\n'; IFS= read -r value"
        with subprocess.Popen(
            ["/bin/sh", "-c", script, b"\xff", "--allow-all-tools"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ) as child:
            try:
                self.assertTrue(select.select([child.stdout], [], [], 15)[0])
                self.assertEqual(child.stdout.readline().strip(), "ready")
                result = self.invoke(str(child.pid))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(
                    json.loads(result.stdout),
                    [{"pid": child.pid, "argv": None}],
                )
            finally:
                child.terminate()
                child.wait(timeout=10)

    def test_request_is_bounded_and_rejects_invalid_process_ids(self) -> None:
        for arguments in [
            [], ["0"], ["-1"], ["invalid"], ["2147483648"], ["1"] * 17,
        ]:
            with self.subTest(arguments=arguments):
                result = self.invoke(*arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("invalid_process_ids", result.stderr)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
