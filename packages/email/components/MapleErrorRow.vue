<script setup lang="ts">
/** One ranked error. The NEW badge butts directly against the message — keep
    that join tight, whitespace here renders as a visible space. */
defineProps({
	rowBorder: { type: String, default: "[[rowBorder]]" },
	index: { type: String, default: "[[index]]" },
	message: { type: String, default: "[[message]]" },
	count: { type: String, default: "[[count]]" },
})
</script>

<template><div class="px-3 py-2.5" :style="`border-bottom:${rowBorder}`">
<table class="w-full"><tbody><tr>
<td class="w-[20px] align-top"><p class="m-0 font-mono text-[13px] leading-[24px] text-maple-fg-dim">{{ index }}.</p></td>
<td class="align-top"><p class="m-0 font-mono text-[13px] leading-snug text-maple-fg">[[#newBadge]]{{ message }}</p>[[#affectedServices]]</td>
<td class="w-[56px] text-right align-top"><p class="m-0 font-mono text-[13px] font-medium leading-[24px] text-maple-red">{{ count }}&times;</p></td>
</tr></tbody></table>
</div></template>
