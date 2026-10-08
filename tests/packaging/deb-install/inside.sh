#!/bin/bash
# Runs INSIDE a disposable ubuntu:24.04 container: install the .deb like an admin, start it as a
# normal user under Xvfb with the Chromium sandbox ON (no --no-sandbox), and report what ran.
set -u
export DEBIAN_FRONTEND=noninteractive
echo "== os: $(. /etc/os-release; echo $PRETTY_NAME)"
apt-get update -qq >/dev/null
apt-get install -y -qq xvfb xauth dbus-x11 gnome-keyring curl procps >/dev/null 2>&1
cp /pkg/app.deb /tmp/app.deb
echo "== install"
apt-get install -y /tmp/app.deb > /tmp/install.log 2>&1; echo "install exit=$?"
grep -iE "apparmor|Setting up pos" /tmp/install.log
dpkg -s pos-desktop | grep -E "^(Status|Version|Depends)"
install_dir=$(dirname "$(readlink -f /usr/bin/pos-desktop)")
echo "install dir: $install_dir"
ls -l "$install_dir/chrome-sandbox" /usr/bin/pos-desktop
echo "chrome-sandbox mode: $(stat -c %a "$install_dir/chrome-sandbox")"
echo "userns available: $(unshare --user true 2>/dev/null && echo yes || echo no)"
useradd -m cashier
echo "== start as cashier, sandbox ON"
su cashier -c 'dbus-run-session -- bash /pkg/as-cashier.sh'
echo "== done"
