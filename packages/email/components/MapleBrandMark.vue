<script setup lang="ts">
import { useHead } from "@maizzle/framework"

/**
 * The Maple tree mark, for email headers.
 *
 * A hosted PNG rather than the inline SVG the app uses: Gmail and Outlook strip
 * `<svg>`, so a mail client would render nothing at all. The amber colorway is
 * transparent-backed, so it sits bare on the surface — no tile — matching how the
 * mark renders in-app.
 *
 * Served by the landing site (`apps/landing/public/brand/logo/`, published at
 * `site: "https://maple.dev"`), so the URL is absolute and stage-independent: a
 * mail client has no origin to resolve a relative path against.
 *
 * The inline style is react-email's `<Img>` reset, carried over verbatim, as is
 * the preload hint React 19 emitted alongside it.
 */
const MARK_SRC = "https://maple.dev/brand/logo/maple-mark-amber-256.png"

defineProps({ size: { type: Number, default: 32 } })

useHead({ link: [{ rel: "preload", as: "image", href: MARK_SRC }] })
</script>

<template><img alt="Maple" :height="size" :src="MARK_SRC" style="display:block;outline:none;border:none;text-decoration:none" :width="size"></template>
