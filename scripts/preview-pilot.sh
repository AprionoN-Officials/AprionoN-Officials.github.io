#!/usr/bin/env bash
set -euo pipefail

# Render 2.0 — Phase 6.1B Isolated Two-Image Static WebP Pilot
# Processes ONLY Robin/1.png (82.9 MP) and Ruby Hoshino/1.png (360.66 MP), sequentially.

export VIPS_CONCURRENCY="${VIPS_CONCURRENCY:-1}"
export VIPS_DISC_THRESHOLD="${VIPS_DISC_THRESHOLD:-100m}"

MIN_FREE_DISK_KB=$((4 * 1024 * 1024))      # 4 GiB
MAX_RSS_LIMIT_KB=$((8 * 1024 * 1024))      # 8 GiB
MAX_TMP_DELTA_KB=$((5 * 1024 * 1024))      # 5 GiB
MAX_INPUT_PIXELS=400000000                 # 400 MP ceiling
PER_IMAGE_TIMEOUT_SEC=180

OUT_DIR="$(pwd)/pilot-out"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/webp" "$OUT_DIR/logs"

WORK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/render2-pilot.XXXXXX")"
MON_PID=""

cleanup() {
  if [[ -n "$MON_PID" ]]; then
    kill "$MON_PID" 2>/dev/null || true
    wait "$MON_PID" 2>/dev/null || true
    MON_PID=""
  fi
  rm -rf "$WORK_TMP"
}
trap cleanup EXIT

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

check_disk_kb() {
  df -k --output=avail /tmp | tail -n 1 | tr -d ' '
}

used_disk_kb() {
  df -k --output=used /tmp | tail -n 1 | tr -d ' '
}

# 1. Inspect installed libvips version & validate vipsthumbnail flags before real conversion
VIPS_VERSION="$(vips --version)"
vipsthumbnail --help > "$OUT_DIR/logs/vipsthumbnail-help.txt" 2>&1 || true
log "Branch: $(git rev-parse --abbrev-ref HEAD) | HEAD: $(git rev-parse HEAD)"
log "libvips version: $VIPS_VERSION"
log "VIPS_CONCURRENCY=$VIPS_CONCURRENCY | VIPS_DISC_THRESHOLD=$VIPS_DISC_THRESHOLD"

COLOR_FLAGS=()
if grep -q -- '--eprofile' "$OUT_DIR/logs/vipsthumbnail-help.txt"; then
  COLOR_FLAGS+=(--eprofile srgb)
fi
if grep -q -- '--intent' "$OUT_DIR/logs/vipsthumbnail-help.txt"; then
  COLOR_FLAGS+=(--intent perceptual)
fi
log "Selected color flags (pre-smoke): ${COLOR_FLAGS[*]:-(none)}"

# Smoke-test flags against a synthetic 4x4 transparent RGBA PNG
python3 - "$WORK_TMP/smoke.png" <<'PYEOF'
import struct, sys, zlib
def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
w, h = 4, 4
ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
rows = b''
for y in range(h):
    # row filter byte 0 + 2 transparent pixels + 2 opaque sky-blue pixels
    rows += b'\x00' + (b'\x00\x00\x00\x00' * 2) + (b'\x02\x84\xc7\xff' * 2)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')
with open(sys.argv[1], 'wb') as f:
    f.write(png)
PYEOF

if ! vipsthumbnail "$WORK_TMP/smoke.png" --size "2x>" "${COLOR_FLAGS[@]}" -o "$WORK_TMP/smoke-stage.png[compression=1]" 2>"$OUT_DIR/logs/smoke.log"; then
  log "Smoke test with color flags failed; retrying without optional color flags"
  cat "$OUT_DIR/logs/smoke.log" || true
  COLOR_FLAGS=()
  vipsthumbnail "$WORK_TMP/smoke.png" --size "2x>" -o "$WORK_TMP/smoke-stage.png[compression=1]"
