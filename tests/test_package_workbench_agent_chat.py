#!/usr/bin/env python3
from pathlib import Path
import os
import subprocess
import tempfile


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    packager = root / "scripts/package-workbench-agent-chat.sh"
    with tempfile.TemporaryDirectory(prefix="workbench-agent-chat-package-") as raw:
        temp = Path(raw)
        source = temp / "source"
        destination = temp / "app/Contents/Resources/agent-chat"
        for directory in ("adapters", "node_modules/example", "public", "src", "test"):
            (source / directory).mkdir(parents=True)
        for filename in (
            "OuroWorkbenchMCP",
            "catalog.ts",
            "cmux-chat",
            "server.ts",
            "session-persistence.ts",
            "theme.ts",
            "types.ts",
            "workbench-mcp.ts",
        ):
            (source / filename).write_text(filename)
        (source / "adapters/acp.ts").write_text("adapter")
        (source / "node_modules/example/index.js").write_text("dependency")
        (source / "public/app.css").write_text("css")
        (source / "src/main.tsx").write_text("ui")
        (source / "test/should-not-ship.ts").write_text("test")
        os.chmod(source / "OuroWorkbenchMCP", 0o755)
        os.chmod(source / "cmux-chat", 0o755)

        result = subprocess.run(
            [
                str(packager),
                str(source),
                str(destination),
                "com.ourostack.workbench.v1.debug",
            ],
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            raise AssertionError(result.stderr or result.stdout)
        for relative in (
            "OuroWorkbenchMCP",
            "adapters/acp.ts",
            "cmux-chat",
            "node_modules/example/index.js",
            "public/app.css",
            "server.ts",
            "src/main.tsx",
            "workbench-mcp.ts",
        ):
            if not (destination / relative).exists():
                raise AssertionError(f"missing packaged runtime file: {relative}")
        if (destination / "test").exists():
            raise AssertionError("test sources must not ship in the app bundle")
        if not os.access(destination / "cmux-chat", os.X_OK):
            raise AssertionError("packaged launcher lost executable permission")


if __name__ == "__main__":
    main()
