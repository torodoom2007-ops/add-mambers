const { Telegraf, Markup } = require('telegraf');
const express = require('express');
require('dotenv').config();

// ==========================================
//                 הגדרות
// ==========================================
const token = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID) || 8017590244; // מזהה האדמין הראשי
const CREDITS_PER_SUB = 3;     // כמה קרדיטים עולה מנוי אחד
const REWARD_PER_JOIN = 3;     // כמה קרדיטים מקבל משתמש על הצטרפות
const SPONSOR_EVERY = 5;       // כל כמה פעולות נדרש אימות ערוץ ספונסר
const DEFAULT_SPONSOR = '@your_sponsor_channel';

if (!token) {
  console.error('❌ BOT_TOKEN is missing in environment variables!');
  process.exit(1);
}

const bot = new Telegraf(token);
const app = express();
app.use(express.json());

// --- מסד נתונים בזיכרון (מתאפס בכל הפעלה מחדש! מומלץ לחבר ל-Supabase/MongoDB) ---
const db = {
  users: {},    // { userId: { credits, completedCount, sponsorCompleted, state, claimed:[], busy, notified } }
  channels: [], // [ { id, name, link, chatRef, ownerId, approved, active, targetSubs, gained, orderCode } ]
  orders: {},   // { orderCode: { userId, channelId, creditsSpent, subsCount, delivered, status, date } }
  settings: {
    sponsorChannel: process.env.SPONSOR_CHANNEL || DEFAULT_SPONSOR
  }
};
let channelCounter = 1;

// --- אימוג'י פרימיום לגוף ההודעות בלבד (לא עובד בכפתורים!) ---
const E = {
  flash: '<tg-emoji emoji-id="5780782082108167841">⚡</tg-emoji>',
  diamond: '<tg-emoji emoji-id="5271998448042785916">💎</tg-emoji>',
  check: '<tg-emoji emoji-id="5269470868379026531">✅</tg-emoji>',
  next: '<tg-emoji emoji-id="5460991276948143687">▶️</tg-emoji>',
  sub: '<tg-emoji emoji-id="6231225487469842472">👑</tg-emoji>',
  confirm: '<tg-emoji emoji-id="6231018663319704664">🛡️</tg-emoji>',
  orders: '<tg-emoji emoji-id="5431499171045581032">📊</tg-emoji>',
  userCard: '🪪'
};

const BTN = {
  earn: '💎 הרווח קרדיטים חינם',
  add: '⚡ MemberFlow | הוספת מנויים',
  orders: '📊 ההזמנות שלי',
  help: '❓ עזרה והסברים',
  admin: '⚙️ פאנל ניהול אדמין'
};

// ==========================================
//                 פונקציות עזר
// ==========================================
const isAdmin = (ctx) => ctx.from && ctx.from.id === ADMIN_ID;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const escapeHtml = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// תו RLM בתחילת כל שורה מתקן סימני פיסוק וערבוב עברית/אנגלית
const RLM = '\u200f';
const rtl = (t) => t.split('\n').map((l) => (l.trim() ? RLM + l : l)).join('\n');

// שליחת הודעה — תמיד עם parse_mode HTML
const html = (ctx, text, kb) =>
  ctx.reply(rtl(text), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(kb || {})
  });

// עריכת הודעה — תמיד עם parse_mode HTML (זה היה הבאג שהציג תגיות גולמיות)
const safeEdit = async (ctx, text, kb) => {
  try {
    await ctx.editMessageText(rtl(text), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(kb || {})
    });
  } catch (e) {
    const msg = e.description || e.message || '';
    if (!msg.includes('message is not modified')) console.error('Edit error:', msg);
  }
};

const respond = (ctx, text, kb, edit) => (edit ? safeEdit(ctx, text, kb) : html(ctx, text, kb));

const ensureUser = (userId) => {
  if (!db.users[userId]) {
    db.users[userId] = {
      credits: 10, // בונוס הצטרפות
      completedCount: 0,
      sponsorCompleted: false,
      state: null,
      claimed: [],
      busy: false,
      notified: false
    };
  }
  return db.users[userId];
};

