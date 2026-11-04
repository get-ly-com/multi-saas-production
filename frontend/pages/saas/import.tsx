import Link from 'next/link';
import { ChangeEvent, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import { api, today } from '@/lib/api';
import { downloadCsv, parseCsv } from '@/lib/csv';
import useSubmit from '@/lib/useSubmit';

// Moves records in from another product's CSV export, using the same create calls the app's own
// forms use. Opening balances are not part of this: they go in as one journal entry.

type Kind = 'contacts' | 'companies' | 'customers' | 'vendors' | 'accounts' | 'items';
type Field = { key: string; label: string; hint?: string };
type Presets = Record<string, string[]>;

const MAX_ROWS = 5000;
const BATCH = 10;

const KINDS: { id: Kind; label: string; what: string }[] = [
  { id: 'contacts', label: 'CRM contacts', what: 'people' },
  { id: 'companies', label: 'CRM companies', what: 'companies' },
  { id: 'customers', label: 'Customers (accounting)', what: 'customers' },
  { id: 'vendors', label: 'Vendors (accounting)', what: 'vendors' },
  { id: 'accounts', label: 'Chart of accounts', what: 'accounts' },
  { id: 'items', label: 'Inventory items', what: 'items' }
];

const FIELDS: Record<Kind, Field[]> = {
  contacts: [
    { key: 'name', label: 'Full name', hint: 'Or use first and last name' },
    { key: 'first_name', label: 'First name' },
    { key: 'last_name', label: 'Last name' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'job_title', label: 'Job title' },
    { key: 'company', label: 'Company', hint: 'Linked to a CRM company, which is added if it is new' }
  ],
  companies: [
    { key: 'name', label: 'Company name' },
    { key: 'website', label: 'Website' },
    { key: 'phone', label: 'Phone' },
    { key: 'industry', label: 'Industry' }
  ],
  customers: [
    { key: 'name', label: 'Name' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'address', label: 'Address' },
    { key: 'city', label: 'Town or city' },
    { key: 'region', label: 'State or region' },
    { key: 'postcode', label: 'Postcode or ZIP' },
    { key: 'country', label: 'Country' }
  ],
  vendors: [],
  accounts: [
    { key: 'code', label: 'Account code' },
    { key: 'name', label: 'Account name' },
    { key: 'type', label: 'Account type', hint: 'Read as asset, liability, equity, income or expense' }
  ],
  items: [
    { key: 'name', label: 'Item name' },
    { key: 'sku', label: 'SKU' },
    { key: 'barcode', label: 'Barcode' },
    { key: 'price', label: 'Selling price' },
    { key: 'unit', label: 'Unit' }
  ]
};
FIELDS.vendors = FIELDS.customers;

const REQUIRED: Record<Kind, string> = {
  contacts: 'a name (full, or first and last) or an email',
  companies: 'a company name',
  customers: 'a name',
  vendors: 'a name',
  accounts: 'an account code, a name and a type',
  items: 'an item name and a SKU'
};

// Header names other tools use, tried after the source's own ones
const GENERIC: Presets = {
  name: ['name', 'full name', 'contact name', 'display name', 'customer name', 'vendor name', 'supplier name', 'company name', 'account name', 'item name', 'product name'],
  first_name: ['first name', 'firstname', 'given name'],
  last_name: ['last name', 'lastname', 'surname', 'family name'],
  email: ['email', 'e-mail', 'email address', 'emailaddress', 'emailid', 'work email'],
  phone: ['phone', 'phone number', 'telephone', 'mobile', 'mobile phone', 'work phone'],
  job_title: ['job title', 'title', 'position', 'job position', 'role'],
  company: ['company', 'company name', 'account name', 'organization', 'organisation', 'related company'],
  website: ['website', 'website url', 'web site', 'domain', 'company domain name'],
  industry: ['industry'],
  address: ['address', 'billing address', 'street', 'address line 1', 'street address'],
  city: ['city', 'town', 'town / city'],
  region: ['state', 'region', 'province', 'county', 'state/region'],
  postcode: ['postcode', 'postal code', 'zip', 'zip code', 'postal / zip code'],
  country: ['country', 'country/region'],
  code: ['code', 'account code', 'account number', 'account #', 'number', 'no.'],
  type: ['type', 'account type'],
  sku: ['sku', 'item code', 'product code', 'internal reference', 'reference', 'part number'],
  barcode: ['barcode', 'upc', 'ean', 'gtin'],
  price: ['price', 'selling price', 'sales price', 'unit price', 'rate', 'sale price', 'list price'],
  unit: ['unit', 'unit of measure', 'usage unit', 'uom']
};

type Source = { id: string; label: string; howTo: string; presets: Partial<Record<Kind, Presets>> };

// The standard export headers of each product. Each list is tried in order; anything not found
// falls back to the common names above, and everything can be changed by hand.
const SOURCES: Source[] = [
  {
    id: 'quickbooks',
    label: 'QuickBooks Online',
    howTo: 'Customers, vendors and products: open the list, then use the export icon. Chart of accounts: Reports > Account List > Export to CSV. Turn on account numbers (Settings > Advanced) first, so each account has a code.',
    presets: {
      contacts: { name: ['Customer', 'Customer full name', 'Name'], email: ['Email'], phone: ['Phone', 'Phone Numbers', 'Mobile'], company: ['Company', 'Company name'] },
      companies: { name: ['Company', 'Company name', 'Customer'], phone: ['Phone'], website: ['Website'] },
      customers: { name: ['Customer', 'Customer full name', 'Name'], email: ['Email'], phone: ['Phone', 'Phone Numbers', 'Mobile'], address: ['Billing Address', 'Billing Street', 'Full Address'], city: ['Billing City'], region: ['Billing State'], postcode: ['Billing ZIP', 'Billing Zip'], country: ['Billing Country'] },
      vendors: { name: ['Vendor', 'Vendor full name', 'Name'], email: ['Email'], phone: ['Phone', 'Phone Numbers', 'Mobile'], address: ['Address', 'Street Address'], city: ['City'], region: ['State'], postcode: ['ZIP', 'Zip'], country: ['Country'] },
      accounts: { code: ['Account #', 'Account Number', 'Number', 'Num'], name: ['Account', 'Full name', 'Name'], type: ['Type', 'Account Type'] },
      items: { name: ['Product/Service Name', 'Product/Service', 'Name'], sku: ['SKU'], price: ['Sales Price / Rate', 'Sales Price/Rate', 'Price'], unit: ['Unit'] }
    }
  },
  {
    id: 'xero',
    label: 'Xero',
    howTo: 'Contacts: Contacts > All contacts > Export. Chart of accounts: Accounting > Chart of accounts > Export. Items: Business > Products and services > Export.',
    presets: {
      contacts: { name: ['*ContactName', 'ContactName'], first_name: ['FirstName'], last_name: ['LastName'], email: ['EmailAddress'], phone: ['PhoneNumber', 'MobileNumber'] },
      companies: { name: ['*ContactName', 'ContactName'], phone: ['PhoneNumber'], website: ['Website'] },
      customers: { name: ['*ContactName', 'ContactName'], email: ['EmailAddress'], phone: ['PhoneNumber', 'MobileNumber'], address: ['POAddressLine1', 'SAAddressLine1'], city: ['POCity', 'SACity'], region: ['PORegion', 'SARegion'], postcode: ['POPostalCode', 'SAPostalCode'], country: ['POCountry', 'SACountry'] },
      vendors: { name: ['*ContactName', 'ContactName'], email: ['EmailAddress'], phone: ['PhoneNumber', 'MobileNumber'], address: ['POAddressLine1', 'SAAddressLine1'], city: ['POCity', 'SACity'], region: ['PORegion', 'SARegion'], postcode: ['POPostalCode', 'SAPostalCode'], country: ['POCountry', 'SACountry'] },
      accounts: { code: ['*Code', 'Code'], name: ['*Name', 'Name'], type: ['*Type', 'Type'] },
      items: { name: ['ItemName', '*ItemName'], sku: ['*ItemCode', 'ItemCode'], price: ['SalesUnitPrice'] }
    }
  },
  {
    id: 'zoho',
    label: 'Zoho (CRM, Books or Inventory)',
    howTo: 'Zoho CRM: Setup > Data Administration > Export, pick Contacts or Accounts. Zoho Books or Inventory: open Customers, Vendors, Chart of Accounts or Items, then use the menu > Export.',
    presets: {
      contacts: { first_name: ['First Name'], last_name: ['Last Name'], name: ['Full Name', 'Contact Name', 'Display Name'], email: ['Email', 'EmailID'], phone: ['Phone', 'Mobile', 'MobilePhone'], job_title: ['Title', 'Designation'], company: ['Account Name', 'Company Name'] },
      companies: { name: ['Account Name', 'Company Name'], phone: ['Phone'], website: ['Website'], industry: ['Industry'] },
      customers: { name: ['Display Name', 'Customer Name', 'Company Name'], email: ['EmailID', 'Email'], phone: ['Phone', 'MobilePhone'], address: ['Billing Address', 'Billing Street'], city: ['Billing City'], region: ['Billing State'], postcode: ['Billing Code', 'Billing Zip'], country: ['Billing Country'] },
      vendors: { name: ['Display Name', 'Vendor Name', 'Company Name'], email: ['EmailID', 'Email'], phone: ['Phone', 'MobilePhone'], address: ['Billing Address', 'Billing Street'], city: ['Billing City'], region: ['Billing State'], postcode: ['Billing Code', 'Billing Zip'], country: ['Billing Country'] },
      accounts: { code: ['Account Code'], name: ['Account Name'], type: ['Account Type'] },
      items: { name: ['Item Name', 'Name'], sku: ['SKU'], barcode: ['UPC', 'EAN', 'ISBN'], price: ['Rate', 'Selling Price'], unit: ['Unit', 'Usage unit'] }
    }
  },
  {
    id: 'hubspot',
    label: 'HubSpot',
    howTo: 'Open Contacts, Companies or Products, then Export (or Actions > Export) and pick CSV.',
    presets: {
      contacts: { first_name: ['First Name'], last_name: ['Last Name'], email: ['Email'], phone: ['Phone Number', 'Mobile Phone Number'], job_title: ['Job Title'], company: ['Company Name', 'Associated Company'] },
      companies: { name: ['Company name', 'Name'], website: ['Website URL', 'Company Domain Name'], phone: ['Phone Number'], industry: ['Industry'] },
      customers: { name: ['Company name', 'Name'], phone: ['Phone Number'], address: ['Street Address'], city: ['City'], region: ['State/Region'], postcode: ['Postal Code'], country: ['Country/Region'] },
      items: { name: ['Name'], sku: ['SKU'], price: ['Unit price', 'Price'] }
    }
  },
  {
    id: 'odoo',
    label: 'Odoo',
    howTo: 'Open the list (Contacts, Chart of Accounts or Products), select the rows, then Action > Export and save as CSV. Pick the fields shown here when Odoo asks which to export.',
    presets: {
      contacts: { name: ['Name', 'Display Name'], email: ['Email'], phone: ['Phone', 'Mobile'], job_title: ['Job Position'], company: ['Company Name', 'Related Company', 'Company'] },
      companies: { name: ['Name', 'Display Name'], website: ['Website'], phone: ['Phone'], industry: ['Industry'] },
      customers: { name: ['Name', 'Display Name'], email: ['Email'], phone: ['Phone', 'Mobile'], address: ['Street'], city: ['City'], region: ['State'], postcode: ['Zip'], country: ['Country'] },
      vendors: { name: ['Name', 'Display Name'], email: ['Email'], phone: ['Phone', 'Mobile'], address: ['Street'], city: ['City'], region: ['State'], postcode: ['Zip'], country: ['Country'] },
      accounts: { code: ['Code'], name: ['Account Name', 'Name'], type: ['Type', 'Account Type'] },
      items: { name: ['Name', 'Product'], sku: ['Internal Reference'], barcode: ['Barcode'], price: ['Sales Price'], unit: ['Unit of Measure', 'Unit'] }
    }
  },
  { id: 'csv', label: 'Other (any CSV file)', howTo: 'Any CSV with a header row works. Pick which column holds what in the next step.', presets: {} }
];

// The other product's account type, read as one of ours. Checked in this order, so
// "Cost of revenue" is an expense and "Other current liability" is not an asset.
const TYPE_WORDS: [string, string[]][] = [
  ['liability', ['payable', 'liabilit', 'credit card', 'output tax', 'tax payable', 'loan', 'accrual']],
  ['equity', ['equity', 'earnings', 'capital', 'drawings', 'retained']],
  ['expense', ['cost', 'expense', 'overhead', 'depreciation', 'direct costs', 'purchases']],
  ['revenue', ['income', 'revenue', 'sales']],
  ['asset', ['asset', 'receivable', 'bank', 'cash', 'stock', 'inventory', 'prepay', 'input tax', 'clearing', 'current']]
];

const accountType = (value: string) => {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  return TYPE_WORDS.find(([, words]) => words.some((word) => text.includes(word)))?.[0] || null;
};

const isCashType = (value: string) => /\b(bank|cash)\b/i.test(value);

const clean = (header: string) => header.replace(/^﻿/, '').trim().replace(/^\*/, '').toLowerCase();

const guessColumn = (headers: string[], names: string[]) => {
  const wanted = names.map(clean);
  for (const name of wanted) {
    const found = headers.findIndex((header) => clean(header) === name);
    if (found >= 0) return found;
  }
  return -1;
};

// Some reports put a title and the company name above the header row
const findHeaderRow = (rows: string[][], fields: Field[], presets: Presets) => {
  const names = new Set(fields.flatMap(({ key }) => [...(presets[key] || []), ...(GENERIC[key] || [])]).map(clean));
  let best = 0;
  let bestScore = -1;
  rows.slice(0, 10).forEach((row, index) => {
    const score = row.filter((cell) => names.has(clean(cell))).length;
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  });
  if (bestScore > 0) return best;
  const wide = rows.findIndex((row) => row.filter((cell) => cell.trim()).length >= 2);
  return wide >= 0 ? wide : 0;
};

const parsePrice = (value: string) => {
  const text = value.replace(/[^0-9.\-]/g, '');
  if (!text) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : NaN;
};

const lower = (value: unknown) => String(value || '').trim().toLowerCase();

type Planned = { index: number; body: any; key: string; company?: string };
type Failed = { index: number; reason: string };

// Turns one row into what the create call takes, or says why it can't be imported
const buildRow = (kind: Kind, get: (key: string) => string): { body?: any; key?: string; company?: string; problem?: string } => {
  if (kind === 'contacts') {
    const email = lower(get('email'));
    const name = get('name') || `${get('first_name')} ${get('last_name')}`.trim() || email;
    if (!name) return { problem: 'No name or email' };
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { problem: `The email "${email}" doesn't look right` };
    return {
      body: { name, email: email || null, phone: get('phone') || null, job_title: get('job_title') || null },
      key: email || `name:${lower(name)}`,
      company: get('company') || undefined
    };
  }
  if (kind === 'companies') {
    const name = get('name');
    if (!name) return { problem: 'No company name' };
    return { body: { name, website: get('website') || null, phone: get('phone') || null, industry: get('industry') || null }, key: lower(name) };
  }
  if (kind === 'customers' || kind === 'vendors') {
    const name = get('name');
    if (!name) return { problem: 'No name' };
    const email = lower(get('email'));
    const address = ['address', 'city', 'region', 'postcode', 'country'].map(get).filter(Boolean).join(', ');
    return { body: { name, email: email || null, phone: get('phone') || null, address: address || null }, key: email || `name:${lower(name)}` };
  }
  if (kind === 'accounts') {
    const code = get('code');
    const name = get('name');
    const rawType = get('type');
    if (!code) return { problem: 'No account code' };
    if (!name) return { problem: 'No account name' };
    const type = accountType(rawType);
    if (!type) return { problem: rawType ? `Account type "${rawType}" isn't one we recognise` : 'No account type' };
    return { body: { code, name, type, is_cash: type === 'asset' && isCashType(rawType) }, key: lower(code) };
  }
  const sku = get('sku');
  const name = get('name');
  if (!name) return { problem: 'No item name' };
  if (!sku) return { problem: 'No SKU' };
  const price = parsePrice(get('price'));
  if (Number.isNaN(price)) return { problem: `The price "${get('price')}" isn't a number` };
  const barcode = get('barcode');
  const unit = get('unit');
  return {
    body: { sku, name, price, ...(barcode ? { barcode } : {}), ...(unit ? { unit } : {}) },
    key: lower(sku)
  };
};

const LIST_PATH: Record<Kind, string> = {
  contacts: '/api/crm/contacts',
  companies: '/api/crm/companies',
  customers: '/api/accounting/customers',
  vendors: '/api/accounting/vendors',
  accounts: '/api/accounting/accounts',
  items: '/api/inventory/items'
};

// The keys already in the app, so those rows are skipped
const existingKeys = (kind: Kind, rows: any[]) => {
  const keys = new Set<string>();
  rows.forEach((row) => {
    if (kind === 'accounts') keys.add(lower(row.code));
    else if (kind === 'items') keys.add(lower(row.sku));
    else if (kind === 'companies') keys.add(lower(row.name));
    else {
      if (row.email) keys.add(lower(row.email));
      keys.add(`name:${lower(row.name)}`);
    }
  });
  return keys;
};

const DUPLICATE_BY: Record<Kind, string> = {
  contacts: 'email (or name when there is no email)',
  companies: 'name',
  customers: 'email (or name when there is no email)',
  vendors: 'email (or name when there is no email)',
  accounts: 'account code',
  items: 'SKU'
};

export default function Import() {
  return <AppShell><ImportApp /></AppShell>;
}

function ImportApp() {
  const [sourceId, setSourceId] = useState('quickbooks');
  const [kind, setKind] = useState<Kind>('customers');
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [plan, setPlan] = useState<{ add: Planned[]; duplicates: number[]; failed: Failed[] } | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<{ added: number; duplicates: number; failed: Failed[] } | null>(null);
  const [error, setError] = useState('');
  const { busy, run } = useSubmit();

  const source = SOURCES.find(({ id }) => id === sourceId) || SOURCES[0];
  const fields = FIELDS[kind];
  const presets = source.presets[kind] || {};
  const offered = source.id === 'csv' ? KINDS : KINDS.filter(({ id }) => source.presets[id]);

  const reset = () => {
    setFileName('');
    setHeaders([]);
    setRows([]);
    setMapping({});
    setPlan(null);
    setSummary(null);
    setProgress({ done: 0, total: 0 });
    setError('');
  };

  const pickSource = (id: string) => {
    const next = SOURCES.find((option) => option.id === id) || SOURCES[0];
    setSourceId(id);
    if (next.id !== 'csv' && !next.presets[kind]) setKind((Object.keys(next.presets)[0] as Kind) || 'contacts');
    reset();
  };

  const pickKind = (id: Kind) => {
    setKind(id);
    reset();
  };

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    reset();
    try {
      const all = parseCsv(await file.text());
      if (!all.length) throw new Error('That file is empty.');
      const headerAt = findHeaderRow(all, fields, presets);
      const head = all[headerAt].map((cell) => cell.replace(/^﻿/, '').trim());
      const body = all.slice(headerAt + 1);
      if (!body.length) throw new Error('That file has a header row but no rows under it.');
      if (body.length > MAX_ROWS) throw new Error(`That file has ${body.length.toLocaleString()} rows. Split it into files of up to ${MAX_ROWS.toLocaleString()} rows and import them one at a time.`);
      const guessed: Record<string, number> = {};
      fields.forEach(({ key }) => {
        const fromSource = guessColumn(head, presets[key] || []);
        guessed[key] = fromSource >= 0 ? fromSource : guessColumn(head, GENERIC[key] || []);
      });
      // A "Company Name" column is the contact's company, not the person's name
      if (kind === 'contacts' && guessed.name >= 0 && guessed.name === guessed.company) guessed.name = -1;
      setFileName(file.name);
      setHeaders(head);
      setRows(body);
      setMapping(guessed);
    } catch (err: any) {
      setError(err.message || 'That file could not be read. Save it as CSV and try again.');
    }
  };

  const valueOf = (row: string[], key: string) => {
    const column = mapping[key];
    return column >= 0 ? (row[column] || '').trim() : '';
  };

  const preview = useMemo(() => rows.slice(0, 10), [rows]);
  const mappedFields = fields.filter(({ key }) => mapping[key] >= 0);

  const check = () => run(async () => {
    setError('');
    setSummary(null);
    try {
      const existing = existingKeys(kind, await api.get(LIST_PATH[kind]));
      const seen = new Set<string>();
      const add: Planned[] = [];
      const duplicates: number[] = [];
      const failed: Failed[] = [];
      rows.forEach((row, index) => {
        const built = buildRow(kind, (key) => valueOf(row, key));
        if (built.problem) return failed.push({ index, reason: built.problem });
        // The same record twice in the file counts once
        if (existing.has(built.key) || seen.has(built.key)) return duplicates.push(index);
        seen.add(built.key);
        add.push({ index, body: built.body, key: built.key, company: built.company });
      });
      setPlan({ add, duplicates, failed });
    } catch (err: any) {
      setError(err.message);
    }
  });

  const start = () => run(async () => {
    if (!plan) return;
    setError('');
    const failed = [...plan.failed];
    let added = 0;
    setProgress({ done: 0, total: plan.add.length });

    // Contacts are linked to CRM companies by name; a missing company is added once
    const companyIds = new Map<string, Promise<string>>();
    if (kind === 'contacts' && plan.add.some(({ company }) => company)) {
      try {
        (await api.get('/api/crm/companies')).forEach((company: any) => companyIds.set(lower(company.name), Promise.resolve(company.id)));
      } catch (err: any) {
        setError(`Could not read your CRM companies: ${err.message}`);
        return;
      }
    }
    const companyId = (name: string) => {
      const key = lower(name);
      if (!companyIds.has(key)) {
        const made = api.post('/api/crm/companies', { name }).then((company: any) => company.id);
        // A failed company can be tried again by a later row
        made.catch(() => companyIds.delete(key));
        companyIds.set(key, made);
      }
      return companyIds.get(key);
    };

    const send = async (item: Planned) => {
      let body = item.body;
      if (item.company) {
        try {
          body = { ...body, company_id: await companyId(item.company) };
        } catch (err: any) {
          throw new Error(`Could not add the company "${item.company}": ${err.message}`);
        }
      }
      await api.post(LIST_PATH[kind], body);
    };

    for (let at = 0; at < plan.add.length; at += BATCH) {
      const batch = plan.add.slice(at, at + BATCH);
      const results = await Promise.allSettled(batch.map(send));
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') added += 1;
        else failed.push({ index: batch[i].index, reason: result.reason?.message || 'Could not be saved' });
      });
      setProgress({ done: Math.min(at + BATCH, plan.add.length), total: plan.add.length });
    }

    failed.sort((a, b) => a.index - b.index);
    setSummary({ added, duplicates: plan.duplicates.length, failed });
    setPlan(null);
  });

  const downloadFailed = () => {
    if (!summary) return;
    downloadCsv(`import-${kind}-not-imported-${today()}.csv`, [
      [...headers, 'Why it was not imported'],
      ...summary.failed.map(({ index, reason }) => [...headers.map((_, column) => rows[index]?.[column] ?? ''), reason])
    ]);
  };

  const kindLabel = KINDS.find(({ id }) => id === kind);
  const running = busy && progress.total > 0;

  return (
    <div className="stack">
      <div className="page-head"><h1>Move your data in</h1></div>

      <p className="muted">
        Export a CSV from the product you use now and bring your records here. Nothing is changed in your old product,
        and records already here are skipped, so it is safe to run an import again.
      </p>
      <p className="muted">
        Opening balances aren&apos;t imported here. Enter them as one opening <Link href="/saas/accounting/journal">journal entry</Link> dated
        the day you switch, after importing your chart of accounts.
      </p>

      {error && <p className="error">{error}</p>}

      <div className="card stack">
        <h2>1. Where is your data coming from?</h2>
        <div className="form-grid">
          <label>From
            <select value={sourceId} disabled={busy} onChange={(e) => pickSource(e.target.value)}>
              {SOURCES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <label>What to bring in
            <select value={kind} disabled={busy} onChange={(e) => pickKind(e.target.value as Kind)}>
              {offered.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <label>CSV file (up to {MAX_ROWS.toLocaleString()} rows)
            <input type="file" accept=".csv,text/csv" disabled={busy} onChange={readFile} />
          </label>
        </div>
        <p className="muted">{source.howTo}</p>
        {fileName && <p className="notice">Read {rows.length.toLocaleString()} rows from {fileName}.</p>}
      </div>

      {headers.length > 0 && !summary && (
        <div className="card stack">
          <h2>2. Check which column is which</h2>
          <p className="muted">
            We matched the columns from a standard {source.label} export. Change any that are wrong. Each row needs {REQUIRED[kind]}.
          </p>
          <div className="form-grid">
            {fields.map(({ key, label, hint }) => (
              <label key={key} title={hint}>{label}
                <select value={mapping[key] ?? -1} disabled={busy} onChange={(e) => { setMapping({ ...mapping, [key]: Number(e.target.value) }); setPlan(null); }}>
                  <option value={-1}>Not in this file</option>
                  {headers.map((header, column) => <option key={column} value={column}>{header || `Column ${column + 1}`}</option>)}
                </select>
              </label>
            ))}
          </div>
          {kind === 'accounts' && (
            <p className="muted">
              Account types are read from words like bank, receivable, payable, equity, income, sales, cost and expense.
              A type we can&apos;t read is listed in the summary so you can add that account by hand.
            </p>
          )}

          <h3>First {preview.length} rows, as they will be saved</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Row</th>{mappedFields.map(({ key, label }) => <th key={key}>{label}</th>)}</tr></thead>
              <tbody>
                {preview.map((row, index) => (
                  <tr key={index}>
                    <td>{index + 1}</td>
                    {mappedFields.map(({ key }) => <td key={key} className="wrap">{valueOf(row, key) || '—'}</td>)}
                  </tr>
                ))}
                {!mappedFields.length && <tr><td className="empty">Pick at least one column above</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {headers.length > 0 && !summary && (
        <div className="card stack">
          <h2>3. Look for records you already have</h2>
          <p className="muted">Rows are skipped when the {DUPLICATE_BY[kind]} is already here, or appears earlier in the file.</p>
          {!plan && <div><button className="primary" disabled={busy || !mappedFields.length} onClick={check}>{busy ? 'Checking…' : 'Check for duplicates'}</button></div>}
          {plan && (
            <>
              <p>
                <strong>{plan.add.length.toLocaleString()}</strong> new {kindLabel?.what} to add,{' '}
                <strong>{plan.duplicates.length.toLocaleString()}</strong> already here,{' '}
                <strong>{plan.failed.length.toLocaleString()}</strong> missing something they need.
              </p>
              {running && (
                <div className="stack">
                  <progress max={progress.total} value={progress.done} style={{ width: '100%' }} aria-label="Import progress" />
                  <p className="muted">Added {progress.done.toLocaleString()} of {progress.total.toLocaleString()}… keep this page open until it finishes.</p>
                </div>
              )}
              <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
                <button className="primary" disabled={busy || !plan.add.length} onClick={start}>
                  {running ? 'Importing…' : `Import ${plan.add.length.toLocaleString()} ${kindLabel?.what}`}
                </button>
                <button disabled={busy} onClick={() => setPlan(null)}>Back</button>
              </div>
            </>
          )}
        </div>
      )}

      {summary && (
        <div className="card stack">
          <h2>4. Done</h2>
          <p>
            <strong>{summary.added.toLocaleString()}</strong> added, <strong>{summary.duplicates.toLocaleString()}</strong> skipped
            because they were already here, <strong>{summary.failed.length.toLocaleString()}</strong> not imported.
          </p>
          {summary.failed.length > 0 && (
            <p className="muted">
              Download the rows that were not imported, with the reason for each. Fix them in the file and import that file again.
            </p>
          )}
          <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
            {summary.failed.length > 0 && <button onClick={downloadFailed}>Download rows not imported</button>}
            <button className="primary always" onClick={reset}>Import another file</button>
            <Link className="button" href={LINKS[kind]}>Open {kindLabel?.label.toLowerCase()}</Link>
          </div>
        </div>
      )}
    </div>
  );
}

const LINKS: Record<Kind, string> = {
  contacts: '/saas/crm/contacts',
  companies: '/saas/crm/companies',
  customers: '/saas/accounting/customers',
  vendors: '/saas/accounting/vendors',
  accounts: '/saas/accounting/accounts',
  items: '/saas/inventory'
};
