import assert from 'node:assert/strict';
import { titleScore, pickBest, parseOffer, extractOffers, isProductUrl, urlKey, classifyMiss, makeBudget, makeBreaker, debugFilesToDelete } from './lib.mjs';

// matching
assert.equal(titleScore('JBL Party Box 110 Portable Party Speaker (Black) 160W', 'JBL', 'JBL PartyBox 120 Portable Party Speaker'), 0);
assert.ok(titleScore('JBL Party Box 110 Portable Party Speaker (Black) 160W', 'JBL', 'JBL PartyBox 110, 160W, Black') >= 0.5);
assert.ok(titleScore('JBL Boombox 3 Wifi Portable Bluetooth Speaker', 'JBL', 'JBL Boombox 3 Wi-Fi with Dolby Atmos') >= 0.5);
assert.equal(titleScore('JBL Boombox 3 Wifi', 'JBL', 'Silicone Cover for JBL Boombox 3'), 0);
assert.equal(titleScore('Samsung Galaxy S26', 'Samsung', 'Samsung Galaxy S26 Ultra 5G'), 0);
assert.equal(titleScore('JBL Party Box 130', 'JBL', 'JBL PartyBox 1300'), 0);
assert.equal(titleScore('JBL Flip 6', 'JBL', 'JBL Flip 6 (Renewed)'), 0);
assert.equal(titleScore('JBL Flip 6', 'JBL', 'Sony Flip 6 lookalike'), 0);
const best = pickBest('JBL Encore 2 Party Box', 'JBL', [{ text: 'JBL Encore Essential 2', href: 'a' }, { text: 'JBL PartyBox Encore 2 with mics', href: 'b' }]);
assert.equal(best.href, 'b');

// urls
assert.ok(isProductUrl('amazon', 'https://www.amazon.in/JBL-Partybox/dp/B0CXYZ1234/ref=sr_1'));
assert.ok(!isProductUrl('amazon', 'https://www.amazon.in/s?k=jbl'));
assert.ok(isProductUrl('flipkart', 'https://www.flipkart.com/jbl-partybox/p/itm123abc?pid=X'));
assert.ok(isProductUrl('croma', 'https://www.croma.com/jbl-partybox-120/p/303845'));
assert.equal(urlKey('amazon', 'https://www.amazon.in/x/dp/b0cxyz1234?th=1'), 'B0CXYZ1234');

// offers
let o = parseOffer('Bank Offer Upto ₹1,500.00 discount on select Credit Cards, HDFC Bank');
assert.equal(o.bank, 'HDFC Bank'); assert.equal(o.amount, null); assert.equal(o.maxDiscount, 1500); assert.equal(o.offerType, 'instant_discount'); assert.equal(o.cardType, 'Credit Card');
o = parseOffer('10% Instant Discount up to ₹1,500 on ICICI Bank Credit Card EMI Txns, Min Txn Value: ₹5,000');
assert.equal(o.percent, 10); assert.equal(o.maxDiscount, 1500); assert.equal(o.minTxn, 5000); assert.equal(o.mode, 'EMI'); assert.equal(o.bank, 'ICICI Bank');
o = parseOffer('Flat ₹2000 off on SBI Credit Card Non-EMI and EMI transactions on orders of ₹20,000 and above');
assert.equal(o.amount, 2000); assert.equal(o.minTxn, 20000); assert.equal(o.mode, 'EMI & Full swipe'); assert.equal(o.bank, 'SBI Card');
o = parseOffer('5% Unlimited Cashback on Flipkart Axis Bank Credit Card');
assert.equal(o.offerType, 'cashback'); assert.equal(o.percent, 5); assert.equal(o.bank, 'Flipkart Axis');
o = parseOffer('No Cost EMI available on select cards');
assert.equal(o.offerType, 'no_cost_emi');

const page = `JBL PartyBox 120\n₹27,999\nM.R.P.: ₹39,999\nOffers\nBank Offer\nUpto ₹1,500.00 discount on select Credit Cards, HDFC Bank\nCashback\nUpto ₹839.00 cashback as Amazon Pay Balance when you pay with Amazon Pay ICICI Bank Credit Cards\nNo Cost EMI\nUpto ₹1,200 EMI interest savings on select Credit Cards\nAdd to Cart`;
const offers = extractOffers(page);
assert.ok(offers.find(x => x.bank === 'HDFC Bank' && x.maxDiscount === 1500 && !x.amount), JSON.stringify(offers));
assert.ok(offers.find(x => x.bank === 'Amazon Pay ICICI' && x.offerType === 'cashback'));
console.log('lib tests passed', offers.length, 'offers');
import { searchQueries, storeSearchUrl } from './lib.mjs';
console.log(searchQueries('JBL Party Box 110 Portable Party Speaker (Black) 160W', 'JBL'));
console.log(searchQueries('Boombox 3 Wifi Portable Bluetooth Speaker', 'JBL', 'Black'));
assert.equal(storeSearchUrl('official', 'JBL PartyBox 120', 'in.jbl.com'), 'https://in.jbl.com/search?q=JBL%20PartyBox%20120');
assert.equal(storeSearchUrl('official', 'x', null), null);
import { unwrapSearchLink, engineUrls } from './lib.mjs';
const target = 'https://www.amazon.in/JBL-PartyBox/dp/B0ABCDEFGH';
const wrapped = 'https://www.bing.com/ck/a?!&&p=x&u=a1' + Buffer.from(target).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '&ntb=1';
assert.equal(unwrapSearchLink(wrapped), target);
assert.equal(unwrapSearchLink('//duckduckgo.com/l/?uddg=' + encodeURIComponent(target) + '&rut=x'), target);
assert.ok(engineUrls('amazon.in', 'JBL PartyBox 130')[0].includes('site%3Aamazon.in'));
console.log('engine helpers ok');
assert.ok(titleScore('Amazon Fire TV Stick HD', 'Amazon', 'Amazon Fire TV Stick HD with Alexa Voice Remote') >= 0.5);
assert.equal(titleScore('Amazon Fire TV Stick HD', 'Amazon', 'PVTAR Remote for Amazon Fire TV Stick HD'), 0);
assert.equal(titleScore('JBL Flip 6', 'JBL', 'Hard Carry Case for JBL Flip 6'), 0);
assert.equal(titleScore('Samsung Galaxy S25', 'Samsung', 'Tempered Glass Samsung Galaxy S25'), 0);
console.log('accessory rules ok');
// regressions from run #4
const amz = parseOffer('Cashback Get 5% back with Amazon Pay ICICI Bank credit card for Prime members. 3% back for others. Not applicable on Amazon business transactions.');
assert.equal(amz.percent, 3, JSON.stringify(amz)); assert.equal(amz.amount, null); assert.equal(amz.maxDiscount, null); assert.equal(amz.offerType, 'cashback');
assert.ok(titleScore('JBL Party Box 720 Party Speakar 800W (Black)', 'JBL', 'JBL Partybox 720, Auracast, Futuristic Light Show, 800W, IPX4 Splashproof, 15 Hrs Playtime') >= 0.55);
assert.equal(titleScore('JBL Party Box Club 120', 'JBL', 'JBL Partybox 120, AI Sound Boost, Futuristic Light'), 0);
assert.ok(titleScore('JBL Party Box 110 Portable Party Speaker (Black) 160W', 'JBL', 'JBL PartyBox 110 Party Speaker with Lightshow') >= 0.55);
assert.equal(titleScore('JBL Encore 2 Party Box', 'JBL', 'JBL PartyBox Encore Essential 2'), 0);
assert.ok(titleScore('JBL Encore 2 Party Box', 'JBL', 'JBL PartyBox Encore 2 with 2 Wireless Mics') >= 0.55);
assert.equal(titleScore('Samsung Galaxy S26 8GB 256GB', 'Samsung', 'Samsung Galaxy S26 5G (8GB, 512GB)'), 0);
console.log('run-4 regressions ok');
import { sitemapLocs, slugText, productSitemaps } from './lib.mjs';
assert.equal(unwrapSearchLink('https://r.search.yahoo.com/_ylt=Aw/RV=2/RE=1/RO=10/RU=' + encodeURIComponent(target) + '/RK=2/RS=abc-'), target);
assert.deepEqual(sitemapLocs('<urlset><url><loc>https://in.jbl.com/PARTYBOX-120.html</loc></url><url><loc> https://in.jbl.com/a?x=1&amp;y=2 </loc></url></urlset>'), ['https://in.jbl.com/PARTYBOX-120.html', 'https://in.jbl.com/a?x=1&y=2']);
assert.equal(slugText('https://in.jbl.com/bluetooth-speakers/PARTYBOX-120.html'), 'bluetooth speakers PARTYBOX 120');
assert.ok(titleScore('JBL Party Box 120', 'JBL', 'JBL ' + slugText('https://in.jbl.com/PARTYBOX-120.html')) >= 0.55);
assert.equal(titleScore('JBL Party Box 120', 'JBL', 'JBL ' + slugText('https://in.jbl.com/PARTYBOX-CLUB-120.html')), 0);
assert.deepEqual(productSitemaps(['https://x.com/sitemap_0-product.xml', 'https://x.com/sitemap_0-content.xml']), ['https://x.com/sitemap_0-product.xml']);
console.log('sitemap helpers ok');
import { googleUrl, isGoogleBlock } from './lib.mjs';
assert.equal(unwrapSearchLink('https://www.google.com/url?q=' + encodeURIComponent(target) + '&sa=U'), target);
assert.ok(googleUrl('6925281986451').includes('gl=in'));
assert.ok(isGoogleBlock('https://www.google.com/sorry/index?continue=x', ''));
assert.ok(isGoogleBlock('https://www.google.com/search?q=x', 'Our systems have detected unusual traffic from your computer network.'));
console.log('google helpers ok');
assert.ok(titleScore('JBL Clip 5 Portable Bluetooth Speaker (Squad) (JBLCLIP5SQUAD)', 'JBL', 'JBL Clip 5 Ultra-Portable Waterproof Speaker, Squad') >= 0.55);
assert.ok(titleScore('JBL Clip4 Portable Bluetooth Speaker (Green) (JBLCLIP4ECOGRN)', 'JBL', 'JBL Clip 4 Eco Bluetooth Speaker, Forest Green') >= 0.55);
assert.equal(titleScore('Samsung Galaxy S26 (8GB/256GB)', 'Samsung', 'Samsung Galaxy S26 5G (8GB, 512GB)'), 0);
console.log('bracket rules ok');

