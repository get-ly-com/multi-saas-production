// Handles quoted fields, including commas and line breaks inside them
export const parseCsv = (text: string) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field || row.length) rows.push([...row, field]);
  return rows.filter((cells) => cells.some((cell) => cell.trim()));
};

// Spreadsheet exports name these columns in many ways
const COLUMN_NAMES: Record<string, string[]> = {
  name: ['name', 'full name', 'contact', 'contact name', 'lead', 'lead name'],
  first: ['first name', 'firstname', 'given name'],
  last: ['last name', 'lastname', 'surname', 'family name'],
  email: ['email', 'e-mail', 'email address'],
  phone: ['phone', 'mobile', 'telephone', 'phone number'],
  company: ['company', 'account', 'organization', 'organisation', 'company name'],
  job_title: ['title', 'job title', 'position', 'role'],
  source: ['source', 'lead source']
};

export const readPeople = (text: string) => {
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];

  const headers = head.map((cell) => cell.trim().toLowerCase());
  const column = (field: string) => headers.findIndex((header) => COLUMN_NAMES[field].includes(header));
  const cell = (row: string[], field: string) => (column(field) >= 0 ? (row[column(field)] || '').trim() : '');

  return rows.map((row) => ({
    name: cell(row, 'name') || `${cell(row, 'first')} ${cell(row, 'last')}`.trim(),
    email: cell(row, 'email'),
    phone: cell(row, 'phone'),
    company: cell(row, 'company'),
    job_title: cell(row, 'job_title'),
    source: cell(row, 'source')
  }));
};

export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'];

export const parseStatementDate = (value: string, format: string) => {
  const parts = value.trim().split(/[-/.]/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;

  const [first, second, third] = parts;
  const [year, month, day] = format === 'YYYY-MM-DD'
    ? [first, second, third]
    : format === 'DD/MM/YYYY' ? [third, second, first] : [third, first, second];
  const fullYear = year < 100 ? 2000 + year : year;

  const date = new Date(Date.UTC(fullYear, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
};

// A day over 12 or a leading year settles the format. Otherwise this assumes day first.
export const guessDateFormat = (values: string[]) => {
  const dates = values.map((value) => value.trim().split(/[-/.]/).map(Number)).filter((parts) => parts.length === 3);
  if (dates.some(([first]) => first > 31)) return 'YYYY-MM-DD';
  if (dates.some(([, second]) => second > 12)) return 'MM/DD/YYYY';
  return 'DD/MM/YYYY';
};

// Banks write amounts as 1,234.50, (45.00), -45.00 or $45.00 CR
export const parseStatementAmount = (value: string) => {
  const text = value.trim();
  if (!text) return null;

  const cleaned = text.replace(/[^0-9.\-()]/g, '');
  const negative = cleaned.includes('(') || cleaned.startsWith('-') || /dr$/i.test(text);
  const amount = Number(cleaned.replace(/[()\-]/g, ''));
  if (!cleaned || Number.isNaN(amount)) return null;
  return negative ? -amount : amount;
};
