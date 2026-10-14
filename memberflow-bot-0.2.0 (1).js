/**
 * MemberFlow Bot — v0.2.0
 * Cleaned, fixed, optimized & upgraded
 *
 * שינויים לפי בקשת המשתמש:
 * - הוספת קלף עולה 2 קרדיטים (ניתן לשינוי באדמין – cardCreationCost)
 * - אחרי אישור מנהל → המשתמש מועבר מיד לבחירת מסלול קידום
 * - אין אפשרות לשמור קלף בלי שימוש בקרדיטים
 * - קלף מאושר בלי הזמנה פעילה = נשמר ולא מתפרסם
 */

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
require('dotenv').config();

// ==========================================
//                 הגדרות
// ==========================================
const VERSION = '0.2.0';
const token = process.env.BOT_TOKEN;
const ADMIN_IDS = new Set([
  8017590244,
  ...String(process.env.ADMIN_IDS || process.env.ADMIN_ID || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean)
]);
const DATA_FILE = process.env.DATA_FILE || './data.json';
const AUTO_BACKUP_HOURS = Number(process.env.AUTO_BACKUP_HOURS) || 6;
const DEFAULT_SPONSOR = '@your_sponsor_channel';
const UNVERIFIED_WAIT_SEC = 15;
const MAX_OPEN_TICKETS = 3;

if (!token) {
  console.error('❌ BOT_TOKEN is missing in environment variables!');
  process.exit(1);
}

const bot = new Telegraf(token);
const app = express();
app.use(express.json());
let BOT_USERNAME = '';
let BOT_ID = null;

// ==========================================
//          מסד נתונים + שמירה לקובץ
// ==========================================
const defaults = () => ({
  users: {},
  channels: [],
  orders: {},
  promos: {},
  tickets: [],
  counters: { channel: 1, ticket: 1, plan: 4 },
  settings: {
    sponsorChannel: process.env.SPONSOR_CHANNEL || DEFAULT_SPONSOR,
    rewardPerJoin: 3,
    unverifiedReward: 1,
    welcomeBonus: 10,
    referralBonus: 5,
    dailyBonus: 2,
    sponsorEvery: 5,
    sponsorReward: 1,
    cardCreationCost: 2,          // ← חדש: עלות הוספת קלף
    requireBotAdmin: false,
    maintenance: false,
    plans: [
      { id: 1, credits: 30, subs: 10, active: true },
      { id: 2, credits: 60, subs: 20, active: true },
      { id: 3, credits: 150, subs: 55, active: true }
    ]
  }
});

let db = defaults();

const loadDb = (p) => {
  const d = defaults();
  db = {
    ...d,
    ...p,
    settings: { ...d.settings, ...(p.settings || {}) },
    counters: { ...d.counters, ...(p.counters || {}) }
  };
  Object.values(db.users).forEach((u) => {
    u.busy = false;
  });
};

try {
  if (fs.existsSync(DATA_FILE)) {
    loadDb(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    console.log('📂 Data loaded from', DATA_FILE);
  }
} catch (e) {
  console.error('Failed to load data:', e.message);
}

const saveDb = () => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db));
  } catch (e) {
    /* ignore write errors */
  }
};
setInterval(saveDb, 30000);

const S = () => db.settings;

// ==========================================
//                 אימוג'י ותוויות
// ==========================================
const E = {
  flash: '<tg-emoji emoji-id="5780782082108167841">⚡</tg-emoji>',
  diamond: '<tg-emoji emoji-id="5271998448042785916">💎</tg-emoji>',
  check: '<tg-emoji emoji-id="5269470868379026531">✅</tg-emoji>',
  next: '<tg-emoji emoji-id="5460991276948143687">▶️</tg-emoji>',
  sub: '<tg-emoji emoji-id="6231225487469842472">👑</tg-emoji>',
  confirm: '<tg-emoji emoji-id="6231018663319704664">🛡️</tg-emoji>',
  orders: '<tg-emoji emoji-id="5431499171045581032">📊</tg-emoji>',
  gift: '<tg-emoji emoji-id="5199749070830197566">🎁</tg-emoji>'
};

const BTN = {
  earn: '💎 הרווח קרדיטים חינם',
  add: '⚡ MemberFlow | הוספת מנויים',
  profile: '👤 הפרופיל שלי',
  orders: '📊 ההזמנות שלי',
  promo: '🎁 Redeem Promo Code',
  support: '🛠 תמיכה טכנית',
  help: '❓ עזרה והסברים',
  admin: '⚙️ פאנל ניהול אדמין'
};

const ORDER_STATUS = {
  active: '⚡ פעיל',
  paused: '⏸ מושהה',
  completed: '✅ הושלם',
  cancelled: '❌ בוטל'
};

// ==========================================
//                 פונקציות עזר
// ==========================================
const isAdmin = (ctx) => ctx.from && ADMIN_IDS.has(ctx.from.id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => Math.floor(Math.random() * n);
const escapeHtml = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const RLM = '\u200f';
const rtl = (t) =>
  t
    .split('\n')
    .map((l) => (l.trim() ? RLM + l : l))
    .join('\n');
const fmtDate = (d) =>
  new Date(d).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
const bar = (d, t) => {
  const f = t > 0 ? Math.min(10, Math.round((d / t) * 10)) : 0;
  return '▰'.repeat(f) + '▱'.repeat(10 - f);
};
const uLink = (u) => `<a href="tg://user?id=${u.id}">${escapeHtml(u.name)}</a>`;
const uTag = (u) => (u.username ? `@${escapeHtml(u.username)}` : 'ללא');
const isMemberStatus = (s) =>
  ['member', 'creator', 'administrator'].includes(s);

const html = (ctx, text, kb) =>
  ctx.reply(rtl(text), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(kb || {})
  });

const safeEdit = async (ctx, text, kb) => {
  try {
    await ctx.editMessageText(rtl(text), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(kb || {})
    });
  } catch (e) {
    const m = e.description || e.message || '';
    if (m.includes('not modified')) return;
    if (ctx.callbackQuery) return html(ctx, text, kb).catch(() => {});
    console.error('Edit error:', m);
  }
};

const show = (ctx, text, kb) =>
  ctx.callbackQuery ? safeEdit(ctx, text, kb) : html(ctx, text, kb);

const sendTo = (id, text, kb) =>
  bot.telegram.sendMessage(id, rtl(text), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(kb || {})
  });

const notifyAdmins = async (text, kb) => {
  for (const id of ADMIN_IDS) {
    try {
      await sendTo(id, text, kb);
    } catch (e) {
      /* admin has not started the bot */
    }
  }
};

const ensureUser = (from) => {
  let u = db.users[from.id];
  if (!u) {
    u = db.users[from.id] = {
      id: from.id,
      credits: S().welcomeBonus,
      totalEarned: S().welcomeBonus,
      totalSpent: 0,
      completedCount: 0,
      sponsorCompleted: false,
      state: null,
      data: {},
      claimed: [],
      pending: {},
      busy: false,
      notified: false,
      banned: false,
      joinedAt: Date.now(),
      referrer: null,
      referrals: 0,
      lastDaily: 0,
      promoFails: [],
      liveTicket: null
    };
  }
  u.name =
    [from.first_name, from.last_name].filter(Boolean).join(' ') || 'משתמש';
  u.username = from.username || '';
  return u;
};

const addCredits = (u, n) => {
  u.credits += n;
  if (n > 0) u.totalEarned = (u.totalEarned || 0) + n;
};

const normChannel = (s) =>
  '@' +
  String(s)
    .trim()
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^@/, '');
const sponsorEnabled = () => S().sponsorChannel !== DEFAULT_SPONSOR;
const sponsorLink = () =>
  `https://t.me/${S().sponsorChannel.replace('@', '')}`;

// --- הזמנות וקלפים ---
const liveOrder = (c) =>
  Object.values(db.orders).find(
    (o) =>
      o.channelId === c.id && o.status === 'active' && o.delivered < o.subsCount
  );
const isLive = (c) => c.approved && !c.disabled && !!liveOrder(c);
const userOrders = (uid) =>
  Object.values(db.orders)
    .filter((o) => o.userId === uid)
    .sort((a, b) => b.createdAt - a.createdAt);

const genOrderCode = () => {
  let c;
  do {
    c = 'ORD-' + (100000 + rand(900000));
  } while (db.orders[c]);
  return c;
};

const genPromoCode = () => {
  const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c =
      'MF-' +
      Array.from({ length: 6 }, () => ch[rand(ch.length)]).join('');
  } while (db.promos[c]);
  return c;
};

function cancelOrder(o, refund = true) {
  if (!['active', 'paused'].includes(o.status)) return 0;
  const remaining = o.subsCount - o.delivered;
  const amount = refund
    ? Math.floor((o.creditsSpent * remaining) / o.subsCount)
    : 0;
  o.status = 'cancelled';
  o.cancelledAt = Date.now();
  o.refunded = amount;
  const u = db.users[o.userId];
  if (u && amount) u.credits += amount;
  return amount;
}

// --- פרומו קוד ---
function redeem(user, raw) {
  const code = String(raw || '').trim().toUpperCase();
  const now = Date.now();
  user.promoFails = (user.promoFails || []).filter(
    (t) => now - t < 10 * 60 * 1000
  );
  if (user.promoFails.length >= 5)
    return {
      ok: false,
      msg: '⏳ <b>ניסיונות רבים מדי.</b> נסה שוב בעוד כמה דקות.'
    };
  const p = db.promos[code];
  const fail = (msg) => {
    user.promoFails.push(now);
    return { ok: false, msg };
  };
  if (!p || !p.active) return fail('❌ <b>קוד לא תקין או שאינו פעיל.</b>');
  if (p.userId && p.userId !== user.id)
    return fail('❌ <b>קוד זה שייך למשתמש אחר.</b>');
  if (p.usedBy.includes(user.id))
    return { ok: false, msg: '⚠️ <b>כבר מימשת קוד זה.</b>' };
  if (p.usedBy.length >= p.maxUses)
    return { ok: false, msg: '⚠️ <b>הקוד מוצה ואינו זמין עוד.</b>' };
  p.usedBy.push(user.id);
  addCredits(user, p.credits);
  return {
    ok: true,
    msg:
      `🎉 <b>הקוד מומש בהצלחה!</b>\n\n` +
      `${E.gift} התווספו לחשבונך <b>${p.credits}</b> ${E.diamond}\n` +
      `${E.diamond} יתרה חדשה: <b>${user.credits}</b>`
  };
}

async function sendPromoToUser(uid, credits, adminId) {
  const code = genPromoCode();
  db.promos[code] = {
    code,
    credits,
    maxUses: 1,
    usedBy: [],
    userId: uid,
    active: true,
    createdAt: Date.now(),
    createdBy: adminId
  };
  try {
    await sendTo(
      uid,
      `🎉 <b>ברוכים הבאים למשפחת MemberFlow!</b> 🎉\n\n` +
        `${E.gift} שמחים שהצטרפת אלינו! הנהלת המערכת מעניקה לך מתנת הצטרפות מיוחדת:\n\n` +
        `${E.diamond} שווי המתנה: <b>${credits} קרדיטים</b>\n` +
        `🔑 קוד הפרומו שלך: <code>${code}</code>\n\n` +
        `להפעלה לחץ על הכפתור שמתחת, או על <b>"🎁 Redeem Promo Code"</b> בתפריט הראשי ושלח את הקוד.\n\n` +
        `<i>בהצלחה ושימוש מהנה ${E.flash}</i>`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🎁 Redeem Now', `rd:${code}`)]
      ])
    );
  } catch (e) {
    delete db.promos[code];
    throw e;
  }
  return code;
}

// --- מקלדת ראשית ---
const getMainMenuKeyboard = (userId) => {
  const rows = [
    [BTN.earn, BTN.add],
    [BTN.profile, BTN.orders],
    [BTN.promo, BTN.support],
    [BTN.help]
  ];
  if (ADMIN_IDS.has(userId)) rows.push([BTN.admin]);
  return Markup.keyboard(rows).resize();
};