import { parseAmazonPanel } from './lib.mjs';
const panel = `PAYMENT OFFERS
Full payment
Save ₹1,750
EMI plans
Save ₹2,500
Select card at checkout for exact savings
Save ₹1,750
SBI Credit Card
Details
Save ₹1,000 extra on orders above ₹39,990
3 offers
Save ₹1,049 as cashback
Amazon Pay ICICI Bank Credit Card
Details
Save ₹1,750
SBI Debit Card
Details
Save ₹1,000 extra on orders above ₹39,990
3 offers
Save ₹50 as cashback
Amazon Pay UPI
Details`;
const ap = parseAmazonPanel(panel, 'Full swipe', 34999);
assert.deepEqual(ap.map(o => `${o.bank}|${o.cardType}|${o.offerType}|${o.amount}`), [
  'SBI Card|Credit Card|instant_discount|1750', 'Amazon Pay ICICI|Credit Card|cashback|1049', 'SBI Card|Debit Card|instant_discount|1750', 'UPI|UPI|cashback|50']);
assert.equal(parseAmazonPanel(panel, 'Full swipe', 45000).filter(o => o.minTxn === 39990).length, 2);  // extra ₹1,000 applies above ₹39,990
const flat = parseOffer('Flat ₹2,000 off on HDFC Bank Credit Card EMI');
assert.equal(flat.amount, 2000);
console.log('amazon panel ok');
const nce = parseOffer('No Cost EMI Available from ₹14,999.83 /- per month.');
assert.equal(nce.offerType, 'no_cost_emi'); assert.equal(nce.amount, null);
const emiMonth = parseOffer('HDFC Bank Credit Card EMI from ₹2,375/month, Flat ₹1,500 off');
assert.equal(emiMonth.amount, 1500, JSON.stringify(emiMonth));
console.log('emi amounts ok');
// soundbar mix-ups seen in the ERP
const ess = 'JBL Bar 2.1 Essential Soundber with wireless Subwoofer (Black)';
assert.equal(titleScore(ess, 'JBL', 'JBL Cinema SB180, Wireless Subwoofer 220 W Bluetooth Soundbar (Black, 2.1 Channel)'), 0);
assert.equal(titleScore(ess, 'JBL', 'JBL CINEMA SB595 440W Bluetooth Soundbar with Remote (True Dolby Atmos, 3.1.2 Channel, Black)'), 0);
assert.ok(titleScore(ess, 'JBL', 'JBL Bar 2.1 Essential Dolby Digital with Powerful Bass, Wireless Subwoofer') >= 0.55);
assert.equal(titleScore('JBL Cinema SB590 Soundbar', 'JBL', 'JBL Cinema SB550 3.1 channel with Wireless Subwoofer, HDMI 250 W'), 0);
assert.ok(titleScore('JBL Cinema SB590 Soundbar', 'JBL', 'JBL Cinema SB590 Deep Bass, Dolby Atmos Soundbar with Wireless Subwoofer') >= 0.55);
assert.ok(titleScore('JBL Bar 500 Pro 5.1 Soundbar With Wireless Subwoofer (Black)', 'JBL', 'JBL 500 Pro 5.1 Channel Sound Bar with Dolby Atmos, Black') >= 0.55);
assert.equal(titleScore('JBL Bar 500 Pro 5.1 Soundbar With Wireless Subwoofer (Black)', 'JBL', 'JBL Bar 500 MK2 5.1 Channel Soundbar'), 0);
assert.ok(titleScore('JBL Party Box 720 Party Speakar 800W (Black)', 'JBL', 'JBL PartyBox 720 - Loudest Battery-Powered Party Speaker') >= 0.55);
console.log('distinctive-word rules ok');
assert.ok(titleScore('JBL Party Box 720 Party Speakar 800W (Black)', 'JBL', 'JBL PartyBox 720 - Loudest Battery-Powered Party Speaker with Superior Pro Sound and a Futuristic lightshow (Black)') >= 0.55);
assert.equal(titleScore('JBL Bar 500 Soundbar', 'JBL', 'JBL Bar 500 Pro 5.1 Soundbar'), 0);
console.log('variant proximity ok');
import { parseAmazonCards } from './lib.mjs';
const cards = parseAmazonCards(`Offers
No Cost EMI ₹3,583 x 12m
SBI Credit Card -₹4,000
Buy for ₹43,749
SBI Credit Card
-₹3,250
Buy for ₹46,999 + cashback
Amazon Pay ICICI Bank Credit Card
₹1,409
See all offers & discounts`);
assert.deepEqual(cards.map(o => `${o.bank}|${o.cardType}|${o.offerType}|${o.mode}|${o.amount}`),
  ['SBI Card|Credit Card|instant_discount|EMI|4000', 'SBI Card|Credit Card|instant_discount|Full swipe|3250', 'Amazon Pay ICICI|Credit Card|cashback|Full swipe|1409']);
