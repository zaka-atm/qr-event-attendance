-- Esquema inicial: eventos, pedidos pendientes de pago, entradas y organizadores.
--
-- Principios:
--   * Las entradas solo se crean desde el webhook de Stripe (fulfill_order), nunca desde el cliente.
--   * Los IDs de entrada son UUID v4 aleatorios (gen_random_uuid), nunca secuenciales.
--   * El check-in es un único UPDATE atómico condicionado a checked_in_at IS NULL.
--   * Los usuarios anónimos solo pueden leer eventos publicados. Todo lo demás pasa por
--     funciones SECURITY DEFINER con permisos explícitos.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------

create table public.events (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique check (slug ~ '^[a-z0-9-]{3,60}$'),
  name               text not null,
  venue              text not null,
  starts_at          timestamptz not null,
  price_cents        integer not null check (price_cents >= 50),
  currency           text not null default 'eur',
  capacity           integer not null check (capacity > 0),
  min_age            integer check (min_age between 0 and 99),
  -- RGPD: pide la fecha de nacimiento solo si el evento la necesita.
  collect_birth_date boolean not null default true,
  published          boolean not null default false,
  sales_open         boolean not null default false,
  created_at         timestamptz not null default now(),
  check (min_age is null or collect_birth_date)
);

-- Un pedido es una reserva mientras el comprador paga en Stripe. No es una entrada.
create table public.orders (
  id                   uuid primary key default gen_random_uuid(),
  event_id             uuid not null references public.events(id) on delete restrict,
  status               text not null default 'pending' check (status in ('pending', 'paid', 'expired')),
  -- Datos personales: se mueven a la entrada al pagar y aquí se borran (null).
  name                 text,
  email                text,
  birth_date           date,
  consent_at           timestamptz not null,
  consent_version      text not null,
  amount_cents         integer not null,
  currency             text not null,
  stripe_session_id    text unique,
  stripe_payment_intent text,
  expires_at           timestamptz not null,
  paid_at              timestamptz,
  created_at           timestamptz not null default now()
);

create index orders_event_pending_idx on public.orders (event_id) where status = 'pending';

create table public.tickets (
  id              uuid primary key default gen_random_uuid(),
  -- UNIQUE: un pedido produce como mucho una entrada, aunque el webhook llegue 10 veces.
  order_id        uuid not null unique references public.orders(id) on delete restrict,
  event_id        uuid not null references public.events(id) on delete restrict,
  name            text not null,
  email           text,
  birth_date      date,
  consent_at      timestamptz not null,
  consent_version text not null,
  checked_in_at   timestamptz,          -- NULL = todavía no ha entrado
  checked_in_by   uuid,                 -- auth.users.id del organizador
  email_status    text not null default 'pending' check (email_status in ('pending', 'sent', 'failed')),
  email_sent_at   timestamptz,
  email_error     text,
  anonymized_at   timestamptz,
  created_at      timestamptz not null default now()
);

create index tickets_event_idx on public.tickets (event_id);

-- Quién puede validar entradas. Se rellena a mano (ver README).
create table public.organizers (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.events     enable row level security;
alter table public.orders     enable row level security;
alter table public.tickets    enable row level security;
alter table public.organizers enable row level security;

create or replace function public.is_organizer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.organizers where user_id = auth.uid());
$$;

-- Cualquiera ve los eventos publicados; los organizadores ven todos.
create policy events_public_read on public.events
  for select using (published or public.is_organizer());

-- Los organizadores pueden leer las entradas (para la lista offline de la puerta).
-- No hay políticas de insert/update/delete: nadie escribe directamente en tickets.
create policy tickets_organizer_read on public.tickets
  for select to authenticated using (public.is_organizer());

create policy organizers_self_read on public.organizers
  for select to authenticated using (user_id = auth.uid());

-- orders: sin políticas => solo accesible con la service role (Edge Functions).

