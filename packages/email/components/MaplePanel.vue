<script setup lang="ts">
/** Rounded, bordered surface that clips its rows (service table, error list). */
defineOptions({ inheritAttrs: false })
</script>

<template><div class="overflow-hidden rounded-lg border border-solid border-maple-border-subtle bg-maple-card" v-bind="$attrs"><slot /></div></template>
