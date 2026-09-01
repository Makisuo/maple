import { LogCluster } from "./log-cluster"
import { LruCache } from "./lru-cache"
import { Node } from "./node"

/**
 * The child node at `key`, created when absent. Replaces the `has`-then-`get!`
 * pair the prefix-tree walk repeated nine times: the two calls could not tell
 * the type system they were about the same key.
 */
const childAt = (node: Node, key: string): Node => {
	const existing = node.keyToChildNode.get(key)
	if (existing !== undefined) return existing
	const created = new Node()
	node.keyToChildNode.set(key, created)
	return created
}

export class Drain {
	logClusterDepth: number
	private maxNodeDepth: number
	simTh: number
	maxChildren: number
	rootNode: Node
	extraDelimiters: string[]
	maxClusters: number | null
	paramStr: string
	parametrizeNumericTokens: boolean

	/**
	 * One store, not a nullable pair. `maxClusters` picks an LRU with eviction or
	 * an unbounded Map at construction and never changes it, so a union field
	 * says that where two mutually-exclusive nullable fields only implied it.
	 */
	private store: Map<number, LogCluster> | LruCache<LogCluster>
	clustersCounter: number

	constructor(
		depth: number = 4,
		simTh: number = 0.4,
		maxChildren: number = 100,
		maxClusters: number | null = null,
		extraDelimiters: string[] = [],
		paramStr: string = "<*>",
		parametrizeNumericTokens: boolean = true,
	) {
		if (depth < 3) {
			throw new Error("depth argument must be at least 3")
		}

		this.logClusterDepth = depth
		this.maxNodeDepth = depth - 2
		this.simTh = simTh
		this.maxChildren = maxChildren
		this.rootNode = new Node()
		this.extraDelimiters = extraDelimiters
		this.maxClusters = maxClusters
		this.paramStr = paramStr
		this.parametrizeNumericTokens = parametrizeNumericTokens
		this.clustersCounter = 0

		this.store =
			maxClusters !== null ? new LruCache<LogCluster>(maxClusters) : new Map<number, LogCluster>()
	}

	get clusterCount(): number {
		return this.store.size
	}

	/** Every live cluster, in whatever order the store holds them. */
	clusters(): LogCluster[] {
		return this.store instanceof LruCache ? this.store.values() : [...this.store.values()]
	}

	getTotalClusterSize(): number {
		let total = 0
		for (const cluster of this.clusters()) total += cluster.size
		return total
	}

	/** Read without updating recency — only the LRU distinguishes the two. */
	private clusterPeek(id: number): LogCluster | undefined {
		return this.store instanceof LruCache ? this.store.peek(id) : this.store.get(id)
	}

	private clusterGet(id: number): LogCluster | undefined {
		return this.store.get(id)
	}

	private clusterContains(id: number): boolean {
		return this.store.has(id)
	}

	private clusterInsert(id: number, cluster: LogCluster): void {
		if (this.store instanceof LruCache) {
			this.store.put(id, cluster)
		} else {
			this.store.set(id, cluster)
		}
	}

	private static hasNumbers(s: string): boolean {
		for (let i = 0; i < s.length; i++) {
			const c = s.charCodeAt(i)
			if (c >= 48 && c <= 57) return true
		}
		return false
	}

	getContentAsTokens(content: string): string[] {
		let c = content.trim()
		for (const delimiter of this.extraDelimiters) {
			c = c.split(delimiter).join(" ")
		}
		if (c.length === 0) return []
		return c.split(/\s+/)
	}

	getSeqDistance(seq1: string[], seq2: string[], includeParams: boolean): [number, number] {
		if (seq1.length !== seq2.length) {
			throw new Error("seq1 and seq2 must have equal length")
		}
		if (seq1.length === 0) return [1.0, 0]

		let simTokens = 0
		let paramCount = 0

		for (let i = 0; i < seq1.length; i++) {
			if (seq1[i] === this.paramStr) {
				paramCount++
				continue
			}
			if (seq1[i] === seq2[i]) {
				simTokens++
			}
		}

		if (includeParams) {
			simTokens += paramCount
		}

		return [simTokens / seq1.length, paramCount]
	}

	createTemplate(seq1: string[], seq2: string[]): string[] {
		if (seq1.length !== seq2.length) {
			throw new Error("seq1 and seq2 must have equal length")
		}
		return seq1.map((t1, i) => (t1 === seq2[i] ? seq2[i] : this.paramStr))
	}

	private fastMatch(
		clusterIds: number[],
		tokens: string[],
		simTh: number,
		includeParams: boolean,
	): number | null {
		let maxSim = -1
		let maxParamCount = -1
		let maxClusterId: number | null = null

		for (const cid of clusterIds) {
			const cluster = this.clusterPeek(cid)
			if (!cluster) continue
			const [curSim, paramCount] = this.getSeqDistance(cluster.logTemplateTokens, tokens, includeParams)
			if (curSim > maxSim || (curSim === maxSim && paramCount > maxParamCount)) {
				maxSim = curSim
				maxParamCount = paramCount
				maxClusterId = cid
			}
		}

		if (maxSim >= simTh) {
			return maxClusterId
		}
		return null
	}

