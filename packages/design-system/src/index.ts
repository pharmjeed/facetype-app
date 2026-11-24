/**
 * FaceType AI design system — tokens and shared microcopy (FT-07).
 *
 * Framework-agnostic on purpose: the mobile app is React Native and the
 * research console is Next.js, and both must render the same colours, spacing
 * and Arabic copy without one importing the other's runtime.
 */

export * from './microcopy.ts';
export * from './tokens.ts';
