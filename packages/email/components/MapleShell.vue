<script setup lang="ts">
/**
 * Page chrome: doctype, head, hidden preheader, and the body/container table
 * sandwich. Mirrors what react-email's Html/Head/Preview/Body/Container
 * expanded to, so the compiled output stays byte-comparable with the old
 * renderer.
 */
import { useDoctype } from "@maizzle/framework"

defineProps({ previewText: { type: String, default: "[[previewText]]" } })

useDoctype(
	'<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
)
</script>

<template>
<html dir="ltr" lang="en">
<head>
<meta content="text/html; charset=UTF-8" http-equiv="Content-Type">
<meta name="x-apple-disable-message-reformatting">
<MapleTailwind />
</head>
<body style="background-color:#141210;margin:0;padding:0">
<div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0">{{ previewText }}<div>[[#preheaderPad]]</div></div>
<table border="0" width="100%" cellpadding="0" cellspacing="0" role="presentation" align="center"><tbody><tr><td class="m-0 bg-maple-bg px-4 py-10 font-mono">
<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="mx-auto max-w-[560px] overflow-hidden rounded-xl border border-solid border-maple-border bg-maple-surface"><tbody><tr style="width:100%"><td>
<slot />
</td></tr></tbody></table>
</td></tr></tbody></table>
</body>
</html>
</template>