	private treeSearch(tokens: string[], simTh: number, includeParams: boolean): number | null {
		const tokenCount = tokens.length
		const tokenCountStr = String(tokenCount)

		const firstNode = this.rootNode.keyToChildNode.get(tokenCountStr)
		if (!firstNode) return null

		if (tokenCount === 0) {
			const firstId = firstNode.clusterIds[0]
			return firstId !== undefined ? firstId : null
		}

		let curNode: Node = firstNode
		let curNodeDepth = 1
		for (const token of tokens) {
			if (curNodeDepth >= this.maxNodeDepth) break
			if (curNodeDepth >= tokenCount) break

			const child: Node | undefined = curNode.keyToChildNode.get(token)
			if (child) {
				curNode = child
			} else {
				const wildcardChild: Node | undefined = curNode.keyToChildNode.get(this.paramStr)
				if (wildcardChild) {
					curNode = wildcardChild
				} else {
					return null
				}
			}
			curNodeDepth++
		}

		return this.fastMatch(curNode.clusterIds, tokens, simTh, includeParams)
	}

	private addSeqToPrefixTree(clusterId: number, templateTokens: string[]): void {
		const tokenCount = templateTokens.length
		const tokenCountStr = String(tokenCount)

		let curNode = childAt(this.rootNode, tokenCountStr)

		if (tokenCount === 0) {
			curNode.clusterIds = [clusterId]
			return
		}

		let currentDepth = 1
		for (const token of templateTokens) {
			if (currentDepth >= this.maxNodeDepth || currentDepth >= tokenCount) {
				const newClusterIds = curNode.clusterIds.filter((cid) => this.clusterContains(cid))
				newClusterIds.push(clusterId)
				curNode.clusterIds = newClusterIds
				break
			}

			if (curNode.keyToChildNode.has(token)) {
				curNode = childAt(curNode, token)
			} else if (this.parametrizeNumericTokens && Drain.hasNumbers(token)) {
				curNode = childAt(curNode, this.paramStr)
			} else if (curNode.keyToChildNode.has(this.paramStr)) {
				curNode =
					curNode.keyToChildNode.size < this.maxChildren
						? childAt(curNode, token)
						: childAt(curNode, this.paramStr)
			} else if (curNode.keyToChildNode.size + 1 < this.maxChildren) {
				curNode = childAt(curNode, token)
			} else {
				// At the cap: the wildcard child is created here and absorbs every
				// token that would have pushed the fan-out past `maxChildren`.
				curNode = childAt(curNode, this.paramStr)
			}
			currentDepth++
		}
	}

	addLogMessage(content: string): [LogCluster, string] {
		const contentTokens = this.getContentAsTokens(content)
		const matchClusterId = this.treeSearch(contentTokens, this.simTh, false)
		// `fastMatch` only returns ids whose cluster it just read, so an id that no
		// longer resolves means the store was evicted from under a synchronous
		// call. Both cases are "no cluster to grow" — start a new one.
		const existingCluster = matchClusterId === null ? undefined : this.clusterPeek(matchClusterId)

		if (existingCluster === undefined) {
			this.clustersCounter++
			const clusterId = this.clustersCounter
			const cluster = new LogCluster(contentTokens, clusterId)
			this.clusterInsert(clusterId, cluster)
			this.addSeqToPrefixTree(clusterId, contentTokens)
			return [cluster, "cluster_created"]
		}

		const newTemplateTokens = this.createTemplate(contentTokens, existingCluster.logTemplateTokens)

		const updateType =
			newTemplateTokens.length === existingCluster.logTemplateTokens.length &&
			newTemplateTokens.every((t, i) => t === existingCluster.logTemplateTokens[i])
				? "none"
				: "cluster_template_changed"

		existingCluster.logTemplateTokens = newTemplateTokens
		existingCluster.size += 1

		// Touch to update LRU ordering
		this.clusterGet(existingCluster.clusterId)

		return [existingCluster, updateType]
	}

	private getClustersIdsForSeqLen(seqLen: number): number[] {
		const collectRecursive = (node: Node, ids: number[]): void => {
			ids.push(...node.clusterIds)
			for (const child of node.keyToChildNode.values()) {
				collectRecursive(child, ids)
			}
		}

		const key = String(seqLen)
		const node = this.rootNode.keyToChildNode.get(key)
		if (!node) return []
		const ids: number[] = []
		collectRecursive(node, ids)
		return ids
	}

	match(content: string, fullSearchStrategy: string = "never"): LogCluster | null {
		if (!["always", "never", "fallback"].includes(fullSearchStrategy)) {
			throw new Error(`Invalid full_search_strategy: ${fullSearchStrategy}`)
		}

		const contentTokens = this.getContentAsTokens(content)
		const requiredSimTh = 1.0

		const fullSearch = (): LogCluster | null => {
			const allIds = this.getClustersIdsForSeqLen(contentTokens.length)
			const matchedId = this.fastMatch(allIds, contentTokens, requiredSimTh, true)
			if (matchedId === null) return null
			return this.clusterPeek(matchedId) ?? null
		}

		if (fullSearchStrategy === "always") {
			return fullSearch()
		}

		const matchId = this.treeSearch(contentTokens, requiredSimTh, true)
		if (matchId !== null) {
			return this.clusterPeek(matchId) ?? null
		}

		if (fullSearchStrategy === "never") {
			return null
		}

		return fullSearch()
	}
}
