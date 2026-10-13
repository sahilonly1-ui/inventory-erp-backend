import assert from 'node:assert/strict';
import { titleScore, pickBest, parseOffer, extractOffers, isProductUrl, urlKey } from './lib.mjs';

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
