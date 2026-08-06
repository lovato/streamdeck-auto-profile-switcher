#!/bin/sh
# Shared helper for tracked git hooks in this repo.
set -e

task_name="$1"
if [ -z "$task_name" ]; then
  echo "git hook: missing task name" >&2
  exit 1
fi

root="$(git rev-parse --show-toplevel)"
cd "$root"

if ! command -v task >/dev/null 2>&1; then
  echo "git hook: 'task' not found in PATH (run: task hooks:install after installing go-task)" >&2
  exit 1
fi

exec task "$task_name"
