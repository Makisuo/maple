# Changelog art generator

Generates the release cover and per-section art for `src/content/changelog/*.md`
using [Paper Shaders](https://github.com/paper-design/shaders) — grain gradients
and Bayer dithering — composited under type drawn straight onto a canvas.

Standalone: its own `package.json`, not part of the landing build or its
dependency tree. Nothing here ships to the site; only the exported images do.

```bash
cd apps/landing/tools/changelog-art
bun install
bun build entry.js --outfile=bundle.js --format=iife --target=browser
bun run server.ts          # http://127.0.0.1:4899
```

Open the page, then from the console:

```js
await renderAll()    // every section poster in SPECS
await renderAll(0)   // just SPECS[0], for iterating
await renderCover()  // the 1200×630 release cover / OG card
```

PNGs land in `out/`. Encode for the site:

```bash
# Section art — grain hides compression artifacts, so lossy q92 is right here
# (~170 KB). Lossless would be ~900 KB for no visible gain.
cwebp -q 92 -sharp_yuv -metadata none out/2026-07-alerts.png \
  -o ../../public/changelog/2026-07-alerts.webp

# Cover stays PNG — OG scrapers are unreliable with WebP.
magick out/changelog-2026-07.png -strip -define png:compression-level=9 \
  ../../public/changelog/changelog-2026-07.png
```

## Notes that will bite you

- **Output size is independent of the viewport.** The field renders into a
  backing store at `SCALE`× and is read back with `toDataURL`, so there is no
  screenshot-resolution ceiling. `/save` writes the PNG server-side because a
  2560×1320 data URL is too large to return through a console eval.
- **`ShaderMount` needs `preserveDrawingBuffer: true`** or the canvas reads back
  empty.
- **Never `await requestAnimationFrame`.** `setFrame()` calls `render()`
  synchronously and `render()` never consults visibility, so it draws even when
  the browser pane is hidden — where rAF is suspended and would hang forever.
- **Sign of `offsetX` depends on the shape.** Pattern-space shapes (wave, warp,
  ripple — `v_patternUV`) move right with *negative* offsetX; object-space
  shapes (sphere, blob — `v_objectUV`) move right with *positive* offsetX.
- **Author the pattern for the displayed size, not the rendered size.** Both
  shader families compute in device-pixel space — grain from
  `gl_FragCoord`/`u_resolution`, dithering keeps `u_pxSize` in "consistent
  actual pixels". A pattern tuned at 2560px aliases into speckle once the
  browser paints it into the ~832px article column, and it looks like a bad
  export when it isn't. Working values for a 2560px render shown at ~832px:
  dither `pxSize` 7–9, grain `noise` ~0.26–0.3. **Always review by resizing the
  PNG to 832px wide** — the native export lies to you:

  ```bash
  magick out/2026-07-api.png -resize 832x /tmp/check.png
  ```

- **`maskField()` is the legibility guarantee.** It fades the field out across
  the left half at composite time, so the headline always sits on clean ground
  no matter what a spec does. Tune per-spec with `maskStart` / `maskEnd`.
