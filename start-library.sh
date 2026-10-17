#!/bin/sh
cd "$(dirname "$0")/library" || exit 1
exec npm start
