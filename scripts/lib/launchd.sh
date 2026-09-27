#!/usr/bin/env bash
# The PATH baked into every launchd job this project renders. Source this file;
# don't execute it.
#
# autostart.sh and hermes-setup.sh both render plists, and each used to spell
# the PATH out itself. When autostart.sh gained the Homebrew dirs (docker and
# colima live there, and without them the stack never found Docker at boot),
# hermes-setup.sh kept the old list, so running install-services quietly took
# them back out. One definition, used by both.

# launchd_path [node_bin]: the node binary's dir first when given, then Homebrew, then the system dirs
launchd_path() {
  local prefix=""
  if [ -n "${1:-}" ]; then prefix="$(dirname "$1"):"; fi
  printf '%s' "${prefix}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}
