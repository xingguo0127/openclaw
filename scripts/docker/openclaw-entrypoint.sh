#!/bin/sh
set -eu

# Browser-enabled variants bake a root-owned Playwright registry under /opt.
# Default variants keep the image ENV pointing at the writable, persisted home
# cache so the documented runtime install flow remains compatible.
if [ -x /usr/local/bin/flowos-qa-chromium ] && [ -d /opt/openclaw/ms-playwright ]; then
  export PLAYWRIGHT_BROWSERS_PATH=/opt/openclaw/ms-playwright
fi

exec "$@"