-- Mínimo privilegio a nivel de columnas: los organizadores no necesitan el email
-- ni los datos de consentimiento en el móvil.
revoke all on public.tickets from anon, authenticated;
grant select (id, event_id, name, birth_date, checked_in_at) on public.tickets to authenticated;
revoke all on public.orders from anon, authenticated;
revoke all on public.organizers from anon;
revoke insert, update, delete on public.events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_order: reserva plaza antes de ir a Stripe (llamada por create-checkout)
-- ---------------------------------------------------------------------------

create or replace function public.create_order(
  p_event_slug      text,
  p_name            text,
  p_email           text,
  p_birth_date      date,
  p_consent_version text,
  p_ttl_minutes     integer default 35
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.events;
  v_taken integer;
  v_order public.orders;
  v_age   integer;
begin
  -- FOR UPDATE serializa las reservas del mismo evento: no se puede vender por encima del aforo.
  select * into v_event from public.events
   where slug = p_event_slug and published and sales_open
   for update;
  if not found then
    raise exception 'event_not_available' using errcode = 'P0001';
  end if;

  if v_event.collect_birth_date and p_birth_date is null then
    raise exception 'birth_date_required' using errcode = 'P0001';
  end if;

  if v_event.min_age is not null then
    v_age := extract(year from age(v_event.starts_at::date, p_birth_date))::integer;
    if v_age < v_event.min_age then
      raise exception 'too_young' using errcode = 'P0001';
    end if;
  end if;

  select
    (select count(*) from public.tickets t where t.event_id = v_event.id)
    + (select count(*) from public.orders o
        where o.event_id = v_event.id and o.status = 'pending' and o.expires_at > now())
  into v_taken;

  if v_taken >= v_event.capacity then
    raise exception 'sold_out' using errcode = 'P0001';
  end if;

  insert into public.orders (
    event_id, name, email, birth_date, consent_at, consent_version,
    amount_cents, currency, expires_at
  ) values (
    v_event.id, p_name, lower(p_email),
    case when v_event.collect_birth_date then p_birth_date end,
    now(), p_consent_version,
    v_event.price_cents, v_event.currency,
    now() + make_interval(mins => p_ttl_minutes)
  )
  returning * into v_order;

  return jsonb_build_object(
    'order_id', v_order.id,
    'amount_cents', v_order.amount_cents,
    'currency', v_order.currency,
    'event_name', v_event.name,
    'event_slug', v_event.slug,
    'expires_at', v_order.expires_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- fulfill_order: convierte un pedido pagado en UNA entrada (idempotente)
-- ---------------------------------------------------------------------------

create or replace function public.fulfill_order(
  p_order_id       uuid,
  p_session_id     text,
  p_payment_intent text,
  p_amount_cents   integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order  public.orders;
  v_ticket public.tickets;
begin
  -- El bloqueo de fila hace que dos entregas simultáneas del mismo webhook se
  -- procesen una detrás de otra; la segunda ve status = 'paid' y no crea nada.
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;

  if v_order.stripe_session_id is not null and v_order.stripe_session_id <> p_session_id then
    raise exception 'session_mismatch' using errcode = 'P0001';
  end if;

  if v_order.status = 'paid' then
    select * into v_ticket from public.tickets where order_id = v_order.id;
    return jsonb_build_object('ticket_id', v_ticket.id, 'created', false, 'email_status', v_ticket.email_status);
  end if;

  -- Pedido cuyos datos ya se borraron (caducado hace tiempo): hay que revisarlo a mano.
  if v_order.name is null then
    raise exception 'order_data_missing' using errcode = 'P0001';
  end if;

  if p_amount_cents < v_order.amount_cents then
    raise exception 'amount_mismatch' using errcode = 'P0001';
  end if;

  insert into public.tickets (order_id, event_id, name, email, birth_date, consent_at, consent_version)
  values (v_order.id, v_order.event_id, v_order.name, v_order.email, v_order.birth_date,
          v_order.consent_at, v_order.consent_version)
  returning * into v_ticket;

  -- RGPD: los datos personales viven en un solo sitio (la entrada).
  update public.orders
     set status = 'paid',
         paid_at = now(),
         stripe_session_id = p_session_id,
         stripe_payment_intent = p_payment_intent,
         name = null, email = null, birth_date = null
   where id = v_order.id;

  return jsonb_build_object('ticket_id', v_ticket.id, 'created', true, 'email_status', v_ticket.email_status);
end;
$$;

-- Marca como caducado un pedido cuya sesión de Stripe expiró sin pago (libera la plaza y borra datos).
create or replace function public.expire_order(p_order_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.orders
     set status = 'expired', name = null, email = null, birth_date = null
   where id = p_order_id and status = 'pending';
$$;

-- ---------------------------------------------------------------------------
-- check_in: validación atómica en la puerta (solo organizadores)
-- ---------------------------------------------------------------------------

create or replace function public.check_in(
  p_ticket_id  text,
  p_event_id   uuid,
  p_scanned_at timestamptz default null   -- hora real del escaneo si viene de la cola offline
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_name    text;
  v_birth   date;
  v_at      timestamptz;
  v_event   uuid;
  v_ev_name text;
begin
  if not public.is_organizer() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Un QR con texto que no es un UUID es simplemente una entrada no válida.
  begin
    v_id := trim(p_ticket_id)::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('status', 'invalid');
  end;

  -- La operación clave: solo UNA petición puede pasar checked_in_at de NULL a una hora.
  update public.tickets
     set checked_in_at = least(coalesce(p_scanned_at, now()), now()),
         checked_in_by = auth.uid()
   where id = v_id
     and event_id = p_event_id
     and checked_in_at is null
  returning name, birth_date, checked_in_at into v_name, v_birth, v_at;

  if found then
    return jsonb_build_object(
      'status', 'ok',
      'name', v_name,
      'birth_date', v_birth,
      'checked_in_at', v_at
    );
  end if;

  select t.checked_in_at, t.event_id, t.name, t.birth_date
    into v_at, v_event, v_name, v_birth
    from public.tickets t where t.id = v_id;

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  if v_event <> p_event_id then
    select name into v_ev_name from public.events where id = v_event;
    return jsonb_build_object('status', 'wrong_event', 'event_name', v_ev_name);
  end if;

  return jsonb_build_object('status', 'used', 'name', v_name, 'birth_date', v_birth, 'checked_in_at', v_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- RGPD: anonimizar entradas de eventos pasados
-- ---------------------------------------------------------------------------

create or replace function public.anonymize_past_events(p_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.tickets t
     set name = 'Anonimizado', email = null, birth_date = null, anonymized_at = now()
    from public.events e
   where e.id = t.event_id
     and e.starts_at < now() - make_interval(days => p_days)
     and t.anonymized_at is null;
  get diagnostics v_count = row_count;

  -- Pedidos abandonados: no hay motivo para guardar nada.
  update public.orders
     set status = 'expired', name = null, email = null, birth_date = null
   where status = 'pending' and expires_at < now() - interval '1 day';

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos de las funciones. Supabase concede EXECUTE a anon/authenticated por
-- defecto, así que hay que quitarlo explícitamente.
-- ---------------------------------------------------------------------------

revoke execute on function public.create_order(text, text, text, date, text, integer) from public, anon, authenticated;
revoke execute on function public.fulfill_order(uuid, text, text, integer)           from public, anon, authenticated;
revoke execute on function public.expire_order(uuid)                                 from public, anon, authenticated;
revoke execute on function public.anonymize_past_events(integer)                     from public, anon, authenticated;
revoke execute on function public.check_in(text, uuid, timestamptz)                  from public, anon;
grant  execute on function public.check_in(text, uuid, timestamptz)                  to authenticated;

grant execute on function public.create_order(text, text, text, date, text, integer) to service_role;
grant execute on function public.fulfill_order(uuid, text, text, integer)           to service_role;
grant execute on function public.expire_order(uuid)                                 to service_role;
grant execute on function public.anonymize_past_events(integer)                     to service_role;

-- Para programarlo a diario (Database > Extensions > pg_cron):
--   select cron.schedule('anonymize-past-events', '0 4 * * *', $$select public.anonymize_past_events(30)$$);
