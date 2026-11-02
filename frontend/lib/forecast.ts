// Forecast categories. Matches crm.forecast_category in the database.
export const CATEGORIES = [
  { id: 'commit', name: 'Commit' },
  { id: 'best_case', name: 'Best case' },
  { id: 'pipeline', name: 'Pipeline' },
  { id: 'omit', name: 'Left out' }
];

export const categoryName = (id: string) =>
  ({ won: 'Won', lost: 'Lost' } as Record<string, string>)[id] || CATEGORIES.find((category) => category.id === id)?.name || id;

export const automaticCategory = (probability: number) =>
  probability >= 90 ? 'commit' : probability >= 50 ? 'best_case' : 'pipeline';

// Months as 2026-11
export const monthOf = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

export const addMonths = (month: string, count: number) => {
  const [year, number] = month.split('-').map(Number);
  return monthOf(new Date(year, number - 1 + count, 1));
};

export const monthName = (month: string) => {
  const [year, number] = month.split('-').map(Number);
  return new Date(year, number - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
};
