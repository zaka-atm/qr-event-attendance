import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import Stripe from "npm:stripe@17.7.0";

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

// Cliente con service role: salta RLS. Solo existe dentro de las Edge Functions.
export const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Sin apiVersion explícita: se usa la versión que fija la librería (estable al actualizar el paquete).
export const stripe = new Stripe(env("STRIPE_SECRET_KEY"), {
  httpClient: Stripe.createFetchHttpClient(),
});

export const SITE_URL = env("SITE_URL").replace(/\/$/, "");
export const EVENT_TIMEZONE = Deno.env.get("EVENT_TIMEZONE") ?? "Europe/Madrid";
