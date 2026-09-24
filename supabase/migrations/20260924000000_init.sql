-- Esquema inicial: eventos, pedidos (pendientes de pago), entradas y organizadores.
--
-- Flujo de pago manual (Bizum o transferencia):
--   1. El comprador rellena el formulario -> create_order() reserva plaza y da una referencia (p. ej. K7M2QX).
--   2. Paga por Bizum/transferencia poniendo esa referencia como concepto.
--   3. Un organizador lo comprueba en el banco y pulsa "Confirmar pago" -> confirm_order() crea UNA entrada.
--
-- Principios:
--   * Las entradas solo se crean en confirm_order(), que exige ser organizador. Nunca desde el navegador del comprador.
--   * confirm_order() es idempotente: pulsar dos veces (o desde dos móviles) devuelve la misma entrada.
--   * Los IDs de entrada son UUID v4 aleatorios (gen_random_uuid), nunca secuenciales.
--   * El check-in es un único UPDATE atómico condicionado a checked_in_at IS NULL.
--   * Los anónimos solo pueden leer eventos publicados. Todo lo demás pasa por funciones SECURITY DEFINER.

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
  price_cents        integer not null check (price_cents >= 0),
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

-- Un pedido es una reserva mientras el organizador comprueba el pago. No es una entrada.
create table public.orders (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events(id) on delete restrict,
  -- Concepto que el comprador pone en el Bizum/transferencia. Sin 0/O ni 1/I para evitar confusiones.
  reference       text not null unique check (reference ~ '^[A-HJ-NP-Z2-9]{6}$'),
  status          text not null default 'pending' check (status in ('pending', 'paid', 'cancelled')),
  payment_method  text not null check (payment_method in ('bizum', 'transfer')),
  -- Datos personales: al confirmar se mueven a la entrada y aquí se borran (null).
  name            text,
  email           text,
  birth_date      date,
  consent_at      timestamptz not null,
  consent_version text not null,
  amount_cents    integer not null,
  currency        text not null,
  -- La plaza queda reservada hasta esta hora; después cuenta como libre (se puede confirmar si queda aforo).
  expires_at      timestamptz not null,
  paid_at         timestamptz,
  confirmed_by    uuid,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index orders_event_status_idx on public.orders (event_id, status);

create table public.tickets (
  id              uuid primary key default gen_random_uuid(),
  -- UNIQUE: un pedido produce como mucho una entrada, aunque se confirme dos veces.
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

-- Quién puede confirmar pagos y validar entradas. Se rellena a mano (ver README).
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

-- Los organizadores leen pedidos (panel de pagos) y entradas (lista offline de la puerta).
-- No hay políticas de insert/update/delete: nadie escribe directamente en estas tablas.
create policy orders_organizer_read on public.orders
  for select to authenticated using (public.is_organizer());
create policy tickets_organizer_read on public.tickets
  for select to authenticated using (public.is_organizer());
create policy organizers_self_read on public.organizers
  for select to authenticated using (user_id = auth.uid());

-- Mínimo privilegio por columnas. El email del asistente solo se ve mientras el pedido está
-- pendiente (para cuadrar el pago); en la entrada no hace falta y no se expone.
revoke all on public.orders  from anon, authenticated;
revoke all on public.tickets from anon, authenticated;
grant select (id, event_id, reference, status, payment_method, name, email, amount_cents, currency,
              expires_at, paid_at, cancelled_at, created_at)
  on public.orders to authenticated;
grant select (id, event_id, order_id, name, birth_date, checked_in_at, email_status)
  on public.tickets to authenticated;
revoke all on public.organizers from anon;
revoke insert, update, delete on public.events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Referencia de pago corta y legible
-- ---------------------------------------------------------------------------

create or replace function public.new_reference()
returns text
language plpgsql
volatile
-- En Supabase pgcrypto vive en el esquema "extensions".
set search_path = public, extensions
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea;
  ref text;
begin
  loop
    bytes := gen_random_bytes(6);
    ref := '';
    for i in 0..5 loop
      ref := ref || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.orders where reference = ref);
  end loop;
  return ref;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_order: reserva plaza y devuelve la referencia (llamada por la función create-order)
-- ---------------------------------------------------------------------------

create or replace function public.create_order(
  p_event_slug      text,
  p_name            text,
  p_email           text,
  p_birth_date      date,
  p_payment_method  text,
  p_consent_version text,
  p_hold_hours      integer default 72
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

  -- Doble clic o recarga: si ya hay un pedido pendiente con ese email para el evento, se reutiliza.
  select * into v_order from public.orders
   where event_id = v_event.id and email = lower(p_email) and status = 'pending' and expires_at > now()
   order by created_at desc limit 1;

  if not found then
    select
      (select count(*) from public.tickets t where t.event_id = v_event.id)
      + (select count(*) from public.orders o
          where o.event_id = v_event.id and o.status = 'pending' and o.expires_at > now())
    into v_taken;

    if v_taken >= v_event.capacity then
      raise exception 'sold_out' using errcode = 'P0001';
    end if;

    insert into public.orders (
      event_id, reference, payment_method, name, email, birth_date, consent_at, consent_version,
      amount_cents, currency, expires_at
    ) values (
      v_event.id, public.new_reference(), p_payment_method, p_name, lower(p_email),
      case when v_event.collect_birth_date then p_birth_date end,
      now(), p_consent_version,
      v_event.price_cents, v_event.currency,
      now() + make_interval(hours => p_hold_hours)
    )
    returning * into v_order;
  end if;

  return jsonb_build_object(
    'order_id', v_order.id,
    'reference', v_order.reference,
    'payment_method', v_order.payment_method,
    'amount_cents', v_order.amount_cents,
    'currency', v_order.currency,
    'event_name', v_event.name,
    'event_slug', v_event.slug,
    'email', v_order.email,
    'expires_at', v_order.expires_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- confirm_order: el organizador ha visto el dinero -> UNA entrada (idempotente)
-- ---------------------------------------------------------------------------

create or replace function public.confirm_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order    public.orders;
  v_ticket   public.tickets;
  v_capacity integer;
  v_taken    integer;
begin
  if not public.is_organizer() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- El bloqueo de fila hace que dos confirmaciones simultáneas se procesen una detrás de otra;
  -- la segunda ve status = 'paid' y devuelve la entrada ya creada.
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;

  if v_order.status = 'paid' then
    select * into v_ticket from public.tickets where order_id = v_order.id;
    return jsonb_build_object('ticket_id', v_ticket.id, 'created', false, 'email_status', v_ticket.email_status);
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'order_cancelled' using errcode = 'P0001';
  end if;

  if v_order.name is null then
    raise exception 'order_data_missing' using errcode = 'P0001';
  end if;

  -- Reserva caducada: su plaza pudo liberarse, así que se comprueba el aforo otra vez.
  if v_order.expires_at <= now() then
    select capacity into v_capacity from public.events where id = v_order.event_id for update;
    select
      (select count(*) from public.tickets t where t.event_id = v_order.event_id)
      + (select count(*) from public.orders o
          where o.event_id = v_order.event_id and o.status = 'pending' and o.expires_at > now())
    into v_taken;
    if v_taken >= v_capacity then
      raise exception 'sold_out' using errcode = 'P0001';
    end if;
  end if;

  insert into public.tickets (order_id, event_id, name, email, birth_date, consent_at, consent_version)
  values (v_order.id, v_order.event_id, v_order.name, v_order.email, v_order.birth_date,
          v_order.consent_at, v_order.consent_version)
  returning * into v_ticket;

  -- RGPD: los datos personales viven en un solo sitio (la entrada).
  update public.orders
     set status = 'paid', paid_at = now(), confirmed_by = auth.uid(),
         name = null, email = null, birth_date = null
   where id = v_order.id;

  return jsonb_build_object('ticket_id', v_ticket.id, 'created', true, 'email_status', v_ticket.email_status);
end;
$$;

-- cancel_order: el pago no ha llegado. Libera la plaza y borra los datos del pedido.
create or replace function public.cancel_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_organizer() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.orders
     set status = 'cancelled', cancelled_at = now(), name = null, email = null, birth_date = null
   where id = p_order_id and status = 'pending';
  return found;
end;
$$;

-- prepare_resend: volver a enviar la entrada, opcionalmente a un email corregido.
create or replace function public.prepare_resend(p_ticket_id uuid, p_email text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_organizer() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.tickets
     set email = coalesce(lower(nullif(trim(p_email), '')), email),
         email_status = 'pending', email_error = null
   where id = p_ticket_id and anonymized_at is null;
  if not found then
    raise exception 'ticket_not_found' using errcode = 'P0001';
  end if;
end;
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
    return jsonb_build_object('status', 'ok', 'name', v_name, 'birth_date', v_birth, 'checked_in_at', v_at);
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
-- RGPD: anonimizar entradas de eventos pasados y limpiar pedidos abandonados
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

  -- Pedidos nunca pagados: una semana después de caducar la reserva se cancelan y se borran sus datos.
  update public.orders
     set status = 'cancelled', cancelled_at = now(), name = null, email = null, birth_date = null
   where status = 'pending' and expires_at < now() - interval '7 days';

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos de las funciones. Supabase concede EXECUTE a anon/authenticated por
-- defecto, así que hay que quitarlo explícitamente.
-- ---------------------------------------------------------------------------

revoke execute on function public.new_reference()                                          from public, anon, authenticated;
revoke execute on function public.create_order(text, text, text, date, text, text, integer) from public, anon, authenticated;
revoke execute on function public.anonymize_past_events(integer)                          from public, anon, authenticated;
revoke execute on function public.confirm_order(uuid)                                     from public, anon;
revoke execute on function public.cancel_order(uuid)                                      from public, anon;
revoke execute on function public.prepare_resend(uuid, text)                              from public, anon;
revoke execute on function public.check_in(text, uuid, timestamptz)                       from public, anon;

grant execute on function public.create_order(text, text, text, date, text, text, integer) to service_role;
grant execute on function public.anonymize_past_events(integer)                          to service_role;
-- Estas comprueban dentro que quien llama es organizador:
grant execute on function public.confirm_order(uuid)                to authenticated;
grant execute on function public.cancel_order(uuid)                 to authenticated;
grant execute on function public.prepare_resend(uuid, text)         to authenticated;
grant execute on function public.check_in(text, uuid, timestamptz)  to authenticated;

-- Para programarlo a diario (Database > Extensions > pg_cron):
--   select cron.schedule('anonymize-past-events', '0 4 * * *', $$select public.anonymize_past_events(30)$$);
