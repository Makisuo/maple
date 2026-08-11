// GENERATED FILE — DO NOT EDIT.
//
// Compiled from packages/email/emails/weekly-digest.html by Maizzle.
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
			<p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 1rem; line-height: 1.5rem; font-weight: 600; color: rgb(232, 223, 211);">[[orgName]]</p>
			<p style="margin: 0px; margin-top: 0.125rem; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 0.75rem; line-height: 1rem; color: rgb(138, 127, 114);">Weekly digest &middot; [[dateStart]] &ndash; [[dateEnd]]</p>
		</td>
	</tr></tbody></table>
</td></tr></tbody></table>
<!-- Orange accent divider -->
<div style="margin-left: 1.5rem; margin-right: 1.5rem; height: 1px; background-color: rgb(58, 52, 46); background-image: linear-gradient(to right, #e8872a, #3a342e 40%);"></div>
<!-- Health verdict banner -->
[[#statusBanner]]
<!-- 7-day trend sparkline -->
[[#sparklineSection]]
<!-- Summary cards, 2x2 -->
<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="padding-left: 1.25rem; padding-right: 1.25rem; padding-top: 1rem;"><tbody><tr><td>
	<table style="width: 100%; border-collapse: collapse;"><tbody>
		<tr>
			[[#summaryRowOne]]
		</tr>
		<tr>[[#summaryRowTwo]]</tr>
	</tbody></table>
</td></tr></tbody></table>
<!-- Service health -->
[[#servicesSection]]
<!-- Top errors -->
[[#errorsSection]]
<!-- Ingestion -->
<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="padding-left: 1.5rem; padding-right: 1.5rem; padding-top: 1.25rem;"><tbody><tr><td>
	<p style="margin: 0px; margin-bottom: 0.75rem; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; text-transform: uppercase; line-height: 24px; letter-spacing: 0.1em; color: rgb(92, 85, 76);">Ingestion</p>
	<table style="width: 100%; border-collapse: collapse;"><tbody><tr>
		[[#ingestionCells]]
	</tr></tbody></table>
</td></tr></tbody></table>
<!-- CTA -->
<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="padding-left: 1.5rem; padding-right: 1.5rem; padding-bottom: 0.5rem; padding-top: 1.5rem;"><tbody><tr><td>
	<a href="[[dashboardUrl]]" target="_blank" style="display: block; border-radius: 0.5rem; background-color: rgb(232, 135, 42); padding-left: 1.5rem; padding-right: 1.5rem; padding-top: 0.75rem; padding-bottom: 0.75rem; text-align: center; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 0.875rem; line-height: 1.25rem; font-weight: 600; color: rgb(255, 255, 255); text-decoration-line: none;">Open dashboard &rarr;</a>
</td></tr></tbody></table>
<!-- Footer -->
<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="padding-left: 1.5rem; padding-right: 1.5rem; padding-bottom: 1.5rem; padding-top: 0.75rem;"><tbody><tr><td>
	<p style="margin: 0px; text-align: center; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 11px; line-height: 24px; color: rgb(92, 85, 76);">Powered by <a href="[[baseUrl]]" target="_blank" style="color: rgb(138, 127, 114); text-decoration-line: none;">Maple</a> &middot; You subscribed to weekly digests. <a href="[[unsubscribeUrl]]" target="_blank" style="color: rgb(138, 127, 114); text-decoration-line: underline;">Unsubscribe</a></p>
</td></tr></tbody></table>
</td></tr></tbody></table>
</td></tr></tbody></table>
</body>
</html>`

/** Repeated, optional and nested regions spliced into the page's slots. */
export const FRAGMENTS = {
	affectedServices: `<p style="margin: 0px; margin-top: 0.125rem; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; line-height: 1.25; color: rgb(92, 85, 76);">[[text]]</p>`,
	barErr: `<div style="height:[[h]]px;background-color:#e85d4a;border-top-left-radius:[[radiusTop]];border-top-right-radius:[[radiusTop]];border-bottom-left-radius:3px;border-bottom-right-radius:3px"></div>`,
	barOk: `<div style="height:[[h]]px;background-color:#e8872a;border-top-left-radius:3px;border-top-right-radius:3px;border-bottom-left-radius:[[radiusBottom]];border-bottom-right-radius:[[radiusBottom]]"></div>`,
	biggestMover: `<p style="margin: 0px; margin-top: 0.25rem; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 12px; line-height: 1.375; color: rgb(138, 127, 114);">[[text]]</p>`,
	deltaPill: `<span style="display:inline-block;background-color:[[bg]];color:[[color]];border-radius:5px;padding:2px 6px;font-size:11px;font-weight:600;line-height:14px">[[arrow]] [[value]]</span>`,
	errorRow: `<div style="padding-left: 0.75rem; padding-right: 0.75rem; padding-top: 0.625rem; padding-bottom: 0.625rem; border-bottom: [[rowBorder]];">
	<table style="width: 100%;"><tbody><tr>
		<td style="width: 20px; vertical-align: top;"><p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 13px; line-height: 24px; color: rgb(92, 85, 76);">[[index]].</p></td>
		<td style="vertical-align: top;">
			<p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 13px; line-height: 1.375; color: rgb(232, 223, 211);">[[#newBadge]][[message]]</p>
			[[#affectedServices]]
		</td>
		<td style="width: 56px; text-align: right; vertical-align: top;"><p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 13px; font-weight: 500; line-height: 24px; color: rgb(232, 93, 74);">[[count]]&times;</p></td>
	</tr></tbody></table>
</div>`,
	errorsSection: `<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="padding-left: 1.5rem; padding-right: 1.5rem; padding-top: 1.25rem;"><tbody><tr><td>
	<table style="width: 100%;"><tbody><tr>
		<td style="vertical-align: middle;"><p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; text-transform: uppercase; line-height: 24px; letter-spacing: 0.1em; color: rgb(92, 85, 76);">Top Errors</p></td>
		<td style="text-align: right; vertical-align: middle;"><a href="[[errorsUrl]]" target="_blank" style="font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: rgb(232, 135, 42); text-decoration-line: none;">View all &rarr;</a></td>
	</tr></tbody></table>
	<div style="margin-top: 0.5rem; overflow: hidden; border-radius: 0.5rem; border-width: 1px; border-style: solid; border-color: rgb(48, 43, 38); background-color: rgb(38, 35, 32);">
		[[#errorRows]]
	</div>
</td></tr></tbody></table>`,
	ingestionCell: `<td style="width: 25%; padding: 0.25rem;"><div style="border-radius: 0.5rem; background-color: rgb(38, 35, 32); padding-left: 0.75rem; padding-right: 0.75rem; padding-top: 0.625rem; padding-bottom: 0.625rem; text-align: center;">
	<p style="margin: 0px; margin-bottom: 0.25rem; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; text-transform: uppercase; line-height: 24px; letter-spacing: 0.1em; color: rgb(92, 85, 76);">[[label]]</p>
	<p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 0.875rem; line-height: 1.25rem; font-weight: 600; color: rgb(232, 223, 211);">[[value]]</p>
	[[#ingestionDelta]]
</div></td>`,
	ingestionDelta: `<p style="margin: 0px; margin-top: 0.25rem; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; line-height: 1.25; color: [[color]];">[[arrow]] [[value]]</p>`,
	newBadge: `<span style="display:inline-block;background-color:rgba(232,93,74,0.16);color:#e85d4a;border-radius:4px;padding:1px 5px;font-size:9px;font-weight:700;letter-spacing:0.08em;margin-right:6px;vertical-align:middle">NEW</span>`,
	serviceRequestsDelta: `<p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; line-height: 1.25; color: [[color]];">[[arrow]] [[value]]</p>`,
	serviceRow: `<tr>
	<td style="padding-left: 0.75rem; padding-right: 0.75rem; padding-top: 0.625rem; padding-bottom: 0.625rem; border-bottom: [[rowBorder]];"><a href="[[url]]" target="_blank" style="font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 13px; font-weight: 500; color: rgb(232, 223, 211); text-decoration-line: none;"><span style="color:[[dotColor]];font-size:9px;margin-right:6px">&#9679;</span>[[name]]</a></td>
	<td style="padding-left: 0.75rem; padding-right: 0.75rem; padding-top: 0.625rem; padding-bottom: 0.625rem; text-align: right; vertical-align: middle; border-bottom: [[rowBorder]];">
		<p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 13px; line-height: 24px; color: rgb(138, 127, 114);">[[requests]]</p>
		[[#serviceRequestsDelta]]
	</td>
	<td style="padding-left: 0.75rem; padding-right: 0.75rem; padding-top: 0.625rem; padding-bottom: 0.625rem; text-align: right; vertical-align: middle; border-bottom: [[rowBorder]];"><p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 13px; line-height: 24px; color: [[errRateColor]];">[[errRate]]</p></td>
	<td style="padding-left: 0.75rem; padding-right: 0.75rem; padding-top: 0.625rem; padding-bottom: 0.625rem; text-align: right; vertical-align: middle; border-bottom: [[rowBorder]];"><p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 13px; line-height: 24px; color: rgb(138, 127, 114);">[[p95]]</p></td>
</tr>`,
	servicesSection: `<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="padding-left: 1.5rem; padding-right: 1.5rem; padding-top: 1.25rem;"><tbody><tr><td>
	<p style="margin: 0px; margin-bottom: 0.75rem; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; text-transform: uppercase; line-height: 24px; letter-spacing: 0.1em; color: rgb(92, 85, 76);">Service Health</p>
	<div style="overflow: hidden; border-radius: 0.5rem; border-width: 1px; border-style: solid; border-color: rgb(48, 43, 38); background-color: rgb(38, 35, 32);">
		<table style="width: 100%; border-collapse: collapse;">
			<thead><tr>
				<th style="padding-left: 0.75rem; padding-right: 0.75rem; padding-top: 0.5rem; padding-bottom: 0.5rem; text-align: left; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.1em; color: rgb(92, 85, 76); border-bottom: 1px solid #302b26;">Service</th>
				<th style="padding-left: 0.75rem; padding-right: 0.75rem; padding-top: 0.5rem; padding-bottom: 0.5rem; text-align: right; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.1em; color: rgb(92, 85, 76); border-bottom: 1px solid #302b26;">Reqs</th>
				<th style="padding-left: 0.75rem; padding-right: 0.75rem; padding-top: 0.5rem; padding-bottom: 0.5rem; text-align: right; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.1em; color: rgb(92, 85, 76); border-bottom: 1px solid #302b26;">Err%</th>
				<th style="padding-left: 0.75rem; padding-right: 0.75rem; padding-top: 0.5rem; padding-bottom: 0.5rem; text-align: right; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.1em; color: rgb(92, 85, 76); border-bottom: 1px solid #302b26;">P95</th>
			</tr></thead>
			<tbody>
				[[#serviceRows]]
			</tbody>
		</table>
	</div>
</td></tr></tbody></table>`,
	sparkBar: `<td style="height:52px;vertical-align:bottom;padding:0 3px">[[#barOk]][[#barErr]]</td>`,
	sparkLabel: `<td style="text-align:center;padding-top:6px"><p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 9px; line-height: 24px; color: rgb(92, 85, 76);">[[label]]</p></td>`,
	sparklineSection: `<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="padding-left: 1.5rem; padding-right: 1.5rem; padding-top: 1.25rem;"><tbody><tr><td>
	<table style="width: 100%;"><tbody><tr>
		<td style="vertical-align: middle;"><p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; text-transform: uppercase; line-height: 24px; letter-spacing: 0.1em; color: rgb(92, 85, 76);">Requests &middot; 7-day trend</p></td>
		<td style="text-align: right; vertical-align: middle;"><p style="margin: 0px; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 13px; font-weight: 600; line-height: 24px; color: rgb(232, 223, 211);">[[totalRequests]] <span style="font-weight:400">[[#deltaPill]]</span></p></td>
	</tr></tbody></table>
	<div style="margin-top: 0.5rem; border-radius: 0.5rem; border-width: 1px; border-style: solid; border-color: rgb(48, 43, 38); background-color: rgb(38, 35, 32); padding-left: 0.75rem; padding-right: 0.75rem; padding-bottom: 0.5rem; padding-top: 0.75rem;">
		<table style="width: 100%; border-collapse: collapse;"><tbody>
			<tr>[[#sparkBars]]</tr>
			<tr>[[#sparkLabels]]</tr>
		</tbody></table>
	</div>
</td></tr></tbody></table>`,
	statusBanner: `<table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="padding-left: 1.25rem; padding-right: 1.25rem; padding-top: 1.25rem;"><tbody><tr><td>
	<div style="border-left:3px solid [[accent]];background-color:[[bannerBg]];border-top-right-radius:8px;border-bottom-right-radius:8px;padding:14px 16px">
		<span style="display:inline-block;background-color:[[pillBg]];color:[[pillFg]];border-radius:5px;padding:3px 8px;font-size:10px;font-weight:700;letter-spacing:0.12em">[[label]]</span>
		<p style="margin: 0px; margin-top: 0.625rem; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 14px; font-weight: 500; line-height: 1.375; color: rgb(232, 223, 211);">[[headline]]</p>
		[[#biggestMover]]
	</div>
</td></tr></tbody></table>`,
	summaryCard: `<td style="width: 50%; padding: 0.25rem;"><div style="border-radius: 0.5rem; background-color: rgb(38, 35, 32); padding-left: 1rem; padding-right: 1rem; padding-top: 0.875rem; padding-bottom: 0.875rem;">
	<p style="margin: 0px; margin-bottom: 0.375rem; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 10px; text-transform: uppercase; line-height: 24px; letter-spacing: 0.1em; color: rgb(92, 85, 76);">[[label]]</p>
	<p style="margin: 0px; margin-bottom: 0.5rem; font-family: 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 22px; font-weight: 600; line-height: 1; color: rgb(232, 223, 211);">[[value]]</p>
	[[#deltaPill]]
</div></td>`,
} as const

export type FragmentName = keyof typeof FRAGMENTS
