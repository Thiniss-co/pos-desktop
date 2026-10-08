#!/bin/bash
# Started by inside.sh as the unprivileged `cashier` user inside the container.
set -u
cd ~
echo secret | gnome-keyring-daemon --unlock --components=secrets --daemonize >/dev/null
xvfb-run -a -s "-screen 0 1366x850x24" /usr/bin/pos-desktop --remote-debugging-port=9333 --password-store=gnome-libsecret > /tmp/app.log 2>&1 &
for i in $(seq 1 60); do
  curl -s localhost:9333/json/list > /tmp/targets.json 2>/dev/null && grep -q 'renderer/index.html' /tmp/targets.json && break
  sleep 1
done
echo "renderer page loaded: $(grep -c 'renderer/index.html' /tmp/targets.json 2>/dev/null)"
grep -o '"title": "[^"]*"' /tmp/targets.json | head -3
sleep 2
APP=$(ps -eo pid=,comm= | awk '$2=="pos-desktop"{print $1}')
echo "app processes: $(echo $APP | wc -w)"
for pid in $APP; do
  args=$(tr '\0' ' ' < /proc/$pid/cmdline)
  type=$(echo "$args" | grep -o -- '--type=[a-z-]*' || echo '--type=browser')
  echo "$pid $type no-sandbox=$(echo "$args" | grep -c -- '--no-sandbox') userns=$(readlink /proc/$pid/ns/user 2>/dev/null || echo hidden) pidns=$(readlink /proc/$pid/ns/pid 2>/dev/null || echo hidden)"
done
echo "-- app log (FATAL/sandbox lines):"
grep -iE "FATAL|sandbox" /tmp/app.log | head -5
echo "-- app log head:"
head -8 /tmp/app.log
echo "browser userns: $(readlink /proc/self/ns/user)  (this shell; a sandboxed child shows a different value or hidden)"
kill $APP 2>/dev/null
