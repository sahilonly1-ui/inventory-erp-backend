import { describe, it, expect } from 'vitest';
import { parseDrikMonth, drikMonthUrl } from '../modules/festive/drik';

const card = (href: string, name: string, cls: string, date: string, detail: string) =>
  `<a href="${href}" class="dpEvent"><div class="dpEventImage"><div class="dpEmbeddedContainer dpRatio3By2"><img src="x.webp" alt="${name}" ><noscript><img src="x.jpg" alt="${name}"></noscript></div></div><div class="dpEventInfo"><div class="dpEventName ${cls}">${name}</div><div class="dpEventGregDate">${date}</div>${detail}</div></a>`;

describe('Drik Panchang month page', () => {
  it('reads every event card with its date', () => {
    const html = '<div>' + [
      card('/ekadashis/rama/rama-ekadashi-date-time.html?year=2026', 'Rama Ekadashi', 'dpHinduEventColor', 'November 5, 2026, Thursday', 'Kartika, Krishna Ekadashi'),
      card('/sikh/guru-nanak.html', 'Guru Nanak Jayanti', 'dpSikhEventColor', 'November 24, 2026, Tuesday', 'Kartika, Shukla Purnima'),
      card('/x.html', 'Children&#39;s Day', 'dpHinduEventColor', 'November 14, 2026, Saturday', 'fixed day in Gregorian calendar'),
      card('/x.html', 'Children&#39;s Day', 'dpHinduEventColor', 'November 14, 2026, Saturday', 'fixed day in Gregorian calendar'),
    ].join('') + '</div>';
    const ev = parseDrikMonth(html);
    expect(ev).toHaveLength(3);
    expect(ev[0]).toMatchObject({ day: '2026-11-05', name: 'Rama Ekadashi', kind: 'Hindu', detail: 'Kartika, Krishna Ekadashi' });
    expect(ev[1]).toMatchObject({ day: '2026-11-24', name: 'Guru Nanak Jayanti', kind: 'Sikh' });
    expect(ev[2].name).toBe("Children's Day");
  });
  it('builds month URLs', () => {
    expect(drikMonthUrl(2026, 10)).toBe('https://www.drikpanchang.com/festivals/month/festivals-november.html?year=2026');
    expect(drikMonthUrl(2027, 0)).toBe('https://www.drikpanchang.com/festivals/month/festivals-january.html?year=2027');
  });
});
