#!/usr/bin/env python3
"""Regression coverage for Ghostty helper paths in embedded app bundles.

The terminal host owns the exact CLI executable path. Shell integration must
repair stale directory metadata from that path and invoke the helper directly.
"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
ZSH_INTEGRATION = ROOT / "ghostty/src/shell-integration/zsh/ghostty-integration"
BASH_INTEGRATION = ROOT / "ghostty/src/shell-integration/bash/ghostty.bash"
CMUX_ZSH_INTEGRATION = ROOT / "Resources/shell-integration/cmux-zsh-integration.zsh"
CMUX_BASH_INTEGRATION = ROOT / "Resources/shell-integration/cmux-bash-integration.bash"
FISH_INTEGRATION = (
    ROOT
    / "ghostty/src/shell-integration/fish/vendor_conf.d/ghostty-shell-integration.fish"
)


def _run_wrapper(
    shell: str,
    integration: Path,
    helper: Path,
    log: Path,
    features: str,
    expected_arguments: list[str],
) -> None:
    env = os.environ.copy()
    env.update(
        {
            "GHOSTTY_BIN": str(helper),
            # Reproduce cmux's GUI executable directory. No `ghostty` binary
            # exists here because cmux embeds GhosttyKit in its own executable.
            "GHOSTTY_BIN_DIR": str(helper.parents[2] / "MacOS"),
            "GHOSTTY_SHELL_FEATURES": features,
            "GHOSTTY_TEST_LOG": str(log),
        }
    )

    if shell == "zsh":
        command = [
            "zsh",
            "-dfc",
            (
                "typeset -gi _ghostty_fd=1; "
                'source "$1"; '
                "_ghostty_deferred_init; "
                "ssh user@example.com"
            ),
            "zsh",
            str(integration),
        ]
    elif shell == "bash":
        command = [
            "bash",
            "--noprofile",
            "--norc",
            "-ic",
            'source "$1"; ssh user@example.com',
            "bash",
            str(integration),
        ]
    else:
        command = [
            "fish",
            "--no-config",
            "--interactive",
            "--command",
            (
                'source "$argv[1]"; '
                "emit fish_prompt >/dev/null; "
                "functions -q ssh; or begin; "
                'echo "fish SSH wrapper was not installed" >&2; '
                "exit 97; "
                "end; "
                "ssh user@example.com"
            ),
            str(integration),
        ]

    result = subprocess.run(command, env=env, text=True, capture_output=True)
    if result.returncode != 0:
        raise AssertionError(
            f"{shell} SSH wrapper failed with exit {result.returncode}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )

    actual = log.read_text().splitlines() if log.exists() else []
    if actual != expected_arguments:
        raise AssertionError(
            f"{shell} SSH wrapper invoked the wrong executable or arguments: "
            f"expected {expected_arguments!r}, got {actual!r}"
        )


def _run_path_repair(shell: str, integration: Path, helper: Path, tmp: Path) -> None:
    stale_dir = tmp / f"{shell}-stale-bin"
    env = os.environ.copy()
    env.update(
        {
            "GHOSTTY_BIN": str(helper),
            "GHOSTTY_BIN_DIR": str(stale_dir),
            "PATH": f"/usr/bin:/bin:{stale_dir}",
        }
    )
    if shell == "zsh":
        command = [
            "zsh",
            "-dfc",
            'source "$1"; _cmux_fix_path; print -r -- "$GHOSTTY_BIN_DIR"; print -r -- "$PATH"',
            "zsh",
            str(integration),
        ]
    else:
        command = [
            "bash",
            "--noprofile",
            "--norc",
            "-c",
            'source "$1"; _cmux_fix_path; printf "%s\\n%s\\n" "$GHOSTTY_BIN_DIR" "$PATH"',
            "bash",
            str(integration),
        ]
    result = subprocess.run(command, env=env, text=True, capture_output=True)
    if result.returncode != 0:
        raise AssertionError(f"{shell} path repair failed: {result.stderr}")
    actual_dir, actual_path = result.stdout.strip().splitlines()[-2:]
    expected_dir = str(helper.parent)
    path_entries = actual_path.split(":")
    if (
        actual_dir != expected_dir
        or expected_dir not in path_entries
        or str(stale_dir) in path_entries
        or path_entries.index(expected_dir) > path_entries.index("/usr/bin")
    ):
        raise AssertionError(
            f"{shell} path repair retained stale Ghostty state: "
            f"dir={actual_dir!r} path={actual_path!r}"
        )


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="cmux-issue-8093-") as raw_tmp:
        tmp = Path(raw_tmp)
        contents = tmp / "cmux.app/Contents"
        helper = contents / "Resources/bin/cmux-ghostty-cli"
        helper.parent.mkdir(parents=True)
        (contents / "MacOS").mkdir(parents=True)
        helper.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$GHOSTTY_TEST_LOG"\n')
        helper.chmod(0o755)

        for shell, integration in (
            ("zsh", CMUX_ZSH_INTEGRATION),
            ("bash", CMUX_BASH_INTEGRATION),
        ):
            _run_path_repair(shell, integration, helper, tmp)

        for shell, integration in (
            ("zsh", ZSH_INTEGRATION),
            ("bash", BASH_INTEGRATION),
        ):
            log = tmp / f"{shell}-argv.log"
            _run_wrapper(
                shell,
                integration,
                helper,
                log,
                "ssh-env,ssh-terminfo",
                ["+ssh", "--", "user@example.com"],
            )

        if shutil.which("fish") is None:
            print("SKIP: fish is not installed; fish SSH wrappers were not exercised")
        else:
            for features, expected_flags in (
                ("ssh-env", ["--terminfo=false"]),
                ("ssh-terminfo", ["--forward-env=false"]),
                ("ssh-env,ssh-terminfo", []),
            ):
                log = tmp / f"fish-{features}.log"
                _run_wrapper(
                    "fish",
                    FISH_INTEGRATION,
                    helper,
                    log,
                    features,
                    ["+ssh", *expected_flags, "--", "user@example.com"],
                )

    print("PASS: Ghostty SSH wrappers invoke the host-provided executable path")


if __name__ == "__main__":
    main()