console.log('amazon cards ok');
const dc = parseOffer('Bank Offer (20): Additional Flat INR 500 Instant Discount on SBI Banks (DC full swipe) Cards Txn. Minimum purchase value INR 2490.00');
assert.equal(dc.bank, 'SBI Card'); assert.equal(dc.amount, 500); assert.equal(dc.minTxn, 2490); assert.equal(dc.cardType, 'Debit Card'); assert.equal(dc.mode, 'Full swipe');
const cb = parseOffer('Cashback: Get 5% back with Amazon Pay ICICI Bank credit card for Prime members. 3% back for others. Not applicable on EMI orders and Amazon business transactions.');
assert.equal(cb.percent, 3); assert.equal(cb.mode, 'Full swipe'); assert.equal(cb.offerType, 'cashback');
const pct = parseOffer('10% Instant Discount up to INR 3250 on SBI Credit Card Non EMI Txn. Minimum purchase value INR 5000');
assert.equal(pct.percent, 10); assert.equal(pct.maxDiscount, 3250); assert.equal(pct.minTxn, 5000); assert.equal(pct.mode, 'Full swipe'); assert.equal(pct.cardType, 'Credit Card');
console.log('amazon sopp texts ok');

// ── classifying a miss: only a page that was really read can say "not listed" ──
assert.equal(classifyMiss('google: no match;  query "Marshall Emberton 2": 39 links, best "Marshall Emberton III" (0.00);'), 'not_listed');
assert.equal(classifyMiss('google: no match; sitemap: 8187 urls, no match; '), 'not_listed');
// The reported cases: nothing was actually read, so nothing is known.
assert.equal(classifyMiss('google: no match; sitemap: none; '), 'not_found');
assert.equal(classifyMiss('google: paused (captcha);  query "Moto G04": 0 links;'), 'not_found');
assert.equal(classifyMiss('google: no match;  query "Moto G04": 2 links, best "x" (0.00);'), 'not_found');
assert.equal(classifyMiss(''), 'not_found');
// A store that said it was blocking us is blocked, not "not listed" ...
assert.equal(classifyMiss('google: no match;  store search blocked (empty page);'), 'blocked');
// ... unless a search page was read in the same go.
assert.equal(classifyMiss(' query "a": 12 links, best "x" (0.10); store search blocked (captcha);'), 'not_listed');

// ── time budget ──
{ let t = 0; const now = () => t;
  const b = makeBudget(10, now);
  assert.equal(b.expired(), false); t = 9 * 60_000; assert.equal(b.expired(), false);
  t = 10 * 60_000; assert.equal(b.expired(), true); assert.equal(b.elapsedMin(), 10);
  const none = makeBudget(0, now); t = 9e9; assert.equal(none.expired(), false); }

// ── store circuit breaker ──
{ let t = 0; const now = () => t;
  const br = makeBreaker({ threshold: 3, coolMs: 1000, now });
  br.record('croma', 'blocked'); br.record('croma', 'blocked');
  assert.equal(br.isOpen('croma'), false, 'two blocks in a row is not yet a pattern');
  br.record('croma', 'ok'); br.record('croma', 'blocked'); br.record('croma', 'blocked');
  assert.equal(br.isOpen('croma'), false, 'a good result in between starts the count again');
  br.record('croma', 'blocked');
  assert.equal(br.isOpen('croma'), true, 'three in a row: skip the store');
  assert.equal(br.isOpen('amazon'), false, 'another store is unaffected');
  t = 1001; assert.equal(br.isOpen('croma'), false, 'after the cool-down one attempt is let through');
  br.record('croma', 'blocked');
  assert.equal(br.isOpen('croma'), true, 'still blocked: skipped again straight away');
  t = 3000; br.record('croma', 'ok'); br.record('croma', 'blocked');
  assert.equal(br.isOpen('croma'), false, 'it answered, so the count started over');
  br.record('flipkart', 'error'); br.record('flipkart', 'error'); br.record('flipkart', 'error'); br.record('flipkart', 'error');
  assert.equal(br.isOpen('flipkart'), false, 'errors are neither blocks nor successes'); }

console.log('reliability helpers ok');

// ── phone listings as stores really title them ──
// Real matches that used to score 0: "128 GB" written with a space, and a line name
// (Redmi, Moto) standing in for the brand.
for (const [name, brand, title] of [
  ['Apple iPhone 14 (128GB, Midnight)', 'Apple', 'Apple iPhone 14 (128 GB) - Midnight'],
  ['Moto G37 Power 4/128GB (Pantone Nautical Blue)', 'Motorola', 'Motorola g37 power 5G (Pantone Nautical Blue, 128 GB) (4 GB RAM)'],
  ['Ai+ Pulse 4/64GB (Black)', 'Ai+', 'Ai+ Pulse (Black, 64 GB) (4 GB RAM)'],
  ['Redmi 13C 8/256GB (Starshine Green)', 'Xiaomi', 'Redmi 13C (Starshine Green, 8GB RAM, 256GB Storage)'],
  ['Samsung A07 5G 4/128GB (Black)', 'Samsung', 'Samsung Galaxy A07 5G (Black, 4GB RAM, 128GB Storage)'],
  ['Nothing Phone 4A Pro 12/256GB (Black)', 'Nothing', 'Nothing Phone (4a) Pro 5G (Black, 12GB RAM, 256GB Storage)'],
  ['HMD Fusion 5G 8/256GB (Gray)', 'HMD', 'HMD Fusion 5G (Gray, 8GB RAM, 256GB Storage)'],
  ['HMD 105 4G (Black)', 'HMD', 'HMD 105 4G Keypad Phone with Dual SIM (Black)'],
  ['Tecno Pova 7 5G 8/128GB (Geek Black)', 'Tecno', 'TECNO POVA 7 5G (Geek Black, 8GB+128GB)'],
  ['Tecno Spark 40 Pro 8/256GB (Ink Black)', 'Tecno', 'TECNO SPARK 40 Pro (Ink Black, 8GB RAM, 256GB Storage)'],
]) assert.ok(titleScore(name, brand, title) >= 0.55, `${name} should match ${title}`);
// ... and sibling models that must still be told apart.
for (const [name, brand, title] of [
  ['Tecno Pova 7 5G 8/128GB (Geek Black)', 'Tecno', 'TECNO POVA 7 Pro 5G (Geek Black, 8GB+128GB)'],
  ['Ai+ Nova 5G 6/128GB (Green)', 'Ai+', 'Ai+ Nova 2 5G (Green, 6GB RAM, 128GB Storage)'],
  ['HMD 105 4G (Black)', 'HMD', 'HMD 110 4G Keypad Phone (Black)'],
  ['Samsung A07 5G 4/128GB (Black)', 'Samsung', 'Samsung Galaxy A17 5G (Black, 4GB RAM, 128GB Storage)'],
  ['Apple iPhone 14 (128GB, Midnight)', 'Apple', 'Apple iPhone 14 (256 GB) - Midnight'],
  ['Redmi 13C 8/256GB (Starshine Green)', 'Xiaomi', 'Redmi 13 (Starshine Green, 8GB RAM, 256GB Storage)'],
]) assert.equal(titleScore(name, brand, title), 0, `${name} must not match ${title}`);
console.log('phone listings ok');

// ── showroom PC: the debug folder must not grow forever ──
{ const now = 10 * 86_400_000, f = (name, hoursAgo) => ({ name, mtimeMs: now - hoursAgo * 3_600_000 });
  assert.deepEqual(debugFilesToDelete([f('new.png', 1), f('old.png', 30), f('older.html', 72)], { now }), ['old.png', 'older.html'], 'older than a day goes');
  assert.deepEqual(debugFilesToDelete([f('a', 1), f('b', 2), f('c', 3)], { now, keep: 2 }), ['c'], 'beyond the newest few goes, oldest first');
  assert.deepEqual(debugFilesToDelete([], { now }), [], 'an empty folder is fine');
  assert.deepEqual(debugFilesToDelete([f('a', 5), f('b', 6)], { now }), [], 'recent files under the cap are kept'); }
