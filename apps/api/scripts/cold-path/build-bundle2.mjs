import { createRequire } from 'module'
import { realpathSync } from 'fs'
const alch = realpathSync(process.cwd() + '/node_modules/alchemy')
const req = createRequire(alch + '/package.json')
const { rolldown } = await import(req.resolve('rolldown'))
const cfMod = await import(req.resolve('@distilled.cloud/cloudflare-rolldown-plugin'))
const cloudflareRolldown = cfMod.default
console.log('rolldown from:', req.resolve('rolldown'))

const seo = process.env.SEO
const out = process.env.OUT ?? 'bundle-out'
const build = await rolldown({
  input: 'apps/api/src/worker.ts',
  external: ['lightningcss', 'fsevents'],
  plugins: [
    cloudflareRolldown({ compatibilityDate: '2026-04-08', compatibilityFlags: ['nodejs_compat'] }),
  ],
  checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
})
await build.write({
  format: 'esm',
  sourcemap: 'hidden',
  minify: true,
  keepNames: true,
  dir: out,
  ...(seo === undefined ? {} : { strictExecutionOrder: seo === '1' }),
})
console.log('built', out)
