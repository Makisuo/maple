import { AsyncLocalStorage } from "node:async_hooks"
import { defineMiddleware } from "astro:middleware"
import { baseLocale, isLocale, locales, overwriteServerAsyncLocalStorage } from "./paraglide/runtime.js"

type Locale = (typeof locales)[number]

/**
 * Scopes the paraglide locale to the page being rendered. Astro renders pages
 * concurrently, so the locale must live in AsyncLocalStorage rather than a
 * module-level variable — a bare `setLocale` would bleed across pages.
 */
const localeStorage = new AsyncLocalStorage<{ locale: Locale }>()

overwriteServerAsyncLocalStorage({
	getStore: () => localeStorage.getStore(),
	run: (store, callback) => localeStorage.run(store, callback),
})

export const onRequest = defineMiddleware((context, next) => {
	const locale = isLocale(context.currentLocale) ? context.currentLocale : baseLocale
	return localeStorage.run({ locale }, () => next())
})
