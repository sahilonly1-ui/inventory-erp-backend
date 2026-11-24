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
