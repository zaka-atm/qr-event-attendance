-- Datos de ejemplo. Ejecuta en el SQL Editor de Supabase y adapta los valores.

-- 1. Un evento (precio en céntimos). Pon published/sales_open a true cuando quieras abrir la venta.
insert into public.events (slug, name, venue, starts_at, price_cents, capacity, min_age, collect_birth_date, published, sales_open)
values ('fiesta-otono-2026', 'Fiesta de Otoño', 'Sala Principal, Madrid', '2026-10-18 22:00:00+02', 1500, 400, 18, true, true, true);

-- 2. Un organizador: créalo antes en Authentication > Users > Add user (email + contraseña)
--    y después dale permiso para validar entradas:
-- insert into public.organizers (user_id)
-- select id from auth.users where email = 'puerta1@tudominio.com';
