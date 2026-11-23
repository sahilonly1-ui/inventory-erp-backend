import { describe, it, expect, vi } from 'vitest';
vi.mock('../config/prisma', () => ({ prisma: {} }));
vi.mock('../config/logger', () => ({ logger: { info() {}, warn() {}, error() {} } }));
import { verify } from '../modules/pricewatch/pricewatch.service';
import { normaliseStoreUrl, searchUrl } from '../modules/pricewatch/stores';

const offer = { bank: 'HDFC Bank', cardType: 'Credit Card', offerType: 'instant_discount', mode: 'EMI', percent: 10, maxDiscount: 1500, summary: '10% off up to ₹1,500 on HDFC credit card EMI' };

describe('agent result verification', () => {
  it('accepts a normal result and computes the effective price', () => {
    const v: any = verify({ store: 'amazon', url: 'https://www.amazon.in/JBL/dp/B0CXYZ1234/ref=x', price: 29999, mrp: 39999, priceText: '₹29,999', offers: [offer] }, 28000, 'JBL');
    expect(v.status).toBe('ok');
    expect(v.url).toBe('https://www.amazon.in/dp/B0CXYZ1234');
    expect(v.effectivePrice).toBe(28499);
  });
  it('does not trust a price without a real product URL', () => {
    expect((verify({ store: 'amazon', url: 'https://www.amazon.in/s?k=jbl', price: 29999 }, 28000, 'JBL') as any).status).toBe('unverified');
    expect((verify({ store: 'croma', url: 'https://www.amazon.in/dp/B0CXYZ1234', price: 29999 }, 28000, 'JBL') as any).status).toBe('unverified');
  });
  it('flags implausible prices and mismatched price text', () => {
    expect((verify({ store: 'croma', url: 'https://www.croma.com/jbl/p/301234', price: 9999 }, 28000, 'JBL') as any).status).toBe('suspect');
    expect((verify({ store: 'croma', url: 'https://www.croma.com/jbl/p/301234', price: 29999, priceText: '₹27,999' }, 28000, 'JBL') as any).status).toBe('suspect');
  });
  it('ignores absurd offer values and handles not listed', () => {
    const v: any = verify({ store: 'flipkart', url: 'https://www.flipkart.com/jbl/p/itmabc123?pid=X', price: 30000, offers: [{ ...offer, percent: null, maxDiscount: null, amount: 25000 }] }, null, 'JBL');
    expect(v.effectivePrice).toBeNull();
    expect((verify({ store: 'reliance', status: 'not_listed' }, null, 'JBL') as any).status).toBe('not_listed');
  });
  it('treats a placeholder price as not on sale', () => {
    expect((verify({ store: 'official', url: 'https://in.nothing.tech/products/phone-4b', price: 9999999 }, null, 'Nothing') as any).status).toBe('not_found');
  });
  it('prefers a full-swipe offer, falls back to an EMI one, respects caps and minimums', () => {
    const url = 'https://www.reliancedigital.in/product/samsung-galaxy-a37-5g-x';
    const sbi = { bank: 'SBI Card', cardType: 'Credit Card', offerType: 'instant_discount', mode: 'Full swipe', percent: 10, maxDiscount: 10000, minTxn: 5000, summary: '10% SBI' };
    const emi = { bank: 'ICICI Bank', cardType: 'Credit Card', offerType: 'instant_discount', mode: 'EMI', amount: 8000, summary: 'ICICI EMI' };
    const v: any = verify({ store: 'reliance', url, price: 56499, offers: [emi, sbi] }, null, 'Samsung');
    expect(v.effectivePrice).toBe(56499 - 5650);
    expect(v.bestOffer).toBe('₹5,650 off · SBI Card · Credit Card · Full swipe');
    const e: any = verify({ store: 'reliance', url, price: 56499, offers: [emi] }, null, 'Samsung');
    expect(e.bestOffer).toBe('₹8,000 off · ICICI Bank · Credit Card · EMI');
    const low: any = verify({ store: 'reliance', url, price: 3999, offers: [sbi] }, null, 'Samsung');
    expect(low.bestOffer).toBeNull();
  });
});

describe('store urls', () => {
  it('normalises and builds search links', () => {
    expect(normaliseStoreUrl('official', 'https://in.jbl.com/PARTYBOX-120.html', 'JBL')).toBe('https://in.jbl.com/PARTYBOX-120.html');
    expect(searchUrl('amazon', 'JBL PartyBox 120')).toBe('https://www.amazon.in/s?k=JBL%20PartyBox%20120');
    expect(searchUrl('official', 'X', 'UnknownBrand')).toBeNull();
  });
});
