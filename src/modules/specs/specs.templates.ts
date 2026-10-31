export type SpecField = { key: string; label: string };

const F = (pairs: [string, string][]): SpecField[] => pairs.map(([key, label]) => ({ key, label }));

export const PHONE = F([
  ['processor', 'Processor / Chipset'],
  ['ramStorage', 'RAM & Storage'],
  ['display', 'Display'],
  ['camera', 'Camera'],
  ['battery', 'Battery & Charging'],
  ['os', 'OS & Updates'],
  ['network', 'Network & Connectivity'],
  ['expandable', 'Expandable Storage'],
]);

const TEMPLATES: { match: RegExp; fields: SpecField[] }[] = [
  { match: /feature|keypad|basic phone/i, fields: F([
    ['display', 'Display'], ['camera', 'Camera'], ['battery', 'Battery'], ['network', 'Network & SIM'],
    ['storage', 'Memory & Expandable'], ['features', 'Key Features']]) },
  { match: /bud|tws|earphone|earbud|neck|headphone|headset|audio/i, fields: F([
    ['driver', 'Drivers & Sound'], ['anc', 'ANC / ENC'], ['battery', 'Playback & Charging'],
    ['connectivity', 'Bluetooth & Codecs'], ['water', 'Water Resistance'], ['features', 'Key Features']]) },
  { match: /smart\s*phone|mobile|^phones?$/i, fields: PHONE },
  { match: /\btab|ipad|tablet/i, fields: F([
    ['processor', 'Processor / Chipset'], ['ramStorage', 'RAM & Storage'], ['display', 'Display'],
    ['camera', 'Camera'], ['battery', 'Battery & Charging'], ['os', 'OS & Updates'],
    ['network', 'Wi-Fi / Cellular'], ['expandable', 'Expandable Storage']]) },
  { match: /watch|smart\s*band|fitness band|wearable/i, fields: F([
    ['display', 'Display'], ['battery', 'Battery Life & Charging'], ['health', 'Health & Fitness'],
    ['connectivity', 'Calling & Connectivity'], ['compatibility', 'Compatibility'], ['water', 'Water Resistance'],
    ['features', 'Key Features']]) },
  { match: /speaker|soundbar|sound bar/i, fields: F([
    ['output', 'Output Power'], ['battery', 'Battery & Charging'], ['connectivity', 'Connectivity'],
    ['water', 'Water Resistance'], ['features', 'Key Features']]) },
  { match: /power\s*bank/i, fields: F([
    ['capacity', 'Capacity'], ['output', 'Output & Fast Charging'], ['ports', 'Ports'],
    ['features', 'Safety & Features'], ['weight', 'Size & Weight']]) },
  { match: /charger|adapter|adaptor/i, fields: F([
    ['output', 'Power Output'], ['ports', 'Ports'], ['protocol', 'Fast-Charging Standards'],
    ['compatibility', 'Compatibility'], ['cable', 'Cable Included']]) },
  { match: /cable/i, fields: F([
    ['type', 'Connector Type'], ['length', 'Length'], ['power', 'Power / Data Rating'],
    ['build', 'Build'], ['compatibility', 'Compatibility']]) },
  { match: /\btv\b|television|\bled\b/i, fields: F([
    ['display', 'Screen & Resolution'], ['os', 'Smart OS'], ['audio', 'Audio Output'],
    ['connectivity', 'Ports & Connectivity'], ['features', 'Key Features']]) },
];

export function builtInTemplate(categoryName: string): SpecField[] | null {
  for (const t of TEMPLATES) if (t.match.test(categoryName)) return t.fields;
  return null;
}

export const GENERIC = F([
  ['features', 'Key Features'], ['connectivity', 'Connectivity'], ['power', 'Battery / Power'],
  ['compatibility', 'Compatibility'], ['inBox', 'In the Box']]);
