// Playwright はグローバル/ローカルどちらでも解決できるようにする
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  const root = execSync('npm root -g').toString().trim();
  pw = require(root + '/playwright');
}
const { chromium } = pw;
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = process.cwd();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};
const server = createServer(async (req, res) => {
  try {
    let p = req.url.split('?')[0];
    if (p === '/') p = '/index.html';
    const data = await readFile(join(ROOT, p));
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n); } };

const browser = await chromium.launch();
const ctx = await browser.newContext({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(base, { waitUntil: 'networkidle' });

console.log('\n[初期表示 / アイコン]');
ok('タイトル', (await page.title()) === '欲しいものリスト');
const bodyText = await page.evaluate(() => document.body.innerText);
const emojiRe = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2699}\u{2691}]/u;
ok('絵文字・記号がテキストに無い', !emojiRe.test(bodyText));
ok('SVGアイコンが描画されている', (await page.locator('svg.ic-svg').count()) >= 4);
ok('FABにSVG', (await page.locator('#fab svg.ic-svg').count()) === 1);
ok('空状態のイラストがSVG', (await page.locator('.empty .art svg').count()) === 1);

console.log('\n[追加]');
await page.tap('#fab');
await page.waitForTimeout(400);
ok('シートが開く', await page.locator('#shItem.show').isVisible());
await page.fill('#inName', 'AirPods Pro');
await page.fill('#inPrice', '39800');
await page.tap('#starPick button[data-v="4"]'); // 星4つ
ok('星ピッカーが4つ点灯', (await page.locator('#starPick button.filled').count()) === 4);
await page.fill('#inUrl', 'example.com/airpods'); // スキーム無し → https:// が補われる
await page.tap('#saveBtn');
await page.waitForSelector('.item');
ok('1件追加された', (await page.locator('.item').count()) === 1);
ok('名前表示', (await page.locator('.item-name').first().textContent()) === 'AirPods Pro');
ok('カードに星4つ', (await page.locator('.item-stars').first().locator('svg').count()) === 4);
ok('価格フォーマット', (await page.locator('.item-price').first().textContent()).includes('¥39,800'));
ok('合計に反映', (await page.locator('#totalWant').textContent()).includes('39,800'));
ok('登録数=1', (await page.locator('#statCount').textContent()) === '1');
const href = await page.locator('.item-link').first().getAttribute('href');
ok('URLにhttps://が補完される', href === 'https://example.com/airpods');

console.log('\n[URLバリデーション / XSS]');
await page.tap('#fab');
await page.waitForTimeout(400);
await page.fill('#inName', 'テスト');
await page.fill('#inUrl', 'javascript:alert(1)');
await page.tap('#saveBtn');
ok('javascript: URLは拒否される', await page.locator('#fldUrl.invalid').isVisible());
await page.fill('#inUrl', '');
await page.fill('#inName', '<img src=x onerror=alert(1)>');
await page.tap('#saveBtn');
await page.waitForFunction(() => document.querySelectorAll('.item').length === 2);
const injected = await page.evaluate(() => !!document.querySelector('.item img[src="x"]'));
ok('HTMLエスケープされる', injected === false);

console.log('\n[必須チェック]');
await page.tap('#fab');
await page.waitForTimeout(400);
await page.tap('#saveBtn');
ok('名前未入力でエラー', await page.locator('#fldName.invalid').isVisible());
const closeOverlay = () => page.touchscreen.tap(195, 40); // シート上の暗い部分をタップ
await closeOverlay();
await page.waitForTimeout(300);

console.log('\n[購入済みトグル]');
await page.locator('.item .check').first().tap();
await page.waitForSelector('.item.done');
ok('doneクラスが付く', (await page.locator('.item.done').count()) >= 1);
ok('チェックのSVGが表示', (await page.locator('.check.done svg.ic-svg').count()) >= 1);
ok('達成率が0%超', (await page.locator('#statRate').textContent()) !== '0%');
ok('購入済みカウント≥1', parseInt(await page.locator('#statBought').textContent(), 10) >= 1);

console.log('\n[フィルタ]');
await page.tap('.seg button[data-filter="bought"]');
await page.waitForTimeout(100);
ok('購入済みのみ', (await page.locator('.item.done').count()) === (await page.locator('.item').count()));
await page.tap('.seg button[data-filter="all"]');
await page.waitForTimeout(100);

console.log('\n[カテゴリ別サマリー]');
// 既知データを投入して集計を確認
await page.evaluate(() => {
  const data = [
    { id: 'x1', name: 'ガジェA', price: 10000, prio: 3, catId: 'c1', memo: '', url: '', done: false, created: Date.now() },
    { id: 'x2', name: 'ガジェB', price: 5000, prio: 2, catId: 'c1', memo: '', url: '', done: true, created: Date.now() - 1 },
    { id: 'x3', name: '服A', price: 3000, prio: 2, catId: 'c2', memo: '', url: '', done: false, created: Date.now() - 2 },
  ];
  localStorage.setItem('wishlist_app_v1', JSON.stringify(data));
});
await page.reload({ waitUntil: 'networkidle' });
ok('すべて: 合計は未購入分', (await page.locator('#totalWant').textContent()) === '¥13,000');
ok('すべて: 登録数=3', (await page.locator('#statCount').textContent()) === '3');
await page.locator('.chip[data-cf="c1"]').tap();
await page.waitForTimeout(100);
ok('ガジェット: ラベルが「〜の合計」', (await page.locator('#summaryLabel').textContent()).endsWith('の合計'));
ok('ガジェット: 合計=¥10,000（未購入のみ）', (await page.locator('#totalWant').textContent()) === '¥10,000');
ok('ガジェット: 登録数=2', (await page.locator('#statCount').textContent()) === '2');
ok('ガジェット: 購入済み=1', (await page.locator('#statBought').textContent()) === '1');
await page.locator('.chip[data-cf="c2"]').tap();
await page.waitForTimeout(100);
ok('ファッション: 合計=¥3,000', (await page.locator('#totalWant').textContent()) === '¥3,000');
await page.locator('.chip[data-cf="all"]').tap();
await page.waitForTimeout(100);
ok('すべてに戻すとラベルが既定', (await page.locator('#summaryLabel').textContent()) === '欲しいもの合計');