// --- עימוד ---
const paginate = (arr, page, per = 6) => {
  const pages = Math.max(1, Math.ceil(arr.length / per));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  return { items: arr.slice(p * per, p * per + per), page: p, pages };
};
const pager = (prefix, page, pages) => {
  if (pages <= 1) return [];
  const r = [];
  if (page > 0) r.push(Markup.button.callback('◀️', `${prefix}:${page - 1}`));
  r.push(Markup.button.callback(`${page + 1}/${pages}`, 'noop'));
  if (page < pages - 1)
    r.push(Markup.button.callback('▶️', `${prefix}:${page + 1}`));
  return [r];
};
bot.action('noop', (ctx) => ctx.answerCbQuery().catch(() => {}));

// ==========================================
//     Middleware: משתמש, חסימה, תחזוקה, איפוס מצב
// ==========================================
bot.use(async (ctx, next) => {
  if (ctx.chat && ctx.chat.type !== 'private') return;
  if (!ctx.from) return next();
  const user = ensureUser(ctx.from);

  if (!isAdmin(ctx)) {
    if (user.banned) {
      if (ctx.callbackQuery)
        return ctx
          .answerCbQuery('🚫 החשבון שלך נחסם', { show_alert: true })
          .catch(() => {});
      if (ctx.message)
        return html(
          ctx,
          `🚫 <b>החשבון שלך נחסם ממערכת MemberFlow.</b>\nלערעור פנה למנהל המערכת.`
        );
      return;
    }
    if (S().maintenance) {
      if (ctx.callbackQuery)
        return ctx
          .answerCbQuery(
            '🛠 המערכת בתחזוקה קצרה, נסה שוב בעוד רגע',
            { show_alert: true }
          )
          .catch(() => {});
      if (ctx.message)
        return html(
          ctx,
          `🛠 <b>המערכת בתחזוקה קצרה.</b>\nנחזור לפעילות מלאה בקרוב ${E.flash}`
        );
      return;
    }
  }

  const text = ctx.message && ctx.message.text;
  if (
    text &&
    (Object.values(BTN).includes(text) || text.startsWith('/'))
  ) {
    user.state = null;
    user.data = {};
  }
  return next();
});

// ==========================================
//              /start
// ==========================================
bot.start(async (ctx) => {
  const user = db.users[ctx.from.id];
  const payload = (ctx.startPayload || '').trim();

  if (!user.notified) {
    user.notified = true;
    const m = payload.match(/^ref_(\d+)$/);
    const ref =
      m && Number(m[1]) !== user.id ? db.users[m[1]] : null;
    if (ref) {
      user.referrer = ref.id;
      addCredits(ref, S().referralBonus);
      ref.referrals = (ref.referrals || 0) + 1;
      sendTo(
        ref.id,
        `👥 <b>חבר חדש הצטרף דרך הקישור שלך!</b>\n${E.diamond} קיבלת <b>${S().referralBonus}</b> קרדיטים בונוס.`
      ).catch(() => {});
    }
    await notifyAdmins(
      `🪪 <b>משתמש חדש הצטרף לבוט!</b>\n\n` +
        `👤 שם: ${uLink(user)}\n` +
        `🆔 מזהה: <code>${user.id}</code>\n` +
        `🔗 יוזר: ${uTag(user)}\n` +
        `${ref ? `👥 הופנה על ידי: ${uLink(ref)}\n` : ''}` +
        `📅 תאריך: ${fmtDate(user.joinedAt)}\n` +
        `👥 סה"כ משתמשים: <b>${Object.keys(db.users).length}</b>`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🎁 שלח פרומו קוד', `ps:${user.id}`)],
        [Markup.button.callback('👤 פרטי משתמש', `a_user:${user.id}`)]
      ])
    );
  }

  await html(
    ctx,
    `<b>ברוכים הבאים למערכת הרשמית — MemberFlow ${E.flash}</b>\n` +
      `<b>הוספת מנויים וחשיפה לערוצים וקבוצות</b>\n\n` +
      `מערכת מתקדמת להרחבת קהלים, ניהול מנויים והפצת ערוצים ברמת אמינות גבוהה ${E.confirm}\n\n` +
      `👤 <b>כרטיס משתמש אישי:</b>\n` +
      `• שם: ${escapeHtml(user.name)}\n` +
      `• מזהה מערכת: <code>${user.id}</code>\n` +
      `• יתרת קרדיטים: <b>${user.credits}</b> ${E.diamond}\n\n` +
      `<i>גרסה ${VERSION}</i>\n` +
      `<i>בחר באחת האפשרויות בתפריט למטה כדי להתחיל:</i>`,
    getMainMenuKeyboard(user.id)
  );
});

bot.command('cancel', (ctx) =>
  html(
    ctx,
    `${E.check} הפעולה בוטלה.`,
    getMainMenuKeyboard(ctx.from.id)
  )
);
bot.command('admin', (ctx) => (isAdmin(ctx) ? showAdminHome(ctx) : null));

// ==========================================
//        מטפל מצבים (state machine) להודעות טקסט
// ==========================================
const PUBLIC_RE =
  /^(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i;
const PRIVATE_RE =
  /^(?:https?:\/\/)?t\.me\/(\+[A-Za-z0-9_-]{8,}|joinchat\/[A-Za-z0-9_-]{8,})\/?$/i;

const states = {
  // ---------- משתמש ----------
  async CHANNEL_INFO(ctx, user, text) {
    const sep = text.indexOf('|');
    if (sep === -1)
      return html(
        ctx,
        `❌ <b>פורמט שגוי.</b> אנא שלח בצורה: <code>שם | קישור</code>`
      );
    const name = text.slice(0, sep).trim().slice(0, 64);
    const rawLink = text.slice(sep + 1).trim();
    let chatRef = null;
    let link = null;
    let m = rawLink.match(PUBLIC_RE);
    if (m) {
      chatRef = '@' + m[1];
      link = 'https://t.me/' + m[1];
    } else if ((m = rawLink.match(PRIVATE_RE))) {
      link = 'https://t.me/' + m[1];
    }
    if (!name || !link) {
      return html(
        ctx,
        `❌ <b>שם או קישור לא תקינים.</b>\nדוגמה: <code>הערוץ שלי | https://t.me/my_channel</code>`
      );
    }
    const dup = db.channels.find(
      (c) => c.link.toLowerCase() === link.toLowerCase()
    );
    if (dup && dup.ownerId !== user.id)
      return html(
        ctx,
        `❌ <b>ערוץ זה כבר רשום במערכת על ידי משתמש אחר.</b>`
      );

    // בדיקת עלות יצירת קלף
    const cost = S().cardCreationCost || 2;
    if (user.credits < cost) {
      return html(
        ctx,
        `❌ <b>אין מספיק קרדיטים.</b>\n` +
          `הוספת קלף עולה <b>${cost}</b> ${E.diamond}.\n` +
          `היתרה שלך: <b>${user.credits}</b>\n\n` +
          `הרווח קרדיטים דרך "💎 הרווח קרדיטים חינם" וחזור לכאן.`
      );
    }

    let verified = false;
    if (chatRef) {
      try {
        const bm = await bot.telegram.getChatMember(chatRef, BOT_ID);
        verified = ['administrator', 'creator'].includes(bm.status);
      } catch (e) {
        /* not verifiable */
      }
    }

    // Enforce requireBotAdmin
    if (S().requireBotAdmin && chatRef && !verified) {
      return html(
        ctx,
        `❌ <b>חובת אדמין פעילה.</b>\nהבוט חייב להיות אדמין בערוץ הציבורי כדי לרשום אותו.\nהוסף את הבוט כאדמין ונסה שוב.`
      );
    }

    // גביית העלות
    user.credits -= cost;
    user.totalSpent = (user.totalSpent || 0) + cost;

    let card = dup;
    if (card) {
      card.name = name;
      card.verified = verified;
      card.chatRef = chatRef;
      card.approved = false;
      card.creationCost = cost;
    } else {
      card = {
        id: db.counters.channel++,
        name,
        link,
        chatRef,
        ownerId: user.id,
        approved: false,
        disabled: false,
        verified,
        gained: 0,
        creationCost: cost,
        createdAt: Date.now()
      };
      db.channels.push(card);
    }
    user.state = null;
    saveDb();

    // שליחת התראה לאדמינים לאישור הקלף
    await notifyAdmins(
      `🪪 <b>קלף/הזמנה חדשה ממתינה לאישור!</b>\n\n` +
        `👤 משתמש: ${uLink(user)} (<code>${user.id}</code>)\n` +
        `📢 ערוץ: <b>${escapeHtml(name)}</b>\n` +
        `🔗 קישור: ${escapeHtml(link)}\n` +
        `• אימות: ${verified ? '✅ אוטומטי' : '⚠️ ידני'}\n` +
        `• עלות יצירה: ${cost} ${E.diamond}`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            '✅ אישור קלף',
            `admin_approve_card_${card.id}`
          ),
          Markup.button.callback(
            '❌ דחייה',
            `admin_reject_card_${card.id}`
          )
        ]
      ])
    );

    return html(
      ctx,
      `⏳ <b>הקלף שלך נקלט בהצלחה ונשלח לבדיקת הנהלה!</b>\n\n` +
        `• שם הערוץ: <b>${escapeHtml(name)}</b>\n` +
        `• עלות יצירה: <b>${cost}</b> ${E.diamond} (נוכו מהיתרה)\n` +
        `• יתרה נוכחית: <b>${user.credits}</b> ${E.diamond}\n\n` +
        `ברגע שהמנהל יאשר, תקבל הודעה עם אפשרות לבחור מסלול קידום ${E.flash}`,
      getMainMenuKeyboard(user.id)
    );
  },

  async PROMO_INPUT(ctx, user, text) {
    const r = redeem(user, text);
    if (r.ok) user.state = null;
    return html(
      ctx,
      r.ok ? r.msg : `${r.msg}\n\n<i>שלח קוד נוסף או חזור לתפריט.</i>`
    );
  },

  async TICKET_NEW(ctx, user) {
    return supportMessage(ctx, user, 'new');
  },
  async TICKET_REPLY(ctx, user) {
    return supportMessage(ctx, user, 'reply', user.data.ticketId);
  },

  // ---------- אדמין ----------
  async ADMIN_CHAT(ctx, user, text) {
    const t = db.tickets.find((x) => x.id === user.data.ticketId);
    if (!t) {
      user.state = null;
      return html(ctx, `⚠️ הפנייה לא נמצאה.`);
    }
    await adminToUser(ctx, t, text);
  },

  async ADMIN_MSG(ctx, user, text) {
    const uid = user.data.uid;
    user.state = null;
    try {
      await sendTo(
        uid,
        `📩 <b>הודעה מהנהלת MemberFlow:</b>\n\n${escapeHtml(text)}`
      );
      return html(ctx, `${E.check} ההודעה נשלחה.`);
    } catch (e) {
      return html(
        ctx,
        `❌ לא ניתן לשלוח (המשתמש חסם את הבוט?).`
      );
    }
  },

  async USER_SEARCH(ctx, user, text) {
    user.state = null;
    const q = text.replace(/^@/, '').toLowerCase();
    const res = Object.values(db.users).filter(
      (u) =>
        String(u.id) === q ||
        (u.username || '').toLowerCase() === q ||
        u.name.toLowerCase().includes(q)
    );
    if (!res.length) return html(ctx, `❌ לא נמצאו משתמשים.`);
    if (res.length === 1) return showUserDetails(ctx, res[0]);
    return html(
      ctx,
      `🔎 <b>נמצאו ${res.length} תוצאות:</b>`,
      Markup.inlineKeyboard(
        res
          .slice(0, 10)
          .map((u) => [
            Markup.button.callback(
              `${u.name} · ${u.id}`,
              `a_user:${u.id}`
            )
          ])
      )
    );
  },

  async CREDIT_ADJ(ctx, user, text) {
    const u = db.users[user.data.uid];
    const n = parseInt(text, 10);
    if (!u || Number.isNaN(n))
      return html(
        ctx,
        `❌ שלח מספר שלם (אפשר שלילי), למשל <code>50</code> או <code>-20</code>`
      );
    user.state = null;
    u.credits = Math.max(0, u.credits + n);
    if (n > 0) u.totalEarned += n;
    sendTo(
      u.id,
      `${E.diamond} <b>יתרת הקרדיטים שלך עודכנה על ידי ההנהלה.</b>\nיתרה נוכחית: <b>${u.credits}</b>`
    ).catch(() => {});
    return html(
      ctx,
      `${E.check} עודכן (${n > 0 ? '+' : ''}${n}). יתרה חדשה של ${escapeHtml(u.name)}: <b>${u.credits}</b>`
    );
  },

  async PROMO_AMOUNT(ctx, user, text) {
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 1)
      return html(ctx, `❌ שלח מספר קרדיטים חיובי.`);
    user.state = null;
    return doSendPromo(ctx, user.data.uid, n);
  },

  async BROADCAST(ctx, user, text) {
    try {
      await ctx.reply(
        rtl(`📢 <b>הודעה רשמית מהנהלת המערכת:</b>\n\n${text}`),
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      return html(
        ctx,
        `❌ HTML לא תקין בהודעה: ${escapeHtml(e.description || e.message)}\nתקן ושלח שוב.`
      );
    }
    user.state = null;
    user.data = { broadcast: text };
    return html(
      ctx,
      `☝️ <b>זו תצוגה מקדימה.</b> לשלוח ל-<b>${
        Object.values(db.users).filter((u) => !u.banned).length
      }</b> משתמשים?`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ שלח', 'a_bc_ok'),
          Markup.button.callback('❌ בטל', 'a_bc_no')
        ]
      ])
    );
  },

  async PROMO_NEW(ctx, user, text) {
    const [c, m, custom] = text.split(/\s+/);
    const credits = parseInt(c, 10);
    const maxUses = parseInt(m, 10);
    if (
      Number.isNaN(credits) ||
      Number.isNaN(maxUses) ||
      credits < 1 ||
      maxUses < 1
    ) {
      return html(
        ctx,
        `❌ פורמט: <code>קרדיטים מקסימום_מימושים [קוד]</code>\nלדוגמה: <code>50 100 SUMMER</code>`
      );
    }
    let code = custom ? custom.toUpperCase() : genPromoCode();
    if (!/^[A-Z0-9_-]{3,20}$/.test(code))
      return html(
        ctx,
        `❌ הקוד חייב להיות 3-20 תווים באנגלית/ספרות.`
      );
    if (db.promos[code]) return html(ctx, `❌ הקוד כבר קיים.`);
    user.state = null;
    db.promos[code] = {
      code,
      credits,
      maxUses,
      usedBy: [],
      userId: null,
      active: true,
      createdAt: Date.now(),
      createdBy: ctx.from.id
    };
    return html(
      ctx,
      `${E.check} <b>נוצר קוד פרומו:</b> <code>${code}</code>\n${E.diamond} ${credits} קרדיטים · עד ${maxUses} מימושים`
    );
  },

  async PLAN_NEW(ctx, user, text) {
    const [c, s] = text.split(/\s+/).map((x) => parseInt(x, 10));
    if (!c || !s || c < 1 || s < 1)
      return html(
        ctx,
        `❌ פורמט: <code>קרדיטים מנויים</code> לדוגמה <code>100 40</code>`
      );
    user.state = null;
    S().plans.push({
      id: db.counters.plan++,
      credits: c,
      subs: s,
      active: true
    });
    return html(
      ctx,
      `${E.check} נוסף מסלול: <b>${c}</b> ${E.diamond} ← <b>${s}</b> מנויים`
    );
  },

  async SETTING(ctx, user, text) {
    const key = user.data.key;
    const n = parseInt(text, 10);
    if (
      !NUM_SETTINGS[key] ||
      Number.isNaN(n) ||
      n < (key === 'sponsorEvery' ? 1 : 0)
    )
      return html(ctx, `❌ שלח מספר שלם תקין.`);
    user.state = null;
    S()[key] = n;
    return html(
      ctx,
      `${E.check} <b>${NUM_SETTINGS[key]}</b> עודכן ל-<b>${n}</b>`
    );
  },

  async SPONSOR_SET(ctx, user, text) {
    user.state = null;
    if (text.toLowerCase() === 'off') {
      S().sponsorChannel = DEFAULT_SPONSOR;
      return html(ctx, `${E.check} אימות ערוץ חובה <b>בוטל</b>.`);
    }
    const ref = normChannel(text);
    S().sponsorChannel = ref;
    let warn = '';
    try {
      const bm = await bot.telegram.getChatMember(ref, BOT_ID);
      if (!['administrator', 'creator'].includes(bm.status))
        warn =
          '\n⚠️ הבוט אינו אדמין בערוץ — האימות לא יעבוד.';
    } catch (e) {
      warn =
        '\n⚠️ לא ניתן לגשת לערוץ — ודא שהוא ציבורי והבוט אדמין בו.';
    }
    return html(
      ctx,
      `${E.check} ערוץ החובה עודכן ל-<b>${escapeHtml(ref)}</b>${warn}`
    );
  }
};

