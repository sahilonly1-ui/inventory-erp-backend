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
assert.equal(o.bank, 'HDFC Bank'); assert.equal(o.amount, 1500); assert.equal(o.offerType, 'instant_discount'); assert.equal(o.cardType, 'Credit Card');
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
assert.ok(offers.find(x => x.bank === 'HDFC Bank' && x.amount === 1500), JSON.stringify(offers));
assert.ok(offers.find(x => x.bank === 'Amazon Pay ICICI' && x.offerType === 'cashback'));
console.log('lib tests passed', offers.length, 'offers');
import { searchQueries, storeSearchUrl } from './lib.mjs';
console.log(searchQueries('JBL Party Box 110 Portable Party Speaker (Black) 160W', 'JBL'));
console.log(searchQueries('Boombox 3 Wifi Portable Bluetooth Speaker', 'JBL', 'Black'));
assert.equal(storeSearchUrl('official', 'JBL PartyBox 120', 'in.jbl.com'), 'https://in.jbl.com/search?q=JBL%20PartyBox%20120');
assert.equal(storeSearchUrl('official', 'x', null), null);