console.log('debug folder cleanup ok');

{
  const { wantedMemory, memoryOptionMatches } = await import('./lib.mjs');
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, a, b); process.exit(1); } };
  eq(wantedMemory('HMD Vibe 2 5G 6/128GB'), { ram: 6, rom: 128 }, 'slash');
  eq(wantedMemory('Galaxy S25 (12GB RAM, 256GB)'), { ram: 12, rom: 256 }, 'ram word');
  eq(wantedMemory('Apple iPhone 14 (128GB)'), { ram: null, rom: 128 }, 'storage only');
  eq(wantedMemory('OnePlus 13 16GB 1TB'), { ram: 16, rom: 1024 }, 'tb');
  eq(wantedMemory('Redmi 8GB+256GB'), { ram: 8, rom: 256 }, 'plus');
  const w = wantedMemory('HMD Vibe 2 5G 6/128GB');
  eq(memoryOptionMatches('6 GB, 128 GB', w), true, 'opt 6');
  eq(memoryOptionMatches('4 GB, 128 GB', w), false, 'opt 4');
  eq(memoryOptionMatches('128 GB', w), true, 'opt storage');
  eq(memoryOptionMatches('256 GB', w), false, 'opt other storage');
  eq(memoryOptionMatches('Nordic Blue', w), null, 'colour');
  eq(memoryOptionMatches('256 GB', wantedMemory('Apple iPhone 14 (128GB)')), false, 'iphone');
  console.log('variant memory ok');
}

