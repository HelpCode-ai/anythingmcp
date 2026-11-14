// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { describeByRules, detectLanguage, dominantPattern, frequentTerms, groupFolders, nameShape } from './rules';

describe('rule-based folder description', () => {
  it('recognises folder naming patterns', () => {
    expect(nameShape('Nordtor - 70100')).toBe('<name> - <number>');
    expect(nameShape('2024')).toBe('<year>');
    const p = dominantPattern(['Nordtor - 70100', 'Kessler Beschläge - 70107', 'Alpina - 70114', 'Brandt - 70121', 'Lumen Glas - 70128', '_Sonstiges']);
    expect(p).toMatchObject({ shape: '<name> - <number>', count: 5 });
    expect(dominantPattern(['a', 'b', 'c'])).toBeNull();
  });

  it('detects the language from function words and does not mistake German for Spanish', () => {
    const de = ['Zahlungsziel 30 Tage netto, 2 % Skonto bei Zahlung innerhalb von 10 Tagen. Frachtfrei ab 1.500 EUR und mit Aufpreis für Sonderfarben.', 'Sehr geehrte Damen und Herren, wir erhöhen unsere Listenpreise zum 01.01.2026. Die neue Preisliste ist gültig ab April. Mit freundlichen Grüßen'];
    expect(detectLanguage([...de, ...de])).toBe('de');
    expect(detectLanguage(['too short'])).toBeNull();
  });

  it('groups excluded folders by name and lists frequent terms', () => {
    expect(groupFolders(['A/Alt', 'B/Alt', 'C/Archiv 2019'])).toBe('"Alt" (2 folders), "Archiv 2019"');
    expect(frequentTerms(['Brandschutztür Zarge Stahl', 'Zarge Holz Brandschutztür', 'Zarge'])[0]).toBe('zarge');
  });

  it('writes a summary and instructions an AI can use', () => {
    const d = describeByRules({
      displayName: 'Price lists',
      topFolders: ['Nordtor - 70100', 'Kessler - 70107', 'Alpina - 70114', 'Brandt - 70121', 'Lumen - 70128'].map((name) => ({ name, files: 8 })),
      subfolders: ['Nordtor - 70100', 'Kessler - 70107', 'Alpina - 70114'].map((parent) => ({ parent, names: ['Preisliste', 'Konditionen'] })),
      types: { '.pdf': { files: 20, bytes: 1 }, '.xlsx': { files: 20, bytes: 1 } },
      totals: { files: 40, dirs: 15, bytes: 2, oldest: '2024-01-01T00:00:00Z', newest: '2026-05-01T00:00:00Z', nameOnly: 0 },
      samples: [],
      excludedArchives: ['Nordtor - 70100/Preisliste/Alt'],
      toolPrefix: 'pricelists',
    });
    expect(d.source).toBe('rules');
    expect(d.summary).toContain('40 documents');
    expect(d.summary).toContain('<name> - <number>');
    expect(d.instructions).toContain('pricelists_grep');
    expect(d.instructions).toContain('pricelists_view_page');
    expect(d.instructions).toContain('"Preisliste"');
    expect(d.instructions).toContain('Archive folders are not indexed ("Alt")');
  });
});
