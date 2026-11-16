export function readParserConfig(env = process.env) {
  const mode = env.PARSER_MODE || 'off';
  if (!['off', 'fixture', 'live'].includes(mode)) throw new Error('PARSER_MODE must be off, fixture or live');
  if (mode === 'fixture' && env.MODE === 'production') throw new Error('Fixture mode is for local demos only');
  if (mode === 'live' && (env.MODE !== 'production' || env.AVITO_ACCESS_APPROVED !== '1')) {
    throw new Error('Live mode requires MODE=production and AVITO_ACCESS_APPROVED=1 after access is agreed');
  }
  const gap = Number(env.PARSER_MIN_GAP_SECONDS || 30);
  if (!Number.isInteger(gap) || gap < (mode === 'live' ? 15 : 1) || gap > 3600) {
    throw new Error('Invalid PARSER_MIN_GAP_SECONDS (live: 15–3600)');
  }
  return { mode, gap };
}