let cachedBotId = null;
const getBotId = async () => {
  if (!cachedBotId) cachedBotId = (await bot.telegram.getMe()).id;
  return cachedBotId;
};

const normChannel = (s) =>
  '@' + String(s).trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
const sponsorEnabled = () => db.settings.sponsorChannel !== DEFAULT_SPONSOR;
const sponsorLink = () => `https://t.me/${db.settings.sponsorChannel.replace('@', '')}`;
const isMemberStatus = (s) => ['member', 'creator', 'administrator'].includes(s);

const getMainMenuKeyboard = (userId) => {
  const buttons = [
    [BTN.earn, BTN.add],
    [BTN.orders, BTN.help]
  ];
  if (userId === ADMIN_ID) buttons.push([BTN.admin]);
  return Markup.keyboard(buttons).resize();
};

// ==========================================
//     Middleware: יצירת משתמש + איפוס מצב בלחיצה על תפריט
// ==========================================
bot.use(async (ctx, next) => {
  if (ctx.from) {
    const user = ensureUser(ctx.from.id);
    const text = ctx.message && ctx.message.text;
    if (text && (Object.values(BTN).includes(text) || text.startsWith('/'))) {
      user.state = null;
    }
  }
  return next();
});

// ==========================================
//              פקודת התחלה (/start)
// ==========================================
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const firstName = escapeHtml(ctx.from.first_name || 'משתמש יקר');
  const username = ctx.from.username ? `@${escapeHtml(ctx.from.username)}` : 'ללא';
  const user = ensureUser(userId);

  if (!user.notified) {
    user.notified = true;
    try {
      await bot.telegram.sendMessage(
        ADMIN_ID,
        rtl(
          `${E.userCard} <b>משתמש חדש נרשם למערכת!</b>\n\n` +
          `👤 שם: ${firstName}\n` +
          `🆔 מזהה: <code>${userId}</code>\n` +
          `🔗 יוזר: ${username}\n` +
          `📅 תאריך: ${new Date().toLocaleString('he-IL')}`
        ),
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('Failed to notify admin:', e.message);
    }
  }

  const welcomeText =
    `<b>ברוכים הבאים למערכת הרשמית — MemberFlow ${E.flash} | הוספת מנויים וחשיפה</b>\n\n` +
    `מערכת מתקדמת להרחבת קהלים, ניהול מנויים והפצת ערוצים ברמת אמינות גבוהה ${E.confirm}\n\n` +
    `👤 <b>כרטיס משתמש אישי:</b>\n` +
    `• שם: ${firstName}\n` +
    `• מזהה מערכת: <code>${userId}</code>\n` +
    `• יתרת קרדיטים: <b>${user.credits}</b> ${E.diamond}\n\n` +
    `<i>בחר באחת האפשרויות בתפריט למטה כדי להתחיל:</i>`;

  await html(ctx, welcomeText, getMainMenuKeyboard(userId));
});

// ==========================================
//           רווח קרדיטים חינם
// ==========================================
async function showEarnCard(ctx, edit = false) {
  const userId = ctx.from.id;
  const user = ensureUser(userId);

  // משימת חובה כל SPONSOR_EVERY פעולות
  if (
    sponsorEnabled() &&
    user.completedCount > 0 &&
    user.completedCount % SPONSOR_EVERY === 0 &&
    !user.sponsorCompleted
  ) {
    return respond(
      ctx,
      `<b>${E.confirm} אימות ביטחון תקופתי (חובה)</b> ${E.flash}\n\n` +
      `ביצעת <b>${user.completedCount}</b> פעולות בהצלחה! כדי להמשיך להרוויח, עליך להצטרף לערוץ הרשמי של המערכת.\n\n` +
      `🎁 תגמול אימות: <b>1 ${E.diamond}</b> מתנה ${E.next}`,
      Markup.inlineKeyboard([
        [Markup.button.url('⚡ הצטרף לערוץ הרשמי', sponsorLink())],
        [Markup.button.callback('✅ אמת הצטרפות וקבל קרדיט', 'verify_sponsor')]
      ]),
      edit
    );
  }

  // קלפים זמינים: פעילים, לא של המשתמש, ושעוד לא קיבל עליהם קרדיטים
  const available = db.channels.filter(
    (c) => c.active && c.ownerId !== userId && !user.claimed.includes(c.id)
  );

  if (available.length === 0) {
    return respond(
      ctx,
      `⚠️ <b>אין כרגע קלפי חשיפה זמינים במאגר.</b>\n` +
      `אנא חזור מאוחר יותר או פרסם ערוץ משלך דרך התפריט!`,
      Markup.inlineKeyboard([[Markup.button.callback('🔄 רענן', 'next_card')]]),
      edit
    );
  }

  const target = available[Math.floor(Math.random() * available.length)];

  await respond(
    ctx,
    `🪪 <b>קלף חשיפה מנוהל ${E.flash}</b>\n\n` +
    `📢 ערוץ / קבוצה: <b>${escapeHtml(target.name)}</b>\n` +
    `🎯 משימה: הצטרפות כחבר קהילה פעיל\n\n` +
    `🎁 תגמול הצטרפות: <b>${REWARD_PER_JOIN} ${E.diamond}</b>`,
    Markup.inlineKeyboard([
      [Markup.button.url('🔗 מעבר לערוץ המבוקש', target.link)],
      [Markup.button.callback(`קבל ${REWARD_PER_JOIN} קרדיטים 💎`, `claim_${target.id}`)],
      [Markup.button.callback('⏭ דלג לקלף הבא', 'next_card')]
    ]),
    edit
  );
}

