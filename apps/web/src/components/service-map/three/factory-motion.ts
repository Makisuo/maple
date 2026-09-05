import { useMemo } from "react"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { useMountEffect } from "@/hooks/use-mount-effect"
import type { FactoryLink } from "./factory-routing"

const SAMPLES = 512
const programKey = () => "factory-flow-v1"

/** Bake routes once. The GPU moves each instance; a frame only advances one
 * uniform, with no per-crate matrix uploads or curve sampling on the CPU. */
function routeTexture(curve: THREE.Curve<THREE.Vector3>) {
	const data = new Float32Array(SAMPLES * 8)
	for (let i = 0; i < SAMPLES; i++) {
		const progress = i / (SAMPLES - 1)
		const position = curve.getPointAt(progress)
		const tangent = curve.getTangentAt(progress)
		data.set([position.x, position.y, position.z, 1], i * 4)
		data.set([tangent.x, tangent.y, tangent.z, 1], (SAMPLES + i) * 4)
	}
	const texture = new THREE.DataTexture(data, SAMPLES, 2, THREE.RGBAFormat, THREE.FloatType)
	texture.needsUpdate = true
	return texture
}

const declarations = /* glsl */ `
attribute float factoryPhase;
uniform sampler2D factoryRoute;
uniform float factoryTime;
uniform float factoryPeriod;
uniform float factoryLift;
uniform float factoryUnload;

vec3 factorySample(float progress, float row) {
	float index = clamp(progress, 0.0, 1.0) * ${SAMPLES - 1}.0;
	float left = floor(index);
	vec3 a = texture2D(factoryRoute, vec2((left + 0.5) / ${SAMPLES}.0, row)).xyz;
	vec3 b = texture2D(factoryRoute, vec2((min(left + 1.0, ${SAMPLES - 1}.0) + 0.5) / ${SAMPLES}.0, row)).xyz;
	return mix(a, b, fract(index));
}
`

const placement = /* glsl */ `
float factoryCycle = mod(factoryPhase + factoryTime / factoryPeriod, 1.0);
float factoryTravel = mix(1.0, 0.86, factoryUnload);
float factoryProgress = min(factoryCycle / factoryTravel, 1.0);
float factoryDrop = max(0.0, (factoryCycle - 0.86) / 0.14) * factoryUnload;
vec3 factoryCenter = factorySample(factoryProgress, 0.25);
vec3 factoryDirection = normalize(factorySample(factoryProgress, 0.75));
vec2 factoryHeading = normalize(factoryDirection.xz + vec2(0.0, 0.00001));
mat3 factoryRotation = mat3(
	factoryHeading.y, 0.0, -factoryHeading.x,
	0.0, 1.0, 0.0,
	factoryHeading.x, 0.0, factoryHeading.y
);
factoryCenter += factoryDirection * factoryDrop * 0.7;
factoryCenter.y += factoryLift - factoryDrop * factoryDrop * 0.6;
float factoryScale = 1.0 - pow(factoryDrop, 5.0);
`

export function useFactoryMotion(
	link: FactoryLink,
	running: boolean,
	count: number,
	period: number,
	lift = 0,
	unload = false,
) {
	const texture = useMemo(() => routeTexture(link.curve), [link.curve])
	const phases = useMemo(() => Float32Array.from({ length: count }, (_, i) => i / count), [count])
	const uniforms = useMemo(
		() => ({
			factoryRoute: { value: texture },
			factoryTime: { value: 0 },
			factoryPeriod: { value: period },
			factoryLift: { value: lift },
			factoryUnload: { value: Number(unload) },
		}),
		[texture, period, lift, unload],
	)
	useMountEffect(() => () => texture.dispose())
	useFrame((_, delta) => {
		if (running) uniforms.factoryTime.value += Math.min(delta, 0.05)
	})
	const onBeforeCompile = useMemo(
		() => (shader: Parameters<THREE.Material["onBeforeCompile"]>[0]) => {
			Object.assign(shader.uniforms, uniforms)
			shader.vertexShader = shader.vertexShader
				.replace("#include <common>", `#include <common>\n${declarations}`)
				.replace("void main() {", `void main() {\n${placement}`)
				.replace(
					"#include <beginnormal_vertex>",
					"#include <beginnormal_vertex>\nobjectNormal = factoryRotation * objectNormal;",
				)
				.replace(
					"#include <begin_vertex>",
					"#include <begin_vertex>\ntransformed = factoryCenter + factoryRotation * transformed * factoryScale;",
				)
		},
		[uniforms],
	)
	return { phases, material: { onBeforeCompile, customProgramCacheKey: programKey } }
}
