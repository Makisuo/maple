+++
title = "Getting Started"
description = "A starter guide page for the new docs site."
template = "page.html"
[extra]
kind = "guide"
+++

## Why this site exists

This site combines handwritten guides with generated API reference pages so the
high-level documentation and the source-of-truth contracts can live together.

## Build pipeline

The website build is intentionally split into phases:

1. Generate API reference markdown from TypeScript source.
2. Compile the shared CSS and JavaScript assets.
3. Render the site with Zola.
4. Index the built HTML with Pagefind.
5. Upload the final output as Cloudflare Worker static assets.

## Search experience

The visible search interface is custom site code. Pagefind is used as the
indexing and query layer underneath that UI so the site can keep a cohesive,
fully branded look.
