-- Pruebas del flujo completo: reserva, confirmación manual idempotente, check-in y permisos.
-- Cualquier fallo lanza una excepción y psql termina con error (ON_ERROR_STOP).

\set ON_ERROR_STOP on
set client_min_messages = warning;

-- Datos de prueba ------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'org@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'intruso@example.com');
insert into public.organizers (user_id) values ('00000000-0000-0000-0000-00000000000a');

insert into public.events (id, slug, name, venue, starts_at, price_cents, capacity, min_age, collect_birth_date, published, sales_open) values
  ('11111111-1111-4111-8111-111111111111', 'fiesta-test', 'Fiesta Test', 'Sala X', now() + interval '10 days', 1500, 3, 18, true, true, true),
  ('22222222-2222-4222-8222-222222222222', 'otro-evento', 'Otro evento', 'Sala Y', now() + interval '20 days', 1000, 10, null, false, true, true),
  ('33333333-3333-4333-8333-333333333333', 'borrador', 'Borrador', 'Sala Z', now() + interval '20 days', 1000, 10, null, true, false, false);

create temp table t_ctx (k text primary key, v text);
grant all on t_ctx to public;

-- 1. Reservas (service role, como la función create-order) ---------------------
set role service_role;

do $$
declare r jsonb; r2 jsonb;
begin
  r := public.create_order('fiesta-test', 'Ana López', 'ANA@example.com', '1990-05-01', 'bizum', 'v1');
  assert r->>'reference' ~ '^[A-HJ-NP-Z2-9]{6}$', 'referencia legible de 6 caracteres: ' || (r->>'reference');
  assert r->>'email' = 'ana@example.com', 'email normalizado';
  -- Doble envío del formulario: mismo pedido, misma referencia
  r2 := public.create_order('fiesta-test', 'Ana López', 'ana@example.com', '1990-05-01', 'bizum', 'v1');
  assert r2->>'order_id' = r->>'order_id', 'un doble envío no crea otro pedido';
  insert into t_ctx values ('order1', r->>'order_id');
end $$;

-- Edad mínima, fecha obligatoria, evento cerrado y aforo
do $$
begin
  begin
    perform public.create_order('fiesta-test', 'Peque', 'p@example.com', (now() - interval '15 years')::date, 'bizum', 'v1');
    assert false, 'too_young esperado';
  exception when raise_exception then assert sqlerrm = 'too_young', sqlerrm; end;
  begin
    perform public.create_order('fiesta-test', 'Sin fecha', 'p@example.com', null, 'bizum', 'v1');
    assert false, 'birth_date_required esperado';
  exception when raise_exception then assert sqlerrm = 'birth_date_required', sqlerrm; end;
  begin
    perform public.create_order('borrador', 'X', 'x@example.com', '1990-01-01', 'bizum', 'v1');
    assert false, 'event_not_available esperado';
  exception when raise_exception then assert sqlerrm = 'event_not_available', sqlerrm; end;
  begin
    perform public.create_order('fiesta-test', 'X', 'x@example.com', '1990-01-01', 'paypal', 'v1');
    assert false, 'método de pago no válido';
  exception when check_violation then null; end;

  -- aforo 3: Ana + B + C pendientes = lleno
  insert into t_ctx select 'orderB', (public.create_order('fiesta-test', 'B', 'b@example.com', '1990-01-01', 'transfer', 'v1'))->>'order_id';
  insert into t_ctx select 'orderC', (public.create_order('fiesta-test', 'C', 'c@example.com', '1990-01-01', 'bizum', 'v1'))->>'order_id';
  begin
    perform public.create_order('fiesta-test', 'D', 'd@example.com', '1990-01-01', 'bizum', 'v1');
    assert false, 'sold_out esperado';
  exception when raise_exception then assert sqlerrm = 'sold_out', sqlerrm; end;

  insert into t_ctx select 'order_other', (public.create_order('otro-evento', 'Eva', 'eva@example.com', null, 'transfer', 'v1'))->>'order_id';
end $$;

-- El service role no es organizador: no puede confirmar pagos
do $$
begin
  perform public.confirm_order((select v::uuid from t_ctx where k = 'order1'));
  assert false, 'confirm_order exige organizador';
exception when insufficient_privilege then null;
end $$;
reset role;

-- 2. Anónimos: solo ven eventos publicados, nada más -------------------------------
set role anon;
do $$
begin
  assert (select count(*) from public.events) = 2, 'anon solo ve eventos publicados';
  begin perform count(*) from public.tickets; assert false, 'anon no debe leer tickets';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from public.orders; assert false, 'anon no debe leer pedidos';
  exception when insufficient_privilege then null; end;
  begin perform public.confirm_order(gen_random_uuid()); assert false, 'anon no debe confirmar pagos';
  exception when insufficient_privilege then null; end;
  begin perform public.check_in('x', '11111111-1111-4111-8111-111111111111'); assert false, 'anon no debe hacer check-in';
  exception when insufficient_privilege then null; end;
  begin perform public.create_order('fiesta-test', 'X', 'x@example.com', '1990-01-01', 'bizum', 'v1');
    assert false, 'anon no debe llamar a create_order directamente';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 3. Usuario autenticado que NO es organizador -----------------------------------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