bot.on('text', async (ctx, next) => {
  const user = db.users[ctx.from.id];
  if (!user) return next();
  const h = states[user.state];
  if (h) return h(ctx, user, ctx.message.text.trim());
  if (user.liveTicket)
    return supportMessage(ctx, user, 'reply', user.liveTicket);
  return next();
});

// ==========================================
// אישור או דחיית קלפים על ידי אדמין
// ==========================================
bot.action(/^admin_approve_card_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx))
    return ctx.answerCbQuery('אין הרשאה', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});
  const cardId = Number(ctx.match[1]);
  const card = db.channels.find((c) => c.id === cardId);
  if (!card) return ctx.editMessageText('❌ הקלף לא נמצא.');

  card.approved = true;
  saveDb();

  // שליחה למשתמש: הקלף אושר + מעבר מיידי לבחירת מסלול
  const owner = db.users[card.ownerId];
  const plans = S().plans.filter((p) => p.active);
  const rows = plans.map((p) => [
    Markup.button.callback(
      `${p.credits} 💎 ← ${p.subs} מנויים`,
      `buy:${card.id}:${p.id}`
    )
  ]);

  try {
    await sendTo(
      card.ownerId,
      `🎉 <b>הקלף שלך אושר בהצלחה!</b>\n\n` +
        `${E.sub} הערוץ <b>${escapeHtml(card.name)}</b> התקבל במערכת.\n\n` +
        `📌 <b>כדי שהמנויים יתחילו להתווסף – בחר מסלול קידום:</b>\n` +
        `${E.diamond} היתרה שלך: <b>${owner ? owner.credits : '?'}</b>\n\n` +
        `<i>ללא בחירת מסלול הקלף נשמר אבל לא מתפרסם.</i>`,
      Markup.inlineKeyboard(rows)
    );
  } catch (e) {
    /* user blocked bot */
  }

  await ctx.editMessageText(
    `✅ <b>הקלף #${card.id} (${escapeHtml(card.name)}) אושר בהצלחה!</b>\nהודעה עם בחירת מסלול נשלחה למשתמש.`,
    { parse_mode: 'HTML' }
  );
});

bot.action(/^admin_reject_card_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx))
    return ctx.answerCbQuery('אין הרשאה', { show_alert: true });
  await ctx.answerCbQuery().catch(() => {});
  const cardId = Number(ctx.match[1]);
  const cardIndex = db.channels.findIndex((c) => c.id === cardId);
  if (cardIndex === -1) return ctx.editMessageText('❌ הקלף לא נמצא.');

  const card = db.channels[cardIndex];
  const cost = card.creationCost || S().cardCreationCost || 2;

  // החזרת הקרדיטים למשתמש
  const owner = db.users[card.ownerId];
  if (owner) {
    owner.credits += cost;
  }

  db.channels.splice(cardIndex, 1);
  saveDb();

  // הודעה למשתמש על דחייה + החזר
  sendTo(
    card.ownerId,
    `❌ <b>ההזמנה שלך לערוץ "${escapeHtml(card.name)}" נדחתה על ידי ההנהלה.</b>\n\n` +
      `${E.diamond} הוחזרו אליך <b>${cost}</b> קרדיטים.\n` +
      `לפרטים נוספים ניתן לפנות לתמיכה הטכנית.`
  ).catch(() => {});

  await ctx.editMessageText(
    `❌ <b>הקלף #${cardId} נדחה והוסר מהמערכת.</b>\nהוחזרו ${cost} קרדיטים למשתמש.`,
    { parse_mode: 'HTML' }
  );
});

// ==========================================
//          תמיכה טכנית (פניות)
// ==========================================
async function supportMessage(ctx, user, kind, ticketId) {
  const msg = ctx.message;
  const isMedia = !msg.text;
  const body = (
    (isMedia ? '📎 [מדיה] ' : '') + (msg.text || msg.caption || '')
  ).slice(0, 1500);
  let t;

  if (kind === 'new') {
    t = {
      id: db.counters.ticket++,
      userId: user.id,
      status: 'open',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ from: 'user', text: body, ts: Date.now() }]
    };
    db.tickets.push(t);
  } else {
    t = db.tickets.find((x) => x.id === ticketId && x.userId === user.id);
    if (!t) {
      user.state = null;
      user.liveTicket = null;
      return html(ctx, `⚠️ הפנייה לא נמצאה.`);
    }
    t.messages.push({ from: 'user', text: body, ts: Date.now() });
    t.status = 'open';
    t.updatedAt = Date.now();
  }
  user.state = null;
  user.data = {};

  await notifyAdmins(
    `${
      kind === 'new' ? '🎫 <b>פנייה חדשה' : '💬 <b>תגובה חדשה בפנייה'
    } #${t.id}</b>\n` +
      `👤 ${uLink(user)} · <code>${user.id}</code> · ${uTag(user)}\n\n${escapeHtml(
        body
      )}`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('💬 פתח צ\'אט ישיר', `a_tchat:${t.id}`),
        Markup.button.callback('📂 פרטי פנייה', `a_ticket:${t.id}`)
      ]
    ])
  );
  if (isMedia) {
    for (const id of ADMIN_IDS)
      bot.telegram.copyMessage(id, ctx.chat.id, msg.message_id).catch(() => {});
  }
  return html(
    ctx,
    kind === 'new'
      ? `${E.check} <b>פנייתך התקבלה!</b>\n🎫 מספר פנייה: <b>#${t.id}</b>\nנציג יחזור אליך בהקדם. תשובה תגיע ישירות לכאן ${E.flash}`
      : `${E.check} <b>הודעתך נוספה לפנייה #${t.id}</b> ונשלחה לצוות התמיכה.`
  );
}

async function adminToUser(ctx, t, text) {
  const u = db.users[t.userId];
  const msg = ctx.message;
  const isMedia = !msg.text;
  const body = (
    (isMedia ? '📎 [מדיה] ' : '') + (msg.text || msg.caption || '')
  ).slice(0, 1500);
  t.messages.push({ from: 'admin', text: body, ts: Date.now() });
  t.updatedAt = Date.now();
  try {
    await sendTo(
      t.userId,
      `🛠 <b>תגובת התמיכה (פנייה #${t.id}):</b>\n\n${escapeHtml(body)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✍️ השב', `tkr:${t.id}`)]
      ])
    );
    if (isMedia)
      await bot.telegram.copyMessage(t.userId, ctx.chat.id, msg.message_id);
    if (u) u.liveTicket = t.id;
    await ctx.reply('✓ נשלח').catch(() => {});
  } catch (e) {
    await html(ctx, `❌ לא ניתן לשלוח (המשתמש חסם את הבוט?).`);
  }
}

bot.hears(BTN.support, async (ctx) => {
  const user = db.users[ctx.from.id];
  const open = db.tickets.filter(
    (t) => t.userId === user.id && t.status === 'open'
  ).length;
  if (open >= MAX_OPEN_TICKETS) {
    return html(
      ctx,
      `⚠️ יש לך כבר <b>${open}</b> פניות פתוחות. המתן לטיפול לפני פתיחת פנייה חדשה.`
    );
  }
  user.state = 'TICKET_NEW';
  await html(
    ctx,
    `🛠 <b>תמיכה טכנית — MemberFlow</b>\n\n` +
      `תאר את הבעיה או השאלה שלך בהודעה אחת (אפשר גם לצרף תמונה או קובץ).\n` +
      `הפנייה תועבר ישירות לצוות ההנהלה ${E.flash}\n\n` +
      `<i>לביטול שלח /cancel</i>`
  );
});

bot.action(/^tkr:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const id = Number(ctx.match[1]);
  const t = db.tickets.find(
    (x) => x.id === id && x.userId === ctx.from.id
  );
  if (!t) return;
  const user = db.users[ctx.from.id];
  user.state = 'TICKET_REPLY';
  user.data = { ticketId: id };
  await html(
    ctx,
    `✍️ <b>כתוב את תגובתך לפנייה #${id}:</b>\n<i>לביטול שלח /cancel</i>`
  );
});

