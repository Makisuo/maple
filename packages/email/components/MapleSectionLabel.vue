<script setup lang="ts">
/** The small uppercase caption above each block ("Service Health", "Ingestion"). */
defineOptions({ inheritAttrs: false })
</script>

<template><p class="m-0 font-mono text-[10px] uppercase leading-[24px] tracking-widest text-maple-fg-dim" v-bind="$attrs"><slot /></p></template>
