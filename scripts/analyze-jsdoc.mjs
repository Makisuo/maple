#!/usr/bin/env node

import * as Fs from "node:fs"
import * as Path from "node:path"
import * as Process from "node:process"

// Parse command line arguments
const args = Process.argv.slice(2)
const fileFilter = args.find((arg) => arg.startsWith("--file="))?.replace("--file=", "")

/**
 * Analyzes TypeScript files for missing JSDoc examples and category tags
 */
class JSDocAnalyzer {
  constructor() {
    this.results = {
      totalFiles: 0,
      totalExports: 0,
      missingExamples: 0,
      missingCategories: 0,
      fileDetails: [],
      missingItems: []
    }
  }

  /**
   * Get all TypeScript files in the effect/src directory (including schema subdirectory)
   */
  getEffectFiles() {
    const effectSrcDir = Path.join(Process.cwd(), "packages/effect/src")
    const files = Fs.readdirSync(effectSrcDir)
    const allFiles = []

    // Add root level files
    files
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => {
        // Only include files, not directories
        const fullPath = Path.join(effectSrcDir, file)
        return Fs.statSync(fullPath).isFile()
      })
      .forEach((file) => allFiles.push(Path.join(effectSrcDir, file)))

    // Add schema subdirectory files
    const schemaDir = Path.join(effectSrcDir, "schema")
    if (Fs.existsSync(schemaDir)) {
      const schemaFiles = Fs.readdirSync(schemaDir)
      schemaFiles
        .filter((file) => file.endsWith(".ts"))
        .filter((file) => !file.endsWith(".test.ts"))
        .filter((file) => {
          const fullPath = Path.join(schemaDir, file)
          return Fs.statSync(fullPath).isFile()
        })
        .forEach((file) => allFiles.push(Path.join(schemaDir, file)))
    }

    // Add config subdirectory files
    const configDir = Path.join(effectSrcDir, "config")
    if (Fs.existsSync(configDir)) {
      const configFiles = Fs.readdirSync(configDir)
      configFiles
        .filter((file) => file.endsWith(".ts"))
        .filter((file) => !file.endsWith(".test.ts"))
        .filter((file) => {
          const fullPath = Path.join(configDir, file)
          return Fs.statSync(fullPath).isFile()
        })
        .forEach((file) => allFiles.push(Path.join(configDir, file)))
    }

