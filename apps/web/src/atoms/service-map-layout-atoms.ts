import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

export interface ServiceMapLayout {
	positions: Record<string, { x: number; y: number }>
	viewport: { x: number; y: number; zoom: number } | null
}

const Position = Schema.Struct({ x: Schema.Number, y: Schema.Number })
const Viewport = Schema.Struct({ x: Schema.Number, y: Schema.Number, zoom: Schema.Number })

const ServiceMapLayoutSchema = Schema.Struct({
	positions: Schema.Record(Schema.String, Position),
	viewport: Schema.NullOr(Viewport),
}) as Schema.Codec<ServiceMapLayout>

const DEFAULT: ServiceMapLayout = { positions: {}, viewport: null }

export const serviceMapLayoutAtomFamily = Atom.family((orgId: string) =>
	Atom.kvs({
		runtime: localStorageRuntime,
		key: `maple.service-map.layout.${orgId}`,
		schema: ServiceMapLayoutSchema,
		defaultValue: () => DEFAULT,
	}),
)
