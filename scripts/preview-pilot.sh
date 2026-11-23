#!/usr/bin/env bash
set -euo pipefail

# Render 2.0 — Phase 6.1C Full 24-Image Oversized PNG Static WebP Batch (Artifact-Only)
# Processes exactly the 24 audited >71 MP PNGs strictly sequentially with memory/disk/time guardrails.

export VIPS_CONCURRENCY="${VIPS_CONCURRENCY:-1}"
export VIPS_DISC_THRESHOLD="${VIPS_DISC_THRESHOLD:-100m}"

MIN_FREE_DISK_KB=$((4 * 1024 * 1024))      # 4 GiB
MAX_RSS_LIMIT_KB=$((8 * 1024 * 1024))      # 8 GiB
MAX_TMP_DELTA_KB=$((5 * 1024 * 1024))      # 5 GiB
MAX_INPUT_PIXELS=400000000                 # 400 MP ceiling
PER_IMAGE_TIMEOUT_SEC=180
EXPECTED_BATCH_COUNT=24

BATCH_START_EPOCH="$(date +%s)"
OUT_DIR="$(pwd)/batch-out"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/webp/420" "$OUT_DIR/webp/800" "$OUT_DIR/webp/1600" "$OUT_DIR/logs"

WORK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/render2-batch.XXXXXX")"
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
if grep -q -- '--output-profile' "$OUT_DIR/logs/vipsthumbnail-help.txt"; then
  COLOR_FLAGS+=(--output-profile srgb)
elif grep -q -- '--eprofile' "$OUT_DIR/logs/vipsthumbnail-help.txt"; then
  COLOR_FLAGS+=(--eprofile srgb)
fi
if grep -q -- '--intent' "$OUT_DIR/logs/vipsthumbnail-help.txt"; then
  COLOR_FLAGS+=(--intent perceptual)
fi
log "Candidate color flags (pre-smoke): ${COLOR_FLAGS[*]:-(none)}"

# Smoke-test flags against a synthetic 4x4 transparent RGBA PNG
python3 - "$WORK_TMP/smoke.png" <<'PYEOF'
import struct, sys, zlib
def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
w, h = 4, 4
ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
rows = b''
for _ in range(h):
    rows += b'\x00' + (b'\x00\x00\x00\x00' * 2) + (b'\x02\x84\xc7\xff' * 2)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')
with open(sys.argv[1], 'wb') as f:
    f.write(png)
PYEOF

if ! vipsthumbnail "$WORK_TMP/smoke.png" --size "2x>" "${COLOR_FLAGS[@]}" -o "$WORK_TMP/smoke-stage.png[compression=1]" 2>"$OUT_DIR/logs/smoke.log"; then
  log "Smoke test with (${COLOR_FLAGS[*]}) failed; trying --intent perceptual only"
  cat "$OUT_DIR/logs/smoke.log" || true
  COLOR_FLAGS=()
  if grep -q -- '--intent' "$OUT_DIR/logs/vipsthumbnail-help.txt"; then
    COLOR_FLAGS+=(--intent perceptual)
  fi
  if ! vipsthumbnail "$WORK_TMP/smoke.png" --size "2x>" "${COLOR_FLAGS[@]}" -o "$WORK_TMP/smoke-stage.png[compression=1]" 2>>"$OUT_DIR/logs/smoke.log"; then
    log "ERROR: Unsupported vipsthumbnail flags"
    cat "$OUT_DIR/logs/smoke.log" || true
    exit 1
  fi
fi
vips copy "$WORK_TMP/smoke-stage.png" "$WORK_TMP/smoke.webp[Q=85,effort=4]"
SMOKE_BANDS="$(vipsheader -f bands "$WORK_TMP/smoke.webp")"
[[ "$SMOKE_BANDS" -eq 4 ]] || { log "ERROR: smoke WebP lost alpha (bands=$SMOKE_BANDS)"; exit 1; }
rm -f "$WORK_TMP/smoke.png" "$WORK_TMP/smoke-stage.png" "$WORK_TMP/smoke.webp"
log "Smoke test PASS: active flags=(${COLOR_FLAGS[*]:-default}), RGBA preserved (bands=4)."

