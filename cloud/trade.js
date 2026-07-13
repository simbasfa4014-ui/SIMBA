const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ACCOUNT_PATH = path.join(ROOT, 'data', 'account.json');
const PUBLIC_ACCOUNT_PATH = path.join(ROOT, 'docs', 'account.json');
const WATCHLIST = [
  '000001','000333','000651','000725','000858','002050','002230','002415',
  '002475','002594','300014','300059','300122','300308','300750','600009',
  '600031','600036','600050','600089','600276','600309','600519','601012',
  '601088','601318','601398','601899','603259','688981'
];

function marketCode(code) {
  if (/^[569]/.test(code)) return `sh${code}`;
  if (/^[023]/.test(code)) return `sz${code}`;
  if (/^[48]/.test(code)) return `bj${code}`;
  throw new Error(`Unsupported stock code: ${code}`);
}

function chinaDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);
}

function parseQuotes(text) {
  const quotes = [];
  for (const line of text.split(';')) {
    const match = line.match(/v_(?:sh|sz|bj)(\d{6})="([^"]*)"/);
    if (!match) continue;
    const f = match[2].split('~');
    const price = Number(f[3]);
    const previousClose = Number(f[4]);
    if (!Number.isFinite(price) || price <= 0) continue;
    quotes.push({
      code: match[1], name: f[1] || match[1], price,
      previousClose: previousClose || price, open: Number(f[5]) || price,
      high: Number(f[33]) || price, low: Number(f[34]) || price,
      changePercent: Number(f[32]) || 0, quoteTime: f[30] || ''
    });
  }
  return quotes;
}

