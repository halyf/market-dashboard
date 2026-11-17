-- =====================================================================
-- Agendamentos (pg_cron + pg_net) — espelha os jobs do projeto.
-- Substitua SEU-PROJECT-REF e SUA_SERVICE_ROLE_KEY. Não commite a chave real
-- (o ideal é guardá-la no Vault do Supabase).
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Preços (Yahoo + CoinGecko): a cada hora
select cron.schedule('fetch-market-data-hourly', '0 * * * *', $$
  select net.http_post(
    url := 'https://SEU-PROJECT-REF.supabase.co/functions/v1/fetch-market-data',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer SUA_SERVICE_ROLE_KEY'),
    body := '{}'::jsonb
  );
$$);

-- Calendário econômico EUA (FXMacroData): a cada 6 horas
select cron.schedule('fetch-economic-events-6h', '0 */6 * * *', $$
  select net.http_post(
    url := 'https://SEU-PROJECT-REF.supabase.co/functions/v1/fetch-economic-events',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer SUA_SERVICE_ROLE_KEY'),
    body := '{}'::jsonb
  );
$$);

-- Calendário econômico Brasil (Biquote): a cada 6 horas, 15 min depois
select cron.schedule('fetch-br-events-6h', '15 */6 * * *', $$
  select net.http_post(
    url := 'https://SEU-PROJECT-REF.supabase.co/functions/v1/fetch-br-events',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer SUA_SERVICE_ROLE_KEY'),
    body := '{}'::jsonb
  );
$$);

-- Retenção: apaga histórico de preços com mais de 90 dias (todo dia às 03:00)
select cron.schedule('cleanup-price-history', '0 3 * * *', $$
  delete from price_history where timestamp < now() - interval '90 days';
$$);

-- Manutenção: VACUUM diário às 03:30
select cron.schedule('vacuum-price-history', '30 3 * * *', $$
  vacuum price_history;
$$);