// מדיה (תמיכה / שחזור גיבוי)
bot.on(
  ['photo', 'document', 'video', 'voice', 'video_note'],
  async (ctx, next) => {
    const user = db.users[ctx.from.id];
    if (!user) return next();

    if (isAdmin(ctx) && user.state === 'RESTORE' && ctx.message.document) {
      try {
        const link = await bot.telegram.getFileLink(
          ctx.message.document.file_id
        );
        const res = await fetch(String(link));
        const data = await res.json();
        if (!data || typeof data.users !== 'object')
          throw new Error('invalid backup');
        loadDb(data);
        saveDb();
        user.state = null;
        return html(
          ctx,
          `${E.check} <b>הגיבוי שוחזר!</b>\nמשתמשים: ${
            Object.keys(db.users).length
          } · הזמנות: ${Object.keys(db.orders).length} · ערוצים: ${
            db.channels.length
          }`
        );
      } catch (e) {
        return html(
          ctx,
          `❌ שחזור נכשל: ${escapeHtml(e.message)}`
        );
      }
    }
    if (user.state === 'TICKET_NEW') return supportMessage(ctx, user, 'new');
    if (user.state === 'TICKET_REPLY')
      return supportMessage(ctx, user, 'reply', user.data.ticketId);
    if (isAdmin(ctx) && user.state === 'ADMIN_CHAT') {
      const t = db.tickets.find((x) => x.id === user.data.ticketId);
      if (t) return adminToUser(ctx, t);
    }
    if (!user.state && user.liveTicket)
      return supportMessage(ctx, user, 'reply', user.liveTicket);
    return next();
  }
);

// ==========================================
//           רווח קרדיטים חינם
// ==========================================
async function showEarnCard(ctx) {
  const user = db.users[ctx.from.id];
  await ctx.sendChatAction('typing').catch(() => {});

  if (
    sponsorEnabled() &&
    user.completedCount > 0 &&
    user.completedCount % S().sponsorEvery === 0 &&
    !user.sponsorCompleted
  ) {
    return show(
      ctx,
      `<b>${E.confirm} אימות ביטחון תקופתי (חובה)</b> ${E.flash}\n\n` +
        `ביצעת <b>${user.completedCount}</b> פעולות בהצלחה! כדי להמשיך להרוויח, עליך להצטרף לערוץ הרשמי של המערכת.\n\n` +
        `🎁 תגמול אימות: <b>${S().sponsorReward} ${E.diamond}</b> מתנה ${E.next}`,
      Markup.inlineKeyboard([
        [Markup.button.url('⚡ הצטרף לערוץ הרשמי', sponsorLink())],
        [
          Markup.button.callback(
            '✅ אמת הצטרפות וקבל קרדיט',
            'verify_sponsor'
          )
        ]
      ])
    );
  }

  const available = db.channels.filter(
    (c) =>
      isLive(c) &&
      c.ownerId !== user.id &&
      !user.claimed.includes(c.id)
  );
  if (!available.length) {
    return show(
      ctx,
      `⚠️ <b>אין כרגע קלפי חשיפה זמינים במאגר.</b>\nאנא חזור מאוחר יותר או פרסם ערוץ משלך דרך התפריט!`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🔄 רענן', 'next_card')]
      ])
    );
  }

  // ערוצים מאומתים מקבלים קדימות (פי 3)
  const pool = available.flatMap((c) =>
    c.verified ? [c, c, c] : [c]
  );
  const target = pool[rand(pool.length)];
  user.pending[target.id] = Date.now();
  const reward = target.verified
    ? S().rewardPerJoin
    : S().unverifiedReward;

  await show(
    ctx,
    `🪪 <b>קלף חשיפה מנוהל ${E.flash}</b>\n\n` +
      `📢 ערוץ / קבוצה: <b>${escapeHtml(target.name)}</b>\n` +
      `🎯 משימה: הצטרפות כחבר קהילה פעיל\n` +
      `${
        target.verified ? '✅ אימות אוטומטי' : '⚠️ ללא אימות אוטומטי'
      }\n\n` +
      `🎁 תגמול הצטרפות: <b>${reward} ${E.diamond}</b>`,
    Markup.inlineKeyboard([
      [Markup.button.url('🔗 מעבר לערוץ המבוקש', target.link)],
      [
        Markup.button.callback(
          `קבל ${reward} קרדיטים 💎`,
          `claim_${target.id}`
        )
      ],
      [Markup.button.callback('⏭ דלג לקלף הבא', 'next_card')]
    ])
  );
}

bot.hears(BTN.earn, (ctx) => showEarnCard(ctx));
bot.action('next_card', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showEarnCard(ctx);
});

bot.action(/^claim_(\d+)$/, async (ctx) => {
  const channelId = Number(ctx.match[1]);
  const user = db.users[ctx.from.id];
  const channel = db.channels.find((c) => c.id === channelId);

  if (!channel || !isLive(channel))
    return ctx.answerCbQuery('⚠️ קלף זה כבר אינו זמין.', {
      show_alert: true
    });
  if (user.claimed.includes(channelId))
    return ctx.answerCbQuery('כבר קיבלת קרדיטים על ערוץ זה.', {
      show_alert: true
    });
  if (user.busy)
    return ctx.answerCbQuery('⏳ בדיקה כבר מתבצעת...');

  if (!channel.verified) {
    const wait =
      UNVERIFIED_WAIT_SEC -
      (Date.now() - (user.pending[channelId] || 0)) / 1000;
    if (wait > 0) {
      return ctx.answerCbQuery(
        `⏳ הצטרף לערוץ והמתן עוד ${Math.ceil(wait)} שניות לפני האישור`,
        { show_alert: true }
      );
    }
  }

  user.busy = true;
  await ctx.answerCbQuery().catch(() => {});
  const retryKb = Markup.inlineKeyboard([
    [Markup.button.url('🔗 מעבר לערוץ', channel.link)],
    [
      Markup.button.callback(
        'נסה לאמת שוב ⚡',
        `claim_${channel.id}`
      )
    ],
    [Markup.button.callback('⏭ דלג לקלף הבא', 'next_card')]
  ]);

  try {
    await safeEdit(ctx, `⌛ <b>בודק חברות בערוץ...</b>`);
    await sleep(600);
    await safeEdit(ctx, `🔄 <b>מאמת נתונים מול שרתי טלגרם...</b>`);
    await sleep(600);

    if (channel.verified) {
      const cm = await bot.telegram.getChatMember(
        channel.chatRef,
        ctx.from.id
      );
      if (!isMemberStatus(cm.status)) {
        return safeEdit(
          ctx,
          `❌ <b>אימות נכשל!</b>\n\nלא זוהתה הצטרפות בערוץ <b>${escapeHtml(
            channel.name
          )}</b>.\nאנא הצטרף ולחץ שוב על כפתור האימות.`,
          retryKb
        );
      }
    }

    const order = liveOrder(channel);
    if (!order || user.claimed.includes(channelId))
      return safeEdit(
        ctx,
        `⚠️ הקלף כבר אינו זמין.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('⏭ קלף הבא', 'next_card')]
        ])
      );

    const reward = channel.verified
      ? S().rewardPerJoin
      : S().unverifiedReward;
    addCredits(user, reward);
    user.completedCount += 1;
    user.sponsorCompleted = false;
    user.claimed.push(channelId);
    delete user.pending[channelId];
    channel.gained += 1;
    order.delivered += 1;

    if (order.delivered >= order.subsCount) {
      order.status = 'completed';
      order.completedAt = Date.now();
      sendTo(
        order.userId,
        `🎊 <b>ההזמנה ${order.code} הושלמה!</b>\n${E.sub} הערוץ <b>${escapeHtml(
          channel.name
        )}</b> קיבל את כל <b>${order.subsCount}</b> המנויים.`
      ).catch(() => {});
    }

    await safeEdit(
      ctx,
      `${E.check} <b>הפעולה אושרה בהצלחה!</b> ${E.flash}\n\n` +
        `התקבלו <b>${reward} ${E.diamond}</b> לחשבונך האישי.\n` +
        `יתרה מעודכנת: <b>${user.credits} ${E.diamond}</b>`,
      Markup.inlineKeyboard([
        [Markup.button.callback('המשך לקלף הבא ▶️', 'next_card')]
      ])
    );
  } catch (err) {
    console.error(
      'Verification error:',
      err.description || err.message
    );
    await safeEdit(
      ctx,
      `⚠️ <b>שגיאה בביצוע האימות.</b>\nהערוץ אינו זמין כרגע. נסה שוב או דלג לקלף הבא.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            'נסה שוב ⚡',
            `claim_${channel.id}`
          )
        ],
        [Markup.button.callback('⏭ קלף הבא', 'next_card')]
      ])
    );
  } finally {
    user.busy = false;
  }
});

bot.action('verify_sponsor', async (ctx) => {
  const user = db.users[ctx.from.id];
  await ctx.answerCbQuery().catch(() => {});
  try {
    await safeEdit(
      ctx,
      `⌛ <b>מאמת הצטרפות לערוץ הרשמי...</b>`
    );
    await sleep(800);
    const member = await bot.telegram.getChatMember(
      S().sponsorChannel,
      ctx.from.id
    );
    if (isMemberStatus(member.status)) {
      if (!user.sponsorCompleted) {
        user.sponsorCompleted = true;
        addCredits(user, S().sponsorReward);
      }
      await safeEdit(
        ctx,
        `${E.check} <b>האימות הושלם בהצלחה!</b> ${E.flash}\n\nקיבלת <b>${S().sponsorReward} ${E.diamond}</b> במתנה. תוכל להמשיך להרוויח קרדיטים בחופשיות!`,
        Markup.inlineKeyboard([
          [Markup.button.callback('המשך ▶️', 'next_card')]
        ])
      );
    } else {
      await safeEdit(
        ctx,
        `❌ <b>טרם הצטרפת לערוץ הרשמי.</b>\nאנא הצטרף ונסה שוב.`,
        Markup.inlineKeyboard([
          [Markup.button.url('📢 מעבר לערוץ', sponsorLink())],
          [Markup.button.callback('אמת שוב', 'verify_sponsor')]
        ])
      );
    }
  } catch (e) {
    console.error(
      'Sponsor verify error:',
      e.description || e.message
    );
    await safeEdit(
      ctx,
      `⚠️ <b>לא ניתן לאמת כרגע.</b>\nנסה שוב בעוד רגע.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('אמת שוב', 'verify_sponsor')]
      ])
    );
  }
});

// ==========================================
//     הוספת מנויים / פרסום ערוץ
// ==========================================
bot.hears(BTN.add, async (ctx) => {
  const user = db.users[ctx.from.id];
  user.state = 'CHANNEL_INFO';
  const mine = db.channels
    .filter((c) => c.ownerId === user.id && c.approved)
    .slice(0, 8);

  const cost = S().cardCreationCost || 2;

  await html(
    ctx,
    `🪪 <b>יצירת קלף משתמש לקידום וחשיפה ${E.flash}</b>\n\n` +
      `כדי להוסיף ערוץ/קבוצה חדשים, שלח כעת את <b>השם והקישור הישיר</b> בפורמט:\n\n` +
      `<code>שם הערוץ | https://t.me/your_channel</code>\n\n` +
      `💰 <b>עלות יצירת קלף: ${cost} ${E.diamond}</b>\n` +
      `💡 <i>הוספת הבוט כאדמין בערוץ אינה חובה, אך מפעילה אימות אוטומטי, תגמול מלא למצטרפים וקדימה בחשיפה.</i>\n\n` +
      `<i>לאחר אישור המנהל תועבר לבחירת מסלול קידום. ללא מסלול הקלף נשמר אבל לא מתפרסם.</i>` +
      (mine.length
        ? `\n\n📂 <b>או בחר קלף קיים לחיזוק / הפעלה מחדש:</b>`
        : ''),
    mine.length
      ? Markup.inlineKeyboard(
          mine.map((c) => [
            Markup.button.callback(`📢 ${c.name}`, `mycard:${c.id}`)
          ])
        )
      : undefined
  );
});

bot.action(/^mycard:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const c = db.channels.find(
    (x) => x.id === Number(ctx.match[1]) && x.ownerId === ctx.from.id
  );
  if (!c) return;
  db.users[ctx.from.id].state = null;
  await showPlans(ctx, c);
});