fi
vips copy "$WORK_TMP/smoke-stage.png" "$WORK_TMP/smoke.webp[Q=85,effort=4]"
SMOKE_BANDS="$(vipsheader -f bands "$WORK_TMP/smoke.webp")"
[[ "$SMOKE_BANDS" -eq 4 ]] || { log "ERROR: smoke WebP lost alpha (bands=$SMOKE_BANDS)"; exit 1; }
rm -f "$WORK_TMP/smoke.png" "$WORK_TMP/smoke-stage.png" "$WORK_TMP/smoke.webp"
log "Smoke test PASS: vipsthumbnail flags validated (${COLOR_FLAGS[*]:-default}), RGBA preserved (bands=4)."

# 2. Define the exact two pilot images and verify both Git blob OIDs BEFORE converting
declare -a PILOT_SPECS=(
  "robin-1|Render 2.0/Honkai Star Rail/Robin/1.png|6a72443012eb9be5958ce82d21602104320960c5|6000|13816"
  "ruby-hoshino-1|Render 2.0/Oshi No Ko!/Ruby Hoshino/1.png|84126d5f2420502257ce00ef35c2da52fe8da4fc|15819|22799"
)

for spec in "${PILOT_SPECS[@]}"; do
  IFS='|' read -r slug relpath expected_oid expected_w expected_h <<< "$spec"
  actual_oid="$(git ls-tree HEAD -- "$relpath" | awk '{print $3}')"
  if [[ "$actual_oid" != "$expected_oid" ]]; then
    log "ERROR: Blob OID mismatch for $relpath (expected $expected_oid, got ${actual_oid:-MISSING})"
    exit 1
  fi
  log "Verified source blob OID: $relpath -> $actual_oid"
done

METRICS_NDJSON="$WORK_TMP/results.ndjson"
: > "$METRICS_NDJSON"

# 3. Sequential single-image conversion loop (Robin first; immediate stop on failure)
for spec in "${PILOT_SPECS[@]}"; do
  IFS='|' read -r slug relpath expected_oid expected_w expected_h <<< "$spec"
  log "============================================================"
  log "Starting pilot image: $slug ($relpath)"

  free -m | tee "$OUT_DIR/logs/${slug}-mem-before.txt"
  FREE_BEFORE_KB="$(check_disk_kb)"
  USED_BEFORE_KB="$(used_disk_kb)"
  log "Disk /tmp free before: $((FREE_BEFORE_KB / 1024)) MiB"
  if (( FREE_BEFORE_KB < MIN_FREE_DISK_KB )); then
    log "ERROR: Free disk below 4 GiB minimum ($FREE_BEFORE_KB KB)"
    exit 1
  fi

  SRC_PNG="$WORK_TMP/${slug}-source.png"
  STAGE_PNG="$WORK_TMP/${slug}-stage-1600.png"
  TIME_LOG="$OUT_DIR/logs/${slug}-time.txt"
  PEAK_TMP_FILE="$WORK_TMP/${slug}-peak-tmp.txt"

  # Lazy single-blob retrieval (does not check out the ~2 GiB repository)
  git cat-file blob "$expected_oid" > "$SRC_PNG"
  SRC_BYTES="$(stat -c '%s' "$SRC_PNG")"
  log "Extracted single blob: $SRC_BYTES bytes"

  # Validate PNG signature + IHDR dimensions and pixel ceiling before invoking libvips
  python3 - "$SRC_PNG" "$expected_w" "$expected_h" "$MAX_INPUT_PIXELS" <<'PYEOF'
import struct, sys
p, exp_w, exp_h, max_px = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
with open(p, 'rb') as f:
    hdr = f.read(32)
if hdr[:8] != b'\x89PNG\r\n\x1a\n' or hdr[12:16] != b'IHDR':
    raise SystemExit('Invalid PNG signature or missing IHDR')
w, h = struct.unpack('>II', hdr[16:24])
bit_depth, color_type, interlace = hdr[24], hdr[25], hdr[28]
if w <= 0 or h <= 0:
    raise SystemExit(f'Invalid dimensions: {w}x{h}')
