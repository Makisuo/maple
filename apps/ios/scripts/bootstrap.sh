#!/usr/bin/env bash
# Generate Maple.xcodeproj from project.yml and open it.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v xcodegen >/dev/null 2>&1; then
	echo "xcodegen is required: brew install xcodegen" >&2
	exit 1
fi

if [[ ! -f Config/Secrets.xcconfig ]]; then
	cp Config/Secrets.example.xcconfig Config/Secrets.xcconfig
	echo "Created Config/Secrets.xcconfig — add your Clerk publishable key before running."
fi

xcodegen generate
echo "Generated Maple.xcodeproj"
[[ "${1:-}" == "--no-open" ]] || open Maple.xcodeproj
