export interface MaskingInstructionConfig {
	pattern: string
	maskWith: string
}

export class TemplateMinerConfig {
	drainDepth: number = 4
	drainSimTh: number = 0.4
	drainMaxChildren: number = 100
	drainMaxClusters: number | null = null
	drainExtraDelimiters: string[] = []
	maskPrefix: string = "<"
	maskSuffix: string = ">"
	maskingInstructions: MaskingInstructionConfig[] = []
	parametrizeNumericTokens: boolean = true
	parameterExtractionCacheCapacity: number = 3000
}