if w * h > max_px:
    raise SystemExit(f'Image exceeds pixel ceiling: {w}x{h} = {w*h} > {max_px}')
if w != exp_w or h != exp_h:
    raise SystemExit(f'Dimension mismatch: got {w}x{h}, expected {exp_w}x{exp_h}')
print(f'IHDR_OK w={w} h={h} pixels={w*h} bit_depth={bit_depth} color_type={color_type} interlace={interlace}')
PYEOF

  # Sample peak /tmp disk usage in background during decode
  echo "$USED_BEFORE_KB" > "$PEAK_TMP_FILE"
  (
    peak="$USED_BEFORE_KB"
    while true; do
      cur="$(df -k --output=used /tmp | tail -n 1 | tr -d ' ')"
      if [[ "$cur" =~ ^[0-9]+$ ]] && (( cur > peak )); then
        peak="$cur"
        echo "$peak" > "$PEAK_TMP_FILE"
      fi
      sleep 0.2
    done
  ) &
  MON_PID="$!"

  # Controlled single decode of original PNG -> lossless 1600px RGBA intermediate
  log "Running Pass 1 (Original PNG -> lossless 1600px intermediate)..."
  set +e
  /usr/bin/time -v -o "$TIME_LOG" \
    timeout --kill-after=10s "${PER_IMAGE_TIMEOUT_SEC}s" \
    vipsthumbnail "$SRC_PNG" \
      --size "1600x>" \
      "${COLOR_FLAGS[@]}" \
      -o "$STAGE_PNG[compression=1]" \
      > "$OUT_DIR/logs/${slug}-vips.log" 2>&1
  PASS1_RC=$?
  set -e

  kill "$MON_PID" 2>/dev/null || true
  wait "$MON_PID" 2>/dev/null || true
  MON_PID=""

  # Immediately remove extracted original PNG
  rm -f "$SRC_PNG"

  PEAK_USED_KB="$(cat "$PEAK_TMP_FILE" 2>/dev/null || echo "$USED_BEFORE_KB")"
  PEAK_TMP_DELTA_KB=$(( PEAK_USED_KB > USED_BEFORE_KB ? PEAK_USED_KB - USED_BEFORE_KB : 0 ))

  if (( PASS1_RC != 0 )); then
    log "ERROR: Pass 1 conversion failed for $slug (rc=$PASS1_RC)"
    cat "$OUT_DIR/logs/${slug}-vips.log" || true
    cat "$TIME_LOG" || true
    exit "$PASS1_RC"
  fi

  MAX_RSS_KB="$(awk -F': ' '/Maximum resident set size/ {print $2}' "$TIME_LOG" | tr -d ' ')"
  USER_SEC="$(awk -F': ' '/User time \(seconds\)/ {print $2}' "$TIME_LOG" | tr -d ' ')"
  SYS_SEC="$(awk -F': ' '/System time \(seconds\)/ {print $2}' "$TIME_LOG" | tr -d ' ')"
  ELAPSED_WALL="$(awk -F': ' '/Elapsed \(wall clock\) time/ {print $2}' "$TIME_LOG" | tr -d ' ')"
  log "Pass 1 metrics ($slug): MaxRSS=${MAX_RSS_KB} KB ($((MAX_RSS_KB / 1024)) MiB), peakTmpDelta=${PEAK_TMP_DELTA_KB} KB ($((PEAK_TMP_DELTA_KB / 1024)) MiB), elapsed=${ELAPSED_WALL}, user=${USER_SEC}s, sys=${SYS_SEC}s"

  # Enforce hard resource guardrails
  if (( MAX_RSS_KB > MAX_RSS_LIMIT_KB )); then
    log "ERROR: Peak RSS exceeded 8 GiB guardrail ($MAX_RSS_KB KB > $MAX_RSS_LIMIT_KB KB)"
    exit 1
  fi
  if (( PEAK_TMP_DELTA_KB > MAX_TMP_DELTA_KB )); then
    log "ERROR: Peak temp disk delta exceeded 5 GiB guardrail ($PEAK_TMP_DELTA_KB KB > $MAX_TMP_DELTA_KB KB)"
    exit 1
  fi

  # Pass 2: Encode 1600px, 800px, and 420px WebPs from lossless 1600px intermediate
  W1600="$OUT_DIR/webp/${slug}-1600.webp"
  W800="$OUT_DIR/webp/${slug}-800.webp"
  W420="$OUT_DIR/webp/${slug}-420.webp"

  vips copy "$STAGE_PNG" "${W1600}[Q=85,effort=4]"
  vipsthumbnail "$STAGE_PNG" --size "800x>" -o "${W800}[Q=78,effort=4]"
  vipsthumbnail "$STAGE_PNG" --size "420x>" -o "${W420}[Q=72,effort=4]"

  # Immediately remove lossless intermediate PNG
  rm -f "$STAGE_PNG"

  FREE_AFTER_KB="$(check_disk_kb)"
  log "Disk /tmp free after cleanup: $((FREE_AFTER_KB / 1024)) MiB"

  # Validate all 3 WebP outputs (RIFF/WEBP magic, dimensions, aspect ratio <= 1%, alpha min=0/max=255, size bounds)
  python3 - "$slug" "$relpath" "$expected_oid" "$expected_w" "$expected_h" "$SRC_BYTES" \
    "$MAX_RSS_KB" "$PEAK_TMP_DELTA_KB" "$USER_SEC" "$SYS_SEC" "$ELAPSED_WALL" \
    "$FREE_BEFORE_KB" "$FREE_AFTER_KB" "$W420" "$W800" "$W1600" "$METRICS_NDJSON" <<'PYEOF'
