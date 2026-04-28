const { getDefaultConfig } = require("expo/metro-config")
const { withUniwindConfig } = require("uniwind/metro")
const path = require("path")

const projectRoot = __dirname
const monorepoRoot = path.resolve(projectRoot, "../..")

const config = getDefaultConfig(projectRoot)

// Monorepo: watch files outside this package
config.watchFolders = [monorepoRoot]

// Monorepo: resolve packages from both project and root node_modules
config.resolver.nodeModulesPaths = [
	path.resolve(projectRoot, "node_modules"),
	path.resolve(monorepoRoot, "node_modules"),
]

// Block other apps' node_modules so Metro doesn't resolve wrong versions
config.resolver.blockList = [/apps\/web\/node_modules\/.*/]

module.exports = withUniwindConfig(config, {
	cssEntryFile: "./global.css",
})