begin
  assert (select count(*) from public.orders) = 0, 'no organizador no ve pedidos';
  assert (select count(*) from public.tickets) = 0, 'no organizador no ve entradas';
  begin perform public.confirm_order((select v::uuid from t_ctx where k = 'order1'));
    assert false, 'no organizador no debe confirmar pagos';
  exception when insufficient_privilege then null; end;
  begin perform public.cancel_order((select v::uuid from t_ctx where k = 'order1'));
    assert false, 'no organizador no debe cancelar pedidos';
  exception when insufficient_privilege then null; end;
  begin update public.orders set status = 'paid';
    assert false, 'nadie debe actualizar pedidos directamente';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 4. Organizador: confirmar, cancelar, check-in -----------------------------------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  o1 uuid := (select v::uuid from t_ctx where k = 'order1');
  r1 jsonb; r2 jsonb;
begin
  assert (select count(*) from public.orders where status = 'pending') = 4, 'el organizador ve los pedidos pendientes';
  assert (select email from public.orders where id = o1) = 'ana@example.com', 've el email para cuadrar el pago';

  r1 := public.confirm_order(o1);
  r2 := public.confirm_order(o1);
  assert (r1->>'created')::boolean, 'la primera confirmación crea la entrada';
  assert not (r2->>'created')::boolean, 'la segunda NO crea otra entrada';
  assert r1->>'ticket_id' = r2->>'ticket_id', 'ambas devuelven la misma entrada';
  assert (select count(*) from public.tickets where order_id = o1) = 1, 'exactamente una entrada';
  assert (select status from public.orders where id = o1) = 'paid';
  assert (select name from public.orders where id = o1) is null, 'datos personales borrados del pedido';
  assert (r1->>'ticket_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'ID es UUID v4';
  insert into t_ctx values ('ticket1', r1->>'ticket_id');

  begin perform email from public.tickets;
    assert false, 'el email de la entrada no se expone a los móviles';
  exception when insufficient_privilege then null; end;

  -- Cancelar libera plaza; un pedido cancelado no se puede confirmar
  assert public.cancel_order((select v::uuid from t_ctx where k = 'orderC'));
  begin perform public.confirm_order((select v::uuid from t_ctx where k = 'orderC'));
    assert false, 'order_cancelled esperado';
  exception when raise_exception then assert sqlerrm = 'order_cancelled', sqlerrm; end;

  insert into t_ctx select 'ticket_other', (public.confirm_order((select v::uuid from t_ctx where k = 'order_other')))->>'ticket_id';
end $$;

-- Reserva caducada: se puede confirmar si queda aforo; si no, sold_out
reset role;
update public.orders set expires_at = now() - interval '1 hour' where id = (select v::uuid from t_ctx where k = 'orderB');
set role service_role;
insert into t_ctx select 'orderE', (public.create_order('fiesta-test', 'E', 'e@example.com', '1990-01-01', 'bizum', 'v1'))->>'order_id';
insert into t_ctx select 'orderF', (public.create_order('fiesta-test', 'F', 'f@example.com', '1990-01-01', 'bizum', 'v1'))->>'order_id';
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
begin
  -- aforo 3 = Ana (entrada) + E + F (pendientes vigentes): B caducó y ya no cabe
  perform public.confirm_order((select v::uuid from t_ctx where k = 'orderB'));
  assert false, 'sold_out esperado al confirmar una reserva caducada sin aforo';
exception when raise_exception then assert sqlerrm = 'sold_out', sqlerrm;
end $$;

do $$
declare
  ev uuid := '11111111-1111-4111-8111-111111111111';
  t  text := (select v from t_ctx where k = 'ticket1');
  r  jsonb;
begin
  r := public.check_in(t, ev);
  assert r->>'status' = 'ok', r::text;
  assert r->>'name' = 'Ana López', r::text;

  r := public.check_in(t, ev);
  assert r->>'status' = 'used', r::text;
  assert r->>'checked_in_at' is not null, r::text;

  r := public.check_in(gen_random_uuid()::text, ev);
  assert r->>'status' = 'invalid', r::text;

  r := public.check_in('https://evil.example/qr?name=Ana', ev);
  assert r->>'status' = 'invalid', r::text;

  r := public.check_in((select v from t_ctx where k = 'ticket_other'), ev);
  assert r->>'status' = 'wrong_event', r::text;
  assert r->>'event_name' = 'Otro evento', r::text;

  -- Reenvío con email corregido
  perform public.prepare_resend(t::uuid, ' NUEVO@example.com ');
  assert (select email_status from public.tickets where id = t::uuid) = 'pending';
end $$;

-- Sincronización offline: respeta la hora del escaneo, nunca una hora futura.
do $$
declare
  r jsonb;
begin
  r := public.check_in((select v from t_ctx where k = 'ticket_other'), '22222222-2222-4222-8222-222222222222', now() - interval '5 minutes');
  assert r->>'status' = 'ok', r::text;
  assert (r->>'checked_in_at')::timestamptz < now() - interval '4 minutes', r::text;
end $$;
reset role;

do $$
begin
  assert (select email from public.tickets where id = (select v::uuid from t_ctx where k = 'ticket1')) = 'nuevo@example.com';
end $$;

-- 5. RGPD: anonimización y limpieza ------------------------------------------------
update public.events set starts_at = now() - interval '40 days' where slug = 'fiesta-test';
update public.orders set expires_at = now() - interval '8 days' where id = (select v::uuid from t_ctx where k = 'orderE');
select public.anonymize_past_events(30) as anonimizadas \gset
do $$
begin
  assert (select count(*) from public.tickets where anonymized_at is not null) = 1;
  assert (select email from public.tickets where anonymized_at is not null) is null;
  assert (select status from public.orders where id = (select v::uuid from t_ctx where k = 'orderE')) = 'cancelled';
  assert (select name from public.orders where id = (select v::uuid from t_ctx where k = 'orderE')) is null;
end $$;

\echo 'OK: todas las pruebas SQL han pasado'