async function showPlans(ctx, card) {
  const user = db.users[ctx.from.id];
  const plans = S().plans.filter((p) => p.active);
  const rows = plans.map((p) => [
    Markup.button.callback(
      `${p.credits} 💎 ← ${p.subs} מנויים`,
      `buy:${card.id}:${p.id}`
    )
  ]);
  // אין יותר אפשרות "שמור בלי קידום"
  await show(
    ctx,
    `${E.check} <b>הקלף "${escapeHtml(card.name)}" מוכן לקידום!</b> ${E.flash}\n\n` +
      `בחר מסלול קידום:\n` +
      `${E.diamond} היתרה שלך: <b>${user.credits}</b>\n\n` +
      `<i>ללא בחירת מסלול הקלף נשמר במערכת אבל לא מתפרסם.</i>`,
    Markup.inlineKeyboard(rows)
  );
}

bot.action(/^buy:(\d+):(\d+)$/, async (ctx) => {
  const cardId = Number(ctx.match[1]);
  const planId = Number(ctx.match[2]);
  const user = db.users[ctx.from.id];
  const card = db.channels.find(
    (c) =>
      c.id === cardId && c.ownerId === user.id && c.approved
  );
  if (!card)
    return ctx.answerCbQuery('⚠️ הקלף לא נמצא.', {
      show_alert: true
    });

  const plan = S().plans.find((p) => p.id === planId && p.active);
  if (!plan)
    return ctx.answerCbQuery('⚠️ המסלול אינו זמין.', {
      show_alert: true
    });
  if (user.credits < plan.credits) {
    return ctx.answerCbQuery(
      `❌ חסרים לך ${
        plan.credits - user.credits
      } קרדיטים. הרווח עוד דרך "הרווח קרדיטים חינם" וחזור לכאן.`,
      { show_alert: true }
    );
  }
  await ctx.answerCbQuery().catch(() => {});

  user.credits -= plan.credits;
  user.totalSpent = (user.totalSpent || 0) + plan.credits;
  const code = genOrderCode();
  db.orders[code] = {
    code,
    userId: user.id,
    channelId: card.id,
    planId: plan.id,
    creditsSpent: plan.credits,
    subsCount: plan.subs,
    delivered: 0,
    status: 'active',
    createdAt: Date.now()
  };

  notifyAdmins(
    `🛒 <b>הזמנה חדשה ${code}</b>\n👤 ${uLink(
      user
    )} · <code>${user.id}</code>\n📢 ${escapeHtml(
      card.name
    )}\n${E.diamond} ${plan.credits} ← ${plan.subs} מנויים`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📂 פרטי הזמנה', `a_order:${code}`)]
    ])
  ).catch(() => {});

  await safeEdit(
    ctx,
    `✨ <b>ההזמנה נוצרה והופעלה בהצלחה!</b> ${E.flash}\n\n` +
      `${E.orders} קוד הזמנה: <code>${code}</code>\n` +
      `${E.diamond} קרדיטים הושקעו: <b>${plan.credits}</b>\n` +
      `${E.sub} מנויים מתוכננים: <b>${plan.subs}</b>\n` +
      `📌 סטטוס: <b>פעיל במערכת</b>\n\n` +
      `<i>תוכל לעקוב אחר ההתקדמות בכל עת דרך "ההזמנות שלי".</i>`
  );
});

// ==========================================
//          פרופיל, בונוס יומי, הפניות
// ==========================================
async function showProfile(ctx) {
  const u = db.users[ctx.from.id];
  const link = `https://t.me/${BOT_USERNAME}?start=ref_${u.id}`;
  await show(
    ctx,
    `👤 <b>הפרופיל שלי — MemberFlow</b>\n\n` +
      `• שם: ${escapeHtml(u.name)}\n` +
      `• מזהה: <code>${u.id}</code>\n` +
      `• ${E.diamond} יתרה: <b>${u.credits}</b>\n` +
      `• ✅ הצטרפויות שבוצעו: <b>${u.completedCount}</b>\n` +
      `• 📈 סה"כ הרווחת: <b>${u.totalEarned || 0}</b> · 💸 הושקעו: <b>${
        u.totalSpent || 0
      }</b>\n` +
      `• 👥 חברים שהפנית: <b>${u.referrals || 0}</b>\n` +
      `• 📅 הצטרפת: ${fmtDate(u.joinedAt)}\n\n` +
      `🔗 <b>קישור ההזמנה האישי שלך:</b>\n<code>${link}</code>\n` +
      `<i>על כל חבר שמצטרף דרכך תקבל ${S().referralBonus} ${
        E.diamond
      }</i>`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          `🎁 בונוס יומי (+${S().dailyBonus} 💎)`,
          'daily'
        )
      ],
      [
        Markup.button.url(
          '📤 שתף את הקישור',
          `https://t.me/share/url?url=${encodeURIComponent(
            link
          )}&text=${encodeURIComponent(
            'הצטרפו ל-MemberFlow והרוויחו קרדיטים חינם!'
          )}`
        )
      ]
    ])
  );
}
bot.hears(BTN.profile, showProfile);

bot.action('daily', async (ctx) => {
  const u = db.users[ctx.from.id];
  const left = 24 * 3600 * 1000 - (Date.now() - (u.lastDaily || 0));
  if (left > 0) {
    return ctx.answerCbQuery(
      `⏳ הבונוס הבא בעוד ${Math.ceil(left / 3600000)} שעות`,
      { show_alert: true }
    );
  }
  u.lastDaily = Date.now();
  addCredits(u, S().dailyBonus);
  await ctx
    .answerCbQuery(`🎁 קיבלת ${S().dailyBonus} קרדיטים!`, {
      show_alert: true
    })
    .catch(() => {});
  await showProfile(ctx);
});

// ==========================================
//              פרומו קוד (משתמש)
// ==========================================
bot.hears(BTN.promo, async (ctx) => {
  db.users[ctx.from.id].state = 'PROMO_INPUT';
  await html(
    ctx,
    `${E.gift} <b>מימוש קוד פרומו</b>\n\nשלח כעת את הקוד שקיבלת (לדוגמה: <code>MF-AB12CD</code>)\n<i>לביטול שלח /cancel</i>`
  );
});

bot.action(/^rd:([A-Za-z0-9_-]+)$/, async (ctx) => {
  const r = redeem(db.users[ctx.from.id], ctx.match[1]);
  await ctx
    .answerCbQuery(r.ok ? '🎉 מומש!' : '⚠️', { show_alert: !r.ok })
    .catch(() => {});
  if (r.ok) await safeEdit(ctx, r.msg);
  else await html(ctx, r.msg);
});

// ==========================================
//              ההזמנות שלי / עזרה
// ==========================================
bot.hears(BTN.orders, async (ctx) => {
  const list = userOrders(ctx.from.id).slice(0, 10);
  if (!list.length)
    return html(
      ctx,
      `📋 <b>אין לך הזמנות כרגע במערכת.</b>\nלחץ על "MemberFlow | הוספת מנויים" כדי להתחיל.`
    );
  let text = `${E.orders} <b>ההזמנות שלך במערכת MemberFlow:</b> ${E.flash}\n\n`;
  list.forEach((o) => {
    const ch = db.channels.find((c) => c.id === o.channelId);
    text +=
      `• <code>${o.code}</code> — ${escapeHtml(
        ch ? ch.name : '—'
      )}\n` +
      `  ${bar(o.delivered, o.subsCount)} <b>${o.delivered}/${
        o.subsCount
      }</b> · ${ORDER_STATUS[o.status]}\n` +
      `  📅 ${fmtDate(o.createdAt)}\n\n`;
  });
  await html(ctx, text);
});

bot.hears(BTN.help, async (ctx) => {
  const cost = S().cardCreationCost || 2;
  await html(
    ctx,
    `📖 <b>מדריך שימוש רשמי — MemberFlow ${E.flash}</b>\n\n` +
      `1️⃣ <b>רווח קרדיטים:</b> "הרווח קרדיטים חינם" — הצטרף לערוצים המוצגים ואשר לקבלת ${E.diamond}\n\n` +
      `2️⃣ <b>הוספת מנויים:</b> הוסף את הערוץ שלך (עלות יצירה: ${cost} ${E.diamond}), לאחר אישור המנהל בחר מסלול והשקע קרדיטים לקבלת חברים ${E.sub}\n\n` +
      `3️⃣ <b>פרומו קוד:</b> "🎁 Redeem Promo Code" — מימוש קוד מתנה לקרדיטים\n\n` +
      `4️⃣ <b>פרופיל:</b> יתרה, סטטיסטיקות, בונוס יומי וקישור הזמנה אישי\n\n` +
      `5️⃣ <b>אימות ביטחון:</b> כל ${S().sponsorEvery} פעולות יש לאשר חברות בערוץ הרשמי ${E.confirm}\n\n` +
      `6️⃣ <b>תמיכה:</b> "🛠 תמיכה טכנית" — פתיחת פנייה לצוות ההנהלה\n\n` +
      `<i>גרסה ${VERSION}</i>`
  );
});

// ==========================================
//            פאנל ניהול אדמין
// ==========================================
const aAction = (re, fn) =>
  bot.action(re, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx)) return;
    try {
      await fn(ctx);
    } catch (e) {
      console.error(
        'Admin action error:',
        e.description || e.message
      );
    }
  });

const backRow = (to = 'a_home') => [
  Markup.button.callback('🔙 חזרה', to)
];

