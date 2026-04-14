---
title: Getting Started
description: A starter guide page for the new docs site.
sidebar:
  order: 1
---

## Why this site exists

This site combines handwritten guides with generated API reference pages so the
high-level documentation and the source-of-truth contracts can live together.

## Build pipeline

The website build is intentionally split into phases:

1. Generate API reference markdown from TypeScript source.
2. Compile the shared CSS and JavaScript assets.
3. Render the site with Astro and Starlight.
4. Upload the final output as Cloudflare Worker static assets.

## Search experience

Starlight provides built-in search powered by Pagefind so the site has fast,
client-side full-text search out of the box.