console.log('\n[編集]');
await page.locator('.item-body').first().tap();
await page.waitForTimeout(400);
ok('編集シートが開く', (await page.locator('#sheetTitle').textContent()) === '編集する');
const nameVal = await page.inputValue('#inName');
ok('既存値が入る', nameVal.length > 0);
await page.fill('#inName', '編集済みアイテム');
await page.tap('#saveBtn');
await page.waitForFunction(() => [...document.querySelectorAll('.item-name')].some((e) => e.textContent === '編集済みアイテム'));
ok('編集反映', true);

console.log('\n[並び替えシート]');
await page.tap('#sortBtn');
await page.waitForTimeout(400);
ok('ソートシートにSVG', (await page.locator('#sortBox svg.ic-svg').count()) >= 4);
await page.tap('.sort-row[data-k="priceDesc"]');
await page.waitForTimeout(200);
ok('ソートラベル更新', (await page.locator('#sortLabel').textContent()) === '価格が高い順');

console.log('\n[カテゴリ管理]');
await page.tap('#catManageBtn');
await page.waitForTimeout(400);
ok('カテゴリ一覧表示', (await page.locator('.cat-row').count()) >= 4);
ok('chevronがSVG', (await page.locator('.cat-row .chev svg').count()) >= 1);
await page.locator('.cat-row.add-row').tap();
await page.waitForTimeout(400);
await page.fill('#ceName', 'ガジェット2');
await page.locator('.swatch').nth(3).tap();
ok('選択スウォッチにcheck', (await page.locator('.swatch.sel svg.ic-svg').count()) === 1);
await page.tap('#ceSave');
await page.waitForTimeout(300);
ok('カテゴリ追加された', (await page.locator('.cat-row').count()) >= 5);
await closeOverlay();
await page.waitForTimeout(300);

console.log('\n[スワイプ削除]');
const before = await page.locator('.item').count();
// 左スワイプを再現（ハンドラは e.touches[0].clientX/Y を参照）
await page.evaluate(() => {
  const card = document.querySelector('.item');
  const r = card.getBoundingClientRect();
  const fire = (type, x, y) => {
    const t = { clientX: x, clientY: y, identifier: 1, target: card };
    const ev = new Event(type, { bubbles: true, cancelable: true });
    ev.touches = type === 'touchend' ? [] : [t];
    ev.changedTouches = [t];
    card.dispatchEvent(ev);
  };
  fire('touchstart', r.right - 20, r.top + 20);
  fire('touchmove', r.left + 20, r.top + 22);
  fire('touchend', 0, 0);
});
await page.waitForTimeout(400);
const delBtn = page.locator('.item-shell').first().locator('.item-del');
await delBtn.tap();
await page.waitForFunction((n) => document.querySelectorAll('.item').length === n, before - 1);
ok('スワイプ→削除で1件減る', (await page.locator('.item').count()) === before - 1);

console.log('\n[永続化]');
await page.reload({ waitUntil: 'networkidle' });
ok('リロード後もデータが残る', (await page.locator('.item').count()) >= 1);

console.log('\n[PWA]');
ok('manifestがリンクされている', (await page.locator('link[rel="manifest"]').count()) === 1);
ok('apple-touch-iconがある', (await page.locator('link[rel="apple-touch-icon"]').count()) === 1);
const checkRes = async (path, type) => {
  const r = await page.request.get(base + '/' + path);
  return r.status() === 200 && (!type || (r.headers()['content-type'] || '').includes(type));
};
ok('manifest取得OK', await checkRes('manifest.webmanifest'));
const manifest = await (await page.request.get(base + '/manifest.webmanifest')).json();
ok('manifestにアイコン3種', Array.isArray(manifest.icons) && manifest.icons.length >= 3);
ok('sw.js取得OK', await checkRes('sw.js'));
ok('icon-192.png取得OK', await checkRes('icon-192.png', 'image/png'));
ok('icon-512.png取得OK', await checkRes('icon-512.png', 'image/png'));
ok('icon-180.png取得OK', await checkRes('icon-180.png', 'image/png'));
const swReady = await page.evaluate(() =>
  navigator.serviceWorker
    ? Promise.race([
        navigator.serviceWorker.ready.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 5000)),
      ])
    : false
);
ok('Service Worker が有効化される', swReady === true);

console.log('\n[コンソールエラー]');
ok('エラーなし', errors.length === 0);
if (errors.length) console.log('   ', errors);

await page.screenshot({ path: 'screenshot.png', fullPage: true });
await browser.close();
server.close();
console.log(`\n結果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
