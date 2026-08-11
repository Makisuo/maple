// GENERATED FILE — DO NOT EDIT.
//
// Compiled from packages/email/emails/alert-notification.html by Maizzle.
// Regenerate with: bun run --cwd packages/email build

/** The full page, with `[[token]]` values and `[[#slot]]` fragment holes. */
export const PAGE = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en">
<head>
<meta content="text/html; charset=UTF-8" http-equiv="Content-Type">
<meta name="x-apple-disable-message-reformatting">
</head>
<body style="background-color:#141210;margin:0;padding:0">
<div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0">[[previewText]]<div>[[#preheaderPad]]</div></div>
<table border="0" width="100%" cellpadding="0" cellspacing="0" role="presentation" align="center"><tbody><tr><td style="margin: 0px; background-color: rgb(20, 18, 16); padding-left: 1rem; padding-right: 1rem; padding-top: 2.5rem; padding-bottom: 2.5rem; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;">
<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin-left: auto; margin-right: auto; max-width: 560px; overflow: hidden; border-radius: 0.75rem; border-width: 1px; border-style: solid; border-color: rgb(58, 52, 46); background-color: rgb(30, 27, 24);"><tbody><tr style="width:100%"><td>
<!-- Header -->
<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="padding-left: 1.5rem; padding-right: 1.5rem; padding-bottom: 1.25rem; padding-top: 1.5rem;"><tbody><tr><td>
	<table style="width: 100%;"><tbody><tr>
		<td style="width: 36px; padding-right: 0.75rem; vertical-align: middle;">
			<table cellpadding="0" cellspacing="0" role="presentation"><tbody><tr>
				<td style="width:32px;height:32px;background-color:#e8872a;border-radius:8px;text-align:center;vertical-align:middle;font-family:system-ui, -apple-system, sans-serif;font-size:18px;font-weight:700;color:#ffffff;line-height:32px">M</td>
			</tr></tbody></table>
		</td>
		<td style="vertical-align: middle;">
			<p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 1rem; line-height: 1.5rem; font-weight: 600; color: rgb(232, 223, 211);">Maple Alerts</p>
			<p style="margin: 0px; margin-top: 0.125rem; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 0.75rem; line-height: 1rem; color: rgb(138, 127, 114);">Alert notification</p>
		</td>
	</tr></tbody></table>
</td></tr></tbody></table>
<!-- Accent divider -->
<div style="margin-left: 1.5rem; margin-right: 1.5rem; height: 1px; background-color: rgb(58, 52, 46); background-image: linear-gradient(to right, [[accentColor]], #3a342e 40%);"></div>
<!-- Event banner -->
<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="padding-left: 1.25rem; padding-right: 1.25rem; padding-top: 1.25rem;"><tbody><tr><td>
	<div style="border-left:3px solid [[accentColor]];background-color:#262320;border-top-right-radius:8px;border-bottom-right-radius:8px;padding:14px 16px">
		<span style="display:inline-block;background-color:[[accentColor]];color:#ffffff;border-radius:5px;padding:3px 8px;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase">[[eventLabel]]</span>
		<p style="margin: 0px; margin-top: 0.625rem; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 15px; font-weight: 600; line-height: 1.375; color: rgb(232, 223, 211);">[[eventEmoji]] [[ruleName]]</p>
		<p style="margin: 0px; margin-top: 0.25rem; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 12px; line-height: 1.375; color: rgb(138, 127, 114);">[[observedSummary]]</p>
	</div>
</td></tr></tbody></table>
<!-- Details -->
<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="padding-left: 1.5rem; padding-right: 1.5rem; padding-top: 1.25rem;"><tbody><tr><td>
	<div style="overflow: hidden; border-radius: 0.5rem; border-width: 1px; border-style: solid; border-color: rgb(48, 43, 38); background-color: rgb(38, 35, 32);">
		<table style="width: 100%; border-collapse: collapse;"><tbody>
			[[#detailRows]]
		</tbody></table>
	</div>
</td></tr></tbody></table>
<!-- CTAs -->
<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="padding-left: 1.5rem; padding-right: 1.5rem; padding-bottom: 0.5rem; padding-top: 1.5rem;"><tbody><tr><td>
	<table style="width: 100%; border-collapse: collapse;"><tbody><tr>
		<td style="width: 50%; padding-right: 0.25rem;"><a href="[[linkUrl]]" target="_blank" style="display: block; border-radius: 0.5rem; background-color: rgb(232, 135, 42); padding-left: 1rem; padding-right: 1rem; padding-top: 0.75rem; padding-bottom: 0.75rem; text-align: center; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 0.875rem; line-height: 1.25rem; font-weight: 600; color: rgb(255, 255, 255); text-decoration-line: none;">Open in Maple &rarr;</a></td>
		<td style="width: 50%; padding-left: 0.25rem;"><a href="[[chatUrl]]" target="_blank" style="display: block; border-radius: 0.5rem; border-width: 1px; border-style: solid; border-color: rgb(58, 52, 46); background-color: rgb(38, 35, 32); padding-left: 1rem; padding-right: 1rem; padding-top: 0.75rem; padding-bottom: 0.75rem; text-align: center; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 0.875rem; line-height: 1.25rem; font-weight: 600; color: rgb(232, 223, 211); text-decoration-line: none;">Ask Maple AI</a></td>
	</tr></tbody></table>
</td></tr></tbody></table>
<!-- Footer -->
<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="padding-left: 1.5rem; padding-right: 1.5rem; padding-bottom: 1.5rem; padding-top: 0.75rem;"><tbody><tr><td>
	<p style="margin: 0px; text-align: center; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 11px; line-height: 24px; color: rgb(92, 85, 76);">&#127809; Maple Alerts &middot; You are receiving this because this address is an alert destination for your organization.</p>
</td></tr></tbody></table>
</td></tr></tbody></table>
</td></tr></tbody></table>
</body>
</html>`

/** Repeated, optional and nested regions spliced into the page's slots. */
export const FRAGMENTS = {
	detailRow: `<tr>
	<td style="width: 110px; padding-left: 0.75rem; padding-right: 0.75rem; padding-top: 0.625rem; padding-bottom: 0.625rem; vertical-align: top; border-bottom: 1px solid #302b26;"><p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; text-transform: uppercase; line-height: 24px; letter-spacing: 0.1em; color: rgb(92, 85, 76);">[[label]]</p></td>
	<td style="padding-left: 0.75rem; padding-right: 0.75rem; padding-top: 0.625rem; padding-bottom: 0.625rem; vertical-align: top; border-bottom: 1px solid #302b26;"><p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 13px; line-height: 1.375; color: [[valueColor]];">[[value]]</p></td>
</tr>`,
} as const

export type FragmentName = keyof typeof FRAGMENTS
