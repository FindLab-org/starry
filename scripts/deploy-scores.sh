#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCORES_DIR="$ROOT/assets/scores"
IMAGES_DIR="$SCORES_DIR/images"

if ! command -v unzip >/dev/null 2>&1; then
  echo "unzip is required to unpack score assets." >&2
  exit 1
fi

shopt -s nullglob
zips=("$SCORES_DIR"/*.zip)

if (( ${#zips[@]} == 0 )); then
  echo "No score zip files found in $SCORES_DIR."
  exit 0
fi

mkdir -p "$IMAGES_DIR"

for zip_path in "${zips[@]}"; do
  base=$(basename "$zip_path")
  score_name=${base%.zip}
  score_name=${score_name%.livescore}
  json_path="$SCORES_DIR/$score_name.livescore.json"
  tmp_dir=$(mktemp -d)

  echo "Unpacking $base"
  unzip -q -o "$zip_path" -d "$tmp_dir"

  if [[ ! -f "$tmp_dir/index.json" ]]; then
    echo "Skipping $base: index.json not found." >&2
    rm -rf "$tmp_dir"
    continue
  fi

  find "$tmp_dir/assets" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.gif' \) -exec cp -f {} "$IMAGES_DIR/" \; 2>/dev/null || true

  python3 - "$tmp_dir/index.json" "$json_path" <<'PY'
import json
import sys
from pathlib import Path

source = Path(sys.argv[1])
target = Path(sys.argv[2])
data = json.loads(source.read_text())

def rewrite_url(value):
    if isinstance(value, str) and value.startswith('assets/'):
        return 'assets/scores/images/' + value.rsplit('/', 1)[-1]
    return value

for page in data.get('pages', []):
    source_obj = page.get('source')
    if isinstance(source_obj, dict):
        source_obj['url'] = rewrite_url(source_obj.get('url'))
    for system in page.get('systems', []):
        for staff in system.get('staves', []):
            image = staff.get('image')
            if isinstance(image, dict):
                image['url'] = rewrite_url(image.get('url'))

target.write_text(json.dumps(data, separators=(',', ':')))
PY

  echo "Wrote ${json_path#$ROOT/}"
  rm -rf "$tmp_dir"
done

python3 - "$SCORES_DIR/manifest.json" "$SCORES_DIR" <<'PYMANIFEST'
import json
import sys
from pathlib import Path

target = Path(sys.argv[1])
scores_dir = Path(sys.argv[2])
files = sorted(path.name for path in scores_dir.glob('*.livescore.json'))
target.write_text(json.dumps(files, separators=(',', ':')))
PYMANIFEST

echo "Wrote ${SCORES_DIR#$ROOT/}/manifest.json"
