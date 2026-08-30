import json
import re
from pathlib import Path

root = Path(r'C:\Users\Lenovo\Downloads\Render 2.0')
cover_dir = root / 'Cover'
folders_dir = root / 'Render 2.0'
index_path = root / 'index.json'

rename_map = {
    'Bocchi The Rock.jpg': 'Bocchi The Rock!.jpg',
    'Darling in the franxx.avif': 'Darling In The FranXX.avif',
    'Frieren Beyond Journey.webp': 'Sousou No Frieren.webp',
    'Gotoubun No Hanayome.png': 'Gotoubun no hanayome.png',
    'Highschool Dxd.png': 'Highscool DXD.png',
    'Kaguya sama love is war.jpg': 'Kaguya Sama Love Is War.jpg',
    'Komi san cant communicate.webp': 'Komi san Wa Komyushou Desu.webp',
    'Lycoris recoil.webp': 'Lycoris Recoil.webp',
    'Oshi No Ko.jpg': 'Oshi No Ko!.jpg',
    'Spiderman.jpg': 'Spider-Verse.jpg',
    'Tomo can wa onnanoko.webp': 'Tomo Chan Wa Onnanoko.webp',
    'Violet evergarden.webp': 'Violet Evergarden.webp',
    'Zoom100.jpg': 'Zoom 100 Bucket List Of Death.jpg',
}

for old_name, new_name in rename_map.items():
    src = cover_dir / old_name
    dst = cover_dir / new_name
    if src.exists() and src != dst and not dst.exists():
        src.rename(dst)

# Rebuild cover mapping for folder names
folder_names = sorted(p.name for p in folders_dir.iterdir() if p.is_dir())
cover_files = sorted(p for p in cover_dir.iterdir() if p.is_file() and p.name != 'placeholder')

def norm(s: str) -> str:
    return re.sub(r'[^a-z0-9]', '', s.lower())

covers = {}
for folder in folder_names:
    matches = [p.name for p in cover_files if norm(p.stem) == norm(folder)]
    if matches:
        covers[folder] = 'cover/' + matches[0]

# Intentional manual overrides for special edge cases
manual = {
    'Attack On Titan': 'cover/Attack On Titan.webp',
    'Bocchi The Rock!': 'cover/Bocchi The Rock!.jpg',
    'Boku No Hero Academia': 'cover/Boku No Hero Academia.jpg',
    'Chainsaw Man': 'cover/Chainsaw Man.avif',
    'Dandadan': 'cover/Dandadan.webp',
    'Darling In The FranXX': 'cover/Darling In The FranXX.avif',
    'Fate Series': 'cover/Fate Series.avif',
    'Gotoubun no hanayome': 'cover/Gotoubun no hanayome.png',
    'Highscool DXD': 'cover/Highscool DXD.png',
    'Jujutsu Kaisen': 'cover/Jujutsu Kaisen.avif',
    'Kaguya Sama Love Is War': 'cover/Kaguya Sama Love Is War.jpg',
    'Komi san Wa Komyushou Desu': 'cover/Komi san Wa Komyushou Desu.webp',
    'Lycoris Recoil': 'cover/Lycoris Recoil.webp',
    'Mahou Shoujo ni Akogarete': 'cover/Mahou Shoujo ni Akogarete.jpg',
    'Nazo No Kanojo X': 'cover/Nazo No Kanojo X.jpg',
    'Noragami': 'cover/Noragami.avif',
    'One Punch Man': 'cover/One Punch Man.jpg',
    'Oshi No Ko!': 'cover/Oshi No Ko!.jpg',
    'Overlord': 'cover/Overlord.jpg',
    'Sousou No Frieren': 'cover/Sousou No Frieren.webp',
    'Spider-Verse': 'cover/Spider-Verse.jpg',
    'Spy X Family': 'cover/Spy X Family.avif',
    'SSS Gridman': 'cover/SSS Gridman.jpg',
    'Summertime Rendering': 'cover/Summertime Rendering.jpg',
    'Tomo Chan Wa Onnanoko': 'cover/Tomo Chan Wa Onnanoko.webp',
    'Violet Evergarden': 'cover/Violet Evergarden.webp',
    'Zoom 100 Bucket List Of Death': 'cover/Zoom 100 Bucket List Of Death.jpg',
}

covers.update(manual)

with index_path.open('r', encoding='utf-8') as f:
    data = json.load(f)

data['covers'] = covers
with index_path.open('w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write('\n')

print('Cover files after fix:')
for p in sorted(cover_dir.iterdir()):
    if p.is_file() and p.name != 'placeholder':
        print('-', p.name)

print('\nSample cover entries:')
for k, v in list(covers.items())[:8]:
    print(f'  {k}: {v}')