bot.hears(BTN.earn, (ctx) => showEarnCard(ctx, false));

bot.action('next_card', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showEarnCard(ctx, true);
});

// אימות הצטרפות + דימוי טעינה
bot.action(/^claim_(\d+)$/, async (ctx) => {
  const channelId = Number(ctx.match[1]);
  const userId = ctx.from.id;
  const user = ensureUser(userId);
  const channel = db.channels.find((c) => c.id === channelId);

  if (!channel || !channel.active) {
    return ctx.answerCbQuery('⚠️ קלף זה כבר אינו זמין.', { show_alert: true });
  }
  if (user.claimed.includes(channelId)) {
    return ctx.answerCbQuery('כבר קיבלת קרדיטים על ערוץ זה.', { show_alert: true });
  }
  if (user.busy) return ctx.answerCbQuery('⏳ בדיקה כבר מתבצעת...');

  user.busy = true;
  await ctx.answerCbQuery().catch(() => {});

  const retryKb = Markup.inlineKeyboard([
    [Markup.button.url('🔗 מעבר לערוץ', channel.link)],
    [Markup.button.callback('נסה לאמת שוב ⚡', `claim_${channel.id}`)],
    [Markup.button.callback('⏭ דלג לקלף הבא', 'next_card')]
  ]);

  try {
    await safeEdit(ctx, `⌛ <b>בודק חברות בערוץ...</b>`);
    await sleep(600);
    await safeEdit(ctx, `🔄 <b>מאמת נתונים מול שרתי טלגרם...</b>`);
    await sleep(600);

    const chatMember = await bot.telegram.getChatMember(channel.chatRef, userId);

    if (!isMemberStatus(chatMember.status)) {
      await safeEdit(
        ctx,
        `❌ <b>אימות נכשל!</b>\n\n` +
        `לא זוהתה הצטרפות בערוץ <b>${escapeHtml(channel.name)}</b>.\n` +
        `אנא הצטרף לערוץ ולחץ שוב על כפתור האימות.`,
        retryKb
      );
      return;
    }

    // בדיקה חוזרת למניעת race condition
    if (!channel.active || user.claimed.includes(channelId)) return;

    user.credits += REWARD_PER_JOIN;
    user.completedCount += 1;
    user.sponsorCompleted = false;
    user.claimed.push(channelId);

    // עדכון התקדמות הזמנה
    channel.gained += 1;
    const order = db.orders[channel.orderCode];
    if (order) order.delivered = channel.gained;
    if (channel.gained >= channel.targetSubs) {
      channel.active = false;
      if (order) order.status = '✅ הושלם';
    }

    await safeEdit(
      ctx,
      `${E.check} <b>הפעולה אושרה בהצלחה!</b> ${E.flash}\n\n` +
      `התקבלו <b>${REWARD_PER_JOIN} ${E.diamond}</b> לחשבונך האישי.\n` +
      `יתרה מעודכנת: <b>${user.credits} ${E.diamond}</b>`,
      Markup.inlineKeyboard([[Markup.button.callback('המשך לקלף הבא ▶️', 'next_card')]])
    );
  } catch (err) {
    console.error('Verification error:', err.description || err.message);
    await safeEdit(
      ctx,
      `⚠️ <b>שגיאה בביצוע האימות.</b>\n` +
      `ייתכן שהבוט אינו מוגדר כאדמין בערוץ, או שהערוץ אינו זמין. נסה שוב או דלג לקלף הבא.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('נסה שוב ⚡', `claim_${channel.id}`)],
        [Markup.button.callback('⏭ קלף הבא', 'next_card')]
      ])
    );
  } finally {
    user.busy = false;
  }
});

// אימות ערוץ הספונסר
bot.action('verify_sponsor', async (ctx) => {
  const userId = ctx.from.id;
  const user = ensureUser(userId);
  await ctx.answerCbQuery().catch(() => {});

  try {
    await safeEdit(ctx, `⌛ <b>מאמת הצטרפות לערוץ הרשמי...</b>`);
    await sleep(800);

    const member = await bot.telegram.getChatMember(db.settings.sponsorChannel, userId);
    if (isMemberStatus(member.status)) {
      if (!user.sponsorCompleted) {
        user.sponsorCompleted = true;
        user.credits += 1;
      }
      await safeEdit(
        ctx,
        `${E.check} <b>האימות הושלם בהצלחה!</b> ${E.flash}\n\n` +
        `קיבלת <b>1 ${E.diamond}</b> במתנה. תוכל להמשיך להרוויח קרדיטים בחופשיות!`,
        Markup.inlineKeyboard([[Markup.button.callback('המשך ▶️', 'next_card')]])
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
    console.error('Sponsor verify error:', e.description || e.message);
    await safeEdit(
      ctx,
      `⚠️ <b>לא ניתן לאמת כרגע.</b>\nנסה שוב בעוד רגע.`,
      Markup.inlineKeyboard([[Markup.button.callback('אמת שוב', 'verify_sponsor')]])
    );
  }
});

// ==========================================
//     הוספת מנויים / פרסום ערוץ
// ==========================================
bot.hears(BTN.add, async (ctx) => {
  ensureUser(ctx.from.id).state = 'WAITING_FOR_CHANNEL_INFO';

  await html(
    ctx,
    `🪪 <b>יצירת קלף משתמש לקידום וחשיפה ${E.flash}</b>\n\n` +
    `כדי להוסיף את הערוץ/קבוצה שלך למאגר, שלח כעת את <b>השם והקישור הישיר</b> בפורמט הבא:\n\n` +
    `<code>שם הערוץ | https://t.me/your_channel</code>\n\n` +
    `⚠️ הערוץ חייב להיות ציבורי, והבוט חייב להיות מוגדר בו כאדמין (נדרש לאימות מצטרפים).`
  );
});

// קליטת הודעות טקסט (יצירת קלף + פעולות אדמין)
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  const user = ensureUser(userId);
  const text = ctx.message.text.trim();

  // --- יצירת קלף ---
  if (user.state === 'WAITING_FOR_CHANNEL_INFO') {
    const sep = text.indexOf('|');
    if (sep === -1) {
      return html(ctx, `❌ <b>פורמט שגוי.</b> אנא שלח בצורה: <code>שם | קישור</code>`);
    }

    const name = text.slice(0, sep).trim().slice(0, 64);
    const link = text.slice(sep + 1).trim();
    const match = link.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i);

    if (!name || !match) {
      return html(
        ctx,
        `❌ <b>שם או קישור לא תקינים.</b>\n` +
        `נדרש קישור ציבורי בפורמט <code>https://t.me/username</code> (קישורי הזמנה פרטיים עם + אינם נתמכים).`
      );
    }

    const chatRef = `@${match[1]}`;
    const fullLink = `https://t.me/${match[1]}`;

    // בדיקה שהבוט אדמין בערוץ
    try {
      const botMember = await bot.telegram.getChatMember(chatRef, await getBotId());
      if (!['administrator', 'creator'].includes(botMember.status)) throw new Error('not admin');
    } catch (e) {
      return html(
        ctx,
        `❌ <b>לא הצלחתי לאמת את הערוץ.</b>\n` +
        `ודא שהערוץ קיים וציבורי, ושהוספת את הבוט כאדמין בו, ואז שלח שוב.`
      );
    }

    const cardId = channelCounter++;
    db.channels.push({
      id: cardId,
      name,
      link: fullLink,
      chatRef,
      ownerId: userId,
      approved: false, // ממתין לאישור
      active: false,   // יופעל רק אחרי השקעת קרדיטים
      targetSubs: 0,
      gained: 0,
      orderCode: null
    });

    user.state = null;

    return html(
      ctx,
      `🪪 <b>תצוגה מקדימה לקלף הקידום שלך:</b>\n\n` +
      `• שם: <b>${escapeHtml(name)}</b>\n` +
      `• קישור: ${escapeHtml(fullLink)}\n\n` +
      `מאשר להוסיף את הקלף למערכת הרשמית? ${E.confirm}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ אישור והוספה', `approve_card_${cardId}`)],
        [Markup.button.callback('❌ ביטול', `cancel_card_${cardId}`)]
      ])
    );
  }

  // --- אדמין: Broadcast ---
  if (isAdmin(ctx) && user.state === 'WAITING_FOR_BROADCAST') {
    user.state = null;
    await html(ctx, `⌛ <b>שולח הודעה...</b>`);
    let ok = 0;
    let failed = 0;
    for (const uid of Object.keys(db.users)) {
      try {
        await bot.telegram.sendMessage(
          uid,
          rtl(`📢 <b>הודעה רשמית מהנהלת המערכת:</b>\n\n${escapeHtml(text)}`),
          { parse_mode: 'HTML' }
        );
        ok++;
      } catch (e) {
        failed++;
      }
      await sleep(50); // הגבלת קצב נגד FloodWait
    }
    return html(ctx, `${E.check} ההודעה נשלחה ל-<b>${ok}</b> משתמשים (נכשלו: ${failed}).`);
  }

  // --- אדמין: עדכון קרדיטים ---
  if (isAdmin(ctx) && user.state === 'WAITING_FOR_CREDIT_SET') {
    user.state = null;
    const [targetId, amountRaw] = text.split(/\s+/);
    const amount = parseInt(amountRaw, 10);
    if (!db.users[targetId] || Number.isNaN(amount)) {
      return html(ctx, `❌ משתמש לא נמצא או כמות לא תקינה. פורמט: <code>USER_ID AMOUNT</code>`);
    }
    db.users[targetId].credits = Math.max(0, db.users[targetId].credits + amount);
    return html(
      ctx,
      `${E.check} עודכנו <b>${amount}</b> קרדיטים למשתמש <code>${escapeHtml(targetId)}</code>\n` +
      `יתרה חדשה: <b>${db.users[targetId].credits}</b>`
    );
  }

  // --- אדמין: ערוץ חובה ---
  if (isAdmin(ctx) && user.state === 'WAITING_FOR_SPONSOR_SET') {
    user.state = null;
    db.settings.sponsorChannel = normChannel(text);
    return html(ctx, `${E.check} ערוץ החובה עודכן ל-<b>${escapeHtml(db.settings.sponsorChannel)}</b>`);
  }

  return next();
});

bot.action(/^cancel_card_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const cardId = Number(ctx.match[1]);
  const idx = db.channels.findIndex((c) => c.id === cardId && c.ownerId === ctx.from.id && !c.approved);
  if (idx !== -1) db.channels.splice(idx, 1);
  await safeEdit(ctx, `❌ יצירת הקלף בוטלה.`);
});

// אישור קלף ובחירת השקעת קרדיטים
bot.action(/^approve_card_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const cardId = Number(ctx.match[1]);
  const channel = db.channels.find((c) => c.id === cardId && c.ownerId === ctx.from.id);

  if (!channel) return safeEdit(ctx, `⚠️ הקלף לא נמצא.`);
  channel.approved = true;

  await safeEdit(
    ctx,
    `${E.check} <b>הקלף אושר ונוסף למאגר!</b> ${E.flash}\n\n` +
    `בחר כמה קרדיטים להשקיע בקידום הערוץ:\n` +
    `<i>(יחס המרה: ${CREDITS_PER_SUB * 10} קרדיטים = 10 מנויים)</i>`,
    Markup.inlineKeyboard([
      [Markup.button.callback('30 💎 ← 10 מנויים', `add_credits_${cardId}_30`)],
      [Markup.button.callback('60 💎 ← 20 מנויים', `add_credits_${cardId}_60`)],
      [Markup.button.callback('💾 שמור בלי קידום', `add_credits_${cardId}_0`)]
    ])
  );
});

bot.action(/^add_credits_(\d+)_(\d+)$/, async (ctx) => {
  const cardId = Number(ctx.match[1]);
  const amount = parseInt(ctx.match[2], 10);
  const userId = ctx.from.id;
  const user = ensureUser(userId);
  const channel = db.channels.find((c) => c.id === cardId && c.ownerId === userId);

  if (!channel || !channel.approved) {
    return ctx.answerCbQuery('⚠️ הקלף לא נמצא.', { show_alert: true });
  }
  if (channel.orderCode) {
    return ctx.answerCbQuery('הקלף כבר הופעל.', { show_alert: true });
  }

  if (amount === 0) {
    await ctx.answerCbQuery().catch(() => {});
    return safeEdit(
      ctx,
      `💾 <b>הקלף נשמר בלי קידום.</b>\nתוכל להפעיל קידום בכל עת דרך "MemberFlow | הוספת מנויים".`
    );
  }

  if (user.credits < amount) {
    return ctx.answerCbQuery('❌ אין לך מספיק קרדיטים בחשבון!', { show_alert: true });
  }
  await ctx.answerCbQuery().catch(() => {});

  user.credits -= amount;

  let orderCode;
  do {
    orderCode = 'ORD-' + Math.floor(100000 + Math.random() * 900000);
  } while (db.orders[orderCode]);

  const subs = Math.floor(amount / CREDITS_PER_SUB);

  db.orders[orderCode] = {
    userId,
    channelId: cardId,
    creditsSpent: amount,
    subsCount: subs,
    delivered: 0,
    status: '⚡ פעיל ומקבל מנויים',
    date: new Date().toLocaleDateString('he-IL')
  };

  channel.orderCode = orderCode;
  channel.targetSubs = subs;
  channel.gained = 0;
  channel.active = true;

  await safeEdit(
    ctx,
    `✨ <b>ההזמנה נוצרה והופעלה בהצלחה!</b> ${E.flash}\n\n` +
    `📊 קוד הזמנה: <code>${orderCode}</code>\n` +
    `💎 קרדיטים הושקעו: <b>${amount}</b>\n` +
    `👑 מנויים מתוכננים: <b>${subs}</b>\n` +
    `📌 סטטוס: <b>פעיל במערכת</b>\n\n` +
    `<i>תוכל לעקוב אחר הסטטוס בכל עת דרך כפתור "ההזמנות שלי".</i>`
  );
});

// ==========================================
//              ההזמנות שלי
// ==========================================
bot.hears(BTN.orders, async (ctx) => {
  const userId = ctx.from.id;
  const userOrders = Object.entries(db.orders).filter(([, o]) => o.userId === userId);

  if (userOrders.length === 0) {
    return html(ctx, `📋 <b>אין לך הזמנות פעילות כרגע במערכת.</b>`);
  }

  let text = `${E.orders} <b>ההזמנות שלך במערכת MemberFlow:</b> ${E.flash}\n\n`;
  userOrders.forEach(([code, o]) => {
    const ch = db.channels.find((c) => c.id === o.channelId);
    text +=
      `• קוד: <code>${code}</code>\n` +
      `  ערוץ: ${escapeHtml(ch ? ch.name : '—')}\n` +
      `  התקדמות: <b>${o.delivered}/${o.subsCount}</b> | סטטוס: ${o.status}\n\n`;
  });

  await html(ctx, text);
});

// ==========================================
//             עזרה והסברים
// ==========================================
bot.hears(BTN.help, async (ctx) => {
  await html(
    ctx,
    `📖 <b>מדריך שימוש רשמי — MemberFlow ${E.flash}</b>\n\n` +
    `1️⃣ <b>רווח קרדיטים:</b> לחץ על "הרווח קרדיטים חינם", הצטרף לערוצים המוצגים ואשר את ההצטרפות לקבלת קרדיטים ${E.diamond}\n\n` +
    `2️⃣ <b>הוספת מנויים:</b> לחץ על "MemberFlow | הוספת מנויים", הכנס את הפרטים והשקע קרדיטים לקבלת חברים לערוץ שלך ${E.sub}\n\n` +
    `3️⃣ <b>אימות ביטחון:</b> כל ${SPONSOR_EVERY} פעולות יש לאשר חברות בערוץ הרשמי לקבלת בונוס והמשך עבודה ${E.confirm}`
  );
});

// ==========================================
//       פאנל ניהול אדמין
// ==========================================
bot.hears(BTN.admin, async (ctx) => {
  if (!isAdmin(ctx)) return;

  const adminText =
    `⚙️ <b>פאנל שליטה וניהול אדמין — MemberFlow</b> ${E.flash}\n\n` +
    `${E.orders} <b>סטטיסטיקות מערכת:</b>\n` +
    `• סה"כ משתמשים: <b>${Object.keys(db.users).length}</b>\n` +
    `• ערוצים במאגר: <b>${db.channels.length}</b> (פעילים: ${db.channels.filter((c) => c.active).length})\n` +
    `• סה"כ הזמנות: <b>${Object.keys(db.orders).length}</b>\n` +
    `• ערוץ חובה נוכחי: <b>${escapeHtml(db.settings.sponsorChannel)}</b>\n\n` +
    `<i>בחר פעולת ניהול מבוקשת:</i>`;

  await html(
    ctx,
    adminText,
    Markup.inlineKeyboard([
      [Markup.button.callback('📢 שליחת הודעה מערכתית', 'admin_broadcast')],
      [Markup.button.callback('💎 ניהול קרדיטים למשתמש', 'admin_set_credits')],
      [Markup.button.callback('🛡️ הגדרת ערוץ חובה', 'admin_set_sponsor')],
      [Markup.button.callback('🗑️ הסרת כל הערוצים', 'admin_clean_channels')]
    ])
  );
});