# 2. Exact 24 audited oversized (>71 MP) source PNGs from Phase 6.1 audit
declare -a BATCH_SPECS=(
  "mikasa-ackerman-2-6d1bf987|Render 2.0/Attack On Titan/Mikasa Ackerman/2.png|6d1bf987f3e738c759245da34c67abbf06cda52a|8039|11369"
  "ayase-momo-1-48cab6f1|Render 2.0/Dandadan/Ayase Momo/1.png|48cab6f11e58555b7f9fad61b42097127d8795fd|9920|14032"
  "rider-medusa-1-88d28cf8|Render 2.0/Fate Series/Rider (Medusa)/1.png|88d28cf84542c147f4bd30e1dc9a45407f696669|8124|9112"
  "arlecchino-1-98215910|Render 2.0/Genshin Impact/Arlecchino/1.png|982159107a48564702ab8ebfdffeb1d83f87adde|10290|9030"
  "arlecchino-3-88b0d0a6|Render 2.0/Genshin Impact/Arlecchino/3.png|88b0d0a6d131499e7fd84dc91903c9089cf3c4a5|8600|12140"
  "chlorinde-1-ee710bfa|Render 2.0/Genshin Impact/Chlorinde/1.png|ee710bfaa4baf221d97c8a0941b8a02befc2278b|12612|18000"
  "eula-lawrence-1-f56de1a3|Render 2.0/Genshin Impact/Eula Lawrence/1.png|f56de1a3638427a019c9dcac91baf95ffa6a5876|8533|17067"
  "furina-1-f0425bbc|Render 2.0/Genshin Impact/Furina/1.png|f0425bbce276362322ae56a1fcdd92f8a432f026|16000|8800"
  "traveler-1-2-de48796d|Render 2.0/Genshin Impact/Traveler/1,2.png|de48796d38b338c35934c40caf004370afdb181a|13696|6948"
  "traveler-1-44f6bd19|Render 2.0/Genshin Impact/Traveler/1.png|44f6bd19a444e552eff4216d65b1f86071d6c8c7|9328|14064"
  "firefly-1-bacff0e6|Render 2.0/Honkai Star Rail/FireFly/1.png|bacff0e66f3470542b69e017985142152e995cd0|10800|14028"
  "kafka-1-1-1-23ac67bc|Render 2.0/Honkai Star Rail/Kafka/1.1(1).png|23ac67bcd4a341ffc11ea81a25e4b9baa69f6dc5|10878|16372"
  "robin-1-6a724430|Render 2.0/Honkai Star Rail/Robin/1.png|6a72443012eb9be5958ce82d21602104320960c5|6000|13816"
  "stelle-1-3681a852|Render 2.0/Honkai Star Rail/Stelle/1.png|3681a852eeccbd8325db8f8f7ebb7c957ea31ff0|9920|14032"
  "hiiragi-utena-1-5164157a|Render 2.0/Mahou Shoujo ni Akogarete/Hiiragi Utena/1.png|5164157ae4383bfc4128042f926cfb3d4dc124fc|11200|11200"
  "yorha-no-2-type-b-2b-5-4c8c7268|Render 2.0/Nier Automata/Yorha No.2 Type B (2B)/5.png|4c8c7268730de55a61784e92d7aaf4144c1c2961|9167|13333"
  "yorha-no-2-type-b-2b-6-91823206|Render 2.0/Nier Automata/Yorha No.2 Type B (2B)/6.png|9182320669d523ddb126182e52b0bbbc55418cfe|7467|11200"
  "snow-white-2-0a068128|Render 2.0/NIKKE Goddess Of Victory/Snow White/2.png|0a068128453211b5646e91345a216304b1c2551b|8192|12288"
  "ruby-hoshino-1-84126d5f|Render 2.0/Oshi No Ko!/Ruby Hoshino/1.png|84126d5f2420502257ce00ef35c2da52fe8da4fc|15819|22799"
  "fern-1-6e5994aa|Render 2.0/Sousou No Frieren/Fern/1.png|6e5994aa8cd612ec7e73056ab5a7b224a81ba927|11576|16372"
  "ellen-joe-1-538f5300|Render 2.0/Zenless Zone Zero/Ellen Joe/1.png|538f5300e1b54f62191a1ab0d7e618542a66fd3b|16116|9068"
  "koleda-belobog-1-d328b122|Render 2.0/Zenless Zone Zero/Koleda Belobog/1.png|d328b12244aaf090458e107af03fd326cf034a57|17368|10416"
  "miyabi-hoshimi-1-b03f16ed|Render 2.0/Zenless Zone Zero/Miyabi Hoshimi/1.png|b03f16ed2559491e108d292bf9ff615e6f5263ba|14276|18000"
  "nico-demara-1-8e59ec0c|Render 2.0/Zenless Zone Zero/Nico Demara/1.png|8e59ec0cba7bc2bc4926310e13c1da3f9c88b387|8268|13476"
)

