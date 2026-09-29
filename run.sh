#!/bin/sh
cd "$(dirname "$0")/web" && python3 -m http.server 8000
