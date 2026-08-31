/**
 * The 3D map's dial panel.
 *
 * Kept out of `tuning.ts` so the defaults stay importable by `layout.ts` and
 * its jsdom test without dragging dialkit in. The returned object is memoised
 * on the individual values: `useDialKit` hands back a fresh object every
 * render, and the scene re-lays the whole graph out when `tuning` changes
 * identity.
 */
import { useMemo } from "react"
import { useDialKit } from "dialkit"

import { SERVICE_MAP_3D_TUNING as D, type ServiceMap3DTuning } from "./tuning"

export function useServiceMap3DTuning(): ServiceMap3DTuning {
	const dials = useDialKit(
		"Service map 3D",
		{
			layout: {
				floorGap: [D.floorGap, 2, 18, 0.1],
				floorRadius: [D.floorRadius, 4, 32, 0.1],
				clusterSpacing: [D.clusterSpacing, 1.5, 12, 0.1],
				ringInner: [D.ringInner, 2, 24, 0.1],
				ringGap: [D.ringGap, 1, 18, 0.1],
			},
			camera: {
				cameraFov: [D.cameraFov, 20, 90, 1],
				frameFill: [D.frameFill, 0.5, 1.2, 0.01],
				autoRotateSpeed: [D.autoRotateSpeed, 0.05, 4, 0.05],
			},
			look: {
				labelHeight: [D.labelHeight, 0.015, 0.12, 0.001],
				fogDensity: [D.fogDensity, 0, 0.05, 0.0005],
				pipeOpacity: [D.pipeOpacity, 0.05, 1, 0.01],
				packetSpeed: [D.packetSpeed, 0, 4, 0.05],
			},
		},
		// A stable id, so the persisted values survive a render-tree change:
		// without one the panel is keyed by `useId`, which is positional.
		{ id: "service-map-3d", persist: true },
	)

	const { layout, camera, look } = dials
	return useMemo(
		() => ({
			floorGap: layout.floorGap,
			floorRadius: layout.floorRadius,
			clusterSpacing: layout.clusterSpacing,
			ringInner: layout.ringInner,
			ringGap: layout.ringGap,
			cameraFov: camera.cameraFov,
			frameFill: camera.frameFill,
			autoRotateSpeed: camera.autoRotateSpeed,
			labelHeight: look.labelHeight,
			fogDensity: look.fogDensity,
			pipeOpacity: look.pipeOpacity,
			packetSpeed: look.packetSpeed,
		}),
		[
			layout.floorGap,
			layout.floorRadius,
			layout.clusterSpacing,
			layout.ringInner,
			layout.ringGap,
			camera.cameraFov,
			camera.frameFill,
			camera.autoRotateSpeed,
			look.labelHeight,
			look.fogDensity,
			look.pipeOpacity,
			look.packetSpeed,
		],
	)
}
