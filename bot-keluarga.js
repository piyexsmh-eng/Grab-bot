const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN   = '8811749875:AAHYojwO1La7Bo-lqZAOG72fkTkl9l4PrrE';
const ADMIN_ID    = '8811749875';
const SMSCODE_KEY = 'f01720bbdc5b236c137c6b8da5e3fbc2bc336a4b35896c5009a014c62e04156b';

const TG  = 'api.telegram.org';
const SMS = 'api.smscode.gg';

// ── DATABASE FILE ─────────────────────────────────────────
const DB_FILE = path.join(process.env.HOME || '.', 'bot-data.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch(e) { console.log('[DB] Gagal load:', e.message); }
  return {};
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2), 'utf8');
    console.log('[DB] Data tersimpan');
  } catch(e) { console.log('[DB] Gagal simpan:', e.message); }
}

// Auto save setiap 30 detik
setInterval(saveDB, 30000);

// ── LOAD DATA ─────────────────────────────────────────────
const users = loadDB();
const states = {};
let lastUpdateId = 0;
let activeOrders = {};

// ── HELPERS ───────────────────────────────────────────────
function hashPass(pass) {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

function req(host, path, method = 'GET', body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: host, port: 443, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...extraHeaders }
    };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Parse error')); } });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

async function sms(method, path, body = null) {
  const d = await req(SMS, '/v1' + path, method, body, { 'Authorization': 'Bearer ' + SMSCODE_KEY });
  if (!d.success) throw new Error(d.error?.message || 'SMSCode error');
  return d.data;
}

async function tg(chatId, text, extra = {}) {
  await req(TG, `/bot${BOT_TOKEN}/sendMessage`, 'POST', {
    chat_id: chatId, text, parse_mode: 'HTML', ...extra
  });
}

