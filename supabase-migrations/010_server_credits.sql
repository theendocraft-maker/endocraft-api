-- 010_server_credits.sql
-- Server-autoritative Credits: atomare Abbuchung in Postgres.
-- Der Client setzt nie mehr selbst einen Kontostand — beta_codes.credits ist die Wahrheit.

-- Atomar Credits abbuchen. FOR UPDATE sperrt die Zeile → kein Doppel-Spend bei parallelen Calls.
-- Rückgabe: status = 'ok' | 'invalid' | 'inactive' | 'insufficient', balance = aktueller Stand.
create or replace function spend_credits(p_code text, p_cost int)
returns table(status text, balance int)
language plpgsql
security definer
as $$
declare
  cur int;
  act boolean;
begin
  if p_cost is null or p_cost < 0 then
    return query select 'invalid'::text, 0; return;
  end if;
  select credits, active into cur, act
    from beta_codes where code = upper(p_code)
    for update;
  if not found then
    return query select 'invalid'::text, 0; return;
  end if;
  if not act then
    return query select 'inactive'::text, cur; return;
  end if;
  if cur < p_cost then
    return query select 'insufficient'::text, cur; return;
  end if;
  update beta_codes set credits = credits - p_cost
    where code = upper(p_code)
    returning credits into cur;
  return query select 'ok'::text, cur;
end;
$$;

-- Credits gutschreiben (Refund bei Fehler, später Referral-Bonus / Kauf).
-- Rückgabe: neuer Stand, oder -1 wenn Code unbekannt.
create or replace function add_credits(p_code text, p_amount int)
returns int
language plpgsql
security definer
as $$
declare
  cur int;
begin
  if p_amount is null or p_amount < 0 then return -1; end if;
  update beta_codes set credits = credits + p_amount
    where code = upper(p_code)
    returning credits into cur;
  return coalesce(cur, -1);
end;
$$;
