-- Pruebas del flujo completo: reserva, pago idempotente, check-in y permisos.
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

-- 1. Reserva y pago idempotente ------------------------------------------------
set role service_role;

insert into t_ctx select 'order1', (public.create_order('fiesta-test', 'Ana López', 'ANA@example.com', '1990-05-01', 'v1'))->>'order_id';

do $$
declare r1 jsonb; r2 jsonb; n int; o uuid := (select v::uuid from t_ctx where k = 'order1');
begin
  r1 := public.fulfill_order(o, 'cs_test_1', 'pi_1', 1500);
  r2 := public.fulfill_order(o, 'cs_test_1', 'pi_1', 1500);
  assert (r1->>'created')::boolean, 'la primera entrega debe crear la entrada';
  assert not (r2->>'created')::boolean, 'la segunda entrega NO debe crear otra entrada';
  assert r1->>'ticket_id' = r2->>'ticket_id', 'ambas entregas devuelven la misma entrada';
  select count(*) into n from public.tickets where order_id = o;
  assert n = 1, 'debe existir exactamente una entrada';
  assert (select email from public.tickets where order_id = o) = 'ana@example.com', 'email normalizado';
  assert (select name from public.orders where id = o) is null, 'datos personales borrados del pedido';
  assert (select id::text from public.tickets where order_id = o) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'ID es UUID v4';
end $$;

insert into t_ctx select 'ticket1', id::text from public.tickets limit 1;

-- Pago con importe menor que el precio => error
do $$
declare o uuid;
begin
  o := (public.create_order('fiesta-test', 'Luis', 'luis@example.com', '1990-01-01', 'v1'))->>'order_id';
  begin
    perform public.fulfill_order(o, 'cs_test_2', 'pi_2', 100);
    assert false, 'amount_mismatch esperado';
  exception when raise_exception then
    assert sqlerrm = 'amount_mismatch', sqlerrm;
  end;
  perform public.expire_order(o);
  assert (select status from public.orders where id = o) = 'expired';
end $$;

-- 2. Edad mínima y aforo --------------------------------------------------------
do $$
begin
  begin
    perform public.create_order('fiesta-test', 'Peque', 'p@example.com', (now() - interval '15 years')::date, 'v1');
    assert false, 'too_young esperado';
  exception when raise_exception then
    assert sqlerrm = 'too_young', sqlerrm;
  end;
  begin
    perform public.create_order('fiesta-test', 'Sin fecha', 'p@example.com', null, 'v1');
    assert false, 'birth_date_required esperado';
  exception when raise_exception then
    assert sqlerrm = 'birth_date_required', sqlerrm;
  end;
  begin
    perform public.create_order('borrador', 'X', 'x@example.com', '1990-01-01', 'v1');
    assert false, 'event_not_available esperado';
  exception when raise_exception then
    assert sqlerrm = 'event_not_available', sqlerrm;
  end;
  -- aforo 3: 1 entrada + 2 reservas pendientes = lleno
  perform public.create_order('fiesta-test', 'B', 'b@example.com', '1990-01-01', 'v1');
  perform public.create_order('fiesta-test', 'C', 'c@example.com', '1990-01-01', 'v1');
  begin
    perform public.create_order('fiesta-test', 'D', 'd@example.com', '1990-01-01', 'v1');
    assert false, 'sold_out esperado';
  exception when raise_exception then
    assert sqlerrm = 'sold_out', sqlerrm;
  end;
end $$;

-- Entrada en otro evento, para probar wrong_event
do $$
declare o uuid;
begin
  o := (public.create_order('otro-evento', 'Eva', 'eva@example.com', null, 'v1'))->>'order_id';
  perform public.fulfill_order(o, 'cs_test_3', 'pi_3', 1000);
  insert into t_ctx select 'ticket_other', id::text from public.tickets where order_id = o;
end $$;

reset role;

-- 3. Anónimos: solo ven eventos publicados, nada más -------------------------------
set role anon;
do $$
begin
  assert (select count(*) from public.events) = 2, 'anon solo ve eventos publicados';
  begin
    perform count(*) from public.tickets;
    assert false, 'anon no debe leer tickets';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.orders;
    assert false, 'anon no debe leer orders';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.check_in('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111');
    assert false, 'anon no debe poder hacer check-in';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.fulfill_order(gen_random_uuid(), 'x', 'x', 1);
    assert false, 'anon no debe poder crear entradas';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.create_order('fiesta-test', 'X', 'x@example.com', '1990-01-01', 'v1');
    assert false, 'anon no debe llamar a create_order directamente';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- 4. Usuario autenticado que NO es organizador -----------------------------------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
begin
  assert (select count(*) from public.tickets) = 0, 'no organizador no ve entradas';
  begin
    perform public.check_in((select v from t_ctx where k = 'ticket1'), '11111111-1111-4111-8111-111111111111');
    assert false, 'no organizador no debe poder hacer check-in';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.tickets set checked_in_at = now();
    assert false, 'nadie debe poder actualizar tickets directamente';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- 5. Organizador ---------------------------------------------------------------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  ev uuid := '11111111-1111-4111-8111-111111111111';
  t  text := (select v from t_ctx where k = 'ticket1');
  r  jsonb;
begin
  assert (select count(*) from public.tickets) = 2, 'organizador ve todas las entradas';
  begin
    perform email from public.tickets;
    assert false, 'el organizador no necesita el email en el móvil';
  exception when insufficient_privilege then null;
  end;

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
end $$;

-- Sincronización offline: respeta la hora del escaneo, pero nunca una hora futura.
do $$
declare
  ev uuid := '22222222-2222-4222-8222-222222222222';
  t  text := (select v from t_ctx where k = 'ticket_other');
  r  jsonb;
begin
  r := public.check_in(t, ev, now() - interval '5 minutes');
  assert r->>'status' = 'ok', r::text;
  assert (r->>'checked_in_at')::timestamptz < now() - interval '4 minutes', r::text;
end $$;
reset role;

-- 6. RGPD: anonimización ---------------------------------------------------------
update public.events set starts_at = now() - interval '40 days' where slug = 'fiesta-test';
select public.anonymize_past_events(30) as anonimizadas \gset
do $$
begin
  assert (select count(*) from public.tickets where anonymized_at is not null) = 1;
  assert (select email from public.tickets where anonymized_at is not null) is null;
end $$;

\echo 'OK: todas las pruebas SQL han pasado'
