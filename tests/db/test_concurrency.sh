#!/usr/bin/env bash
# Escanea la MISMA entrada desde 20 "puertas" a la vez y comprueba que solo una la acepta.
# Uso: PSQL="psql -h localhost -p 5432 -U postgres -d qr_test" ./tests/db/test_concurrency.sh
set -euo pipefail
PSQL=${PSQL:-psql}

TICKET=$($PSQL -Atq <<'SQL'
set role service_role;
update public.events set capacity = capacity + 1 where slug = 'otro-evento';
select (public.fulfill_order(
  ((public.create_order('otro-evento', 'Concurrencia', 'c@example.com', null, 'v1'))->>'order_id')::uuid,
  'cs_conc', 'pi_conc', 1000))->>'ticket_id';
SQL
)
TICKET=$(echo "$TICKET" | tail -n1)

OUT=$(mktemp)
for i in $(seq 1 20); do
  $PSQL -Atq >>"$OUT" <<SQL &
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select public.check_in('$TICKET', '22222222-2222-4222-8222-222222222222')->>'status';
SQL
done
wait

OK=$(grep -c '^ok$' "$OUT" || true)
USED=$(grep -c '^used$' "$OUT" || true)
rm -f "$OUT"
echo "ok=$OK used=$USED"
if [ "$OK" -ne 1 ] || [ "$USED" -ne 19 ]; then
  echo "FALLO: se esperaba exactamente 1 ok y 19 used" >&2
  exit 1
fi
echo 'OK: solo una puerta aceptó la entrada'
