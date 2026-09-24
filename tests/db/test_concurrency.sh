#!/usr/bin/env bash
# Dos pruebas de concurrencia:
#  1. 20 "puertas" escanean la MISMA entrada a la vez -> solo una la acepta.
#  2. 10 organizadores pulsan "Confirmar pago" del mismo pedido a la vez -> una sola entrada.
# Uso: PSQL="psql -d qr_test" ./tests/db/test_concurrency.sh
set -euo pipefail
PSQL=${PSQL:-psql}
ORG="set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';"

new_order() {
  $PSQL -Atq <<SQL | tail -n1
set role service_role;
update public.events set capacity = capacity + 1 where slug = 'otro-evento';
select (public.create_order('otro-evento', 'Concurrencia', '$1@example.com', null, 'bizum', 'v1'))->>'order_id';
SQL
}

# --- 1. Check-in simultáneo ---------------------------------------------------------
ORDER=$(new_order conc1)
TICKET=$($PSQL -Atq -c "$ORG select (public.confirm_order('$ORDER'))->>'ticket_id';" | tail -n1)

OUT=$(mktemp)
for i in $(seq 1 20); do
  $PSQL -Atq -c "$ORG select public.check_in('$TICKET', '22222222-2222-4222-8222-222222222222')->>'status';" >>"$OUT" &
done
wait
OK=$(grep -c '^ok$' "$OUT" || true); USED=$(grep -c '^used$' "$OUT" || true)
echo "check-in: ok=$OK used=$USED"
[ "$OK" -eq 1 ] && [ "$USED" -eq 19 ] || { echo "FALLO: se esperaba 1 ok y 19 used" >&2; exit 1; }

# --- 2. Confirmación simultánea -------------------------------------------------------
ORDER=$(new_order conc2)
: >"$OUT"
for i in $(seq 1 10); do
  $PSQL -Atq -c "$ORG select (public.confirm_order('$ORDER'))->>'created';" >>"$OUT" &
done
wait
CREATED=$(grep -c '^true$' "$OUT" || true)
TICKETS=$($PSQL -Atq -c "select count(*) from public.tickets where order_id = '$ORDER';")
rm -f "$OUT"
echo "confirmación: created=$CREATED tickets=$TICKETS"
[ "$CREATED" -eq 1 ] && [ "$TICKETS" -eq 1 ] || { echo "FALLO: se esperaba una sola entrada" >&2; exit 1; }

echo 'OK: concurrencia correcta'
