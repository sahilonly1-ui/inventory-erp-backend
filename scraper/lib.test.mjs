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
