/**
 * Branded cold-boot loading state.
 *
 * Shown in the brief windows where the app has nothing to render yet — while
 * Clerk auth settles (`main.tsx`) and while the customer/plan query resolves
 * (`__root.tsx`). Replaces both the blank screen and the bare radial spinner.
 *
 * The signature is a self-assembling trace waterfall: the Maple tree on an amber
 * tile above five "span" bars laid out like a nested call tree (each bar's left =
 * its start time, width = its duration). The bars grow in, in start-time order,
 * while a thin amber playhead sweeps across "collecting" them — Maple's own
 * material (a trace being recorded) standing in for a generic loader. Motion
 * lives only in the waterfall; the mark stays still. Reduced motion settles the
 * spans to the fully-assembled trace and drops the playhead (see the `.boot-*`
 * rules in `styles.css`).
 *
 * The mark is the favicon's geometry at tile scale, not `<MapleMark />`: the tree
 * is drawn in its own 739-unit box and bottom-cropped, so a tile has to seat it on
 * a baseline (74% wide, 2.5 units up from the bottom) rather than centre it, which
 * reads bottom-heavy. `MapleMark` renders bare and exposes no seating, so the
 * transform below is copied verbatim from `public/favicon.svg`. The eyes and the
 * notch beside the trunk are evenodd knockouts — the tile reads THROUGH them, so
 * `fillRule` is load-bearing and the tile fill must stay flat.
 *
 * An inline, JS-free copy of this lives inside `#app` in `index.html` so the
 * very first paint already shows it; React replaces that copy with this
 * component on mount, and since they look identical there is no blank frame and
 * no flash at the handoff. Keep the two visually in sync.
 */
export function BootSplash() {
	return (
		<main
			role="status"
			aria-label="Loading Maple"
			className="flex min-h-screen w-full flex-col items-center justify-center gap-6 bg-background"
		>
			<div className="boot-mark size-11 rounded-[11px]">
				<svg viewBox="0 0 32 32" width={44} height={44} aria-hidden="true">
					<g transform="translate(4.1667 5.8333) scale(.0320253)">
						<path
							fillRule="evenodd"
							fill="#fff"
							d="M369.38 0C480.324 2.908e-08 572.686 76.542 592.669 177.775C681.438 222.749 738.763 293.878 738.765 373.942C738.763 482.538 633.316 574.71 486.96 607.449C499.978 645.591 508.455 690.397 510.789 738.765L227.967 738.764C229.399 709.074 233.146 680.725 238.834 654.436C269.538 661.732 306.949 666.785 347.396 664.859L345.194 618.741C208.102 625.268 0.005 528.243 0 373.948C2.099e-08 293.883 57.322 222.751 146.093 177.775C166.076 76.543 258.436 0.001 369.38 0ZM202.322 258.434C174.48 255.016 149.271 273.738 146.015 300.254L133.046 405.874C129.791 432.389 149.721 456.662 177.563 460.08C205.404 463.499 230.614 444.769 233.87 418.254L246.839 312.633C250.095 286.118 230.163 261.853 202.322 258.434ZM367.3 278.691C339.459 275.273 314.117 295.071 310.699 322.913L298.319 423.736C294.902 451.576 314.7 476.918 342.541 480.337C370.382 483.755 395.724 463.955 399.143 436.115L411.523 335.292C414.941 307.451 395.142 282.109 367.3 278.691Z"
						/>
					</g>
				</svg>
			</div>
			<div className="boot-trace" aria-hidden="true">
				<span className="boot-track boot-track--1" />
				<span className="boot-track boot-track--2" />
				<span className="boot-track boot-track--3" />
				<span className="boot-track boot-track--4" />
				<span className="boot-track boot-track--5" />
				<span className="boot-span boot-span--1" />
				<span className="boot-span boot-span--2" />
				<span className="boot-span boot-span--3" />
				<span className="boot-span boot-span--4" />
				<span className="boot-span boot-span--5" />
				<span className="boot-scan" />
			</div>
			<p className="boot-caption">Collecting spans…</p>
			<span className="sr-only">Loading…</span>
		</main>
	)
}
