import { describe, it, expect, vi } from 'vitest';
vi.mock('../config/logger', () => ({ logger: { info() {}, warn() {}, error() {} } }));
import { parseBing, parseDdg, matchesProduct } from '../modules/specs/specs.websearch';

describe('spec page web search', () => {
  it('reads Bing and DuckDuckGo result links', () => {
    const bing = '<ol><li class="b_algo" data-x="1"><div><h2 class="t"><a href="https://www.gadgets360.com/redmi-a7-pro-5g-price-in-india-135001" h="ID=1">Redmi A7 Pro 5G - Price in India, <strong>Specifications</strong></a></h2></div></li></ol>';
    expect(parseBing(bing)).toEqual([{ url: 'https://www.gadgets360.com/redmi-a7-pro-5g-price-in-india-135001', title: 'Redmi A7 Pro 5G - Price in India, Specifications' }]);
    const ddg = '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.91mobiles.com%2Fredmi-a7-pro-5g-price-in-india&amp;rut=x">Redmi A7 Pro 5G</a>';
    expect(parseDdg(ddg)[0].url).toBe('https://www.91mobiles.com/redmi-a7-pro-5g-price-in-india');
  });
  it('accepts only results carrying every model word', () => {
    expect(matchesProduct('Redmi A7 Pro 5G 4/128GB', 'Redmi', { url: 'https://www.gadgets360.com/redmi-a7-pro-5g-price-in-india-1', title: 'Redmi A7 Pro 5G' })).toBe(true);
    expect(matchesProduct('Redmi A7 Pro 5G 4/128GB', 'Redmi', { url: 'https://www.gadgets360.com/redmi-a7-5g-price-in-india-1', title: 'Redmi A7 5G' })).toBe(false);
    expect(matchesProduct('JBL Tune 760NC', 'JBL', { url: 'https://in.jbl.com/TUNE-760NC.html', title: 'JBL Tune 760NC | Wireless Over-Ear NC headphones' })).toBe(true);
    expect(matchesProduct('JBL Tune 760NC', 'JBL', { url: 'https://in.jbl.com/TUNE-770NC.html', title: 'JBL Tune 770NC' })).toBe(false);
  });
});
describe('spec page web search (more)', () => {
  it('unwraps Bing links and tolerates SKU codes', async () => {
    const { unwrapBing } = await import('../modules/specs/specs.websearch');
    const enc = Buffer.from('https://www.gadgets360.com/x-1').toString('base64').replace(/=+$/, '');
    expect(unwrapBing(`https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${enc}&amp;ntb=1`)).toBe('https://www.gadgets360.com/x-1');
    expect(matchesProduct('Sony LinkBuds S Wireless Headset WF-LS900N/CC', 'Sony', { url: 'https://www.gadgets360.com/sony-linkbuds-s-true-wireless-stereo-tws-earphones-price-in-india-108940', title: 'Sony LinkBuds S' })).toBe(true);
    expect(matchesProduct('Realme Buds Q2s TWS Earphone', 'Realme', { url: 'https://www.gadgets360.com/realme-buds-q2s-true-wireless-stereo-tws-earphones-price-in-india-106457', title: 'Realme Buds Q2s' })).toBe(true);
    expect(matchesProduct('Realme Buds Q2s TWS Earphone', 'Realme', { url: 'https://www.gadgets360.com/realme-buds-q2-price-in-india-1', title: 'Realme Buds Q2' })).toBe(false);
    expect(matchesProduct('Realme Smart TV 4K 43 108 cm', 'Realme', { url: 'https://www.91mobiles.com/realme-smart-tv-4k-43-inch-price-in-india', title: 'Realme Smart TV 4K 43 inch' })).toBe(true);
  });
});