import json, os, subprocess, sys

(
    slug, relpath, oid, src_w, src_h, src_bytes,
    max_rss_kb, peak_tmp_kb, user_s, sys_s, elapsed,
    free_before_kb, free_after_kb, w420, w800, w1600, out_ndjson
) = sys.argv[1:]

src_w, src_h, src_bytes = int(src_w), int(src_h), int(src_bytes)
src_ratio = src_w / src_h

def vh(field, fpath):
    return subprocess.check_output(['vipsheader', '-f', field, fpath], text=True).strip()

def band_stat(op, fpath, band_idx):
    # Extract alpha band to inspect actual transparency values
    tmp_band = fpath + f'.b{band_idx}.v'
    try:
        subprocess.check_call(['vips', 'extract_band', fpath, tmp_band, str(band_idx)])
        return float(subprocess.check_output(['vips', op, tmp_band], text=True).strip())
    finally:
        if os.path.exists(tmp_band):
            os.remove(tmp_band)

tiers = [
    (420, w420, 250 * 1024),
    (800, w800, 600 * 1024),
    (1600, w1600, 1800 * 1024),
]

outputs = {}
prev_bytes = 0
for target_w, fpath, max_bytes in tiers:
    if not os.path.isfile(fpath):
        raise SystemExit(f'Missing output: {fpath}')
    fbytes = os.path.getsize(fpath)
    if fbytes <= 0 or fbytes > max_bytes:
        raise SystemExit(f'Output size out of bounds for {fpath}: {fbytes} bytes (max {max_bytes})')
    with open(fpath, 'rb') as f:
        magic = f.read(12)
    if magic[:4] != b'RIFF' or magic[8:12] != b'WEBP':
        raise SystemExit(f'Invalid RIFF/WEBP header in {fpath}')
    w = int(vh('width', fpath))
    h = int(vh('height', fpath))
    bands = int(vh('bands', fpath))
    interp = vh('interpretation', fpath)
    if w != target_w:
        raise SystemExit(f'Unexpected width for {fpath}: got {w}, expected {target_w}')
    ratio_err = abs((w / h) - src_ratio) / src_ratio
    if ratio_err > 0.01:
        raise SystemExit(f'Aspect ratio drift > 1% for {fpath}: {ratio_err:.4%}')
    if bands != 4:
        raise SystemExit(f'Alpha channel missing in {fpath}: bands={bands}')
    alpha_min = band_stat('min', fpath, 3)
    alpha_max = band_stat('max', fpath, 3)
    if alpha_min != 0.0 or alpha_max <= 0.0:
        raise SystemExit(f'Transparency check failed for {fpath}: alpha_min={alpha_min}, alpha_max={alpha_max}')
    if fbytes <= prev_bytes:
        raise SystemExit(f'Non-monotonic WebP size: {target_w}px ({fbytes} B) <= previous ({prev_bytes} B)')
    prev_bytes = fbytes
    outputs[str(target_w)] = {
        'file': os.path.basename(fpath),
        'bytes': fbytes,
        'kb': round(fbytes / 1024, 2),
        'width': w,
        'height': h,
        'bands': bands,
        'interpretation': interp,
        'aspectRatioErrorPct': round(ratio_err * 100, 4),
        'alphaMin': alpha_min,
        'alphaMax': alpha_max,
        'validRiffWebp': True,
    }