if (( ${#BATCH_SPECS[@]} != EXPECTED_BATCH_COUNT )); then
  log "ERROR: Expected $EXPECTED_BATCH_COUNT batch items, found ${#BATCH_SPECS[@]}"
  exit 1
fi

# Verify ALL 24 source blob OIDs against HEAD before converting any image
for spec in "${BATCH_SPECS[@]}"; do
  IFS='|' read -r slug relpath expected_oid expected_w expected_h <<< "$spec"
  actual_oid="$(git ls-tree HEAD -- "$relpath" | awk '{print $3}')"
  if [[ "$actual_oid" != "$expected_oid" ]]; then
    log "ERROR: Blob OID mismatch for $relpath (expected $expected_oid, got ${actual_oid:-MISSING})"
    exit 1
  fi
done
log "Verified all 24 source blob OIDs against HEAD."

METRICS_NDJSON="$WORK_TMP/results.ndjson"
: > "$METRICS_NDJSON"
ATTEMPTED=0
SUCCEEDED=0

# 3. Strictly sequential single-image conversion loop (stop immediately on any failure)
for spec in "${BATCH_SPECS[@]}"; do
  IFS='|' read -r slug relpath expected_oid expected_w expected_h <<< "$spec"
  ATTEMPTED=$((ATTEMPTED + 1))
  log "[$ATTEMPTED/$EXPECTED_BATCH_COUNT] Processing $slug ($relpath)"

  free -m > "$OUT_DIR/logs/${slug}-mem-before.txt"
  FREE_BEFORE_KB="$(check_disk_kb)"
  USED_BEFORE_KB="$(used_disk_kb)"
  if (( FREE_BEFORE_KB < MIN_FREE_DISK_KB )); then
    log "ERROR: Free disk below 4 GiB minimum before $slug ($FREE_BEFORE_KB KB)"
    exit 1
  fi

  SRC_PNG="$WORK_TMP/${slug}-source.png"
  STAGE_PNG="$WORK_TMP/${slug}-stage-1600.png"
  TIME_LOG="$OUT_DIR/logs/${slug}-time.txt"
  PEAK_TMP_FILE="$WORK_TMP/${slug}-peak-tmp.txt"

  git cat-file blob "$expected_oid" > "$SRC_PNG"
  SRC_BYTES="$(stat -c '%s' "$SRC_PNG")"

  python3 - "$SRC_PNG" "$expected_w" "$expected_h" "$MAX_INPUT_PIXELS" <<'PYEOF'
import struct, sys
p, exp_w, exp_h, max_px = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
with open(p, 'rb') as f:
    hdr = f.read(32)
if hdr[:8] != b'\x89PNG\r\n\x1a\n' or hdr[12:16] != b'IHDR':
    raise SystemExit('Invalid PNG signature or missing IHDR')
w, h = struct.unpack('>II', hdr[16:24])
if w <= 0 or h <= 0 or w * h > max_px:
    raise SystemExit(f'Invalid dimensions or exceeds pixel ceiling: {w}x{h} ({w*h})')
if w != exp_w or h != exp_h:
    raise SystemExit(f'Dimension mismatch: got {w}x{h}, expected {exp_w}x{exp_h}')
PYEOF

  # Monitor peak /tmp disk usage during Pass 1
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

  if (( MAX_RSS_KB > MAX_RSS_LIMIT_KB )); then
    log "ERROR: Peak RSS exceeded 8 GiB guardrail for $slug ($MAX_RSS_KB KB)"
    exit 1
  fi
  if (( PEAK_TMP_DELTA_KB > MAX_TMP_DELTA_KB )); then
    log "ERROR: Peak temp disk delta exceeded 5 GiB guardrail for $slug ($PEAK_TMP_DELTA_KB KB)"
    exit 1
  fi

  W1600="$OUT_DIR/webp/1600/${slug}.webp"
  W800="$OUT_DIR/webp/800/${slug}.webp"
  W420="$OUT_DIR/webp/420/${slug}.webp"

  vips copy "$STAGE_PNG" "${W1600}[Q=85,effort=4]"
  vipsthumbnail "$STAGE_PNG" --size "800x>" -o "${W800}[Q=78,effort=4]"
  vipsthumbnail "$STAGE_PNG" --size "420x>" -o "${W420}[Q=72,effort=4]"

  rm -f "$STAGE_PNG"
  FREE_AFTER_KB="$(check_disk_kb)"

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
    tmp_band = fpath + f'.b{band_idx}.v'
    try:
        subprocess.check_call(['vips', 'extract_band', fpath, tmp_band, str(band_idx)])
        return float(subprocess.check_output(['vips', op, tmp_band], text=True).strip())
    finally:
        if os.path.exists(tmp_band):
            os.remove(tmp_band)

tiers = [
    (420, w420, f'webp/420/{slug}.webp', 350 * 1024),
    (800, w800, f'webp/800/{slug}.webp', 900 * 1024),
    (1600, w1600, f'webp/1600/{slug}.webp', 2500 * 1024),
]

outputs = {}
notes = []
prev_bytes = 0
for target_w, fpath, rel_out, max_bytes in tiers:
    if not os.path.isfile(fpath):
        raise SystemExit(f'Missing output: {fpath}')
    fbytes = os.path.getsize(fpath)
    if fbytes <= 0 or fbytes > max_bytes:
        raise SystemExit(f'Output size out of bounds for {fpath}: {fbytes} B (max {max_bytes} B)')
    with open(fpath, 'rb') as f:
        magic = f.read(12)
    if magic[:4] != b'RIFF' or magic[8:12] != b'WEBP':
        raise SystemExit(f'Invalid RIFF/WEBP header in {fpath}')
    w = int(vh('width', fpath))
    h = int(vh('height', fpath))
    bands = int(vh('bands', fpath))
    interp = vh('interpretation', fpath)
    expected_tier_w = min(target_w, src_w)
    if w != expected_tier_w:
        raise SystemExit(f'Unexpected width for {fpath}: got {w}, expected {expected_tier_w}')
    ratio_err = abs((w / h) - src_ratio) / src_ratio
    if ratio_err > 0.01:
        raise SystemExit(f'Aspect ratio drift > 1% for {fpath}: {ratio_err:.4%}')
    if bands != 4:
        raise SystemExit(f'Alpha channel missing in {fpath}: bands={bands}')
    alpha_min = band_stat('min', fpath, 3)
    alpha_max = band_stat('max', fpath, 3)
    if alpha_max <= 0.0 or alpha_min >= 255.0:
        raise SystemExit(f'Transparency lost in {fpath}: alpha_min={alpha_min}, alpha_max={alpha_max}')
    if alpha_min > 0.0:
        notes.append(f'{target_w}px alphaMin={alpha_min}')
    if fbytes <= prev_bytes:
        raise SystemExit(f'Non-monotonic WebP size: {target_w}px ({fbytes} B) <= previous ({prev_bytes} B)')
    prev_bytes = fbytes
    outputs[str(target_w)] = {
        'path': rel_out,
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
    'status': 'ok',
    'notes': notes,
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
print(f'OK {slug}: rss={record["pass1"]["maxRssMiB"]}MiB tmp={record["pass1"]["peakTmpDeltaMiB"]}MiB wall={elapsed} | 420={outputs["420"]["kb"]}KB 800={outputs["800"]["kb"]}KB 1600={outputs["1600"]["kb"]}KB')
PYEOF

  SUCCEEDED=$((SUCCEEDED + 1))
done

# 4. Verify ZERO original PNG files leaked into batch-out/ and exact 72 WebP files exist
PNG_LEAKS="$(find "$OUT_DIR" -type f -iname '*.png' | wc -l | tr -d ' ')"
WEBP_COUNT="$(find "$OUT_DIR/webp" -type f -iname '*.webp' | wc -l | tr -d ' ')"
if (( PNG_LEAKS != 0 )); then
  log "ERROR: Found $PNG_LEAKS PNG file(s) inside $OUT_DIR"
  exit 1
fi
if (( WEBP_COUNT != 72 )); then
  log "ERROR: Expected 72 WebP files, found $WEBP_COUNT"
  exit 1
fi

# 5. Browser decode verification for all 72 WebP outputs via local HTTP + headless Chrome
CHROME_BIN="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
BROWSER_DECODE_JSON="$WORK_TMP/browser-decode.json"
if [[ -n "$CHROME_BIN" ]]; then
  log "Verifying all 72 WebP files decode in headless browser: $CHROME_BIN"
  python3 - "$OUT_DIR/webp" "$CHROME_BIN" "$BROWSER_DECODE_JSON" <<'PYEOF'
import functools, glob, http.server, json, os, socketserver, subprocess, sys, threading

webp_root, chrome_bin, out_json = sys.argv[1:4]
files = sorted(os.path.relpath(f, webp_root).replace('\\', '/') for f in glob.glob(os.path.join(webp_root, '*', '*.webp')))
if len(files) != 72:
    raise SystemExit(f'Expected 72 WebP files for browser check, got {len(files)}')

imgs_html = ''.join(f'<img data-file="{f}" src="/{f}">' for f in files)
index_html = f"""<!doctype html><html><body>{imgs_html}<pre id="out"></pre><script>
window.addEventListener('load', () => {{
  const res = [...document.querySelectorAll('img')].map(i => ({{
    file: i.dataset.file,
    decoded: Boolean(i.complete && i.naturalWidth > 0 && i.naturalHeight > 0),
    w: i.naturalWidth,
    h: i.naturalHeight
  }}));
  document.getElementById('out').textContent = JSON.stringify({{ total: res.length, decodedCount: res.filter(x => x.decoded).length, failed: res.filter(x => !x.decoded) }});
}});
</script></body></html>"""

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            body = index_html.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()
    def log_message(self, *args):
        pass

handler = functools.partial(Handler, directory=webp_root)
httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
port = httpd.server_address[1]
t = threading.Thread(target=httpd.serve_forever, daemon=True)
t.start()
try:
    dom = subprocess.check_output(
        [chrome_bin, '--headless=new', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=15000', '--dump-dom', f'http://127.0.0.1:{port}/'],
        text=True, stderr=subprocess.DEVNULL, timeout=45
    )
    start = dom.find('<pre id="out">') + len('<pre id="out">')
    end = dom.find('</pre>', start)
    parsed = json.loads(dom[start:end])
    if parsed.get('decodedCount') != 72 or parsed.get('failed'):
        raise SystemExit(f'Browser decode failed: {parsed}')
    with open(out_json, 'w', encoding='utf-8') as f:
        json.dump({'browser': chrome_bin, 'allDecoded': True, **parsed}, f, indent=2)
    print('BROWSER_DECODE_OK: 72/72 WebP files decoded in', chrome_bin)
finally:
    httpd.shutdown()
    httpd.server_close()
PYEOF
else
  echo '{"browser": null, "allDecoded": null, "note": "No headless browser binary preinstalled"}' > "$BROWSER_DECODE_JSON"
fi

# 6. Build batch-metrics.json, oversized-preview-manifest.json, summary.txt, and Step Summary
BATCH_END_EPOCH="$(date +%s)"
TOTAL_ELAPSED_SEC=$((BATCH_END_EPOCH - BATCH_START_EPOCH))

python3 - "$METRICS_NDJSON" "$BROWSER_DECODE_JSON" "$OUT_DIR" "$VIPS_VERSION" "${COLOR_FLAGS[*]:-none}" "$ATTEMPTED" "$SUCCEEDED" "$TOTAL_ELAPSED_SEC" <<'PYEOF'
import json, os, subprocess, sys

ndjson_path, browser_path, out_dir, vips_ver, color_flags, attempted, succeeded, total_elapsed = sys.argv[1:9]
attempted, succeeded, total_elapsed = int(attempted), int(succeeded), int(total_elapsed)
failed = attempted - succeeded

images = [json.loads(line) for line in open(ndjson_path, encoding='utf-8') if line.strip()]
browser_decode = json.load(open(browser_path, encoding='utf-8'))

max_rss_item = max(images, key=lambda x: x['pass1']['maxRssKb'])
max_tmp_item = max(images, key=lambda x: x['pass1']['peakTmpDeltaKb'])
total_webp_bytes = sum(im['outputs'][t]['bytes'] for im in images for t in ('420', '800', '1600'))
total_source_bytes = sum(im['sourceBytes'] for im in images)
total_420_bytes = sum(im['outputs']['420']['bytes'] for im in images)
total_800_bytes = sum(im['outputs']['800']['bytes'] for im in images)
total_1600_bytes = sum(im['outputs']['1600']['bytes'] for im in images)

# Compute total output directory bytes
total_artifact_bytes = 0
for root, _, files in os.walk(out_dir):
    for fn in files:
        total_artifact_bytes += os.path.getsize(os.path.join(root, fn))

branch = subprocess.check_output(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], text=True).strip()
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()

metrics = {
    'branch': branch,
    'commit': commit,
    'vipsVersion': vips_ver,
    'vipsConcurrency': os.environ.get('VIPS_CONCURRENCY'),
    'vipsDiscThreshold': os.environ.get('VIPS_DISC_THRESHOLD'),
    'colorFlags': color_flags,
    'attempted': attempted,
    'succeeded': succeeded,
    'failed': failed,
    'totalWebpOutputs': len(images) * 3,
    'pngLeaksInOutput': 0,
    'totalElapsedSeconds': total_elapsed,
    'totalSourceBytes': total_source_bytes,
    'totalWebpBytes': total_webp_bytes,
    'totalWebpMB': round(total_webp_bytes / (1024 * 1024), 2),
    'tierTotalsBytes': { '420': total_420_bytes, '800': total_800_bytes, '1600': total_1600_bytes },
    'maxPeakRss': { 'slug': max_rss_item['slug'], 'kb': max_rss_item['pass1']['maxRssKb'], 'mib': max_rss_item['pass1']['maxRssMiB'] },
    'maxPeakTmpDelta': { 'slug': max_tmp_item['slug'], 'kb': max_tmp_item['pass1']['peakTmpDeltaKb'], 'mib': max_tmp_item['pass1']['peakTmpDeltaMiB'] },
    'browserDecode': browser_decode,
    'images': images,
}

manifest = {
    'version': 1,
    'generatedFromCommit': commit,
    'vipsVersion': vips_ver,
    'colorFlags': color_flags,
    'totalSources': len(images),
    'totalWebpOutputs': len(images) * 3,
    'entries': {
        im['path']: {
            'slug': im['slug'],
            'sourceBlob': im['sourceBlob'],
            'sourceWidth': im['sourceWidth'],
            'sourceHeight': im['sourceHeight'],
            '420': { 'path': im['outputs']['420']['path'], 'bytes': im['outputs']['420']['bytes'], 'width': im['outputs']['420']['width'], 'height': im['outputs']['420']['height'] },
            '800': { 'path': im['outputs']['800']['path'], 'bytes': im['outputs']['800']['bytes'], 'width': im['outputs']['800']['width'], 'height': im['outputs']['800']['height'] },
            '1600': { 'path': im['outputs']['1600']['path'], 'bytes': im['outputs']['1600']['bytes'], 'width': im['outputs']['1600']['width'], 'height': im['outputs']['1600']['height'] },
            'status': im['status'],
            'notes': im['notes'],
        }
        for im in images
    },
}

with open(os.path.join(out_dir, 'batch-metrics.json'), 'w', encoding='utf-8') as f:
    json.dump(metrics, f, indent=2)
with open(os.path.join(out_dir, 'oversized-preview-manifest.json'), 'w', encoding='utf-8') as f:
    json.dump(manifest, f, indent=2)

summary_lines = [
    'Render 2.0 — Phase 6.1C Full 24-Image Static WebP Batch Summary',
    '================================================================',
    f'Branch / Commit : {branch} @ {commit}',
    f'libvips         : {vips_ver} (VIPS_CONCURRENCY={metrics["vipsConcurrency"]}, colorFlags={color_flags})',
    f'Images          : {succeeded}/{attempted} succeeded, {failed} failed ({metrics["totalWebpOutputs"]} WebP outputs, 0 PNG leaks)',
    f'Total Elapsed   : {total_elapsed}s',
    f'Max Peak RSS    : {metrics["maxPeakRss"]["mib"]} MiB ({metrics["maxPeakRss"]["slug"]})',
    f'Max /tmp Delta  : {metrics["maxPeakTmpDelta"]["mib"]} MiB ({metrics["maxPeakTmpDelta"]["slug"]})',
    f'Source PNG Sum  : {round(total_source_bytes / (1024 * 1024), 2)} MiB -> Total 72 WebPs: {metrics["totalWebpMB"]} MiB (420={round(total_420_bytes/1024,1)}KB, 800={round(total_800_bytes/1024,1)}KB, 1600={round(total_1600_bytes/1024,1)}KB)',
    f'Browser Decode  : {browser_decode.get("decodedCount")}/72 decoded ({browser_decode.get("browser")})',
    '',
    'Per-Image Breakdown:',
]
for idx, im in enumerate(images, 1):
    p1 = im['pass1']
    o = im['outputs']
    summary_lines.append(
        f'{idx:2d}. {im["path"]} | {im["sourceWidth"]}x{im["sourceHeight"]} ({im["sourceMegapixels"]}MP) | '
        f'RSS={p1["maxRssMiB"]}MiB tmp={p1["peakTmpDeltaMiB"]}MiB wall={p1["elapsedWall"]} | '
        f'420={o["420"]["width"]}x{o["420"]["height"]}({o["420"]["kb"]}KB) '
        f'800={o["800"]["width"]}x{o["800"]["height"]}({o["800"]["kb"]}KB) '
        f'1600={o["1600"]["width"]}x{o["1600"]["height"]}({o["1600"]["kb"]}KB)'
    )

summary_text = '\n'.join(summary_lines) + '\n'
with open(os.path.join(out_dir, 'summary.txt'), 'w', encoding='utf-8') as f:
    f.write(summary_text)
print(summary_text)

step_summary = os.environ.get('GITHUB_STEP_SUMMARY')
if step_summary:
    with open(step_summary, 'a', encoding='utf-8') as sf:
        sf.write('## Render 2.0 — Phase 6.1C 24-Image Batch Summary\n\n```\n' + summary_text + '```\n')
PYEOF

log "BATCH COMPLETED SUCCESSFULLY (24/24 images, 72 WebP outputs)"
