BRAVE_BIN=$(which brave-browser 2>/dev/null || which brave 2>/dev/null)

if [ -z "$BRAVE_BIN" ]; then
    echo " Error: Brave browser not found in PATH."
    exit 1
fi

(
  sleep 1
  brave --remote-debugging-port=9222 \
    "http://localhost:3000/workspace" \
    "https://notebooklm.google.com/" > /dev/null 2>&1
) &

npx next dev
