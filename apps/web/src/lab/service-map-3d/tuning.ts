/**
 * The 3D map's spatial and optical constants, in one place so the lab can put
 * them behind dials.
 *
 * Split out of `layout.ts`/`scene.tsx` rather than left as module constants
 * because they are exactly the numbers you want to feel your way to: how far
 * apart storeys have to sit before the plumbing reads, how much frame the graph
 * should fill, how fast a packet has to move to look like traffic rather than
 * decoration. Dependency-free, so `layout.test.ts` keeps running in jsdom.
 */

/** The subset `layoutGraph` needs — node positions only, no camera or optics. */
export interface Layout3DTuning {
	/** Vertical drop per storey, in world units. */
	readonly floorGap: number
	/** Radius of the circle the namespace columns stand on. */
	readonly floorRadius: number
	/** Gap between services of one namespace on one storey. */
	readonly clusterSpacing: number
	/** Radius of the innermost ring, in `rings` mode. */
	readonly ringInner: number
	/** Radius added per tier, in `rings` mode. */
	readonly ringGap: number
}

export interface ServiceMap3DTuning extends Layout3DTuning {
	readonly cameraFov: number
	/** Share of the frustum the graph should occupy after framing. */
	readonly frameFill: number
	readonly autoRotateSpeed: number
	/** Label height as a share of viewport height (labels do not attenuate). */
	readonly labelHeight: number
	readonly fogDensity: number
	readonly pipeOpacity: number
	/** Multiplier on every packet's own latency-derived speed. */
	readonly packetSpeed: number
}

export const SERVICE_MAP_3D_TUNING: ServiceMap3DTuning = {
	floorGap: 7,
	floorRadius: 13,
	clusterSpacing: 4.4,
	ringInner: 7,
	ringGap: 6.5,
	cameraFov: 46,
	frameFill: 0.9,
	autoRotateSpeed: 0.55,
	labelHeight: 0.045,
	fogDensity: 0.0125,
	pipeOpacity: 0.42,
	packetSpeed: 1,
}

/**
 * Identity of a laid-out graph: the camera re-frames when this changes, which
 * `layoutMode` alone cannot express once the spacing is dialable.
 */
export const layoutKey = (mode: string, tuning: Layout3DTuning): string =>
	`${mode}|${tuning.floorGap}|${tuning.floorRadius}|${tuning.clusterSpacing}|${tuning.ringInner}|${tuning.ringGap}`
