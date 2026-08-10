# brand/

Hand-authored brand sources. Two files, both generated once and committed —
nothing here is built in CI.

| File           | What it is                                                      |
| -------------- | --------------------------------------------------------------- |
| `lockup.svg`   | Mark + "Maple", type outlined. Two flat fills: mark, then type. |
| `wordmark.svg` | The type alone, cropped to its own ink. One flat fill.          |

Both come from `scripts/outline-wordmark.py`, which draws the spec on the
`09 — Wordmark / lockup` artboard of the **Maple Logo** file in Paper. That
artboard is where the design decisions live; the script is only how they become
a file. Its proportions in turn come from the shipped nav lockup in
`apps/landing/src/components/NavBar.tsx` — mark at 1.857× the type size, gap at
0.714×, Geist Medium at −0.02em.

The type is outlined rather than set live because these files leave the
building. A `<text>` node renders in whatever the recipient has installed, which
is not Geist.

The mark itself is **not** here. It lives in `apps/landing/public/favicon.svg`
and is read out of that file by both scripts, so the artwork stays defined in
exactly one place.

## Regenerating

```bash
./scripts/outline-wordmark.py     # brand/*.svg          — needs uv
./scripts/generate-brand-kit.sh   # the public kit + zip — needs librsvg, imagemagick
```

Run them in that order; the kit consumes these files. The kit's output lands in
`apps/landing/public/brand/` and is also committed, for the same reason: a
marketing asset that only exists after a `brew install` is one that eventually
404s.
