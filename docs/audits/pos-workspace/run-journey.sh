#!/bin/sh
# Runs workspace journeys against the detached backend worktree on the nested Xephyr display :97
# (2000x1200, no window manager, so the renderer viewport can be sized exactly).
cd /var/www/html/thinis-pos/pos-desktop-pos-workspace || exit 1
DISPLAY=:97 XAUTHORITY= \
PW_BACKEND_ROOT=/var/www/html/thinis-pos/pos-backend-pos-workspace \
PW_EVIDENCE_ROOT=/var/www/html/thinis-pos/pos-desktop-pos-workspace/docs/audits/pos-workspace \
POS_SANDBOX_GUARD_HTTP=1 exec node tests/playwright/run.mjs "$@"