const adminAction = (name, state, prompt) =>
  bot.action(name, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdmin(ctx)) return;
    ensureUser(ADMIN_ID).state = state;
    await html(ctx, prompt);
  });

adminAction('admin_broadcast', 'WAITING_FOR_BROADCAST',
  `📢 <b>שלח כעת את הטקסט שברצונך להפיץ לכל המשתמשים:</b>`);
adminAction('admin_set_credits', 'WAITING_FOR_CREDIT_SET',
  `💎 <b>שלח מזהה משתמש וכמות קרדיטים להוספה (אפשר שלילי) בפורמט:</b>\n<code>USER_ID AMOUNT</code>`);
adminAction('admin_set_sponsor', 'WAITING_FOR_SPONSOR_SET',
  `🛡️ <b>שלח את יוזר ערוץ החובה החדש (כולל @):</b>\n⚠️ הבוט חייב להיות אדמין בערוץ.`);

bot.action('admin_clean_channels', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return;
  db.channels.forEach((c) => {
    const o = db.orders[c.orderCode];
    if (o && o.status.includes('פעיל')) o.status = '🗑️ הוסר ע"י הנהלה';
  });
  db.channels = [];
  await html(ctx, `${E.check} מאגר הערוצים נוקה בהצלחה!`);
});

// ==========================================
//              טיפול בשגיאות כללי
// ==========================================
bot.catch((err, ctx) => {
  console.error(`Unhandled error for ${ctx.updateType}:`, err.description || err.message);
});

// ==========================================
//         הרצת השרת ב-Render
// ==========================================
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('MemberFlow Bot Engine Running...'));

app.listen(PORT, () => {
  console.log(`🚀 Web Service running on port ${PORT}`);
  console.log('🤖 Launching Telegram bot...');
  bot.launch({ dropPendingUpdates: true }).catch((e) => {
    console.error('Bot launch failed:', e.message);
    process.exit(1);
  });
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