record = {
    'slug': slug,
    'path': relpath,
    'sourceBlob': oid,
    'sourceBytes': src_bytes,
    'sourceWidth': src_w,
    'sourceHeight': src_h,
    'sourceMegapixels': round((src_w * src_h) / 1e6, 2),
    'pass1': {
        'maxRssKb': int(max_rss_kb),
        'maxRssMiB': round(int(max_rss_kb) / 1024, 2),
        'peakTmpDeltaKb': int(peak_tmp_kb),
        'peakTmpDeltaMiB': round(int(peak_tmp_kb) / 1024, 2),
        'userSeconds': float(user_s),
        'sysSeconds': float(sys_s),
        'elapsedWall': elapsed,
    },
    'diskFreeBeforeMiB': round(int(free_before_kb) / 1024, 2),
    'diskFreeAfterMiB': round(int(free_after_kb) / 1024, 2),
    'outputs': outputs,
}
with open(out_ndjson, 'a', encoding='utf-8') as f:
    f.write(json.dumps(record) + '\n')
print(f'VALIDATED_OK {slug}:', json.dumps(outputs))
PYEOF

done

# 4. Verify ZERO original PNG files exist anywhere inside pilot-out/
PNG_LEAKS="$(find "$OUT_DIR" -type f -iname '*.png' | wc -l | tr -d ' ')"
if (( PNG_LEAKS != 0 )); then
  log "ERROR: Found $PNG_LEAKS PNG file(s) inside $OUT_DIR"
  exit 1
fi

# 5. Optional real browser decoding check if google-chrome is preinstalled on ubuntu-latest
CHROME_BIN="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
BROWSER_DECODE_JSON="$WORK_TMP/browser-decode.json"
if [[ -n "$CHROME_BIN" ]]; then
  log "Verifying WebP decoding in headless browser: $CHROME_BIN"
  python3 - "$OUT_DIR/webp" "$CHROME_BIN" "$BROWSER_DECODE_JSON" <<'PYEOF'
import base64, glob, json, os, subprocess, sys, tempfile

webp_dir, chrome_bin, out_json = sys.argv[1:4]
files = sorted(glob.glob(os.path.join(webp_dir, '*.webp')))
tags = []
for f in files:
    b64 = base64.b64encode(open(f, 'rb').read()).decode('ascii')
    name = os.path.basename(f)
    tags.append(f'<img data-name="{name}" src="data:image/webp;base64,{b64}">')

html = f"""<!doctype html><html><body>{''.join(tags)}<pre id="out"></pre><script>
window.addEventListener('load', () => {{
  const res = [...document.querySelectorAll('img')].map(i => ({{
    file: i.dataset.name,
    complete: i.complete,
    naturalWidth: i.naturalWidth,
    naturalHeight: i.naturalHeight,
    decoded: Boolean(i.complete && i.naturalWidth > 0 && i.naturalHeight > 0)
  }}));
  document.getElementById('out').textContent = JSON.stringify(res);
}});
</script></body></html>"""

