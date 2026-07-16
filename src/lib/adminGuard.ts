/** Admin-only route guard. */
export function requireAdmin(locals: App.Locals): Response | null {
  if (locals.user?.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Admin access required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}
