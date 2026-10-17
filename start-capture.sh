#!/bin/sh
set -eu
cd "$(dirname "$0")/capture"
exec npm run dev