with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False, encoding='utf-8') as tf:
    tf.write(html)
    html_path = tf.name
try:
    dom = subprocess.check_output(
        [chrome_bin, '--headless=new', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=5000', '--dump-dom', 'file://' + html_path],
        text=True, stderr=subprocess.DEVNULL, timeout=30
    )
    start = dom.find('<pre id="out">') + len('<pre id="out">')
    end = dom.find('</pre>', start)
    parsed = json.loads(dom[start:end])
    if len(parsed) != 6 or not all(x['decoded'] for x in parsed):
        raise SystemExit(f'Browser decode check failed: {parsed}')
    open(out_json, 'w', encoding='utf-8').write(json.dumps({'browser': chrome_bin, 'allDecoded': True, 'images': parsed}, indent=2))
    print('BROWSER_DECODE_OK:', len(parsed), 'WebP images decoded in', chrome_bin)
finally:
    if os.path.exists(html_path):
        os.remove(html_path)
PYEOF
else
  echo '{"browser": null, "allDecoded": null, "note": "No headless browser binary preinstalled"}' > "$BROWSER_DECODE_JSON"
fi

# 6. Assemble final pilot-metrics.json and write GitHub Step Summary
python3 - "$METRICS_NDJSON" "$BROWSER_DECODE_JSON" "$OUT_DIR/pilot-metrics.json" "$VIPS_VERSION" "${COLOR_FLAGS[*]:-none}" <<'PYEOF'
import json, os, subprocess, sys

ndjson_path, browser_path, out_path, vips_ver, color_flags = sys.argv[1:6]
images = [json.loads(line) for line in open(ndjson_path, encoding='utf-8') if line.strip()]
browser_decode = json.load(open(browser_path, encoding='utf-8'))

report = {
    'branch': subprocess.check_output(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], text=True).strip(),
    'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'vipsVersion': vips_ver,
    'vipsConcurrency': os.environ.get('VIPS_CONCURRENCY'),
    'vipsDiscThreshold': os.environ.get('VIPS_DISC_THRESHOLD'),
    'colorFlags': color_flags,
    'pngLeaksInOutput': 0,
    'images': images,
    'browserDecode': browser_decode,
}
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(report, f, indent=2)
print('=== FINAL PILOT METRICS JSON ===')
print(json.dumps(report, indent=2))

summary_file = os.environ.get('GITHUB_STEP_SUMMARY')
if summary_file:
    lines = [
        '## Render 2.0 — Phase 6.1B Two-Image Pilot Metrics',
        f"- **libvips**: `{vips_ver}` (`VIPS_CONCURRENCY={report['vipsConcurrency']}`, `VIPS_DISC_THRESHOLD={report['vipsDiscThreshold']}`)",
        f"- **Color flags**: `{color_flags}`",
        '',
        '| Image | Source | MaxRSS | Peak /tmp Delta | Elapsed | 420px WebP | 800px WebP | 1600px WebP |',
        '|---|---|---|---|---|---|---|---|',
    ]
    for im in images:
        p1 = im['pass1']
        o = im['outputs']
        lines.append(
            f"| `{im['slug']}` | `{im['sourceWidth']}×{im['sourceHeight']}` ({im['sourceMegapixels']} MP) | "
            f"`{p1['maxRssMiB']} MiB` | `{p1['peakTmpDeltaMiB']} MiB` | `{p1['elapsedWall']}` | "
            f"`{o['420']['width']}×{o['420']['height']}` ({o['420']['kb']} KB) | "
            f"`{o['800']['width']}×{o['800']['height']}` ({o['800']['kb']} KB) | "
            f"`{o['1600']['width']}×{o['1600']['height']}` ({o['1600']['kb']} KB) |"
        )
    with open(summary_file, 'a', encoding='utf-8') as sf:
        sf.write('\n'.join(lines) + '\n')
PYEOF

log "PILOT COMPLETED SUCCESSFULLY"
