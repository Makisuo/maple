<script setup lang="ts">
/** Health verdict banner. Every colour is a token: the level is decided at
    render time, so one compiled fragment serves healthy/watch/critical. */
defineProps({
	accent: { type: String, default: "[[accent]]" },
	bannerBg: { type: String, default: "[[bannerBg]]" },
	pillBg: { type: String, default: "[[pillBg]]" },
	pillFg: { type: String, default: "[[pillFg]]" },
	label: { type: String, default: "[[label]]" },
	headline: { type: String, default: "[[headline]]" },
})
</script>

<template>
<MapleSection class="px-5 pt-5">
<div :style="`border-left:3px solid ${accent};background-color:${bannerBg};border-top-right-radius:8px;border-bottom-right-radius:8px;padding:14px 16px`">
<span :style="`display:inline-block;background-color:${pillBg};color:${pillFg};border-radius:5px;padding:3px 8px;font-size:10px;font-weight:700;letter-spacing:0.12em`">{{ label }}</span>
<p class="m-0 mt-2.5 font-mono text-[14px] font-medium leading-snug text-maple-fg">{{ headline }}</p>
[[#biggestMover]]
</div>
</MapleSection>
</template>
