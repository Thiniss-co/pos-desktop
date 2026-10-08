#!/usr/bin/env bash
# V1 packaged acceptance: install the .deb in a DISPOSABLE ubuntu:24.04 container as an administrator
# would (apt resolves its Depends), then start it as a normal user under Xvfb with the Chromium sandbox
# ON (never --no-sandbox) and report the renderer, the sandbox mode and each process's namespaces.
#
# Usage: tests/packaging/deb-install/run.sh dist/pos-desktop_<version>_amd64.deb [--cap-sys-admin]
#
# A default Docker container denies the namespaces Chromium's sandbox needs (its root has no
# CAP_SYS_ADMIN), so a sandboxed start aborts there. `--cap-sys-admin` grants that capability to the
# disposable container only, modelling what a real host gives the sandbox. It never changes the host's
# sandbox or AppArmor policy. The .deb's AppArmor-profile step (Ubuntu 24+ desktops) cannot run in a
# container: verify it on a real Ubuntu desktop (docs/audits/v1-production-readiness/README.md).
set -euo pipefail
deb=$(realpath "$1")
here=$(cd "$(dirname "$0")" && pwd)
caps=()
if [ "${2:-}" = "--cap-sys-admin" ]; then caps=(--cap-add SYS_ADMIN); fi
echo "package: $deb sha256 $(sha256sum "$deb" | cut -d' ' -f1)"
docker run --rm "${caps[@]}" --name "pos-deb-install-$$" \
  -v "$deb:/pkg/app.deb:ro" -v "$here/inside.sh:/pkg/inside.sh:ro" -v "$here/as-cashier.sh:/pkg/as-cashier.sh:ro" \
  ubuntu:24.04 bash /pkg/inside.sh
