-- Analytics: one business dashboard across accounting, CRM, inventory and HR. It keeps no data of
-- its own; it reads the other apps' tables in a few aggregate queries. Every member of the company,
-- viewers too, can see it. Payroll totals come back only for owners and admins, the same people who
-- can see pay in HR. All amounts are in the company's main currency.

CREATE SCHEMA IF NOT EXISTS analytics;
GRANT USAGE ON SCHEMA analytics TO authenticated, service_role;

-- Totals for one date range. Only called from analytics.dashboard after the membership check,
-- so it is closed to everyone else.
CREATE OR REPLACE FUNCTION analytics.period_totals(p_tenant UUID, p_from DATE, p_to DATE, p_payroll BOOLEAN)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH sales AS (
    SELECT
      coalesce(sum(round(coalesce(subtotal, amount - coalesce(tax_amount, 0)) * exchange_rate, 2)), 0) AS revenue,
      count(*) AS invoices
    FROM accounting.invoices
    WHERE tenant_id = p_tenant AND status IN ('sent', 'partial', 'paid') AND invoice_date BETWEEN p_from AND p_to
  ), cash_entries AS (
    -- Net cash per entry, so moving money between two bank accounts counts as neither in nor out.
    -- A reversal nets against the entry it undoes, so a voided payment isn't counted both ways.
    SELECT sum(l.debit - l.credit) AS cash
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE l.tenant_id = p_tenant AND a.is_cash AND e.entry_date BETWEEN p_from AND p_to
    GROUP BY coalesce(e.reversal_of, e.id)
  ), cash AS (
    SELECT coalesce(sum(cash) FILTER (WHERE cash > 0), 0) AS cash_in,
      coalesce(-sum(cash) FILTER (WHERE cash < 0), 0) AS cash_out
    FROM cash_entries
  ), books AS (
    SELECT
      coalesce(sum(l.credit - l.debit) FILTER (WHERE a.type = 'revenue'), 0) AS income,
      coalesce(sum(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0) AS expenses
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id
    WHERE l.tenant_id = p_tenant AND e.source_type <> 'closing' AND e.entry_date BETWEEN p_from AND p_to
      AND a.type IN ('revenue', 'expense')
  ), leads AS (
    SELECT count(*) AS new_leads FROM crm.leads
    WHERE tenant_id = p_tenant AND created_at >= p_from AND created_at < p_to + 1
  ), won AS (
    SELECT count(*) AS won_deals, coalesce(sum(d.value), 0) AS won_value
    FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id
    WHERE d.tenant_id = p_tenant AND s.kind = 'won' AND d.closed_at >= p_from AND d.closed_at < p_to + 1
  ), pay AS (
    SELECT coalesce(sum(gross + employer_costs), 0) AS payroll
    FROM hr.pay_runs
    WHERE p_payroll AND tenant_id = p_tenant AND status IN ('approved', 'paid') AND pay_date BETWEEN p_from AND p_to
  )
  SELECT json_build_object(
    'from', p_from, 'to', p_to,
    'revenue', sales.revenue, 'invoices', sales.invoices,
    'cash_in', cash.cash_in, 'cash_out', cash.cash_out, 'net_cash', cash.cash_in - cash.cash_out,
    'income', books.income, 'expenses', books.expenses, 'profit', books.income - books.expenses,
    'new_leads', leads.new_leads, 'won_deals', won.won_deals, 'won_value', won.won_value,
    'payroll', CASE WHEN p_payroll THEN pay.payroll END
  ) FROM sales, cash, books, leads, won, pay;
$$;

-- Month by month for the 12 months ending with p_month
CREATE OR REPLACE FUNCTION analytics.monthly_trend(p_tenant UUID, p_month DATE, p_payroll BOOLEAN)
RETURNS JSON
LANGUAGE sql STABLE SET search_path = ''
AS $$
  WITH bounds AS (
    SELECT (date_trunc('month', p_month) - interval '11 months')::date AS first_day,
      (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date AS last_day
  ), months AS (
    SELECT generate_series(b.first_day, b.last_day, interval '1 month')::date AS month FROM bounds b
  ), sales AS (
    SELECT date_trunc('month', invoice_date)::date AS month,
      sum(round(coalesce(subtotal, amount - coalesce(tax_amount, 0)) * exchange_rate, 2)) AS revenue
    FROM accounting.invoices, bounds b
    WHERE tenant_id = p_tenant AND status IN ('sent', 'partial', 'paid') AND invoice_date BETWEEN b.first_day AND b.last_day
    GROUP BY 1
  ), cash_entries AS (
    SELECT date_trunc('month', e.entry_date)::date AS month, sum(l.debit - l.credit) AS cash
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id, bounds b
    WHERE l.tenant_id = p_tenant AND a.is_cash AND e.entry_date BETWEEN b.first_day AND b.last_day
    GROUP BY coalesce(e.reversal_of, e.id), 1
  ), cash AS (
    SELECT month, coalesce(sum(cash) FILTER (WHERE cash > 0), 0) AS cash_in,
      coalesce(-sum(cash) FILTER (WHERE cash < 0), 0) AS cash_out
    FROM cash_entries GROUP BY month
  ), books AS (
    SELECT date_trunc('month', e.entry_date)::date AS month,
      sum(l.credit - l.debit) AS profit -- revenue minus expenses
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e ON e.id = l.entry_id
    JOIN accounting.accounts a ON a.id = l.account_id, bounds b
    WHERE l.tenant_id = p_tenant AND e.source_type <> 'closing' AND a.type IN ('revenue', 'expense')
      AND e.entry_date BETWEEN b.first_day AND b.last_day
    GROUP BY 1
  ), leads AS (
    SELECT date_trunc('month', created_at)::date AS month, count(*) AS new_leads
    FROM crm.leads, bounds b
    WHERE tenant_id = p_tenant AND created_at >= b.first_day AND created_at < b.last_day + 1
    GROUP BY 1
  ), won AS (
    SELECT date_trunc('month', d.closed_at)::date AS month, sum(d.value) AS won_value
    FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id, bounds b
    WHERE d.tenant_id = p_tenant AND s.kind = 'won' AND d.closed_at >= b.first_day AND d.closed_at < b.last_day + 1
    GROUP BY 1
  ), pay AS (
    SELECT date_trunc('month', pay_date)::date AS month, sum(gross + employer_costs) AS payroll
    FROM hr.pay_runs, bounds b
    WHERE p_payroll AND tenant_id = p_tenant AND status IN ('approved', 'paid') AND pay_date BETWEEN b.first_day AND b.last_day
    GROUP BY 1
  )
  SELECT json_agg(json_build_object(
    'month', m.month,
    'revenue', coalesce(sales.revenue, 0),
    'cash_in', coalesce(cash.cash_in, 0),
    'cash_out', coalesce(cash.cash_out, 0),
    'profit', coalesce(books.profit, 0),
    'new_leads', coalesce(leads.new_leads, 0),
    'won_value', coalesce(won.won_value, 0),
    'payroll', CASE WHEN p_payroll THEN coalesce(pay.payroll, 0) END
  ) ORDER BY m.month)
  FROM months m
  LEFT JOIN sales ON sales.month = m.month
  LEFT JOIN cash ON cash.month = m.month
  LEFT JOIN books ON books.month = m.month
  LEFT JOIN leads ON leads.month = m.month
  LEFT JOIN won ON won.month = m.month
  LEFT JOIN pay ON pay.month = m.month;
$$;

-- The whole dashboard in one call. The period is compared with the one just before it: whole
-- months with the same number of months before, anything else with the same number of days.
CREATE OR REPLACE FUNCTION analytics.dashboard(p_tenant UUID, p_from DATE, p_to DATE)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  member_role TEXT;
  sees_pay BOOLEAN;
  months INT;
  prev_from DATE;
  prev_to DATE;
  as_of DATE;
  products JSON;
BEGIN
  SELECT role INTO member_role FROM public.tenant_members WHERE tenant_id = p_tenant AND user_id = auth.uid();
  IF member_role IS NULL THEN
    RAISE EXCEPTION 'Not found';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Choose a start date before the end date';
  END IF;
  IF p_to - p_from > 731 THEN
    RAISE EXCEPTION 'Choose up to two years';
  END IF;
  sees_pay := member_role IN ('owner', 'admin');

  months := (extract(year FROM age(p_to + 1, p_from)) * 12 + extract(month FROM age(p_to + 1, p_from)))::int;
  IF extract(day FROM p_from) = 1 AND (p_to + 1) = (p_from + make_interval(months => months))::date AND months > 0 THEN
    prev_from := (p_from - make_interval(months => months))::date;
  ELSE
    prev_from := p_from - (p_to - p_from + 1);
  END IF;
  prev_to := p_from - 1;
  -- Head count is taken on the last day of the period, or today if that is still ahead
  as_of := least(p_to, current_date);

  -- Product profit reads up to a year
  products := inventory.product_profit(p_tenant, greatest(p_from, p_to - 366), p_to);

  RETURN json_build_object(
    'role', member_role,
    'sees_payroll', sees_pay,
    'currency', coalesce((SELECT base_currency FROM accounting.settings WHERE tenant_id = p_tenant), 'USD'),
    'current', analytics.period_totals(p_tenant, p_from, p_to, sees_pay),
    'previous', analytics.period_totals(p_tenant, prev_from, prev_to, sees_pay),
    -- The trend stops at this month, so a period that runs into the future doesn't show empty months
    'trend', analytics.monthly_trend(p_tenant, least(p_to, current_date), sees_pay),
    'receivables', (
      SELECT json_build_object(
        'outstanding', coalesce(sum(base_amount - base_settled), 0),
        'overdue', coalesce(sum(base_amount - base_settled) FILTER (WHERE due_date < current_date), 0),
        'overdue_count', count(*) FILTER (WHERE due_date < current_date))
      FROM accounting.invoices WHERE tenant_id = p_tenant AND status IN ('sent', 'partial')),
    'pipeline', (
      SELECT json_build_object(
        'open_deals', count(*),
        'value', coalesce(sum(d.value), 0),
        'weighted', coalesce(sum(d.value * s.probability / 100.0), 0))
      FROM crm.deals d JOIN crm.stages s ON s.id = d.stage_id
      WHERE d.tenant_id = p_tenant AND s.kind = 'open'),
    'stock', (
      SELECT json_build_object(
        'items', count(*),
        'value', coalesce(sum(stock_value), 0),
        'low', count(*) FILTER (WHERE quantity <= reorder_level))
      FROM inventory.items WHERE tenant_id = p_tenant),
    'people', (
      SELECT json_build_object(
        'as_of', as_of,
        'headcount', count(*) FILTER (WHERE start_date <= as_of AND (end_date IS NULL OR end_date >= as_of)),
        'previous', count(*) FILTER (WHERE start_date <= prev_to AND (end_date IS NULL OR end_date >= prev_to)),
        'joined', count(*) FILTER (WHERE start_date BETWEEN p_from AND as_of),
        'left', count(*) FILTER (WHERE end_date BETWEEN p_from AND as_of))
      FROM hr.employees WHERE tenant_id = p_tenant),
    'top_customers', coalesce((
      SELECT json_agg(t ORDER BY t.revenue DESC, t.name) FROM (
        SELECT i.customer_id, coalesce(c.name, nullif(i.customer_name, ''), 'No customer') AS name,
          sum(round(coalesce(i.subtotal, i.amount - coalesce(i.tax_amount, 0)) * i.exchange_rate, 2)) AS revenue,
          count(*) AS invoices
        FROM accounting.invoices i
        LEFT JOIN accounting.customers c ON c.id = i.customer_id
        WHERE i.tenant_id = p_tenant AND i.status IN ('sent', 'partial', 'paid') AND i.invoice_date BETWEEN p_from AND p_to
        GROUP BY 1, 2
        ORDER BY revenue DESC, name
        LIMIT 5) t), '[]'::json),
    'top_products', coalesce((
      SELECT json_agg(p.value ORDER BY p.n) FROM (
        SELECT value, n FROM json_array_elements(products -> 'items') WITH ORDINALITY AS x(value, n)
        ORDER BY n LIMIT 5) p), '[]'::json),
    'products_from', greatest(p_from, p_to - 366)
  );
END;
$$;

DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'analytics.period_totals(uuid, date, date, boolean)',
    'analytics.monthly_trend(uuid, date, boolean)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
  REVOKE EXECUTE ON FUNCTION analytics.dashboard(uuid, date, date) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION analytics.dashboard(uuid, date, date) TO authenticated;
END;
$$;

-- Add analytics to the API's schema list, keeping every schema other apps have already added
DO $$
DECLARE
  current_list TEXT;
BEGIN
  SELECT substr(setting, length('pgrst.db_schemas=') + 1) INTO current_list
  FROM pg_roles, unnest(rolconfig) AS setting
  WHERE rolname = 'authenticator' AND setting LIKE 'pgrst.db_schemas=%';
  current_list := coalesce(nullif(current_list, ''), 'public, graphql_public');
  IF NOT ('analytics' = ANY (SELECT trim(s) FROM unnest(string_to_array(current_list, ',')) AS s)) THEN
    EXECUTE format('ALTER ROLE authenticator SET pgrst.db_schemas = %L', current_list || ', analytics');
  END IF;
END;
$$;
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
