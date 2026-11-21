# Brand and icons

The Tidewater mark is a storage cylinder holding a tide, with a T across the waterline. The icon files in `assets/icons/` are generated from one set of drawings; replace them as a set rather than editing a single file.

## Drawings

There are three drawings of the same mark. The master is drawn on a 100-unit grid and is used at 48 pixels and up. The 32 pixel and 16 pixel drawings are separate so the T lands on whole pixels instead of being a scaled-down master.

| Drawing | Used for |
|---|---|
| Master, 100 grid | 48 px and larger |
| 32 px | 21–40 px, including the 24 px taskbar icon |
| 16 px | 20 px and smaller, including favicons |

## Colors

| Role | On dark | On light |
|---|---|---|
| Tile | `#12212B` | `#12212B` |
| Cylinder body | `#DCE4EB` | `#C9D4DE` |
| Cylinder top | `#F3F7FA` | `#E4EAF0` |
| Tide | `#4FC1B5` | `#0E7C72` |
| T | `#12212B` | `#12212B` |

## Icon files

| File | Use |
|---|---|
| `assets/icons/app/icon.icns` | macOS app icon. Sizes 16 to 1024 with a transparent margin, following the 824 px body of Apple's 1024 px template. |
| `assets/icons/app/icon.ico` | Windows app icon at 16, 24, 32, 48, 64 and 256 px. |
| `assets/icons/app/32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png` | The PNG sizes the Tauri bundler expects, and the Linux icon. |
| `assets/icons/web/favicon.ico`, `favicon.svg`, `apple-touch-icon.png` | Docs and website. |
| `assets/icons/svg/icon.svg`, `icon-macos.svg` | The app icon as vectors. |
| `assets/icons/svg/mark-on-dark.svg`, `mark-on-light.svg` | The mark without its tile, in color, for docs and README headers. |
| `assets/icons/svg/mark-mono-white.svg`, `mark-mono-black.svg` | One-color mark with the top edge, waterline and T cut out, for the macOS menu bar and print. |

When the Tauri app is added, `bundle.icon` in `tauri.conf.json` points at the files in `assets/icons/app/`, relative to `src-tauri/`.
