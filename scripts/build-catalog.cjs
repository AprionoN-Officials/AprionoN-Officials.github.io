const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const PREVIEW_TIERS = ['420', '800', '1600'];
const SAFE_PREVIEW_RE = /^previews\/(420|800|1600)\/[a-z0-9._-]+\.webp$/;

function validateAndResolvePreviews(manifest, entries, options = {}) {
  const resolved = new Map();
  if (!manifest) return resolved;
  if (typeof manifest !== 'object' || !manifest.entries || typeof manifest.entries !== 'object' || Array.isArray(manifest.entries)) {
    throw Error('Invalid preview manifest structure');
  }
  const tracked = new Set(entries.map(e => e.path));
  const entryByPath = new Map(entries.map(e => [e.path, e]));
  const seenOutputs = new Set();
  const rootDir = options.rootDir || null;

  for (const [srcPath, item] of Object.entries(manifest.entries)) {
    if (!srcPath.startsWith('Render 2.0/') || !entryByPath.has(srcPath)) {
      throw Error('Unknown preview manifest source path: ' + srcPath);
    }
    if (!item || typeof item !== 'object') {
      throw Error('Invalid preview manifest entry: ' + srcPath);
    }
    const srcEntry = entryByPath.get(srcPath);
    if (srcEntry.oid && item.sourceBlob && srcEntry.oid !== item.sourceBlob) {
      throw Error(`Preview manifest blob OID mismatch for ${srcPath}: expected ${srcEntry.oid}, got ${item.sourceBlob}`);
    }
    const tierKeys = Object.keys(item).filter(k => /^\d+$/.test(k));
    for (const k of tierKeys) {
      if (!PREVIEW_TIERS.includes(k)) throw Error(`Invalid preview tier "${k}" for ${srcPath}`);
    }
    const tierMap = {};
    for (const tier of PREVIEW_TIERS) {
      const tierObj = item[tier];
      const relPath = typeof tierObj === 'string' ? tierObj : tierObj?.path;
      if (typeof relPath !== 'string' || !SAFE_PREVIEW_RE.test(relPath) || !relPath.startsWith(`previews/${tier}/`)) {
        throw Error(`Invalid preview path for ${srcPath} [${tier}]: ${relPath}`);
      }
      if (seenOutputs.has(relPath)) {
        throw Error(`Duplicate preview output path: ${relPath}`);
      }
      const existsInGit = tracked.has(relPath);
      const existsOnDisk = Boolean(rootDir && fs.existsSync(path.join(rootDir, relPath)));
      if (!existsInGit && !existsOnDisk) {
        throw Error(`Missing static preview file: ${relPath}`);
      }
      seenOutputs.add(relPath);
      tierMap[tier] = relPath;
    }
    resolved.set(srcPath, tierMap);
  }
  return resolved;
}

// Read tracked paths without downloading or decoding the original PNG files.
function buildCatalog(data, entries, updatedAt, options = {}) {
  const images = entries.filter(e => e.path.startsWith('Render 2.0/') && /\.(png|webp|jpe?g|avif)$/i.test(e.path));
  data.files = images.map(e => e.path).sort((a, b) => a.localeCompare(b, 'en'));
  const available = new Set(data.files);
  const previewMap = validateAndResolvePreviews(options.previewManifest || null, entries, options);
  data.metadata = Object.fromEntries(images.map(e => {
    const meta = { size: e.size, updatedAt: updatedAt(e.path) };
    const previews = previewMap.get(e.path);
    if (previews) meta.previews = previews;
    return [e.path, meta];
  }));
  const toRecentEntry = filePath => {
    const parts = filePath.split('/');
    return { name: parts.length > 3 ? parts.at(-2) : path.basename(filePath), game: parts[1], path: filePath };
  };
  const recentPaths = [];
  const seenRecent = new Set();
  for (const p of (Array.isArray(data.recentRenderPriority) ? data.recentRenderPriority : [])) {
    if (available.has(p) && !seenRecent.has(p)) {
      seenRecent.add(p);
      recentPaths.push(p);
      if (recentPaths.length >= 5) break;
    }
  }
  const byUpdated = images.slice().sort((a, b) => data.metadata[b.path].updatedAt.localeCompare(data.metadata[a.path].updatedAt) || a.path.localeCompare(b.path));
  for (const e of byUpdated) {
    if (recentPaths.length >= 5) break;
    if (!seenRecent.has(e.path)) {
      seenRecent.add(e.path);
      recentPaths.push(e.path);
    }
  }
  data.recentRenders = recentPaths.map(toRecentEntry);
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
    const parts = header.trim().split(/\s+/);
    return { path: file, oid: parts[2], size: Number(parts.at(-1)) };
  });
  const data = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  const previewManifestPath = path.join(process.cwd(), 'previews', 'manifest.json');
  const previewManifest = fs.existsSync(previewManifestPath)
    ? JSON.parse(fs.readFileSync(previewManifestPath, 'utf8'))
    : null;

  // Batch extract commit timestamps for fast execution with fallback to individual git log queries.
  const timestamps = new Map();
  try {
    const out = execFileSync('git', ['-c', 'core.quotePath=false', 'log', '--format=COMMIT:%cI', '--name-only', '--', 'Render 2.0'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    let currentDate = null;
    for (const line of out.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith('COMMIT:')) {
        currentDate = line.slice(7).trim();
      } else if (currentDate && !timestamps.has(line)) {
        timestamps.set(line, new Date(currentDate).toISOString());
      }
    }
  } catch {
    // If batch query fails or is unsupported, individual fallback will resolve timestamps.
  }

  buildCatalog(data, entries, file => {
    if (timestamps.has(file)) return timestamps.get(file);
    const date = execFileSync('git', ['-c', 'core.quotePath=false', 'log', '-1', '--format=%cI', '--', file], { encoding: 'utf8' }).trim();
    if (!date) throw Error('No commit date for ' + file);
    const iso = new Date(date).toISOString();
    timestamps.set(file, iso);
    return iso;
  }, { previewManifest, rootDir: process.cwd() });
  fs.writeFileSync('index.json', JSON.stringify(data, null, 2) + '\n');
  console.log('Catalog generated: ' + data.files.length + ' renders');
}
module.exports = { buildCatalog, validateAndResolvePreviews };