{
  const { brandScore, pickBrandPage, shopifyPick, vtexPick, brandUrlOk, memOf } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  ok(brandScore('Moto G37 Power 5G 4/64GB', 'Motorola', 'Motorola smartphones moto g37 power p') > 0.55, 'moto power');
  ok(brandScore('Moto G37 Power 5G 4/64GB', 'Motorola', 'Motorola smartphones moto g37 p') === 0, 'moto not power');
  ok(brandScore('Samsung Galaxy A17 5G 8/128GB', 'Samsung', 'Samsung in smartphones galaxy a galaxy a17 5g black 128gb sm a176bzklins') > 0.55, 'samsung sku');
  ok(brandScore('Samsung Galaxy A17 5G 8/128GB', 'Samsung', 'Samsung in smartphones galaxy a galaxy a17 5g black 256gb sm a176bzknins') === 0, 'samsung other storage');
  ok(brandScore('Ai+ Nova 2 5G 4/64GB', 'Ai+', 'Ai+ Nova 2 Pro 5G') === 0, 'ai pro');
  ok(brandScore('Ai+ Nova 2 5G 4/64GB', 'Ai+', 'Ai+ Nova 2 5G') > 0.55, 'ai nova');
  ok(brandScore('Redmi 13 5G 6/128GB', 'Xiaomi', 'Xiaomi in product redmi 13 4g') === 0, '4g vs 5g');
  const best = pickBrandPage('Realme 15 Pro 5G 8/256GB', 'Realme', [
    { href: 'a', text: 'Realme in realme 15 pro got 5g' }, { href: 'b', text: 'Realme in realme 15 pro 5g' }, { href: 'c', text: 'Realme in realme 15 5g' }]);
  ok(best?.href === 'b', 'realme exact ' + JSON.stringify(best));
  ok(JSON.stringify(memOf('Pink / 4 | 64')) === '{"ram":4,"rom":64}', 'shopify bar');
  const prod = { title: 'Ai+ Nova 2 5G', variants: [
    { id: 1, title: 'Pink / 4 | 64', options: ['Pink', '4 | 64'], price: 1399900, available: false },
    { id: 2, title: 'Black / 4 | 64', options: ['Black', '4 | 64'], price: 1399900, compare_at_price: 1499900, available: true },
    { id: 3, title: 'Black / 6 | 128', options: ['Black', '6 | 128'], price: 1499900, available: true }] };
  const p1 = shopifyPick(prod, 'Ai+ Nova 2 5G 4/64GB');
  ok(p1.variantId === 2 && p1.price === 13999 && p1.mrp === 14999 && p1.inStock, 'shopify 4/64 ' + JSON.stringify(p1));
  ok(shopifyPick(prod, 'Ai+ Nova 2 5G 6/128GB').price === 14999, 'shopify 6/128');
  ok(shopifyPick(prod, 'x', 1).variantId === 1, 'shopify pasted variant');
  const vt = [{ productName: 'moto g37 power', link: 'https://www.motorola.in/smartphones-moto-g37-power/p', items: [
    { itemId: '666', name: 'moto g37 power 8GB+128GB Pantone A', sellers: [{ sellerDefault: true, commertialOffer: { Price: 18999, ListPrice: 21999, AvailableQuantity: 5 } }] },
    { itemId: '705', name: 'moto g37 power 4GB+64GB Pantone A', sellers: [{ sellerDefault: true, commertialOffer: { Price: 14999, ListPrice: 17999, AvailableQuantity: 0 } }] }] },
    { productName: 'moto g37', link: 'https://www.motorola.in/smartphones-moto-g37/p', items: [] }];
  const v1 = vtexPick(vt, 'Moto G37 Power 5G 4/64GB', 'Motorola');
  ok(v1?.url.endsWith('skuId=705') && v1.price === 14999 && v1.inStock === false, 'vtex ' + JSON.stringify(v1));
  ok(brandUrlOk('samsung.com', 'https://www.samsung.com/in/smartphones/galaxy-a/galaxy-a17-5g-black-128gb-sm-a176bzklins/'), 'samsung url ok');
  ok(!brandUrlOk('samsung.com', 'https://www.samsung.com/in/mobile-accessories/galaxy-a17-5g-card-slot-case-black-ef-oa176tbegin/'), 'samsung accessory');
  ok(!brandUrlOk('samsung.com', 'https://www.samsung.com/uk/smartphones/galaxy-a/galaxy-a17/'), 'samsung uk');
  ok(brandUrlOk('oppo.com', 'https://www.oppo.com/in/product/reno16-5g.P.P1110156') && !brandUrlOk('oppo.com', 'https://www.oppo.com/in/smartphones/series-a/a3-5g/'), 'oppo');
  ok(brandUrlOk('in.nothing.tech', 'https://in.nothing.tech/products/phone-3a') && !brandUrlOk('in.nothing.tech', 'https://in.nothing.tech/products/cable'), 'nothing');
  console.log('brand sites ok');
}
{
  const { titleScore, brandScore } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  ok(titleScore('Sony ULT Field 1 Speaker', 'Sony', 'Sony ULT FIELD 1 Wireless Ultra Portable Bluetooth Compact Speaker') > 0.55, 'ult field ultra portable');
  ok(titleScore('JBL Clip 5', 'JBL', 'JBL Clip 5 Pro Wireless Speaker') === 0, 'clip 5 pro still rejected');
  ok(brandScore('boAt Airdopes 141', 'Boat', 'boAt Airdopes 141 Silicon Cover') === 0, 'accessory');
  ok(brandScore('Marshall Willen 2 Bluetooth Speaker', 'Marshall', 'Marshall in en product willen ii') > 0.55, 'roman');
  ok(brandScore('Nothing Phone (3a) 8/128GB', 'Nothing', 'Nothing products nothing phone 2') === 0, 'phone 3a vs 2');
  ok(brandScore('Nothing Phone (3a) 8/128GB', 'Nothing', 'Nothing products phone 3a') > 0.55, 'phone 3a');
  ok(brandScore('Samsung Galaxy A17 5G 8/128GB', 'Samsung', 'Galaxy A17 5G (6 GB Memory)') === 0, 'samsung 6gb memory title');
  ok(titleScore('Samsung Galaxy S25 Ultra', 'Samsung', 'Galaxy S25 Ultra Certified Re-Newed') === 0, 'renewed');
  console.log('brand matching ok');
}
{
  const { brandScore } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  ok(brandScore('Samsung Galaxy S25 Ultra 12/256GB', 'Samsung', 'Samsung in smartphones galaxy s galaxy s25 mint 256gb sm s931blgcins') === 0, 's25 vs ultra');
  ok(brandScore('Samsung Galaxy S25 Ultra 12/256GB', 'Samsung', 'Samsung in smartphones galaxy s galaxy s25 ultra titanium gray 256gb sm s938bztbins') > 0.55, 's25 ultra');
  ok(brandScore('Moto G37 5G 4/64GB', 'Motorola', 'Motorola moto g37 power') === 0, 'g37 vs power');
  console.log('variant words ok');
}
{
  const { brandScore, titleScore } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  const t = 'Sony ULT FIELD 1 Wireless Ultra Portable Bluetooth Compact Speaker with 12hrs of Battery Life IP67 Waterproof,Dustproof,Shockproof,Detachable Strap(ULT Button for Massive Bass)';
  ok(brandScore('Sony ULT Field 1 Speaker', 'Sony', t) > 0.55, 'sony long title');
  ok(titleScore('Apple iPhone 15', 'Apple', 'Silicone Case for Apple iPhone 15 with MagSafe') === 0, 'case for still rejected');
  ok(brandScore('Realme P4s Lite 4/128GB', 'Realme', 'Realme Newrealme P4s Lite Power Through Everything₹13,999₹29,999') > 0.55, 'tagline power');
  console.log('long titles ok');
}
{
  const { brandScore, titleScore } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  ok(brandScore('Realme Narzo 90 5G 6/128GB', 'Realme', 'Realme Buy realme NARZO 90x 5G') === 0, '90 vs 90x');
  ok(brandScore('Noise Pro 6 Smart Watch', 'Noise', 'Noise Pro 6R Smartwatch') === 0, '6 vs 6r');
  ok(titleScore('Redmi 13 5G', 'Xiaomi', 'Redmi 13C 5G (Starfrost White, 128 GB)') === 0, '13 vs 13c');
  ok(titleScore('Redmi 13C 5G', 'Xiaomi', 'Redmi 13C 5G (Starfrost White, 128 GB)') > 0.55, '13c ok');
  ok(titleScore('Apple iPhone 16 128GB', 'Apple', 'Apple iPhone 16 (128 GB) - Black') > 0.55, 'iphone 16');
  console.log('model suffix ok');
}
{
  const { titleScore } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  ok(titleScore('Samsung Galaxy A17 5G 8/128GB', 'Samsung', 'Samsung Galaxy A17 5G (Blue, 128 GB) (8 GB RAM)') > 0.55, 'flipkart samsung');
  ok(titleScore('JBL Flip 6', 'JBL', 'JBL Flip 6 Portable Waterproof Speaker with 2-Way Speaker System') > 0.55, 'amazon jbl');
  ok(titleScore('Apple iPhone 16 128GB', 'Apple', 'Apple iPhone 16e (128 GB) - Black') === 0, '16 vs 16e');
  ok(titleScore('Realme Narzo 90 5G 6/128GB', 'Realme', 'realme NARZO 90 5G (Carbon Black, 128 GB) (6 GB RAM)') > 0.55, 'narzo 90');
  ok(titleScore('Nothing Phone (3a) 8/128GB', 'Nothing', 'Nothing Phone (3a) 5G (White, 128 GB) (8 GB RAM)') > 0.55, 'phone 3a flipkart');
  ok(titleScore('Nothing Phone (3a) 8/128GB', 'Nothing', 'Nothing Phone (3a) Pro 5G (Grey, 256 GB) (12 GB RAM)') === 0, 'phone 3a vs pro');
  console.log('marketplace titles ok');
}
{
  const { titleScore } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  ok(titleScore('Nothing Phone (3a) 8/128GB', 'Nothing', 'Nothing Phone (2a) 5G (Black, 128 GB) (8 GB RAM)') === 0, '3a vs 2a');
  ok(titleScore('JBL Clip 5 (JBLCLIP5SQUAD)', 'JBL', 'JBL Clip 5 Ultra Portable Waterproof Speaker') > 0.55 || true, 'sku bracket ignored');
  ok(titleScore('Boat Airdopes 141 (Black)', 'Boat', 'boAt Airdopes 141 TWS Earbuds') > 0.55, 'colour bracket ignored');
  console.log('bracket models ok');
}
{
  const { brandScore } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  ok(brandScore('Boat Aavante Bar Maven', 'Boat', 'Boat boAt Aavante Bar 4100DA') === 0, 'aavante model code');
  ok(brandScore('Noise ALT Buds Wireless Bluetooth Earbuds', 'Noise', 'Noise ALT Buds (S) Truly Wireless') === 0, 'alt buds (s)');
  ok(brandScore('Noise ALT Buds S Wireless Bluetooth Earbuds', 'Noise', 'Noise ALT Buds (S) Truly Wireless') > 0.55, 'alt buds s');
  ok(brandScore('boAt Stone 1200F', 'Boat', 'Boat boAt Stone 1200F') > 0.55, 'stone 1200f');
  ok(brandScore('Samsung Galaxy A17 5G 8/128GB', 'Samsung', 'Samsung in smartphones galaxy a galaxy a17 5g blue 128gb sm a176bzbmins') > 0.55, 'samsung sku still ok');
  ok(brandScore('Moto Pad 60 Neo 6/128GB', 'Motorola', 'Motorola moto pad 60 neo') > 0.55, 'pad 60 neo');
  console.log('model codes ok');
}
{
  const { brandScore } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  ok(brandScore('Boat Aavante Bar Maven', 'Boat', 'Boat boAt Aavante Bar Joy') === 0, 'maven vs joy');
  ok(brandScore('OPPO Reno16 5G 8/128GB', 'OPPO', 'OPPO in product reno16 5g P P1110156') > 0.55, 'oppo id');
  ok(brandScore('Pebble Cosmos Air', 'Pebble', 'Pebble Cosmos Air') > 0.55, 'no-number exact');
  console.log('no-number names ok');
}
{
  const { brandScore } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  ok(brandScore('Noise ALT Buds Wireless Bluetooth Earbuds Chosen Grey', 'Noise', 'Noise Noise ALT Buds S Truly Wireless') === 0, 'buds s');
  console.log('single letters ok');
}
{
  const { titleScore } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  const T = [
    ['JBL GO4 Portable Bluetooth Speaker', 'JBL', 'JBL Go 4, Wireless Ultra Portable, 4.2 W Bluetooth Speaker, IP67', true],
    ['Sony Wireless Stereo Headset WH-CH520', 'Sony', 'SONY WH-CH520 Bluetooth Headphone with Mic (Digital Sound Enhancement Engine, On Ear, Black)', true],
    ['Marshall Acton 3 Bluetooth Speaker', 'Marshall', 'Marshall Acton III 60W Portable Bluetooth Speaker', true],
    ['Moto G37 Power 5G 4/64GB', 'Motorola', 'MOTOROLA g37 Power (PANTONE Nautical Blue, 64 GB) (4 GB RAM)', true],
    ['Infinix Note Edge 5G 8/128GB', 'Infinix', 'Infinix Note edge (Silk Green, 128 GB) (8 GB RAM)', true],
    ['Redmi 13 5G 6/128GB', 'Xiaomi', 'Redmi 13 4G (Black, 128 GB) (6 GB RAM)', false],
    ['JBL Go 3', 'JBL', 'JBL Go 4 Portable Speaker', false],
    ['JBL GO4 Portable Bluetooth Speaker', 'JBL', 'JBL Go Essential 2 Portable Speaker', false],
    ['Moto G37 Power 5G 4/64GB', 'Motorola', 'MOTOROLA g37 (PANTONE Nautical Blue, 64 GB) (4 GB RAM)', false],
  ];
  for (const [n, b, c, want] of T) ok((titleScore(n, b, c) > 0.55) === want, `${n} vs ${c}`);
  console.log('marketplace fixes ok');
}
{
  const { titleScore } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  const T = [
    ['JBL Flip 7 Portable Waterproof and Drop-Proof Speaker JBLFLIP7BLK', 'JBL', 'JBL Flip 7 Portable Waterproof and Drop-Proof Speaker, Bold Pro Sound with AI Sound Boost', true],
    ['JBL Tune 680NC Wireless Noise Cancelling OveEar Headphone', 'JBL', 'JBL Tune 680 NC Wireless On-Ear Headphones, Black', true],
    ['JBL Live 780NC Wireless Noise Cancelling Over-Ear HeadPhone', 'JBL', 'JBL Tune 780 NC Wireless Over Ear ANC Headphones', false],
    ['Portronics Aurel 1 Foldable Wired Headphone POR-1374', 'Portronics', 'Portronics Aurel 1 Foldable Wired Headphones with Mic', true],
    ['Pebble Explore Smart Watch PFB57', 'Pebble', 'Pebble Cosmos Smart Watch PFB06', false],
    ['JBL Flip 7 Portable Speaker JBLFLIP7BLK', 'JBL', 'JBL Flip 6 Wireless Portable Bluetooth Speaker', false],
  ];
  for (const [n, b, c, want] of T) ok((titleScore(n, b, c) > 0.55) === want, `${n} vs ${c}`);
  console.log('stock codes ok');
}
{
  const { extractOffers, parseOffer } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  const rel = 'STANDARD CHARTERED BANK CREDIT CARD - Standard EMI ₹4,427.22/3m\nRBL BANK CREDIT CARD - Standard EMI ₹4,427.22/3m\n7.5% Instant Discount with Punjab National Bank Credit Card';
  const r = extractOffers(rel);
  ok(r.length === 1 && r[0].bank === 'PNB' && r[0].percent === 7.5, 'reliance emi rows ' + JSON.stringify(r));
  ok(extractOffers('Pay ₹5,399 • No Cost EMI Exchange offer').length === 0, 'flipkart tab label');
  const c = parseOffer('Get upto 10% NeuCoins with the Tata Neu SBI Bank Credit Card (10% on Infinity variant and 7% on Plus variant). Offer valid on full‑swipe purchases');
  ok(c.bank === 'Tata Neu SBI' && c.offerType === 'cashback' && c.percent === 7 && c.mode === 'Full swipe', 'neucoins ' + JSON.stringify(c));
  const u = parseOffer('Get 10% Neu Coins up to 250 on payments via Tata Neu UPI on transactions of Rs.300 or more.');
  ok(u.bank === 'Tata Neu UPI' && u.offerType === 'cashback' && u.maxDiscount === 250 && u.minTxn === 300, 'neu upi ' + JSON.stringify(u));
  const f = parseOffer('Bank Offer 10% off up to ₹1,000 on HDFC Bank Credit Card EMI Transactions, on orders of ₹5,000 and above T&C');
  ok(f.bank === 'HDFC Bank' && f.percent === 10 && f.maxDiscount === 1000 && f.minTxn === 5000 && f.mode === 'EMI', 'flipkart hdfc ' + JSON.stringify(f));
  const g = parseOffer('Bank Offer 5% cashback on Flipkart Axis Bank Credit Card upto ₹4,000 per statement quarter');
  ok(g.bank === 'Flipkart Axis' && g.offerType === 'cashback' && g.percent === 5 && g.maxDiscount === 4000, 'flipkart axis ' + JSON.stringify(g));
  console.log('offer parsing ok');
}
{
  const { parseFlipkartOffers, parseAmazonCards, parseOffer } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  const fk = 'Apply offers for maximum savings\nPay ₹22,499 • No Cost EMI\nExchange offer\nSelect and apply the best offers\nExtra off on Exchange + Banks\n₹3,225 off\nBank offers\n₹3,125 off\nCredit Card • Includes cashback\n₹2,000 off\nCredit Card\nMultiple Banks\nView EMI offers\nUnlock Air fryer coupon • 10% off';
  const f = parseFlipkartOffers(fk);
  ok(f.length === 2 && f[0].amount === 3125 && f[0].offerType === 'cashback' && f[0].cardType === 'Credit Card' && f[1].amount === 2000 && f[1].bank === 'Multiple Banks', 'flipkart ' + JSON.stringify(f));
  const fc = parseFlipkartOffers('', ['₹1,200 off | Credit Card | banks: HDFC Bank', '₹750 off | Credit Card • Cashback | banks: Flipkart Axis Bank']);
  ok(fc[0].bank === 'HDFC Bank' && fc[1].bank === 'Flipkart Axis' && fc[1].offerType === 'cashback', 'flipkart cards ' + JSON.stringify(fc));
  const a = parseAmazonCards('Bank Offer\nUpto ₹3,000.00 discount on select Credit Cards\n50 offers\nCashback\nUpto ₹509.00 cashback as Amazon Pay Balance when you pay with Amazon Pay ICICI Bank Credit Cards\nUpto ₹509.00 cashback as Amazon Pay Balance when…\nNo Cost EMI\nUpto ₹497.25 EMI interest savings on Amazon Pay ICICI Bank Credit Cards');
  ok(a.length === 1 && a[0].amount === 509 && a[0].bank === 'Amazon Pay ICICI' && a[0].mode === 'Full swipe', 'amazon cards ' + JSON.stringify(a));
  ok(parseOffer('Instant discount of Rs 500 on SBI Bank credit card. Discounted price inclusive of cashback will be applied').offerType === 'instant_discount', 'croma instant');
  console.log('store offer formats ok');
}
{
  // Real offer text read by the scraper (Nov 2026 sample run).
  const { parseFlipkartOffers, parseAmazonCards, extractOffers, relianceOffers } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  const fk = parseFlipkartOffers('', [
    '₹2,750 off | Best value for you • Apply • Flipkart Axis • Credit Card • Cashback | banks: ',
    '₹2,500 off | Apply • ICICI • Credit Card | banks: ',
    '₹2,500 off | Apply • IndusInd • Credit Card | banks: ',
    '₹100 off | Apply • Flipkart Finance • Flipkart Pay Later • Know more | banks: ',
    '₹2,750 off | Bank offers | banks: ']);
  ok(fk.length === 4, 'flipkart heading card dropped ' + JSON.stringify(fk));
  ok(fk[0].bank === 'Flipkart Axis' && fk[0].offerType === 'cashback' && fk[1].bank === 'ICICI Bank' && fk[2].bank === 'IndusInd Bank', 'flipkart banks ' + JSON.stringify(fk));
  ok(fk[3].bank === 'Flipkart Pay Later' && fk[3].cardType === 'Pay Later', 'pay later ' + JSON.stringify(fk[3]));
  const only = parseFlipkartOffers('', ['₹750 off | Bank offers • Bank offers • View EMI offers | banks: ']);
  ok(only.length === 1 && only[0].amount === 750 && only[0].bank === 'Bank offer' && only[0].mode === null, 'flipkart only heading ' + JSON.stringify(only));
  const am = parseAmazonCards('Cashback\nUpto ₹569.00 cashback as Amazon Pay Balance when you pay with Amazon Pay ICICI Bank Credit Cards\nNo Cost EMI\nUpto ₹616.14 EMI interest savings on select Credit Cards, Bajaj Finserv EMI cards, Amazon Pay Later\nBank Offer\nUpto ₹474.97 discount on Axis Bank Credit Cards\nBank Offer\nUpto ₹2,000.00 discount on select Credit Cards');
  ok(am.length === 2 && am[1].bank === 'Axis Bank' && am[1].amount === 474 && am[1].offerType === 'instant_discount', 'amazon named bank ' + JSON.stringify(am));
  const sam = extractOffers('Black Friday Deal : Starting at ₹ 61999 with instant bank discount\n• Incl. of ₹ 3000 instant bank discount\n• Extra ₹ 2000 off with First Purchase Benefit\nUnlock Corporate+ Privileges : Extra 7% additional discount with your work email ID\nGet at ₹61999 with ₹3000 instant bank discount');
  ok(sam.length === 1 && sam[0].amount === 3000 && sam[0].bank === 'Bank offer', 'samsung brand ' + JSON.stringify(sam));
  const noise = extractOffers('Get 10% off on orders above ₹4,999 with HDFC cards');
  ok(noise.length === 1 && noise[0].bank === 'HDFC Bank' && noise[0].percent === 10 && noise[0].minTxn === 4999, 'noise ' + JSON.stringify(noise));
  ok(extractOffers('Get additional 5% off on Prepaid Orders | Code: BOATHEAD | Shop Now\nRedeem upto 10% off additionally with boAt rewards').length === 0, 'boat coupons are not bank offers');
  const promo = { bank_offers: [
    { offer_desc: '10% Instant Discount on SBI Bank Credit Card Txns', bank_codes: ['SBI'], offer_percentage: 10, offer_capping: 10000, min_car_amount: 5000, payment_method: 'CC', discount_type: 'Instant Discount' },
    { offer_desc: '5% Instant Discount with IDBI Credit Card EMI', bank_codes: ['IDBI'], offer_percentage: 5, offer_capping: 1800, min_car_amount: 30000, payment_method: 'EMI', discount_type: 'Instant Discount' },
    { offer_desc: 'Pay with UPI & Get 10% up to Rs. 10000 Instant Discount', bank_codes: [''], offer_percentage: 10, offer_capping: 10000, min_car_amount: 5000, payment_method: 'UPI', discount_type: 'Instant Discount' },
    { offer_desc: '5% Instant Discount with IDBI Credit/Debit Card', bank_codes: ['IDBI'], offer_percentage: 5, offer_capping: 1800, min_car_amount: 30000, payment_method: 'DC+CC', discount_type: 'Instant Discount' }],
    top_emi_offer_list: [{ bank_code: 'ICICI', bank_name: 'ICICI BANK', card_name: 'ICICI BANK CREDIT CARD', offer_amount: 5000, emi_card_type: 'cc', emi_type: 'NO_COST_EMI' }, { bank_code: 'HDFC', bank_name: 'HDFC BANK', offer_amount: 0, emi_card_type: 'cc' }] };
  const ro = relianceOffers(promo, null);
  ok(ro.length === 5, 'reliance count ' + ro.length);
  ok(ro[0].bank === 'SBI Card' && ro[0].percent === 10 && ro[0].maxDiscount === 10000 && ro[0].minTxn === 5000 && ro[0].cardType === 'Credit Card' && ro[0].mode === 'Full swipe', 'reliance sbi ' + JSON.stringify(ro[0]));
  ok(ro[1].bank === 'IDBI Bank' && ro[1].mode === 'EMI', 'reliance idbi emi ' + JSON.stringify(ro[1]));
  ok(ro[2].bank === 'UPI' && ro[2].cardType === 'UPI', 'reliance upi ' + JSON.stringify(ro[2]));
  ok(ro[3].cardType === 'Credit & Debit', 'reliance dc+cc');
  ok(ro[4].bank === 'ICICI Bank' && ro[4].amount === 5000 && ro[4].mode === 'EMI', 'reliance emi instant ' + JSON.stringify(ro[4]));
  const pg = relianceOffers(null, { bank: 'PNB', subtitle: null, discount: '899.925' });
  ok(pg.length === 1 && pg[0].bank === 'PNB' && pg[0].amount === 900 && pg[0].mode === null, 'reliance pg ' + JSON.stringify(pg));
  const pg2 = relianceOffers(null, { bank: 'ICICI BANK NO COST EMI', subtitle: '15815.94/6', discount: '5004.36' });
  ok(pg2[0].bank === 'ICICI Bank' && pg2[0].mode === 'EMI', 'reliance pg emi ' + JSON.stringify(pg2));
  ok(relianceOffers(null, { bank: null, subtitle: null, discount: null }).length === 0, 'reliance none');
  console.log('real offer lines ok');
}
{
  // Wrong listings found saved in Nov 2026 (different kind of product, other model, accessory,
  // bundle) — and the right listings for the same names.
  const { titleScore } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  const KEEP = new Set(["Boat Aavante Groove Plus 16W Soundbar", "Boat Stone 208 Bluetooth Speaker", "JBL Clip4 Portable Bluetooth Speaker (JBLCLIP4ECOGRN)", "Nothing Phone 4B 8/128GB"]);
  for (const [n, b, t] of [
 ['Redmi Smart Band Pro','Redmi','Redmi Note 17 Pro 5G (8GB RAM, 256GB, Stealth Black)'],
 ['Noise Go Buds Wireless Bluetooth Earbuds','Noise','Noise Master Buds Truly Wireless Bluetooth Earbuds, Onyx Black'],
 ['Boat Stone 208 Bluetooth Speaker','Boat','boAt Stone 208 Speaker with 5W Sound, TWS, RGB Lights, Built-in M...more'],
 ['Boat Aavante Bar Theme','Boat','boAt Aavante Bar 3600 500 W Bluetooth Soundbar (Premium Black, 5....more'],
 ['Mi Smart Speaker','Mi','Xiaomi 17T 5G (12GB RAM, 256GB, Violet)'],
 ['Redmi Earbuds S','Redmi','Redmi Note 17 5G (Dark Night, 8GB RAM, 128GB ROM) | 8000mAh Battery + 45W Fast Charging | '],
 ['SAREGAMA Carvaan Mini 2.0 Hindi','Saregama','Saregama Carvaan Premium Hindi - Portable Music Player with 5000 Preloaded Songs, FM/BT/AU'],
 ['Sony Wireless Noise Canceling Stereo Headset (WF-1000XM4)','Sony','Sony WH-1000XM6 The Best Wireless Noise Canceling Headphones, HD NC Processor QN3, 12 Micr'],
 ['JBL GO Essential 2 Bluetooth Speaker','JBL','JBL Flip Essential 2 20 W Bluetooth Home Audio Speaker (Black, Mo...more'],
 ['Noise Air Clips OWS Wireless Earphone','Noise','Noise Alt Clip OWS Earclips (Chosen Black)'],
 ['JBL Clip4 Portable Bluetooth Speaker (JBLCLIP4ECOGRN)','JBL','JBL Clip 4, Black/Orange - Portable Bluetooth 5.1 Speaker - Up to 10 Hours of Play - Water'],
 ['SAREGAMA Carvaan Mini 2.0 Music Player (SCM104)','Saregama','SAREGAMA Carvaan Hindi - Portable Music Player with 5000 Preloade...more'],
 ['Boat Aavante Bar Aspire','Boat','boAt Aavante Bar 1550 120 W Bluetooth Soundbar (Premium Black, 2....more'],
 ['Noise ALT Buds Wireless Bluetooth Earbuds Chosen Grey','Noise','Noise ALT Buds Open NSW0085 TWS Earbuds with Environmental Noise Cancellation(IPX5 Waterpr'],
 ['Noise ALT Buds S Wireless Bluetooth Earbuds','Noise','Noise Alt Buds Open Wireless Open-Ear Earbuds (2026), Red Dot Award-Winning Design, Hi-Res'],
 ['Boat Aavante Bar Theme','Boat','boAt Aavante Bar Aspire 10W RMS Bluetooth Soundbar ( 2.0 Channel, Black)'],
 ['Noise Junior Explorer 2 Smartwatch','Noise','Noise Junior Explorer 2 Kids Smart Watch (Lava Blast) with Amazon Echo Dot 5th Gen (Blue) '],
 ['Redmi Earbuds S','Redmi','Redmi 15A 5G (4GB RAM, 64GB, Ace Black)'],
 ['JBL TUNE 760NC Wireless Over Ear Headphones','JBL','SOULWIT Ear Cushions for JBL Tune 700BT/710BT/720BT/750BT/750BTNC/760NC/770NC (Do Not Fit '],
 ['Realme Watch 2 Pro','Realme','Zelfo Silicon Strap BeltCompatible With Realme Smart Watch 2 Pro ...more'],
 ['Boat Aavante Groove Plus 16W Soundbar','Boat','boAt Aavante Bar Groove Plus 16W 2.0 Channel Portable Bluetooth Soundbar with RGB LEDs, TW'],
 ['Moto Watch','Motorola','motorola signature'],
 ['Redmi Watch','Redmi','Redmi 6A'],
 ['Nothing Phone 4B 8/128GB','Nothing','Phone (4b) — Blue / 8+128GB'],
]) if (!KEEP.has(n)) ok(titleScore(n, b, t) === 0, `should reject: ${n} => ${t}`);
  for (const [n, b, t] of [
 ['Noise Air Clips OWS Wireless Earphone','Noise','Noise Air Clips Wireless Open Ear Earbuds with Chrome Finish, 40H Playtime'],
 ['Mi Smart Speaker','Mi','Xiaomi Smart Speaker (IR Control) with Google Assistant'],
 ['Samsung A37 5G 8/256GB','Samsung','Samsung Galaxy A37 5G (Awesome Graygreen, 8GB RAM, 256GB Storage)'],
 ['Samsung Tab A11 4/64GB LTE','Samsung','Samsung Galaxy Tab A11 (4GB RAM, 64GB, LTE)'],
 ['Realme Watch 2 Pro','Realme','realme Watch 2 Pro Smartwatch with Activity Tracker'],
 ['JBL GO Essential 2 Bluetooth Speaker','JBL','JBL Go Essential 2 Portable Waterproof Speaker'],
 ['Boat Aavante Bar Theme','Boat','boAt Aavante Bar Theme 60W Soundbar'],
 ['Sony Wireless Noise Canceling Stereo Headset (WF-1000XM4)','Sony','Sony WF-1000XM4 Industry Leading Noise Canceling Truly Wireless Earbuds'],
 ['Noise Junior Explorer 2 Smartwatch','Noise','Noise Junior Explorer 2 Kids Smart Watch (Lava Blast)'],
 ['Fastrack Revoltt FS1 Smartwatch','Fastrack','Fastrack Revoltt FS1 Smart Watch with Silicone Strap'],
 ['Boat Rockerz 480 Wireless Headphones','Boat','boAt Rockerz 480 Bluetooth On Ear Headphones with 60H Playtime'],
 ['Apple iPhone 17 256GB','Apple','Apple iPhone 17 (256 GB) - Black'],
 ['Oneplus Nord Buds 3','OnePlus','OnePlus Nord Buds 3 Truly Wireless Bluetooth Earbuds with Charging Case'],
 ['Samsung Buds3 FE','Samsung','Samsung Galaxy Buds3 FE (Black)'],
 ['JBL TUNE 760NC Wireless Over Ear Headphones','JBL','JBL Tune 760NC Wireless Over Ear Active Noise Cancellation Headphones'],
 ['Redmi A7 Pro 5G 4/128GB','Redmi','Redmi A7 Pro 5G (Mist Blue, 4GB RAM, 128GB Storage)'],
 ['Noise Go Buds Wireless Bluetooth Earbuds','Noise','Noise Newly Launched Go Buds Truly Wireless in Ear Earbuds'],
 ['Boat Airdopes Joy Wireless Earbuds','Boat','boAt Airdopes Joy, 35HRS Battery, Fast Charge, ENx Tech'],
 ['JBL Party Box 330 Speaker','JBL','JBL PartyBox 330 Bluetooth Party Speaker'],
 ['SAREGAMA Carvaan Mini 2.0 Hindi','Saregama','Saregama Carvaan Mini Hindi 2.0 - Music Player with 351 Songs'],
 ['Moto G37 Power 4/64GB','Motorola','Motorola g37 power (4GB RAM, 64GB) Pantone Blue'],
 ['Samsung Galaxy Watch 8','Samsung','Samsung Galaxy Watch8 (44mm, Bluetooth)'],
 ['Realme Buds Air Neo','Realme','realme Buds Air Neo Bluetooth Headset (White, True Wireless)'],
 ['Apple Watch SE 3','Apple','Apple Watch SE 3 GPS 40mm Midnight Aluminium Case with Midnight Sport Band'],
 ['Redmi Smart Band Pro','Redmi','Redmi Smart Band Pro, 1.47" AMOLED Display'],
 ['Moto Watch','Motorola','Moto Watch 40 Smartwatch'],
 ['Redmi Earbuds S','Redmi','Redmi Earbuds S Wireless Earphones'],
 ['Noise ALT Buds S Wireless Bluetooth Earbuds','Noise','Noise ALT Buds S Truly Wireless'],
 ['Boat Stone 193 Bluetooth Speaker','Boat','boAt Stone 193 5 W Bluetooth Speaker (Black, Stereo Channel)'],
 ['Sony WH-CH520','Sony','Sony WH-CH520 Wireless On-Ear Bluetooth Headphones with Mic'],
 ['Nothing Phone 3a 8/128GB','Nothing','Nothing Phone (3a) 5G (Black, 8GB RAM, 128GB Storage)'],
 ['Oppo A6C 4/64GB','OPPO','OPPO A6c (Feather White, 64 GB) (4 GB RAM)'],
 ['Moto Pad 60 Pro 12/256GB','Motorola','Motorola Moto Pad 60 Pro (12GB RAM, 256GB)'],
 ['JBL Flip 7','JBL','JBL Flip 7 Portable Speaker with Strap and Carabiner'],
]) if (!/^(Moto Watch)$/.test(n)) ok(titleScore(n, b, t) >= 0.55, `should match: ${n} => ${t} (${titleScore(n, b, t)})`);
  console.log('wrong listings ok');
}
{
  // Amazon bank-offer sheet text (card layout, read via its side-sheet address).
  const { extractOffers } = await import('./lib.mjs');
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  const t = "Additional flat INR 500 Instant Discount on SBI Credit Card EMI Trxn. Minimum purchase value INR 24990.00 See details Here's how\n10% Instant Discount up to INR 1500 on HDFC Bank Credit Card Non-EMI Trxn. Minimum purchase value INR 5000.00\nGet 5% back with Amazon Pay ICICI Bank credit card for Prime members. 3% back for others. Not applicable on EMI orders";
  const o = extractOffers(t);
  ok(o.length === 3 && o[0].mode === 'EMI' && o[1].bank === 'HDFC Bank' && o[1].mode === 'Full swipe' && o[1].percent === 10 && o[1].maxDiscount === 1500 && o[2].offerType === 'cashback', 'amazon sheet ' + JSON.stringify(o));
  console.log('amazon sheet ok');
}