async function getUpdates() {
  const d = await req(TG, `/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
  return d.result || [];
}

const noKb = { remove_keyboard: true };

function kb(items, cols = 2) {
  const rows = [];
  for (let i = 0; i < items.length; i += cols)
    rows.push(items.slice(i, i + cols).map(t => ({ text: t })));
  return { keyboard: rows, resize_keyboard: true, one_time_keyboard: true };
}

function isLoggedIn(chatId) { return users[chatId]?.loggedIn; }
function getUser(chatId) { return users[chatId]; }

// ── MENU ──────────────────────────────────────────────────
async function showMenu(chatId) {
  const u = getUser(chatId);
  const isAdmin = String(chatId) === String(ADMIN_ID);
  await tg(chatId,
`👋 Halo <b>${u.username}</b>!
💰 Saldo: <b>Rp ${Number(u.balance).toLocaleString('id-ID')}</b>

Pilih menu:`,
    { reply_markup: kb([
      '🚗 Beli OTP Grab',
      '💰 Cek Saldo',
      '📋 Order Saya',
      ...(isAdmin ? ['👑 Admin Panel'] : []),
      '🚪 Logout'
    ], 2) }
  );
}

async function showWelcome(chatId) {
  await tg(chatId,
`🚗 <b>Bot OTP Grab Indonesia</b>

Selamat datang! Silakan login atau daftar akun baru.`,
    { reply_markup: kb(['📝 Daftar', '🔐 Login'], 2) }
  );
}

// ── REGISTRASI ────────────────────────────────────────────
async function startRegister(chatId) {
  states[chatId] = { step: 'reg_username' };
  await tg(chatId, '📝 <b>Daftar Akun Baru</b>\n\nMasukkan username (min 3 huruf):', { reply_markup: noKb });
}

async function startLogin(chatId) {
  states[chatId] = { step: 'login_username' };
  await tg(chatId, '🔐 <b>Login</b>\n\nMasukkan username:', { reply_markup: noKb });
}

// ── BELI OTP GRAB ─────────────────────────────────────────
async function cmdBeli(chatId) {
  const u = getUser(chatId);
  await tg(chatId, '⏳ Mengecek stok Grab Indonesia...');
  try {
    const countries = await sms('GET', '/catalog/countries');
    const indonesia = countries.find(c => c.name.toLowerCase().includes('indonesia') && c.active);
    if (!indonesia) throw new Error('Indonesia tidak ditemukan');

    const services = await sms('GET', '/catalog/services?country_id=' + indonesia.id);
    const grab = services.find(s => s.name.toLowerCase().includes('grab') && s.active);
    if (!grab) throw new Error('Grab tidak tersedia');

    const products = await sms('GET', `/catalog/products?country_id=${indonesia.id}&platform_id=${grab.id}&sort=price_asc&limit=10`);
    const avail = products.filter(p => p.active && p.available > 0);
    if (!avail.length) throw new Error('Stok Grab habis saat ini');

    const p = avail[0];
    if (u.balance < p.price) {
      await tg(chatId,
`❌ <b>Saldo tidak cukup!</b>

Saldo kamu: Rp ${Number(u.balance).toLocaleString('id-ID')}
Harga: Rp ${Number(p.price).toLocaleString('id-ID')}

Hubungi admin untuk top up saldo.`
      );
      await showMenu(chatId);
      return;
    }

    states[chatId] = { step: 'confirm_buy', product: p };
    await tg(chatId,
`🚗 <b>Beli Nomor Grab Indonesia</b>

📦 ${p.name}
💰 Harga: <b>Rp ${Number(p.price).toLocaleString('id-ID')}</b>
📊 Stok: ${p.available}
💳 Saldo kamu: Rp ${Number(u.balance).toLocaleString('id-ID')}

Lanjut beli?`,
      { reply_markup: kb(['✅ Ya, Beli', '❌ Batal'], 2) }
    );
  } catch(e) {
    await tg(chatId, '❌ ' + e.message);
    await showMenu(chatId);
  }
}

async function prosesBeli(chatId) {
  const st = states[chatId];
  const u = getUser(chatId);
  const prod = st.product;
  states[chatId] = null;

  await tg(chatId, '⏳ Membeli nomor...', { reply_markup: noKb });
  try {
    const d = await sms('POST', '/orders/create', { product_id: prod.id, quantity: 1 });
    const order = Array.isArray(d.orders) ? d.orders[0] : d;
    if (!order || !order.phone_number) throw new Error('Nomor tidak diterima');

    u.balance -= prod.price;
    if (!u.orders) u.orders = [];
    u.orders.unshift({
      id: order.id,
      phone: order.phone_number,
      price: prod.price,
      status: 'ACTIVE',
      otp: null,
      waktu: new Date().toLocaleString('id-ID')
    });
    saveDB(); // simpan setelah transaksi

    await tg(chatId,
`✅ <b>Nomor Berhasil Dibeli!</b>

📞 Nomor: <code>${order.phone_number}</code>
🔢 Order ID: <code>${order.id}</code>
💰 Harga: Rp ${Number(prod.price).toLocaleString('id-ID')}
💳 Sisa saldo: Rp ${Number(u.balance).toLocaleString('id-ID')}

⏳ Masukkan nomor ini di Grab, lalu tunggu OTP.
Bot akan kirim kode otomatis!

/batal_${order.id} — untuk batalkan`
    );

    startPolling(chatId, order.id, order.phone_number);
    await showMenu(chatId);
  } catch(e) {
    await tg(chatId, '❌ Gagal: ' + e.message);
    await showMenu(chatId);
  }
}

// ── ORDERS ────────────────────────────────────────────────
async function cmdOrders(chatId) {
  const u = getUser(chatId);
  if (!u.orders || !u.orders.length) {
    await tg(chatId, '📋 Belum ada order.');
    await showMenu(chatId);
    return;
  }
  const em = { ACTIVE:'🟡', OTP_RECEIVED:'🟢', COMPLETED:'✅', CANCELED:'❌', EXPIRED:'⏰' };
  const lines = u.orders.slice(0, 10).map(o =>
    `${em[o.status]||'•'} <b>${o.phone}</b>\n` +
    `   ID: <code>${o.id}</code>\n` +
    (o.otp ? `   🔑 OTP: <b>${o.otp}</b>` : `   ${o.status}`) +
    `\n   🕐 ${o.waktu}`
  ).join('\n\n');
  await tg(chatId, `📋 <b>Order Saya:</b>\n\n${lines}`);
  await showMenu(chatId);
}

// ── ADMIN PANEL ───────────────────────────────────────────
async function showAdminPanel(chatId) {
  const members = Object.values(users).filter(u => !u.isAdmin);
  const list = members.length
    ? members.map(u => `👤 <b>${u.username}</b> — Rp ${Number(u.balance).toLocaleString('id-ID')}`).join('\n')
    : 'Belum ada anggota';
  await tg(chatId,
`👑 <b>Admin Panel</b>

Total anggota: ${members.length}

${list}`,
    { reply_markup: kb(['💸 Top Up Saldo', '🗑 Hapus Akun', '📊 Semua Order', '🔙 Kembali'], 2) }
  );
}

async function startTopUp(chatId) {
  const list = Object.values(users).filter(u => u.username !== 'Admin').map(u => u.username);
  if (!list.length) { await tg(chatId, '❌ Belum ada anggota.'); return; }
  states[chatId] = { step: 'admin_topup_user' };
  await tg(chatId, '💸 Pilih anggota untuk di-top up:', { reply_markup: kb(list, 2) });
}

async function showSemuaOrder(chatId) {
  const em = { ACTIVE:'🟡', OTP_RECEIVED:'🟢', COMPLETED:'✅', CANCELED:'❌', EXPIRED:'⏰' };
  let allOrders = [];
  Object.values(users).forEach(u => {
    (u.orders || []).slice(0, 5).forEach(o => {
      allOrders.push({ ...o, username: u.username });
    });
  });
  if (!allOrders.length) { await tg(chatId, '📋 Belum ada order.'); return; }
  const lines = allOrders.slice(0, 15).map(o =>
    `${em[o.status]||'•'} <b>${o.username}</b> — ${o.phone}\n` +
    (o.otp ? `   🔑 ${o.otp}` : `   ${o.status}`)
  ).join('\n\n');
  await tg(chatId, `📊 <b>Semua Order:</b>\n\n${lines}`);
  await showAdminPanel(chatId);
}

// ── OTP POLLING ───────────────────────────────────────────
function startPolling(chatId, orderId, phone) {
  if (activeOrders[orderId]) return;
  let attempts = 0;
  const iv = setInterval(async () => {
    attempts++;
    if (attempts > 40) {
      clearInterval(iv); delete activeOrders[orderId];
      const u = getUser(chatId);
      if (u) {
        const o = u.orders?.find(x => x.id === orderId);
        if (o) { u.balance += o.price; o.status = 'EXPIRED'; saveDB(); }
      }
      await tg(chatId, `⏰ Order <code>${orderId}</code> expired. Saldo dikembalikan otomatis.`);
      return;
    }
    try {
      const list = await sms('GET', '/orders?limit=50');
      const o = list.find(x => x.id === orderId);
      if (!o) return;
      if (o.otp_code) {
        clearInterval(iv); delete activeOrders[orderId];
        const u = getUser(chatId);
        if (u) {
          const lo = u.orders?.find(x => x.id === orderId);
          if (lo) { lo.otp = o.otp_code; lo.status = 'OTP_RECEIVED'; saveDB(); }
        }
        await tg(chatId,
`🎉 <b>OTP GRAB MASUK!</b>

📞 Nomor: <code>${phone}</code>
🔑 Kode OTP: <b><code>${o.otp_code}</code></b>

Masukkan kode ini di aplikasi Grab sekarang!`
        );
      } else if (['EXPIRED','CANCELED','COMPLETED'].includes(o.status)) {
        clearInterval(iv); delete activeOrders[orderId];
      }
    } catch(e) {}
  }, 15000);
  activeOrders[orderId] = { chatId, phone, iv };
}

// ── MESSAGE HANDLER ───────────────────────────────────────
async function handle(msg) {
  const chatId = String(msg.chat.id);
  const text = msg.text?.trim();
  if (!text) return;
  const st = states[chatId];

  // ── REGISTRASI ───────────────────────────────────────
  if (st?.step === 'reg_username') {
    if (text.length < 3) { await tg(chatId, '❌ Username minimal 3 huruf.'); return; }
    if (Object.values(users).find(u => u.username === text)) {
      await tg(chatId, '❌ Username sudah dipakai.'); return;
    }
    states[chatId] = { step: 'reg_password', username: text };
    await tg(chatId, `✅ Username: <b>${text}</b>\n\nBuat password (min 4 karakter):`);
    return;
  }

  if (st?.step === 'reg_password') {
    if (text.length < 4) { await tg(chatId, '❌ Password minimal 4 karakter.'); return; }
    users[chatId] = {
      username: st.username,
      passwordHash: hashPass(text),
      balance: 0,
      orders: [],
      loggedIn: true,
      isAdmin: false
    };
    states[chatId] = null;
    saveDB();
    await tg(chatId, `🎉 <b>Akun berhasil dibuat!</b>\n\nUsername: <b>${st.username}</b>\nSaldo awal: Rp 0\n\nHubungi admin untuk top up saldo.`);
    await showMenu(chatId);
    return;
  }

  // ── LOGIN ─────────────────────────────────────────────
  if (st?.step === 'login_username') {
    const found = Object.entries(users).find(([id, u]) => u.username === text);
    if (!found) { await tg(chatId, '❌ Username tidak ditemukan.'); return; }
    states[chatId] = { step: 'login_password', targetId: found[0], username: text };
    await tg(chatId, `👤 <b>${text}</b>\n\nMasukkan password:`);
    return;
  }

  if (st?.step === 'login_password') {
    const u = users[st.targetId];
    if (!u || hashPass(text) !== u.passwordHash) {
      states[chatId] = null;
      await tg(chatId, '❌ Password salah.', { reply_markup: kb(['📝 Daftar', '🔐 Login'], 2) });
      return;
    }
    if (st.targetId !== chatId) {
      users[chatId] = { ...u, loggedIn: true };
    } else {
      u.loggedIn = true;
    }
    states[chatId] = null;
    saveDB();
    await tg(chatId, `✅ Login berhasil! Selamat datang, <b>${u.username}</b>!`);
    await showMenu(chatId);
    return;
  }

  // ── ADMIN TOP UP ──────────────────────────────────────
  if (st?.step === 'admin_topup_user') {
    const target = Object.entries(users).find(([id, u]) => u.username === text);
    if (!target) { await tg(chatId, '❌ User tidak ditemukan.'); return; }
    states[chatId] = { step: 'admin_topup_amount', targetId: target[0], targetName: text };
    await tg(chatId, `💸 Top up untuk <b>${text}</b>\n\nMasukkan jumlah (contoh: 50000):`, { reply_markup: noKb });
    return;
  }

  if (st?.step === 'admin_topup_amount') {
    const amount = parseInt(text.replace(/\D/g, ''));
    if (!amount || amount < 1000) { await tg(chatId, '❌ Minimal Rp 1.000'); return; }
    const u = users[st.targetId];
    if (!u) { await tg(chatId, '❌ User tidak ditemukan.'); return; }
    u.balance += amount;
    states[chatId] = null;
    saveDB();
    await tg(chatId, `✅ Top up <b>Rp ${amount.toLocaleString('id-ID')}</b> ke <b>${st.targetName}</b>\nSaldo baru: Rp ${u.balance.toLocaleString('id-ID')}`);
    await tg(st.targetId,
`💰 <b>Saldo kamu ditambah!</b>

+Rp ${amount.toLocaleString('id-ID')}
Saldo sekarang: Rp ${u.balance.toLocaleString('id-ID')}`
    ).catch(()=>{});
    await showAdminPanel(chatId);
    return;
  }

  // ── ADMIN HAPUS AKUN ──────────────────────────────────
  if (st?.step === 'admin_hapus') {
    const entry = Object.entries(users).find(([id, u]) => u.username === text);
    if (entry) { delete users[entry[0]]; saveDB(); await tg(chatId, `✅ Akun <b>${text}</b> dihapus.`); }
    states[chatId] = null;
    await showAdminPanel(chatId);
    return;
  }

  // ── KONFIRMASI BELI ───────────────────────────────────
  if (st?.step === 'confirm_buy') {
    if (text === '✅ Ya, Beli') { await prosesBeli(chatId); return; }
    if (text === '❌ Batal') {
      states[chatId] = null;
      await tg(chatId, '❌ Dibatalkan.');
      await showMenu(chatId);
      return;
    }
  }

  // ── BELUM LOGIN ───────────────────────────────────────
  if (!isLoggedIn(chatId)) {
    if (text === '📝 Daftar' || text === '/daftar') { await startRegister(chatId); return; }
    if (text === '🔐 Login' || text === '/login') { await startLogin(chatId); return; }
    await showWelcome(chatId);
    return;
  }

  // ── SUDAH LOGIN ───────────────────────────────────────
  if (text === '/start' || text === '🔙 Kembali') { await showMenu(chatId); return; }
  if (text === '🚗 Beli OTP Grab' || text === '/beli') { await cmdBeli(chatId); return; }
  if (text === '💰 Cek Saldo' || text === '/saldo') {
    const u = getUser(chatId);
    await tg(chatId, `💰 Saldo kamu: <b>Rp ${Number(u.balance).toLocaleString('id-ID')}</b>`);
    await showMenu(chatId);
    return;
  }
  if (text === '📋 Order Saya' || text === '/orders') { await cmdOrders(chatId); return; }
  if (text === '🚪 Logout') {
    const u = getUser(chatId);
    if (u) { u.loggedIn = false; saveDB(); }
    states[chatId] = null;
    await tg(chatId, '👋 Logout berhasil.', { reply_markup: noKb });
    await showWelcome(chatId);
    return;
  }

  // Admin
  if (String(chatId) === String(ADMIN_ID)) {
    if (text === '👑 Admin Panel') { await showAdminPanel(chatId); return; }
    if (text === '💸 Top Up Saldo') { await startTopUp(chatId); return; }
    if (text === '📊 Semua Order') { await showSemuaOrder(chatId); return; }
    if (text === '🗑 Hapus Akun') {
      const list = Object.values(users).filter(u => u.username !== 'Admin').map(u => u.username);
      if (!list.length) { await tg(chatId, '❌ Belum ada anggota.'); return; }
      states[chatId] = { step: 'admin_hapus' };
      await tg(chatId, 'Pilih akun yang dihapus:', { reply_markup: kb(list, 2) });
      return;
    }
  }

  if (text.startsWith('/batal_')) {
    const id = parseInt(text.replace('/batal_', ''));
    try {
      await sms('POST', '/orders/cancel', { id });
      const u = getUser(chatId);
      const o = u?.orders?.find(x => x.id === id);
      if (o) { u.balance += o.price; o.status = 'CANCELED'; saveDB(); }
      if (activeOrders[id]) { clearInterval(activeOrders[id].iv); delete activeOrders[id]; }
      await tg(chatId, `✅ Order dibatalkan. Saldo dikembalikan.`);
    } catch(e) { await tg(chatId, '❌ ' + e.message); }
    return;
  }

  await showMenu(chatId);
}

// ── MAIN ──────────────────────────────────────────────────
async function main() {
  console.log('\n🚗 Bot Grab Keluarga + Penyimpanan Data\n');

  // Buat akun admin jika belum ada
  if (!users[ADMIN_ID]) {
    users[ADMIN_ID] = {
      username: 'Admin',
      passwordHash: hashPass('admin123'),
      balance: 0,
      orders: [],
      loggedIn: false,
      isAdmin: true
    };
    saveDB();
  }

  console.log(`[DB] Data dimuat dari: ${DB_FILE}`);
  console.log(`[DB] Total akun tersimpan: ${Object.keys(users).length}`);

  try {
    const bal = await sms('GET', '/balance');
    console.log('✅ SMSCode OK | Saldo: Rp', Number(bal.balance).toLocaleString('id-ID'));
  } catch(e) { console.log('❌ SMSCode:', e.message); }

  try {
    await tg(ADMIN_ID,
`🟢 <b>Bot Grab Keluarga aktif!</b>
💾 Data tersimpan di file (tidak hilang saat restart)

Login Admin:
Username: <b>Admin</b>
Password: <b>admin123</b>

⚠️ Segera ganti password setelah login!`
    );
    console.log('✅ Telegram OK');
  } catch(e) { console.log('❌ Telegram:', e.message); }

  while (true) {
    try {
      const updates = await getUpdates();
      for (const u of updates) {
        lastUpdateId = u.update_id;
        if (u.message) await handle(u.message);
      }
    } catch(e) { console.error('[LOOP]', e.message); }
    await new Promise(r => setTimeout(r, 1000));
  }
}

main();
