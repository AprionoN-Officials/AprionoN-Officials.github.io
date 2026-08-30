import json
import re
import struct
import zlib
from pathlib import Path

root = Path(r'C:\Users\Lenovo\Downloads\Render 2.0')
cover_dir = root / 'Cover'
folder_dir = root / 'Render 2.0'
index_path = root / 'index.json'

# Create a valid placeholder PNG so missing folders still render something cleanly
placeholder = cover_dir / 'placeholder.png'
if not placeholder.exists():
    color = (173, 216, 230)  # light blue
    raw = b'\x00' + bytes(color)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack('!I', len(data))
            + tag
            + data
            + struct.pack('!I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('!IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw))
    png += chunk(b'IEND', b'')
    placeholder.write_bytes(png)

# Load current data and ensure all folders have a cover mapping
with index_path.open('r', encoding='utf-8') as f:
    data = json.load(f)

folders = sorted(p.name for p in folder_dir.iterdir() if p.is_dir())
covers = data.get('covers', {})

for folder in folders:
    if folder not in covers:
        # Find a similar cover if a file exists with normalized match.
        norm = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())
        target = norm(folder)
        match = None
        for p in sorted(cover_dir.iterdir()):
            if p.is_file() and p.name != 'placeholder' and p.name != 'placeholder.png':
                if norm(p.stem) == target:
                    match = p.name
                    break
        covers[folder] = 'cover/' + (match if match else 'placeholder.png')

# Keep old valid entries intact and remove invalid placeholder-less entries if present.
for key, value in list(covers.items()):
    if value in ('cover/placeholder', 'cover/placeholder.png'):
        continue
    if value.startswith('cover/') and value.endswith('placeholder'):
        covers[key] = 'cover/placeholder.png'

# Ensure cover file references are strings
for k in list(covers):
    covers[k] = str(covers[k])

data['covers'] = covers
with index_path.open('w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write('\n')

print('VALID_PLACEHOLDER', placeholder.exists())
print('TOTAL_FOLDERS', len(folders))
print('TOTAL_COVER_KEYS', len(covers))
print('MISSING_MAPPING_NOW', sum(1 for folder in folders if folder not in covers))
print('PLACEHOLDER_USED_FOR', [folder for folder in folders if covers.get(folder) == 'cover/placeholder.png'][:10])
