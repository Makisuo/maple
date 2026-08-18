/**
 * Branded cold-boot loading state.
 *
 * Shown in the brief windows where the app has nothing to render yet — while
 * Clerk auth settles (`main.tsx`) and while the customer/plan query resolves
 * (`__root.tsx`). Replaces both the blank screen and the bare radial spinner.
 *
 * The signature is a self-assembling trace waterfall: the Maple tree above five
 * "span" bars laid out like a nested call tree (each bar's left = its start time,
 * width = its duration). The bars grow in, in start-time order, while a thin amber
 * playhead sweeps across "collecting" them — Maple's own material (a trace being
 * recorded) standing in for a generic loader. Reduced motion settles the spans to
 * the fully-assembled trace, drops the playhead and holds the eyes open (see the
 * `.boot-*` rules in `styles.css`).
 *
 * The mark renders bare, in `--primary`, on the page background — no tile. A tile
 * is chrome the favicon needs to survive a browser tab strip; here it would just be
 * a box around a box, and it forced the favicon's seating transform (bottom-cropped
 * artwork scaled into a 32-unit box) on a surface with nothing to seat against. Bare
 * means the raw 739 viewBox renders directly, and the eyes knock through to the page
 * rather than to a tile. `fillRule` stays load-bearing either way.
 *
 * The blink is the mark's only motion, deliberately: the playhead already sweeps
 * every 2.4s directly below it, and a second continuous rhythm (a breathe, a pulse,
 * a glow) makes the screen read busy rather than calm. The first blink lands at
 * ~0.9s so a fast boot still catches one, then a 5.6s cycle with a double-blink
 * keeps the beat off the metronome.
 *
 * It works off the knockouts rather than by splitting the path: one `currentColor`
 * rect per eye, scaling 0 → 1 from its top edge, fills the hole with tree colour
 * top-down. The mark's own `d` stays byte-identical.
 *
 * The rects OVER-COVER the eyes by ~10 units on the left, right and bottom, and
 * they are not clipped. Clipping each rect to its eye subpath is the obvious version
 * and it is wrong: the clip edge and the knockout edge are the same curve, so their
 * antialiasing composites to partial coverage and a seam rings every shut eye.
 * Overspill has no such problem — everything immediately around the eyes is the same
 * canopy colour, so it is invisible and only the eye hole shows the lid. The rects
 * must stay inside the canopy though: past its bottom edge they would paint into the
 * gap above the trunk, where they very much would show.
 *
 * Timing carries the naturalism. A blink is not symmetric — the lid slams shut and
 * drifts open — so the close is 90ms on an accelerating curve, holds 60ms, then
 * opens over 180ms on a decelerating one. The tree squashes with it (wider and
 * shorter at the moment of closure, anchored at the roots, overshooting a touch
 * taller on the way back), which is what keeps it from reading as a shutter.
 *
 * An inline, JS-free copy of this lives inside `#app` in `index.html` so the
 * very first paint already shows it; React replaces that copy with this
 * component on mount, and since they look identical there is no blank frame and
 * no flash at the handoff. Keep the two visually in sync, blink timing included.
 */
export function BootSplash() {
	return (
		<main
			role="status"
			aria-label="Loading Maple"
			className="flex min-h-screen w-full flex-col items-center justify-center gap-6 bg-background"
		>
			<div className="boot-mark">
				<svg viewBox="0 0 739 739" width={56} height={56} aria-hidden="true">
					<path
						fillRule="evenodd"
						fill="currentColor"
						d="M369.38 0C480.324 2.908e-08 572.686 76.542 592.669 177.775C681.438 222.749 738.763 293.878 738.765 373.942C738.763 482.538 633.316 574.71 486.96 607.449C499.978 645.591 508.455 690.397 510.789 738.765L227.967 738.764C229.399 709.074 233.146 680.725 238.834 654.436C269.538 661.732 306.949 666.785 347.396 664.859L345.194 618.741C208.102 625.268 0.005 528.243 0 373.948C2.099e-08 293.883 57.322 222.751 146.093 177.775C166.076 76.543 258.436 0.001 369.38 0ZM202.322 258.434C174.48 255.016 149.271 273.738 146.015 300.254L133.046 405.874C129.791 432.389 149.721 456.662 177.563 460.08C205.404 463.499 230.614 444.769 233.87 418.254L246.839 312.633C250.095 286.118 230.163 261.853 202.322 258.434ZM367.3 278.691C339.459 275.273 314.117 295.071 310.699 322.913L298.319 423.736C294.902 451.576 314.7 476.918 342.541 480.337C370.382 483.755 395.724 463.955 399.143 436.115L411.523 335.292C414.941 307.451 395.142 282.109 367.3 278.691Z"
					/>
					{/* Lids. Each rect's top edge sits exactly on its eye's topmost point and
					    over-covers on the other three sides; see the note above on why these are
					    unclipped. Eye extents: left 129–251 x 255–465, right 294–416 x 275–485. */}
					<rect className="boot-lid" x="119" y="255" width="142" height="222" fill="currentColor" />
					<rect className="boot-lid" x="284" y="275" width="142" height="222" fill="currentColor" />
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
