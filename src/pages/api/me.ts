import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user!; // middleware guarantees auth on /api/*
  return new Response(
    JSON.stringify({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      theme: user.theme,
      language: user.language,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
