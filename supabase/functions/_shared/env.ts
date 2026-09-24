import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.1";

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

// Cliente con service role: salta RLS. Solo existe dentro de las Edge Functions.
export const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Cliente que actúa COMO el usuario que llama (su token de sesión). Postgres comprueba la firma del
 * token y las funciones SQL deciden con is_organizer() si puede hacer la operación.
 */
export function asCaller(req: Request): SupabaseClient | null {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: auth } },
  });
}

export const SITE_URL = env("SITE_URL").replace(/\/$/, "");
export const EVENT_TIMEZONE = Deno.env.get("EVENT_TIMEZONE") ?? "Europe/Madrid";

/** Datos para que el comprador pague. Se muestran en la web y en el email. */
export function paymentDetails() {
  return {
    bizum_phone: Deno.env.get("BIZUM_PHONE") ?? "",
    iban: Deno.env.get("BANK_IBAN") ?? "",
    holder: Deno.env.get("BANK_HOLDER") ?? env("ORGANIZER_NAME"),
  };
}
