/**
 * Links into the dashboard app.
 *
 * The app root bounces a signed-out visitor to `/sign-in`, so every acquisition
 * CTA has to name `/sign-up` itself — "Start free trial" pointing at the bare
 * origin lands a visitor with no account on a login form.
 */
export const APP_URL = "https://app.maple.dev"
export const APP_SIGN_UP_URL = `${APP_URL}/sign-up`
export const APP_SIGN_IN_URL = `${APP_URL}/sign-in`
