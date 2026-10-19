const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Read tracked paths without downloading or decoding the original PNG files.
function buildCatalog(data, entries, updatedAt) {
  const images = entries.filter(e => e.path.startsWith('Render 2.0/') && /\.(png|webp|jpe?g|avif)$/i.test(e.path));
  data.files = images.map(e => e.path).sort((a, b) => a.localeCompare(b, 'en'));
  const available = new Set(data.files);
  data.metadata = Object.fromEntries(images.map(e => [e.path, { size: e.size, updatedAt: updatedAt(e.path) }]));
  data.recentRenders = images.slice().sort((a, b) => data.metadata[b.path].updatedAt.localeCompare(data.metadata[a.path].updatedAt) || a.path.localeCompare(b.path)).slice(0, 5).map(e => {
    const parts = e.path.split('/');
    return { name: parts.length > 3 ? parts.at(-2) : path.basename(e.path), game: parts[1], path: e.path };
  });
  const previous = new Map((data.recentFolders || []).map(f => [f.name, f]));
  const folders = new Map();
  images.forEach(e => {
    const name = e.path.split('/')[1];
    const date = data.metadata[e.path].updatedAt;
    if (!folders.has(name) || date > folders.get(name)) folders.set(name, date);
  });
  data.recentFolders = [...folders].map(([name, date]) => ({ name, updatedAt: date, status: previous.get(name)?.updatedAt?.slice(0, 10) === date.slice(0, 10) ? previous.get(name).status || '' : 'update' })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name)).slice(0, 5);
  for (const item of data.recentRenders) if (!available.has(item.path)) throw Error('Missing render: ' + item.path);
  const tracked = new Set(entries.map(e => e.path));
  for (const cover of Object.values(data.covers || {})) if (!tracked.has(cover)) throw Error('Missing cover: ' + cover);
  return data;
}

if (require.main === module) {
  const entries = execFileSync('git', ['ls-tree', '-rlz', 'HEAD'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean).map(line => {
    const [header, file] = line.split('\t');
    return { path: file, size: Number(header.trim().split(/\s+/).at(-1)) };
  });
  const data = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  buildCatalog(data, entries, file => {
    const date = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], { encoding: 'utf8' }).trim();
    if (!date) throw Error('No commit date for ' + file);
    return new Date(date).toISOString();
  });
  fs.writeFileSync('index.json', JSON.stringify(data, null, 2) + '\n');
  console.log('Catalog generated: ' + data.files.length + ' renders');
}
module.exports = { buildCatalog };