async function fetchQuotes(codes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`https://qt.gtimg.cn/q=${codes.map(marketCode).join(',')}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 SIMBA-Paper-Trading/1.0' }
    });
    if (!response.ok) throw new Error(`Quote service returned ${response.status}`);
    const bytes = await response.arrayBuffer();
    return parseQuotes(new TextDecoder('gb18030').decode(bytes));
  } finally {
    clearTimeout(timeout);
  }
}

function fee(amount, side) {
  const commission = Math.max(5, amount * 0.00025);
  const transfer = amount * 0.00001;
  const stamp = side === 'sell' ? amount * 0.0005 : 0;
  return +(commission + transfer + stamp).toFixed(2);
}

function sellable(position, date) {
  return (position.lots || []).filter((lot) => lot.date < date).reduce((sum, lot) => sum + lot.quantity, 0);
}

function values(account, quoteMap) {
  let marketValue = 0;
  for (const [code, position] of Object.entries(account.positions)) {
    marketValue += (quoteMap.get(code)?.price || position.lastPrice || 0) * position.quantity;
  }
  return { marketValue, total: account.cash + marketValue };
}

function execute(account, quoteMap, side, code, quantity, reason, date) {
  const quote = quoteMap.get(code);
  const position = account.positions[code] || { quantity: 0, cost: 0, lots: [] };
  if (!quote || quantity < 100 || quantity % 100) return false;
  const amount = quote.price * quantity;
  const charge = fee(amount, side);

  if (side === 'buy') {
    if (amount + charge > account.cash) return false;
    account.cash = +(account.cash - amount - charge).toFixed(2);
    position.quantity += quantity;
    position.cost = +(position.cost + amount + charge).toFixed(2);
    position.lastPrice = quote.price;
    position.lots.push({ date, quantity });
    account.positions[code] = position;
  } else {
    if (sellable(position, date) < quantity) return false;
    let remaining = quantity;
    for (const lot of position.lots) {
      if (lot.date >= date || remaining <= 0) continue;
      const used = Math.min(lot.quantity, remaining);
      lot.quantity -= used;
      remaining -= used;
    }
    const average = position.cost / position.quantity;
    position.quantity -= quantity;
    position.cost = +(position.cost - average * quantity).toFixed(2);
    position.lots = position.lots.filter((lot) => lot.quantity > 0);
    position.lastPrice = quote.price;
    account.cash = +(account.cash + amount - charge).toFixed(2);
    if (!position.quantity) delete account.positions[code];
  }

  account.trades.push({
    time: new Date().toISOString(), side, code, name: quote.name,
    quantity, price: quote.price, fee: charge, reason
  });
  return true;
}

function trade(account, quotes, date) {
  if (account.lastTradeDate === date) return ['今日已经完成调仓'];
  const quoteMap = new Map(quotes.map((quote) => [quote.code, quote]));
  const actions = [];

  for (const [code, position] of Object.entries({ ...account.positions })) {
    const quote = quoteMap.get(code);
    const available = sellable(position, date);
    if (!quote || !available) continue;
    const average = position.cost / position.quantity;
    const pnl = ((quote.price - average) / average) * 100;
    let reason = '';
    if (pnl <= -5) reason = `止损 ${pnl.toFixed(1)}%`;
    else if (pnl >= 12) reason = `止盈 ${pnl.toFixed(1)}%`;
    else if (quote.changePercent <= -2.5) reason = `当日走弱 ${quote.changePercent.toFixed(1)}%`;
    if (reason && execute(account, quoteMap, 'sell', code, available, reason, date)) {
      actions.push(`卖出 ${quote.name} ${available} 股：${reason}`);
    }
  }

  const total = values(account, quoteMap).total;
  let slots = Math.max(0, 4 - Object.keys(account.positions).length);
  const candidates = quotes
    .filter((q) => !account.positions[q.code])
    .filter((q) => !/ST|退/.test(q.name) && !/^[NC]/.test(q.name))
    .filter((q) => q.changePercent >= 0.8 && q.changePercent <= 7.5 && q.price > q.open)
    .sort((a, b) => b.changePercent - a.changePercent);

  for (const quote of candidates) {
    if (!slots) break;
    const availableCash = Math.max(0, account.cash - total * 0.15);
    const budget = Math.min(total * 0.2, availableCash);
    const quantity = Math.floor(budget / quote.price / 100) * 100;
    const reason = `强势轮动，涨幅 ${quote.changePercent.toFixed(1)}%`;
    if (quantity >= 100 && execute(account, quoteMap, 'buy', quote.code, quantity, reason, date)) {
      actions.push(`买入 ${quote.name} ${quantity} 股：${reason}`);
      slots -= 1;
    }
  }

  account.lastTradeDate = date;
  return actions.length ? actions : ['今日没有满足条件的交易，保持现有持仓和现金'];
}

function loadAccount() {
  return JSON.parse(fs.readFileSync(ACCOUNT_PATH, 'utf8'));
}

function saveAccount(account) {
  const json = `${JSON.stringify(account, null, 2)}\n`;
  fs.writeFileSync(ACCOUNT_PATH, json);
  fs.writeFileSync(PUBLIC_ACCOUNT_PATH, json);
}

async function main() {
  const account = loadAccount();
  const date = chinaDate();
  const tracked = [...new Set([...WATCHLIST, ...Object.keys(account.positions)])];
  const quotes = await fetchQuotes(tracked);
  if (quotes.length < Math.min(10, tracked.length)) throw new Error('Too few valid quotes; refusing to trade');
  const quoteDate = quotes.map((q) => q.quoteTime.slice(0, 8)).filter(Boolean).sort().at(-1);
  if (quoteDate !== date.replaceAll('-', '')) {
    console.log(`Market closed or quotes are stale (${quoteDate || 'unknown'}); no trade.`);
    return;
  }

  const quoteMap = new Map(quotes.map((quote) => [quote.code, quote]));
  for (const [code, position] of Object.entries(account.positions)) {
    if (quoteMap.has(code)) position.lastPrice = quoteMap.get(code).price;
  }
  const hhmm = quotes.map((q) => q.quoteTime.slice(8, 12)).filter(Boolean).sort().at(-1);
  const actions = hhmm >= '1430' && hhmm <= '1455' ? trade(account, quotes, date) : ['行情已更新，尚未到每日调仓窗口'];
  const summary = values(account, quoteMap);
  account.quotes = quotes;
  account.updatedAt = new Date().toISOString();
  account.decisions.push({ time: account.updatedAt, date, actions, totalAsset: +summary.total.toFixed(2) });
  account.nav.push({ time: account.updatedAt, value: +summary.total.toFixed(2) });
  account.decisions = account.decisions.slice(-120);
  account.nav = account.nav.slice(-240);
  saveAccount(account);
  console.log(actions.join('\n'));
  console.log(`Total asset: ${summary.total.toFixed(2)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { marketCode, parseQuotes, fee, sellable, trade };