async function showAdminHome(ctx) {
  const users = Object.values(db.users);
  const orders = Object.values(db.orders);
  const day = Date.now() - 24 * 3600 * 1000;
  const cnt = (st) => orders.filter((o) => o.status === st).length;
  const openT = db.tickets.filter((t) => t.status === 'open').length;
  const circulation = users.reduce((s, u) => s + u.credits, 0);

  await show(
    ctx,
    `⚙️ <b>פאנל שליטה וניהול — MemberFlow</b> ${E.flash}\n` +
      `<i>v${VERSION}</i>\n\n` +
      `👥 משתמשים: <b>${users.length}</b> (חדשים ב-24ש': ${
        users.filter((u) => u.joinedAt > day).length
      } · חסומים: ${users.filter((u) => u.banned).length})\n` +
      `${E.diamond} קרדיטים במחזור: <b>${circulation}</b>\n` +
      `📡 קלפים: <b>${db.channels.length}</b> (חיים: ${
        db.channels.filter(isLive).length
      })\n` +
      `📦 הזמנות: <b>${orders.length}</b> (⚡${cnt('active')} · ⏸${cnt(
        'paused'
      )} · ✅${cnt('completed')} · ❌${cnt('cancelled')})\n` +
      `🎫 פניות פתוחות: <b>${openT}</b>\n` +
      `🎁 קודי פרומו: <b>${Object.keys(db.promos).length}</b>\n` +
      `🛡️ ערוץ חובה: <b>${
        sponsorEnabled()
          ? escapeHtml(S().sponsorChannel)
          : 'כבוי'
      }</b>\n` +
      `${
        S().maintenance ? '🛠 <b>מצב תחזוקה פעיל</b>\n' : ''
      }\n` +
      `<i>בחר פעולת ניהול:</i>`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('📦 הזמנות', 'a_orders:all:0'),
        Markup.button.callback(
          `🎫 פניות תמיכה${openT ? ` (${openT})` : ''}`,
          'a_tickets:open:0'
        )
      ],
      [
        Markup.button.callback('👥 משתמשים', 'a_users:0'),
        Markup.button.callback('📢 הודעה לכולם', 'a_broadcast')
      ],
      [
        Markup.button.callback('🎁 פרומו קודים', 'a_promos:0'),
        Markup.button.callback('💎 מסלולי קרדיט', 'a_plans')
      ],
      [
        Markup.button.callback('📡 ערוצים וקלפים', 'a_channels:0'),
        Markup.button.callback('🛡️ ערוץ חובה', 'a_sponsor')
      ],
      [
        Markup.button.callback('⚙️ הגדרות מערכת', 'a_settings'),
        Markup.button.callback('💾 גיבוי ושחזור', 'a_backup_menu')
      ],
      [Markup.button.callback('🔄 רענן', 'a_home')]
    ])
  );
}
bot.hears(BTN.admin, (ctx) =>
  isAdmin(ctx) ? showAdminHome(ctx) : null
);
aAction('a_home', showAdminHome);

// ---------- הזמנות ----------
aAction(/^a_orders:(\w+):(\d+)$/, async (ctx) => {
  const filter = ctx.match[1];
  let list = Object.values(db.orders).sort(
    (a, b) => b.createdAt - a.createdAt
  );
  if (filter !== 'all') list = list.filter((o) => o.status === filter);
  const p = paginate(list, ctx.match[2], 8);
  const f = (key, label) =>
    Markup.button.callback(
      filter === key ? `• ${label}` : label,
      `a_orders:${key}:0`
    );
  const rows = [
    [
      f('all', 'הכל'),
      f('active', '⚡'),
      f('paused', '⏸'),
      f('completed', '✅'),
      f('cancelled', '❌')
    ],
    ...p.items.map((o) => {
      const u = db.users[o.userId];
      return [
        Markup.button.callback(
          `${ORDER_STATUS[o.status].split(' ')[0]} ${o.code} · ${
            o.delivered
          }/${o.subsCount} · ${u ? u.name.slice(0, 12) : o.userId}`,
          `a_order:${o.code}`
        )
      ];
    }),
    ...pager(`a_orders:${filter}`, p.page, p.pages).map((r) => r),
    backRow()
  ];
  await show(
    ctx,
    `📦 <b>כל ההזמנות בבוט</b> — ${list.length} תוצאות`,
    Markup.inlineKeyboard(rows)
  );
});

aAction(/^a_order:(ORD-\d+)$/, async (ctx) =>
  showOrder(ctx, ctx.match[1])
);

async function showOrder(ctx, code) {
  const o = db.orders[code];
  if (!o)
    return show(
      ctx,
      `⚠️ הזמנה לא נמצאה.`,
      Markup.inlineKeyboard([backRow('a_orders:all:0')])
    );
  const u = db.users[o.userId];
  const ch = db.channels.find((c) => c.id === o.channelId);
  const pct = Math.round((o.delivered / o.subsCount) * 100);
  const rows = [];
  if (o.status === 'active')
    rows.push([
      Markup.button.callback('⏸ השהה', `a_opause:${code}`)
    ]);
  if (o.status === 'paused')
    rows.push([
      Markup.button.callback('▶️ חדש', `a_opause:${code}`)
    ]);
  if (['active', 'paused'].includes(o.status))
    rows.push([
      Markup.button.callback(
        '❌ בטל + החזר יחסי',
        `a_ocancel:${code}:1`
      ),
      Markup.button.callback(
        '❌ בטל בלי החזר',
        `a_ocancel:${code}:0`
      )
    ]);
  rows.push([
    Markup.button.callback('👤 פרטי בעלים', `a_user:${o.userId}`),
    Markup.button.callback('💬 הודעה לבעלים', `a_msg:${o.userId}`)
  ]);
  rows.push(backRow('a_orders:all:0'));
  await show(
    ctx,
    `📦 <b>הזמנה ${code}</b>\n\n` +
      `📌 סטטוס: <b>${ORDER_STATUS[o.status]}</b>\n` +
      `📅 נוצרה: ${fmtDate(o.createdAt)}\n` +
      `${
        o.completedAt
          ? `🏁 הושלמה: ${fmtDate(o.completedAt)}\n`
          : ''
      }` +
      `${
        o.cancelledAt
          ? `🛑 בוטלה: ${fmtDate(o.cancelledAt)} (הוחזרו ${
              o.refunded || 0
            } 💎)\n`
          : ''
      }\n` +
      `👤 בעלים: ${u ? uLink(u) : o.userId} · <code>${
        o.userId
      }</code> · ${u ? uTag(u) : ''}\n` +
      `📢 ערוץ: <b>${escapeHtml(ch ? ch.name : '—')}</b>\n` +
      `🔗 ${ch ? escapeHtml(ch.link) : '—'}\n` +
      `🔍 אימות: ${
        ch && ch.verified ? '✅ אוטומטי' : '⚠️ ללא'
      }\n\n` +
      `${E.diamond} קרדיטים שהושקעו: <b>${o.creditsSpent}</b>\n` +
      `${E.sub} התקדמות: ${bar(
        o.delivered,
        o.subsCount
      )} <b>${o.delivered}/${o.subsCount}</b> (${pct}%)`,
    Markup.inlineKeyboard(rows)
  );
}
aAction(/^a_opause:(ORD-\d+)$/, async (ctx) => {
  const o = db.orders[ctx.match[1]];
  if (o && ['active', 'paused'].includes(o.status))
    o.status = o.status === 'active' ? 'paused' : 'active';
  await showOrder(ctx, ctx.match[1]);
});
aAction(/^a_ocancel:(ORD-\d+):(\d)$/, async (ctx) => {
  const o = db.orders[ctx.match[1]];
  if (!o) return;
  const refunded = cancelOrder(o, ctx.match[2] === '1');
  sendTo(
    o.userId,
    `❌ <b>ההזמנה ${o.code} בוטלה על ידי ההנהלה.</b>${
      refunded
        ? `\n${E.diamond} הוחזרו אליך <b>${refunded}</b> קרדיטים.`
        : ''
    }`
  ).catch(() => {});
  await showOrder(ctx, o.code);
});

// ---------- פניות תמיכה ----------
aAction(/^a_tickets:(\w+):(\d+)$/, async (ctx) => {
  const st = ctx.match[1];
  const list = db.tickets
    .filter((t) => t.status === st)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const p = paginate(list, ctx.match[2], 8);
  await show(
    ctx,
    `🎫 <b>פניות תמיכה — ${
      st === 'open' ? 'פתוחות' : 'סגורות'
    }</b> (${list.length})`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          st === 'open' ? '• 🟢 פתוחות' : '🟢 פתוחות',
          'a_tickets:open:0'
        ),
        Markup.button.callback(
          st === 'closed' ? '• ⚪ סגורות' : '⚪ סגורות',
          'a_tickets:closed:0'
        )
      ],
      ...p.items.map((t) => {
        const u = db.users[t.userId];
        return [
          Markup.button.callback(
            `#${t.id} · ${
              u ? u.name.slice(0, 14) : t.userId
            } · ${t.messages.length}💬`,
            `a_ticket:${t.id}`
          )
        ];
      }),
      ...pager(`a_tickets:${st}`, p.page, p.pages),
      backRow()
    ])
  );
});

async function showTicket(ctx, id) {
  const t = db.tickets.find((x) => x.id === Number(id));
  if (!t)
    return show(
      ctx,
      `⚠️ פנייה לא נמצאה.`,
      Markup.inlineKeyboard([backRow('a_tickets:open:0')])
    );
  const u = db.users[t.userId];
  const hist = t.messages
    .slice(-8)
    .map(
      (m) =>
        `${m.from === 'user' ? '👤' : '🛠'} <i>${fmtDate(
          m.ts
        )}</i>\n${escapeHtml(m.text.slice(0, 300))}`
    )
    .join('\n\n');
  const rows = [];
  rows.push(
    t.status === 'open'
      ? [
          Markup.button.callback(
            '💬 צ\'אט ישיר',
            `a_tchat:${t.id}`
          ),
          Markup.button.callback(
            '✅ סגור פנייה',
            `a_tclose:${t.id}`
          )
        ]
      : [
          Markup.button.callback(
            '🔓 פתח מחדש',
            `a_topen:${t.id}`
          )
        ]
  );
  rows.push([
    Markup.button.callback('👤 פרטי משתמש', `a_user:${t.userId}`)
  ]);
  rows.push(backRow('a_tickets:open:0'));
  await show(
    ctx,
    `🎫 <b>פנייה #${t.id}</b> — ${
      t.status === 'open' ? '🟢 פתוחה' : '⚪ סגורה'
    }\n` +
      `👤 ${u ? uLink(u) : t.userId} · <code>${t.userId}</code> · ${
        u ? uTag(u) : ''
      }\n` +
      `📅 נפתחה: ${fmtDate(t.createdAt)}\n\n${hist}`,
    Markup.inlineKeyboard(rows)
  );
}
aAction(/^a_ticket:(\d+)$/, (ctx) => showTicket(ctx, ctx.match[1]));

aAction(/^a_tchat:(\d+)$/, async (ctx) => {
  const t = db.tickets.find((x) => x.id === Number(ctx.match[1]));
  if (!t) return;
  const admin = db.users[ctx.from.id];
  admin.state = 'ADMIN_CHAT';
  admin.data = { ticketId: t.id };
  const u = db.users[t.userId];
  if (u) u.liveTicket = t.id;
  sendTo(
    t.userId,
    `🛠 <b>נציג תמיכה הצטרף לשיחה בפנייה #${t.id}.</b>\nאפשר לכתוב כאן ישירות.`
  ).catch(() => {});
  await html(
    ctx,
    `💬 <b>צ'אט ישיר פעיל — פנייה #${t.id}</b>\nמשתמש: ${
      u ? uLink(u) : t.userId
    }\n\nכל הודעה (טקסט/מדיה) שתשלח תועבר אליו. לסיום לחץ על הכפתור.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🚪 סיום צ\'אט', `a_tend:${t.id}`)]
    ])
  );
});
aAction(/^a_tend:(\d+)$/, async (ctx) => {
  const admin = db.users[ctx.from.id];
  admin.state = null;
  admin.data = {};
  await safeEdit(
    ctx,
    `🚪 <b>הצ'אט הסתיים.</b> הפנייה נשארת פתוחה עד לסגירה.`
  );
});
aAction(/^a_tclose:(\d+)$/, async (ctx) => {
  const t = db.tickets.find((x) => x.id === Number(ctx.match[1]));
  if (!t) return;
  t.status = 'closed';
  t.updatedAt = Date.now();
  const u = db.users[t.userId];
  if (u && u.liveTicket === t.id) u.liveTicket = null;
  sendTo(
    t.userId,
    `${E.check} <b>פנייה #${t.id} נסגרה.</b>\nתודה שפנית אלינו! לפתיחת פנייה חדשה: "🛠 תמיכה טכנית".`
  ).catch(() => {});
  await showTicket(ctx, t.id);
});
aAction(/^a_topen:(\d+)$/, async (ctx) => {
  const t = db.tickets.find((x) => x.id === Number(ctx.match[1]));
  if (t) {
    t.status = 'open';
    t.updatedAt = Date.now();
  }
  await showTicket(ctx, ctx.match[1]);
});

