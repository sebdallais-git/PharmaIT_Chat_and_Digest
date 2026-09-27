"""Render SearXNG settings: the repo's base file plus the Brave Search API key.

SearXNG reads engine API keys only from its settings file, never from the
environment, and the repo's copy must not hold a key. So scripts/setup-searxng.sh
runs this inside the container: it reads the base file, takes the key from
BRAVE_API_KEY (passed by name, so the value is never in an argv), fills the two
marked placeholder lines of the braveapi engine and writes the result mode 600.

Plain text substitution on marked lines rather than a YAML round-trip: it needs
only the standard library, and leaves every other line exactly as committed.

Usage: python3 render-searxng-settings.py <base.yml> <out.yml>
"""
import json
import os
import sys

KEY_MARK = "# placeholder: brave-api-key"
INACTIVE_MARK = "# placeholder: brave-api-inactive"


def render(base_text: str, key: str) -> str:
    lines = base_text.splitlines(keepends=True)
    for mark in (KEY_MARK, INACTIVE_MARK):
        if sum(mark in line for line in lines) != 1:
            raise ValueError(f"expected exactly one line with the placeholder {mark!r}")
    out = []
    for line in lines:
        indent = line[: len(line) - len(line.lstrip())]
        if KEY_MARK in line:
            # A JSON string is also a valid YAML double-quoted scalar
            line = f"{indent}api_key: {json.dumps(key)}\n"
        elif INACTIVE_MARK in line:
            line = f"{indent}inactive: false\n"
        out.append(line)
    return "".join(out)


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    base_path, out_path = sys.argv[1], sys.argv[2]
    with open(base_path, encoding="utf-8") as fh:
        text = fh.read()
    key = os.environ.get("BRAVE_API_KEY", "").strip()
    if key:
        try:
            text = render(text, key)
        except ValueError as err:
            print(f"render-searxng-settings: {err}", file=sys.stderr)
            return 1
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(out_path, 0o600)
    return 0


if __name__ == "__main__":
    sys.exit(main())
