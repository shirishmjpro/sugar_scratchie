#!/usr/bin/env bash
set -euo pipefail

VENV_PATH="${1:-.venv311}"
PYTHON_BIN="${PYTHON_BIN:-/opt/homebrew/bin/python3.11}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Python 3.11 not found at $PYTHON_BIN"
  echo "Set PYTHON_BIN=/path/to/python3.11 and rerun."
  exit 1
fi

if [[ ! -d "$VENV_PATH" ]]; then
  "$PYTHON_BIN" -m venv "$VENV_PATH"
fi

"$VENV_PATH/bin/pip" install \
  'torch>=2.12.0' \
  torchvision \
  opencv-python \
  'numpy>=2.0.0' \
  'Pillow>=10.0.0' \
  'mmengine>=0.4.0,<1.0.0' \
  'mmcv-lite>=2.0.0rc4,<2.2.0' \
  'mmdet>=3.0.0,<3.3.0' \
  pycocotools \
  json_tricks \
  matplotlib \
  addict \
  termcolor \
  yapf \
  shapely \
  terminaltables \
  six \
  munkres \
  platformdirs \
  contourpy \
  cycler \
  fonttools \
  kiwisolver \
  pyparsing \
  python-dateutil

"$VENV_PATH/bin/pip" install --no-deps mmpose==1.3.2

echo
echo "Installed AI mesh dependencies into $VENV_PATH"
echo "Run with:"
echo "  $VENV_PATH/bin/python scripts/generate-ai-mesh-keyframes.py"
