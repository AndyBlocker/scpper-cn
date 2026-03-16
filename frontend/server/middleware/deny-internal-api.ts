/**
 * Block public access to /api/internal/** at the Nuxt edge.
 *
 * The BFF already requires x-internal-key for /internal routes, but this
 * middleware provides defense-in-depth by short-circuiting the request before
 * it even reaches the proxy layer.
 */
export default defineEventHandler((event) => {
  const path = event.path || getRequestURL(event).pathname;
  if (path === '/api/internal' || path.startsWith('/api/internal/')) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  }
});