    return allFiles
  }

  /**
   * Extract exported members from a TypeScript file using more comprehensive parsing
   */
  extractExports(content, filename) {
    const exports = []
    const lines = content.split("\n")
    const processedFunctions = new Set() // Track functions to avoid counting overloads

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Skip comments and empty lines
      if (line.startsWith("//") || line.startsWith("*") || !line) continue

      // More comprehensive export patterns including multi-line declarations
      // Note: Using [\w$]+ to include $ character in export names (e.g., Array$, Object$)
      const exportPatterns = [
        /^export\s+const\s+([\w$]+)[\s:=]/,
        /^export\s+function\s+([\w$]+)\s*[(<]/,
        /^export\s+type\s+([\w$]+)[\s=<]/,
        /^export\s+interface\s+([\w$]+)[\s<{]/,
        /^export\s+class\s+([\w$]+)[\s<{]/,
        /^export\s+enum\s+([\w$]+)[\s{]/,
        /^export\s+namespace\s+([\w$]+)[\s{]/,
        /^export\s+declare\s+const\s+([\w$]+)[\s:]/,
        /^export\s+declare\s+function\s+([\w$]+)\s*[(<]/,
        /^export\s+declare\s+type\s+([\w$]+)[\s=<]/,
        /^export\s+declare\s+interface\s+([\w$]+)[\s<{]/,
        /^export\s+declare\s+class\s+([\w$]+)[\s<{]/,
        /^export\s+declare\s+enum\s+([\w$]+)[\s{]/,
        /^export\s+declare\s+namespace\s+([\w$]+)[\s{]/,
        // Handle object destructuring exports
        /^export\s+\{\s*([\w$]+)/
      ]

      for (const pattern of exportPatterns) {
        const match = line.match(pattern)
        if (match) {
          const exportName = match[1]

          // Skip re-exports and internal exports
          if (line.includes("from ") || exportName.startsWith("_")) {
            continue
          }

          // Skip certain common re-export patterns
          if (line.includes("export {") && line.includes("}")) {
            continue
          }

          // For function overloads, only count the first declaration (with JSDoc)
          if (line.includes("function ")) {
            if (processedFunctions.has(exportName)) {
              continue // Skip this overload
            }
            processedFunctions.add(exportName)
          }

          // Find associated JSDoc block
          const jsdoc = this.findJSDocBlock(lines, i)

          // Skip internal exports - they don't need categories or examples
          if (jsdoc.isInternal) {
            break
          }

          const exportType = this.getExportType(line)

          const effectSrcDir = Path.join(Process.cwd(), "packages/effect/src")
          exports.push({
            name: exportName,
            line: i + 1,
            type: exportType,
            hasExample: jsdoc.hasExample,
            hasCategory: jsdoc.hasCategory,
            jsdocStart: jsdoc.start,
            filename: Path.relative(effectSrcDir, filename),
            exportLine: line
          })
          break
        }
      }
    }

    return exports
  }

  /**
   * Find JSDoc block preceding an export - improved to handle gaps and better detection
   */
  findJSDocBlock(lines, exportLineIndex) {
    let hasExample = false
    let hasCategory = false
    let isInternal = false
    let jsdocStartLine = -1
    let jsdocEndLine = -1
    let emptyLinesCount = 0

    // Look backwards for JSDoc block, allowing for empty lines
    for (let i = exportLineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim()

      // Empty line - count them but continue searching
      if (!line) {
        emptyLinesCount++
        // Allow up to 3 empty lines between JSDoc and export
        if (emptyLinesCount > 3 && jsdocEndLine === -1) {
          break
        }
        continue
      }

      // Reset empty line count when we find content
      if (line) {
        emptyLinesCount = 0
      }

      // End of JSDoc block
      if (line === "*/") {
        jsdocEndLine = i
        continue
      }

      // Start of JSDoc block
      if (line.startsWith("/**")) {
        jsdocStartLine = i

        // Single line JSDoc /** comment */
        if (line.endsWith("*/")) {
          if (line.includes("@example")) hasExample = true
          if (line.includes("@category")) hasCategory = true
          if (line.includes("@internal")) isInternal = true
          break
        }

        // Multi-line JSDoc block - scan the entire block
        // Note: jsdocEndLine is found first (going backwards), then jsdocStartLine
        if (jsdocEndLine !== -1) {
          for (let j = jsdocStartLine; j <= jsdocEndLine; j++) {
            const blockLine = lines[j].trim()
            if (blockLine.includes("@example")) {
              hasExample = true
            }
            if (blockLine.includes("@category")) {
              hasCategory = true
            }
            if (blockLine.includes("@internal")) {
              isInternal = true
            }
          }
        }
        break
      }

      // Hit another export/declaration - stop searching if we haven't found JSDoc yet
      if (
        line && (line.startsWith("export ") ||
          line.startsWith("import ") ||
          line.startsWith("const ") ||
          line.startsWith("function ") ||
          line.startsWith("class ") ||
          line.startsWith("interface ") ||
          line.startsWith("type ") ||
          line.startsWith("enum "))
      ) {
        break
      }
    }

    return { hasExample, hasCategory, isInternal, start: jsdocStartLine }
  }

  /**
   * Determine the type of export with better detection
   */
  getExportType(line) {
    if (line.includes("const ")) return "const"
    if (line.includes("function ")) return "function"
    if (line.includes("type ")) return "type"
    if (line.includes("interface ")) return "interface"
    if (line.includes("class ")) return "class"
    if (line.includes("enum ")) return "enum"
    if (line.includes("namespace ")) return "namespace"
    if (line.includes("declare ")) return "declare"
    return "unknown"
  }

  /**
   * Analyze a single file
   */
  analyzeFile(filepath) {
    const content = Fs.readFileSync(filepath, "utf8")
    const effectSrcDir = Path.join(Process.cwd(), "packages/effect/src")
    const filename = Path.relative(effectSrcDir, filepath)
    const exports = this.extractExports(content, filepath)

    const fileStats = {
      filename,
      totalExports: exports.length,
      missingExamples: exports.filter((e) => !e.hasExample).length,
      missingCategories: exports.filter((e) => !e.hasCategory).length,
      exports: exports.map((e) => ({
        name: e.name,
        type: e.type,
        line: e.line,
        hasExample: e.hasExample,
        hasCategory: e.hasCategory
      }))
    }

    // Track missing items for detailed reporting
    exports.forEach((exp) => {
      if (!exp.hasExample || !exp.hasCategory) {
        this.results.missingItems.push({
          file: filename,
          name: exp.name,
          type: exp.type,
          line: exp.line,
          missingExample: !exp.hasExample,
          missingCategory: !exp.hasCategory
        })
      }
    })

    return fileStats
  }

  /**
   * Run analysis on all Effect source files or a specific file
   */
  analyze(targetFile = null) {
    const files = this.getEffectFiles()

    if (targetFile) {
      const targetPath = Path.join(Process.cwd(), "packages/effect/src", targetFile)

      if (!files.includes(targetPath)) {
        Process.stdout.write(`Error: File '${targetFile}' not found.\n`)
        Process.stdout.write(`Use relative paths from packages/effect/src/:\n`)
        Process.stdout.write(`  - For root files: Effect.ts, Array.ts, etc.\n`)
        Process.stdout.write(`  - For schema files: schema/Schema.ts, schema/AST.ts, etc.\n`)
        Process.stdout.write(`  - For config files: config/Config.ts, config/ConfigError.ts, etc.\n\n`)
        Process.stdout.write(`Available files:\n`)
        const effectSrcDir = Path.join(Process.cwd(), "packages/effect/src")
        files.forEach((f) => {
          const relativePath = Path.relative(effectSrcDir, f)
          Process.stdout.write(`  ${relativePath}\n`)
        })
        return
      }

      // Analyze only the target file
      const fileStats = this.analyzeFile(targetPath)
      this.generateFileReport(fileStats)
      return
    }

    Process.stdout.write(
      `Analyzing ${files.length} TypeScript files in packages/effect/src/ (including schema and config subdirectories)...\n\n`
    )

    this.results.totalFiles = files.length

    for (const filepath of files) {
      const fileStats = this.analyzeFile(filepath)
      this.results.fileDetails.push(fileStats)

      this.results.totalExports += fileStats.totalExports
      this.results.missingExamples += fileStats.missingExamples
      this.results.missingCategories += fileStats.missingCategories
    }

    this.generateReport()
  }

  /**
   * Generate report for a single file
   */
  generateFileReport(fileStats) {
    const { exports, filename, missingCategories, missingExamples, totalExports } = fileStats

    Process.stdout.write("=".repeat(60) + "\n")
    Process.stdout.write(`         ${filename.toUpperCase()} DOCUMENTATION REPORT\n`)
    Process.stdout.write("=".repeat(60) + "\n\n")

    // Summary
    Process.stdout.write("📊 SUMMARY\n")
    Process.stdout.write("-".repeat(20) + "\n")
    Process.stdout.write(`Total exports: ${totalExports}\n`)
    Process.stdout.write(
      `Missing examples: ${missingExamples} (${((missingExamples / totalExports) * 100).toFixed(1)}%)\n`
    )
    Process.stdout.write(
      `Missing categories: ${missingCategories} (${((missingCategories / totalExports) * 100).toFixed(1)}%)\n\n`
    )

    // Missing examples
    if (missingExamples > 0) {
      Process.stdout.write("📝 MISSING EXAMPLES\n")
      Process.stdout.write("-".repeat(30) + "\n")
      const missingExampleItems = exports.filter((e) => !e.hasExample)
      missingExampleItems.forEach((item, index) => {
        Process.stdout.write(`${index + 1}. ${item.name} (${item.type}) - Line ${item.line}\n`)
      })
      Process.stdout.write("\n")
    }

    // Missing categories
    if (missingCategories > 0) {
      Process.stdout.write("🏷️  MISSING CATEGORIES\n")
      Process.stdout.write("-".repeat(30) + "\n")
      const missingCategoryItems = exports.filter((e) => !e.hasCategory)
      missingCategoryItems.forEach((item, index) => {
        Process.stdout.write(`${index + 1}. ${item.name} (${item.type}) - Line ${item.line}\n`)
      })
      Process.stdout.write("\n")
    }

    // Breakdown by type
    Process.stdout.write("📋 BREAKDOWN BY TYPE\n")
    Process.stdout.write("-".repeat(25) + "\n")
    const typeStats = {}
    exports.forEach((exp) => {
      if (!typeStats[exp.type]) {
        typeStats[exp.type] = { total: 0, missingExample: 0, missingCategory: 0 }
      }
      typeStats[exp.type].total++
      if (!exp.hasExample) typeStats[exp.type].missingExample++
      if (!exp.hasCategory) typeStats[exp.type].missingCategory++
    })

    Object.entries(typeStats).forEach(([type, stats]) => {
      Process.stdout.write(
        `${type}: ${stats.total} total, ${stats.missingExample} missing examples, ${stats.missingCategory} missing categories\n`
      )
    })

    Process.stdout.write("\n" + "=".repeat(60) + "\n")
    Process.stdout.write(`Analysis complete for ${filename}!\n`)
    Process.stdout.write("=".repeat(60) + "\n")
  }

  /**
   * Generate comprehensive analysis report
   */
  generateReport() {
    const { fileDetails, missingCategories, missingExamples, missingItems, totalExports, totalFiles } = this.results

    Process.stdout.write("=".repeat(60) + "\n")
    Process.stdout.write("         EFFECT JSDOC ANALYSIS REPORT\n")
    Process.stdout.write("=".repeat(60) + "\n")
    Process.stdout.write("\n")

    // Summary Statistics
    Process.stdout.write("📊 SUMMARY STATISTICS\n")
    Process.stdout.write("-".repeat(30) + "\n")
    Process.stdout.write(`Total files analyzed: ${totalFiles}\n`)
    Process.stdout.write(`Total exported members: ${totalExports}\n`)
    Process.stdout.write(
      `Missing @example: ${missingExamples} (${((missingExamples / totalExports) * 100).toFixed(1)}%)\n`
    )
    Process.stdout.write(
      `Missing @category: ${missingCategories} (${((missingCategories / totalExports) * 100).toFixed(1)}%)\n`
    )
    Process.stdout.write("\n")

    // Top files needing attention (sorted by total missing items)
    Process.stdout.write("🎯 TOP FILES NEEDING ATTENTION\n")
    Process.stdout.write("-".repeat(40) + "\n")
    const sortedFiles = fileDetails
      .filter((f) => f.missingExamples > 0 || f.missingCategories > 0)
      .sort((a, b) => (b.missingExamples + b.missingCategories) - (a.missingExamples + a.missingCategories))
      .slice(0, 15)

    sortedFiles.forEach((file, index) => {
      Process.stdout.write(`${index + 1}. ${file.filename}\n`)
      Process.stdout.write(
        `   📝 ${file.missingExamples} missing examples, 🏷️  ${file.missingCategories} missing categories\n`
      )
      Process.stdout.write(`   📦 ${file.totalExports} total exports\n`)
    })

    Process.stdout.write("\n")

    // Files with perfect documentation
    const perfectFiles = fileDetails.filter((f) => f.missingExamples === 0 && f.missingCategories === 0)
    if (perfectFiles.length > 0) {
      Process.stdout.write("✅ PERFECTLY DOCUMENTED FILES\n")
      Process.stdout.write("-".repeat(35) + "\n")
      perfectFiles.forEach((file) => {
        Process.stdout.write(`   ${file.filename} (${file.totalExports} exports)\n`)
      })
      Process.stdout.write("\n")
    }

    // Show a sample of missing items for the top file
    if (sortedFiles.length > 0) {
      const topFile = sortedFiles[0]
      const topFileMissingItems = missingItems.filter((item) => item.file === topFile.filename).slice(0, 10)
      if (topFileMissingItems.length > 0) {
        Process.stdout.write(`🔍 SAMPLE MISSING ITEMS FROM ${topFile.filename}\n`)
        Process.stdout.write("-".repeat(35) + "\n")
        topFileMissingItems.forEach((item) => {
          const missing = []
          if (item.missingExample) missing.push("example")
          if (item.missingCategory) missing.push("category")
          Process.stdout.write(`   ${item.name} (${item.type}, line ${item.line}): missing ${missing.join(", ")}\n`)
        })
        Process.stdout.write("\n")
      }
    }

    // Detailed breakdown by type
    Process.stdout.write("📋 BREAKDOWN BY EXPORT TYPE\n")
    Process.stdout.write("-".repeat(35) + "\n")
    const typeStats = {}
    missingItems.forEach((item) => {
      if (!typeStats[item.type]) {
        typeStats[item.type] = { total: 0, missingExample: 0, missingCategory: 0 }
      }
      typeStats[item.type].total++
      if (item.missingExample) typeStats[item.type].missingExample++
      if (item.missingCategory) typeStats[item.type].missingCategory++
    })

    Object.entries(typeStats).forEach(([type, stats]) => {
      Process.stdout.write(
        `${type}: ${stats.missingExample} missing examples, ${stats.missingCategory} missing categories\n`
      )
    })

    Process.stdout.write("\n")

    // Progress tracking
    const documentedExamples = totalExports - missingExamples
    const documentedCategories = totalExports - missingCategories
    Process.stdout.write("📈 DOCUMENTATION PROGRESS\n")
    Process.stdout.write("-".repeat(30) + "\n")
    Process.stdout.write(
      `Examples: ${documentedExamples}/${totalExports} (${
        ((documentedExamples / totalExports) * 100).toFixed(1)
      }% complete)\n`
    )
    Process.stdout.write(
      `Categories: ${documentedCategories}/${totalExports} (${
        ((documentedCategories / totalExports) * 100).toFixed(1)
      }% complete)\n`
    )
    Process.stdout.write("\n")

    Process.stdout.write("=".repeat(60) + "\n")
    Process.stdout.write(`Analysis complete! ${missingExamples + missingCategories} items need attention.\n`)
    Process.stdout.write("=".repeat(60) + "\n")

    // Save detailed results to JSON for further analysis
    const outputFile = "jsdoc-analysis-results.json"
    Fs.writeFileSync(outputFile, JSON.stringify(this.results, null, 2))
    Process.stdout.write(`\n📄 Detailed results saved to: ${outputFile}\n`)
  }
}

// Run the analysis
const analyzer = new JSDocAnalyzer()
analyzer.analyze(fileFilter)
