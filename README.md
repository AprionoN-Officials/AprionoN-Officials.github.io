# 🖼️ AprionoN Officials — Render 2.0

### A Modern Gallery for High-Resolution Transparent PNG Renders

**Render 2.0** is a personal web-based gallery developed and maintained by **Apriono**, designed to organize, showcase, preview, and provide access to high-resolution transparent PNG character renders.

The project brings together character renders from various video games, anime, and other series in a clean, responsive, and easy-to-navigate interface.

**🌐 Live Website:** [apriononurhakim.store](https://apriononurhakim.store/)

---

## ✨ Features

### 🎨 Modern & Responsive Interface

- Clean, modern design with a soft blue-and-white visual theme.
- Responsive layouts optimized for desktop, tablet, and mobile devices.
- Organized character galleries and series-based collections.
- Accessible navigation, interactive image cards, and a dedicated mobile menu.

### 🖼️ Optimized Image Previews

Render 2.0 provides optimized previews so visitors can explore high-resolution artwork without automatically downloading large original PNG files.

| Preview Type | Resolution | Purpose |
|---|---|---|
| Thumbnail | 420px | Gallery cards and folder covers |
| Standard Preview | 800px | Default image viewer |
| HD Preview | 1600px | Higher-detail viewing on request |
| Original PNG | Full resolution | Original file access and download |

Most images use optimized WebP previews delivered through `wsrv.nl`.

For exceptionally large PNGs that exceed the image processing service's limits, the website uses locally generated static WebP previews to ensure reliable image loading.

**Original PNG files remain unchanged** and are accessed only through explicit user actions.

### 📁 Organized Character Collections

- Browse renders by series and character.
- Explore nested folders with dedicated cover images.
- Search for characters, folders, and renders.
- Sort available content.
- Navigate using browser Back and Forward controls.

### ♿ Accessibility & Usability

- Keyboard-accessible image previews and navigation.
- Focus management for image dialogs and mobile navigation.
- Responsive image viewer with clearly accessible controls.
- Reduced-motion support.
- Graceful handling of unavailable images.

---

## 📊 Collection Overview

At the time of this update, Render 2.0 contains:

- **146 transparent PNG renders**
- **36 collections**
- Characters from multiple games and anime series
- High-resolution original assets alongside optimized previews

The collection will continue to evolve as new renders are added.

Visit the [live gallery](https://apriononurhakim.store/) to explore the latest additions.

---

## 🖼️ Gallery Preview

<p align="center">
  <img src="previews/420/firefly-1-bacff0e6.webp" alt="FireFly character render preview" width="260">
</p>

<p align="center">
  <em>Example of an optimized character preview from Render 2.0.</em>
</p>

**[Explore Render 2.0 →](https://apriononurhakim.store/)**

---

## 🛠️ Technology & Architecture

Render 2.0 uses a lightweight, static-web architecture designed for straightforward maintenance and efficient image delivery.

**Core technologies:**

- HTML5, CSS3, and JavaScript
- Node.js 22 for catalog generation and automated testing
- JSON-based catalog metadata
- WebP image previews
- GitHub Pages for hosting
- GitHub Actions for continuous integration and deployment

The website does not require a large frontend framework or an application server.

### Image Delivery

The image pipeline separates browsing from original file access:

1. Gallery cards request lightweight 420px thumbnails.
2. Opening an image loads an 800px preview.
3. Selecting HD explicitly loads a 1600px preview.
4. Original PNG files remain available through the Download button.

Static previews are used for oversized source images that cannot be processed reliably by the external image optimization service.

This approach helps reduce unnecessary bandwidth consumption while preserving access to the original artwork.

---

## 📂 Repository Structure

```text
AprionoN-Officials.github.io/
├── .github/
│   └── workflows/          # CI and GitHub Pages deployment
├── Render 2.0/
│   └── Series/
│       └── Character/
│           └── image.png  # Original PNG assets
├── previews/
│   ├── 420/                # Optimized thumbnails
│   ├── 800/                # Standard previews
│   ├── 1600/               # HD previews
│   └── manifest.json       # Static preview mappings
├── scripts/
│   └── build-catalog.cjs  # Catalog generator
├── tests/
│   └── catalog.test.cjs   # Automated regression tests
├── index.html              # Website interface
└── index.json              # Catalog data and metadata
```

---

## ⚙️ Catalog Management

### Adding New Renders

Place new PNG files inside the corresponding series and character directory:

```text
Render 2.0/<Series Name>/<Character Name>/<filename>.png
```

For example:

```text
Render 2.0/Genshin Impact/Character Name/1.png
```

The catalog generator discovers images from Git-tracked files, so individual image entries do not need to be added manually.

Catalog timestamps are derived from the relevant Git commit history.

Some metadata, including custom folder covers and curated recent renders, is maintained through the catalog configuration.

**Important:** Extremely high-resolution PNG files may require additional static WebP previews and manifest entries before they can display reliably.

### Local Development

**Requirements:**

- Node.js 22
- Git with the required repository history

Generate the catalog:

```bash
node scripts/build-catalog.cjs
```

Run automated tests:

```bash
node --test tests/*.test.cjs
```

The catalog build relies on Git history for accurate metadata. A complete repository history is recommended for local catalog generation.

### Deployment

The production website is deployed through **GitHub Actions and GitHub Pages**.

Changes should be developed and tested on a separate branch, then reviewed through a Pull Request before merging into the production `root` branch.

The deployment workflow prepares the website, regenerates catalog information, and publishes the required web assets, including optimized static previews.

Original high-resolution PNG files are maintained separately from the lightweight published website assets.

---

## 📌 Project Goals

Render 2.0 is developed with a focus on:

- **Accessibility:** Making the gallery easy to use across devices and input methods.
- **Performance:** Delivering optimized images without unnecessary downloads.
- **Reliability:** Maintaining working previews and character folder covers.
- **Organization:** Keeping a growing render collection easy to explore.
- **Maintainability:** Using a simple architecture supported by automated testing and deployment.

---

## ⚠️ Usage & Copyright

This repository serves as a personal archive and gallery of character renders.

Characters, original artwork, game assets, trademarks, and other intellectual property belong to their respective creators and rights holders.

The availability of an image in this repository does not automatically grant permission for unrestricted redistribution, commercial use, or other uses that require authorization.

Please respect the rights of the original creators and applicable usage terms.

If you are a rights holder and have concerns about any content, please contact the repository maintainer.

---

## 💙 Feedback & Updates

Render 2.0 is an ongoing personal project. Additional renders, improvements, and maintenance updates may be introduced over time.

If you discover broken images, navigation issues, or other problems, feedback is welcome.

You can explore the website or report technical issues through this GitHub repository.

---

### 👤 Maintained by AprionoN Officials

**Render 2.0 — Transparent PNG Render Gallery**

🌐 **Website:** https://apriononurhakim.store/

💻 **GitHub:** https://github.com/AprionoN-Officials/AprionoN-Officials.github.io

*Built with care for a cleaner, faster, and more accessible render browsing experience.*