// ---------- משתמשים ----------
aAction(/^a_users:(\d+)$/, async (ctx) => {
  const list = Object.values(db.users).sort(
    (a, b) => b.joinedAt - a.joinedAt
  );
  const p = paginate(list, ctx.match[1], 8);
  await show(
    ctx,
    `👥 <b>משתמשים</b> — ${list.length}`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '🔎 חיפוש לפי ID / יוזר / שם',
          'a_usearch'
        )
      ],
      ...p.items.map((u) => [
        Markup.button.callback(
          `${u.banned ? '🚫' : '👤'} ${u.name.slice(0, 18)} · ${
            u.credits
          }💎`,
          `a_user:${u.id}`
        )
      ]),
      ...pager('a_users', p.page, p.pages),
      backRow()
    ])
  );
});
aAction('a_usearch', async (ctx) => {
  const a = db.users[ctx.from.id];
  a.state = 'USER_SEARCH';
  await html(
    ctx,
    `🔎 <b>שלח מזהה משתמש, @יוזר או חלק מהשם:</b>`
  );
});

async function showUserDetails(ctx, u) {
  const orders = userOrders(u.id);
  const openT = db.tickets.filter(
    (t) => t.userId === u.id && t.status === 'open'
  ).length;
  await show(
    ctx,
    `👤 <b>${uLink(u)}</b> ${
      u.banned ? '🚫 <b>חסום</b>' : ''
    }\n\n` +
      `🆔 <code>${u.id}</code> · ${uTag(u)}\n` +
      `${E.diamond} יתרה: <b>${u.credits}</b> · הרווחה: ${
        u.totalEarned || 0
      } · הושקעו: ${u.totalSpent || 0}\n` +
      `✅ הצטרפויות: <b>${u.completedCount}</b>\n` +
      `👥 הפניות: <b>${u.referrals || 0}</b>${
        u.referrer ? ` (הופנה ע"י <code>${u.referrer}</code>)` : ''
      }\n` +
      `📦 הזמנות: <b>${orders.length}</b> (פעילות: ${
        orders.filter((o) => o.status === 'active').length
      })\n` +
      `🎫 פניות פתוחות: <b>${openT}</b>\n` +
      `📅 הצטרף: ${fmtDate(u.joinedAt)}`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '➕➖ עדכן קרדיטים',
          `a_ucr:${u.id}`
        ),
        Markup.button.callback('🎁 שלח פרומו', `ps:${u.id}`)
      ],
      [
        Markup.button.callback(
          '💬 שלח הודעה',
          `a_msg:${u.id}`
        ),
        Markup.button.callback(
          u.banned ? '✅ שחרר חסימה' : '🚫 חסום',
          `a_ban:${u.id}`
        )
      ],
      backRow('a_users:0')
    ])
  );
}
aAction(/^a_user:(\d+)$/, async (ctx) => {
  const u = db.users[ctx.match[1]];
  if (!u) return show(ctx, `⚠️ משתמש לא נמצא.`);
  await showUserDetails(ctx, u);
});
aAction(/^a_ucr:(\d+)$/, async (ctx) => {
  const a = db.users[ctx.from.id];
  a.state = 'CREDIT_ADJ';
  a.data = { uid: Number(ctx.match[1]) };
  await html(
    ctx,
    `${E.diamond} <b>שלח כמות קרדיטים להוספה או הפחתה</b> (למשל <code>50</code> או <code>-20</code>):`
  );
});
aAction(/^a_msg:(\d+)$/, async (ctx) => {
  const a = db.users[ctx.from.id];
  a.state = 'ADMIN_MSG';
  a.data = { uid: Number(ctx.match[1]) };
  await html(ctx, `💬 <b>כתוב את ההודעה שתישלח למשתמש:</b>`);
});
aAction(/^a_ban:(\d+)$/, async (ctx) => {
  const u = db.users[ctx.match[1]];
  if (!u || ADMIN_IDS.has(u.id)) return;
  u.banned = !u.banned;
  await showUserDetails(ctx, u);
});

// ---------- פרומו מהאדמין ----------
aAction(/^ps:(\d+)$/, async (ctx) => {
  const uid = ctx.match[1];
  await html(
    ctx,
    `🎁 <b>שליחת פרומו קוד למשתמש</b> <code>${uid}</code>\nבחר כמות קרדיטים:`,
    Markup.inlineKeyboard([
      [5, 10, 25, 50].map((n) =>
        Markup.button.callback(`${n} 💎`, `psa:${uid}:${n}`)
      ),
      [
        Markup.button.callback('100 💎', `psa:${uid}:100`),
        Markup.button.callback('✍️ סכום אחר', `psc:${uid}`)
      ]
    ])
  );
});
aAction(/^psa:(\d+):(\d+)$/, async (ctx) => {
  await doSendPromo(
    ctx,
    Number(ctx.match[1]),
    Number(ctx.match[2])
  );
});
aAction(/^psc:(\d+)$/, async (ctx) => {
  const a = db.users[ctx.from.id];
  a.state = 'PROMO_AMOUNT';
  a.data = { uid: Number(ctx.match[1]) };
  await html(ctx, `✍️ <b>שלח את כמות הקרדיטים לפרומו:</b>`);
});
async function doSendPromo(ctx, uid, credits) {
  const target = db.users[uid];
  try {
    const code = await sendPromoToUser(uid, credits, ctx.from.id);
    await show(
      ctx,
      `${E.check} <b>נשלח פרומו קוד</b> <code>${code}</code> (${credits} ${E.diamond}) ל-${
        target ? uLink(target) : uid
      }`
    );
  } catch (e) {
    await show(
      ctx,
      `❌ לא ניתן לשלוח (המשתמש חסם את הבוט?): ${escapeHtml(
        e.description || e.message
      )}`
    );
  }
}

// ---------- Broadcast ----------
aAction('a_broadcast', async (ctx) => {
  const a = db.users[ctx.from.id];
  a.state = 'BROADCAST';
  await html(
    ctx,
    `📢 <b>שלח את הטקסט להפצה לכל המשתמשים.</b>\nאפשר להשתמש ב-HTML: <code>&lt;b&gt;מודגש&lt;/b&gt;</code>. תוצג תצוגה מקדימה לפני השליחה.`
  );
});
aAction('a_bc_no', async (ctx) => {
  db.users[ctx.from.id].data = {};
  await safeEdit(ctx, `❌ השליחה בוטלה.`);
});
aAction('a_bc_ok', async (ctx) => {
  const a = db.users[ctx.from.id];
  const text = a.data.broadcast;
  a.data = {};
  if (!text) return safeEdit(ctx, `⚠️ אין הודעה לשליחה.`);
  await safeEdit(ctx, `⌛ <b>שולח...</b> אעדכן בסיום.`);
  const chatId = ctx.chat.id;
  (async () => {
    let ok = 0,
      failed = 0;
    for (const u of Object.values(db.users)) {
      if (u.banned) continue;
      try {
        await sendTo(
          u.id,
          `📢 <b>הודעה רשמית מהנהלת המערכת:</b>\n\n${text}`
        );
        ok++;
      } catch (e) {
        failed++;
      }
      await sleep(50);
    }
    sendTo(
      chatId,
      `${E.check} <b>ההפצה הסתיימה.</b> נשלח: ${ok} · נכשל: ${failed}`
    ).catch(() => {});
  })();
});

// ---------- פרומו קודים (ניהול) ----------
aAction(/^a_promos:(\d+)$/, async (ctx) => {
  const list = Object.values(db.promos).sort(
    (a, b) => b.createdAt - a.createdAt
  );
  const p = paginate(list, ctx.match[1], 8);
  await show(
    ctx,
    `🎁 <b>קודי פרומו</b> — ${list.length}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ צור קוד כללי', 'a_pnew')],
      ...p.items.map((c) => [
        Markup.button.callback(
          `${c.active ? '🟢' : '🔴'} ${c.code} · ${c.credits}💎 · ${
            c.usedBy.length
          }/${c.maxUses}`,
          `a_promo:${c.code}`
        )
      ]),
      ...pager('a_promos', p.page, p.pages),
      backRow()
    ])
  );
});
aAction('a_pnew', async (ctx) => {
  db.users[ctx.from.id].state = 'PROMO_NEW';
  await html(
    ctx,
    `🎁 <b>יצירת קוד פרומו כללי</b>\nפורמט: <code>קרדיטים מקסימום_מימושים [קוד]</code>\nלדוגמה: <code>50 100 SUMMER</code> (בלי קוד — ייווצר אוטומטית)`
  );
});
async function showPromo(ctx, code) {
  const c = db.promos[code];
  if (!c)
    return show(
      ctx,
      `⚠️ קוד לא נמצא.`,
      Markup.inlineKeyboard([backRow('a_promos:0')])
    );
  await show(
    ctx,
    `🎁 <b>קוד פרומו:</b> <code>${c.code}</code>\n\n` +
      `${E.diamond} קרדיטים: <b>${c.credits}</b>\n` +
      `📊 מימושים: <b>${c.usedBy.length}/${c.maxUses}</b>\n` +
      `🎯 ייעודי למשתמש: ${
        c.userId ? `<code>${c.userId}</code>` : 'כללי'
      }\n` +
      `📌 סטטוס: ${c.active ? '🟢 פעיל' : '🔴 כבוי'}\n` +
      `📅 נוצר: ${fmtDate(c.createdAt)}`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          c.active ? '🔴 כבה' : '🟢 הפעל',
          `a_ptg:${c.code}`
        ),
        Markup.button.callback('🗑 מחק', `a_pdel:${c.code}`)
      ],
      backRow('a_promos:0')
    ])
  );
}
aAction(/^a_promo:([A-Z0-9_-]+)$/, (ctx) =>
  showPromo(ctx, ctx.match[1])
);
aAction(/^a_ptg:([A-Z0-9_-]+)$/, async (ctx) => {
  const c = db.promos[ctx.match[1]];
  if (c) c.active = !c.active;
  await showPromo(ctx, ctx.match[1]);
});
aAction(/^a_pdel:([A-Z0-9_-]+)$/, async (ctx) => {
  delete db.promos[ctx.match[1]];
  await show(
    ctx,
    `🗑 הקוד נמחק.`,
    Markup.inlineKeyboard([backRow('a_promos:0')])
  );
});

// ---------- מסלולי קרדיט ----------
async function showPlansAdmin(ctx) {
  const rows = S().plans.map((p) => [
    Markup.button.callback(
      `${p.active ? '🟢' : '🔴'} ${p.credits} 💎 ← ${p.subs} מנויים`,
      `a_plan:${p.id}`
    )
  ]);
  rows.push([
    Markup.button.callback('➕ הוסף מסלול', 'a_plan_new')
  ]);
  rows.push(backRow());
  await show(
    ctx,
    `💎 <b>מסלולי שימוש בקרדיט</b>\n\nאלו המסלולים שהמשתמשים רואים בעת קידום ערוץ.\nלחץ על מסלול לעריכה, או הוסף חדש (למשל מסלול עם בונוס).\n\n` +
      `<i>תגמול הצטרפות נקבע בהגדרות המערכת.</i>`,
    Markup.inlineKeyboard(rows)
  );
}
aAction('a_plans', showPlansAdmin);
aAction('a_plan_new', async (ctx) => {
  db.users[ctx.from.id].state = 'PLAN_NEW';
  await html(
    ctx,
    `➕ <b>מסלול חדש</b>\nשלח: <code>קרדיטים מנויים</code>\nלדוגמה <code>100 40</code> (100 קרדיטים ← 40 מנויים)`
  );
});
aAction(/^a_plan:(\d+)$/, async (ctx) => {
  const p = S().plans.find((x) => x.id === Number(ctx.match[1]));
  if (!p) return showPlansAdmin(ctx);
  await show(
    ctx,
    `💎 <b>מסלול:</b> ${p.credits} ← ${p.subs} מנויים\nסטטוס: ${
      p.active ? '🟢 פעיל' : '🔴 מוסתר'
    }\n<i>מחיר למנוי: ${(p.credits / p.subs).toFixed(2)} 💎</i>`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          p.active ? '🔴 הסתר' : '🟢 הצג',
          `a_plantg:${p.id}`
        ),
        Markup.button.callback('🗑 מחק', `a_plandel:${p.id}`)
      ],
      backRow('a_plans')
    ])
  );
});
aAction(/^a_plantg:(\d+)$/, async (ctx) => {
  const p = S().plans.find((x) => x.id === Number(ctx.match[1]));
  if (p) p.active = !p.active;
  await showPlansAdmin(ctx);
});
aAction(/^a_plandel:(\d+)$/, async (ctx) => {
  S().plans = S().plans.filter(
    (x) => x.id !== Number(ctx.match[1])
  );
  await showPlansAdmin(ctx);
});

// ---------- ערוצים וקלפים ----------
aAction(/^a_channels:(\d+)$/, async (ctx) => {
  const list = [...db.channels].sort(
    (a, b) => b.createdAt - a.createdAt
  );
  const p = paginate(list, ctx.match[1], 8);
  await show(
    ctx,
    `📡 <b>ערוצים וקלפים</b> — ${list.length}`,
    Markup.inlineKeyboard([
      ...p.items.map((c) => [
        Markup.button.callback(
          `${isLive(c) ? '🟢' : '⚪'}${c.verified ? '✅' : ''} ${c.name.slice(
            0,
            22
          )} · ${c.gained}`,
          `a_channel:${c.id}`
        )
      ]),
      ...pager('a_channels', p.page, p.pages),
      backRow()
    ])
  );
});
async function showChannel(ctx, id) {
  const c = db.channels.find((x) => x.id === Number(id));
  if (!c)
    return show(
      ctx,
      `⚠️ קלף לא נמצא.`,
      Markup.inlineKeyboard([backRow('a_channels:0')])
    );
  const o = db.users[c.ownerId];
  const ords = Object.values(db.orders).filter(
    (x) => x.channelId === c.id
  );
  await show(
    ctx,
    `📡 <b>${escapeHtml(c.name)}</b>\n🔗 ${escapeHtml(
      c.link
    )}\n\n` +
      `👤 בעלים: ${o ? uLink(o) : c.ownerId} · <code>${
        c.ownerId
      }</code>\n` +
      `🔍 אימות: ${c.verified ? '✅ אוטומטי' : '⚠️ ללא'}\n` +
      `📌 מצב: ${
        isLive(c) ? '🟢 חי' : '⚪ לא פעיל'
      }${c.disabled ? ' (נחסם ע"י אדמין)' : ''}\n` +
      `👥 מצטרפים שנספרו: <b>${c.gained}</b>\n📦 הזמנות: <b>${ords.length}</b>`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          c.disabled ? '▶️ הפעל חשיפה' : '⏸ עצור חשיפה',
          `a_chtg:${c.id}`
        ),
        Markup.button.callback(
          '🗑 מחק + החזר',
          `a_chdel:${c.id}`
        )
      ],
      [
        Markup.button.callback(
          '👤 פרטי בעלים',
          `a_user:${c.ownerId}`
        )
      ],
      backRow('a_channels:0')
    ])
  );
}
aAction(/^a_channel:(\d+)$/, (ctx) =>
  showChannel(ctx, ctx.match[1])
);
aAction(/^a_chtg:(\d+)$/, async (ctx) => {
  const c = db.channels.find((x) => x.id === Number(ctx.match[1]));
  if (c) c.disabled = !c.disabled;
  await showChannel(ctx, ctx.match[1]);
});
aAction(/^a_chdel:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  Object.values(db.orders)
    .filter((o) => o.channelId === id)
    .forEach((o) => {
      const r = cancelOrder(o, true);
      if (r)
        sendTo(
          o.userId,
          `❌ <b>הקלף הוסר על ידי ההנהלה.</b> הוחזרו אליך <b>${r}</b> ${E.diamond}`
        ).catch(() => {});
    });
  db.channels = db.channels.filter((c) => c.id !== id);
  await show(
    ctx,
    `🗑 הקלף הוסר והזמנות פעילות בוטלו עם החזר יחסי.`,
    Markup.inlineKeyboard([backRow('a_channels:0')])
  );
});

// ---------- ערוץ חובה ----------
aAction('a_sponsor', async (ctx) => {
  db.users[ctx.from.id].state = 'SPONSOR_SET';
  await html(
    ctx,
    `🛡️ <b>ערוץ חובה נוכחי:</b> ${
      sponsorEnabled()
        ? escapeHtml(S().sponsorChannel)
        : 'כבוי'
    }\n\nשלח יוזר חדש (למשל <code>@my_channel</code>) או <code>off</code> לכיבוי.\n⚠️ הבוט חייב להיות אדמין בערוץ.`
  );
});

// ---------- הגדרות מערכת ----------
const NUM_SETTINGS = {
  rewardPerJoin: '💎 תגמול הצטרפות (מאומת)',
  unverifiedReward: '⚠️ תגמול הצטרפות (ללא אימות)',
  welcomeBonus: '🎉 בונוס הצטרפות',
  referralBonus: '👥 בונוס הפניה',
  dailyBonus: '🎁 בונוס יומי',
  sponsorEvery: '🛡️ אימות ספונסר כל X פעולות',
  sponsorReward: '🎁 תגמול אימות ספונסר',
  cardCreationCost: '💰 עלות יצירת קלף'   // ← חדש
};
async function showSettings(ctx) {
  const s = S();
  const rows = Object.entries(NUM_SETTINGS).map(([k, label]) => [
    Markup.button.callback(`${label}: ${s[k]}`, `a_set:${k}`)
  ]);
  rows.push([
    Markup.button.callback(
      `🔐 חובת אדמין בערוצים: ${
        s.requireBotAdmin ? 'פעיל 🟢' : 'כבוי 🔴'
      }`,
      'a_tg:requireBotAdmin'
    )
  ]);
  rows.push([
    Markup.button.callback(
      `🛠 מצב תחזוקה: ${
        s.maintenance ? 'פעיל 🟢' : 'כבוי 🔴'
      }`,
      'a_tg:maintenance'
    )
  ]);
  rows.push(backRow());
  await show(
    ctx,
    `⚙️ <b>הגדרות מערכת</b>\n\nלחץ על הגדרה כדי לשנות אותה.\n<i>חובת אדמין: כשפעיל, אי אפשר לרשום ערוץ שהבוט אינו אדמין בו.</i>`,
    Markup.inlineKeyboard(rows)
  );
}
aAction('a_settings', showSettings);
aAction(/^a_set:(\w+)$/, async (ctx) => {
  const k = ctx.match[1];
  if (!NUM_SETTINGS[k]) return;
  const a = db.users[ctx.from.id];
  a.state = 'SETTING';
  a.data = { key: k };
  await html(
    ctx,
    `✍️ <b>${NUM_SETTINGS[k]}</b>\nערך נוכחי: <b>${S()[k]}</b>\nשלח ערך חדש (מספר שלם):`
  );
});
aAction(
  /^a_tg:(requireBotAdmin|maintenance)$/,
  async (ctx) => {
    S()[ctx.match[1]] = !S()[ctx.match[1]];
    await showSettings(ctx);
  }
);

// ---------- גיבוי ושחזור ----------
aAction('a_backup_menu', async (ctx) => {
  await show(
    ctx,
    `💾 <b>גיבוי ושחזור</b>\n\nהנתונים נשמרים לקובץ בשרת, אך ב-Render (חינמי) הקובץ נמחק בכל הפעלה מחדש. לכן הבוט שולח לך גיבוי אוטומטי כל <b>${AUTO_BACKUP_HOURS}</b> שעות, ואפשר לשחזר ממנו כאן.`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '📥 הורד גיבוי עכשיו',
          'a_backup'
        )
      ],
      [
        Markup.button.callback(
          '📤 שחזר מקובץ גיבוי',
          'a_restore'
        )
      ],
      backRow()
    ])
  );
});
const backupDoc = () => ({
  source: Buffer.from(JSON.stringify(db, null, 2)),
  filename: `memberflow-backup-${new Date()
    .toISOString()
    .slice(0, 16)
    .replace(/[:T]/g, '-')}.json`
});
aAction('a_backup', async (ctx) => {
  saveDb();
  await ctx.replyWithDocument(backupDoc(), {
    caption: '💾 גיבוי MemberFlow'
  });
});
aAction('a_restore', async (ctx) => {
  db.users[ctx.from.id].state = 'RESTORE';
  await html(
    ctx,
    `📤 <b>שלח כעת קובץ גיבוי (.json)</b> כמסמך.\n⚠️ השחזור יחליף את כל הנתונים הנוכחיים!`
  );
});
setInterval(async () => {
  for (const id of ADMIN_IDS) {
    try {
      await bot.telegram.sendDocument(id, backupDoc(), {
        caption: '💾 גיבוי אוטומטי — MemberFlow'
      });
    } catch (e) {
      /* ignore */
    }
  }
}, AUTO_BACKUP_HOURS * 3600 * 1000);

// ==========================================
//        הודעה לא מזוהה (חייב להיות אחרון)
// ==========================================
bot.on('text', (ctx) =>
  html(
    ctx,
    `🤔 <b>לא הבנתי את הבקשה.</b>\nבחר אפשרות מהתפריט למטה ${E.flash}`,
    getMainMenuKeyboard(ctx.from.id)
  )
);

bot.catch((err, ctx) => {
  console.error(
    `Unhandled error (${ctx.updateType}):`,
    err.description || err.message
  );
});

// ==========================================
//        פרופיל הבוט (תיאור) + הרצה
// ==========================================
const BOT_DESCRIPTION =
  '⚡ MemberFlow — המערכת הרשמית להוספת מנויים וחשיפה\n\n' +
  'הדרך המהירה והמסודרת להגדיל את הערוץ או הקבוצה שלך, ולהרוויח תוך כדי.\n\n' +
  '💎 הרוויחו קרדיטים חינם על הצטרפות לערוצים\n' +
  '👑 השקיעו קרדיטים וקבלו מנויים לערוץ שלכם\n' +
  '📊 עקבו אחר ההזמנות שלכם בכל רגע\n' +
  '🛡️ אימות הצטרפות אוטומטי ושקוף\n\n' +
  'לחצו START והתחילו לצמוח ✨';
const BOT_SHORT_DESCRIPTION =
  'MemberFlow ⚡ המערכת הרשמית להוספת מנויים וחשיפה לערוצים וקבוצות';

async function setupBotProfile() {
  try {
    for (const language_code of [undefined, 'he']) {
      const extra = language_code ? { language_code } : {};
      await bot.telegram.callApi('setMyDescription', {
        description: BOT_DESCRIPTION,
        ...extra
      });
      await bot.telegram.callApi('setMyShortDescription', {
        short_description: BOT_SHORT_DESCRIPTION,
        ...extra
      });
    }
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'התחלה / תפריט ראשי' },
      { command: 'cancel', description: 'ביטול פעולה' }
    ]);
    console.log('✅ Bot profile updated');
  } catch (e) {
    console.error(
      'Profile setup failed:',
      e.description || e.message
    );
  }
}

const PORT = process.env.PORT || 3000;
app.get('/', (req, res) =>
  res.send(`MemberFlow Bot Engine v${VERSION} Running...`)
);

app.listen(PORT, async () => {
  console.log(`🚀 Web Service running on port ${PORT}`);
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username;
    BOT_ID = me.id;
  } catch (e) {
    console.error('getMe failed:', e.message);
    process.exit(1);
  }
  await setupBotProfile();
  bot.launch({ dropPendingUpdates: true }).catch((e) => {
    console.error('Bot launch failed:', e.message);
    process.exit(1);
  });
  console.log(`🤖 Telegram bot launched — MemberFlow v${VERSION}`);
});

const shutdown = (sig) => {
  saveDb();
  bot.stop(sig);
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
