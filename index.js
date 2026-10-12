const { Telegraf, Markup } = require('telegraf');
const express = require('express');
require('dotenv').config();

const token = process.env.BOT_TOKEN;
const ADMIN_ID = 8017590244; // מזהה האדמין הראשי שלך

if (!token) {
  console.error("❌ BOT_TOKEN is missing in environment variables!");
  process.exit(1);
}

const bot = new Telegraf(token);
const app = express();
app.use(express.json());

// --- מסד נתונים בזיכרון ---
const db = {
  users: {},      
  channels: [],   
  orders: {},     
  settings: {
    sponsorChannel: process.env.SPONSOR_CHANNEL || '@your_sponsor_channel'
  }
};

// --- אימוג'י פרימיום להודעות בתוך הצ'אט ---
const E = {
  flash: '<tg-emoji emoji-id="5780782082108167841">⚡</tg-emoji>',
  diamond: '<tg-emoji emoji-id="5271998448042785916">💎</tg-emoji>',
  check: '<tg-emoji emoji-id="5269470868379026531">✅</tg-emoji>',
  next: '<tg-emoji emoji-id="5460991276948143687">▶️</tg-emoji>',
  sub: '<tg-emoji emoji-id="6231225487469842472">👑</tg-emoji>',
  confirm: '<tg-emoji emoji-id="6231018663319704664">🛡️</tg-emoji>',
  orders: '<tg-emoji emoji-id="5431499171045581032">📊</tg-emoji>',
  admin: '⚙️',
  userCard: '🪪'
};

const isAdmin = (ctx) => ctx.from && ctx.from.id === ADMIN_ID;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- מקלדת ראשית מתוקנת (משתמשת באימוג'י רגילים למניעת שגיאות תצוגה) ---
const getMainMenuKeyboard = (userId) => {
  const buttons = [
    [`💎 הרווח קרדיטים חינם`, `⚡ MemberFlow | הוספת מנויים`],
    [`📊 ההזמנות שלי`, `❓ עזרה והסברים`]
  ];
  if (userId === ADMIN_ID) {
    buttons.push([`⚙️ פאנל ניהול אדמין`]);
  }
  return Markup.keyboard(buttons).resize();
};

// --- פקודת התחלה (/start) ---
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const firstName = ctx.from.first_name || 'משתמש יקר';
  const username = ctx.from.username ? `@${ctx.from.username}` : 'ללא';

  if (!db.users[userId]) {
    db.users[userId] = {
      credits: 10,
      completedCount: 0,
      sponsorCompleted: false,
      state: null
    };

    try {
      await bot.telegram.sendMessage(
        ADMIN_ID,
        `${E.userCard} <b>משתמש חדש נרשם למערכת!</b>\n\n` +
        `👤 שם: ${firstName}\n` +
        `🆔 מזהה: <code>${userId}</code>\n` +
        `🔗 יוזר: ${username}\n` +
        `📅 תאריך: ${new Date().toLocaleString('he-IL')}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error("Failed to notify admin:", e);
    }
  }

  const welcomeText = 
    `<b>ברוכים הבאים למערכת הרשמית — MemberFlow ${E.flash} | הוספת מנויים וחשיפה</b>\n\n` +
    `מערכת מתקדמת להרחבת קהלים, ניהול מנויים והפצת ערוצים ברמת אמינות גבוהה ${E.confirm}\n\n` +
    `👤 <b>כרטיס משתמש אישי:</b>\n` +
    `• שם: ${firstName}\n` +
    `• מזהה מערכת: <code>${userId}</code>\n` +
    `• יתרת קרדיטים: <b>${db.users[userId].credits}</b> ${E.diamond}\n\n` +
    `<i>בחר באחת האפשרויות בתפריט למטה כדי להתחיל:</i>`;

  await ctx.replyWithHTML(welcomeText, getMainMenuKeyboard(userId));
});

// ==========================================
//           רווח קרדיטים חינם
// ==========================================
bot.hears('💎 הרווח קרדיטים חינם', async (ctx) => {
  const userId = ctx.from.id;
  const user = db.users[userId] || (db.users[userId] = { credits: 10, completedCount: 0, sponsorCompleted: false });

  if (user.completedCount > 0 && user.completedCount % 5 === 0 && !user.sponsorCompleted) {
    return ctx.replyWithHTML(
      `<b>${E.confirm} אימות ביטחון תקופתי (חובה)</b> ${E.flash}\n\n` +
      `ביצעת <b>${user.completedCount}</b> פעולות בהצלחה! כדי להמשיך להרוויח, עליך להצטרף לערוץ הרשמי של המערכת.\n\n` +
      `🎁 תגמול אימות: <b>1 ${E.diamond}</b> מתנה ${E.next}`,
      Markup.inlineKeyboard([
        [Markup.button.url(`${E.flash} הצטרף לערוץ הרשמי`, `https://t.me/${db.settings.sponsorChannel.replace('@','')}`)],
        [Markup.button.callback(`${E.check} אמת הצטרפות וקבל קרדיט`, 'verify_sponsor')]
      ])
    );
  }

  const availableChannels = db.channels.filter(c => c.active && c.ownerId !== userId);
  if (availableChannels.length === 0) {
    return ctx.replyWithHTML(
      `⚠️ <b>אין כרגע קלפי חשיפה זמינים.</b>\n` +
      `אנא חזור מאוחר יותר أو פרסם ערוץ משלך דרך התפריט!`
    );
  }

  const targetChannel = availableChannels[Math.floor(Math.random() * availableChannels.length)];

  const cardText = 
    `🪪 <b>קלף חשיפה מנוהל ${E.flash}</b>\n\n` +
    `📢 ערוץ / קבוצה: <b>${targetChannel.name}</b>\n` +
    `🎯 משימה: הצטרפות כחבר קהילה פעיל\n\n` +
    `🎁 תגמול הצטרפות: <b>3 ${E.diamond}</b>`;

  await ctx.replyWithHTML(cardText, Markup.inlineKeyboard([
    [Markup.button.url('🔗 מעבר לערוץ המבוקש', targetChannel.link)],
    [Markup.button.callback(`קבל 3 ${E.diamond}`, `claim_${targetChannel.id}`)]
  ]));
});

bot.action(/^claim_(.+)$/, async (ctx) => {
  const channelId = ctx.match[1];
  const userId = ctx.from.id;
  const channel = db.channels.find(c => c.id == channelId);

  if (!channel) {
    return ctx.answerCbQuery('⚠️ קלף זה כבר אינו זמין.', { show_alert: true });
  }

  try {
    await ctx.editMessageText(`⌛ <b>בודק חברות בערוץ...</b>`, { parse_mode: 'HTML' });
    await sleep(800);
    await ctx.editMessageText(`🔄 <b>מאמת נתונים מול שרתי טלגרם...</b>`, { parse_mode: 'HTML' });
    await sleep(800);

    const chatMember = await bot.telegram.getChatMember(channel.usernameOrId, userId);
    const isMember = ['member', 'creator', 'administrator'].includes(chatMember.status);

    if (!isMember) {
      await ctx.editMessageText(
        `❌ <b>אימות נכשל!</b>\n\n` +
        `לא זוהתה הצטרפות בערוץ <b>${channel.name}</b>.\n` +
        `אנא הצטרף לערוץ ולחץ שוב על כפתור האימות.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('🔗 מעבר לערוץ', channel.link)],
            [Markup.button.callback(`נסה לאמת שוב ${E.flash}`, `claim_${channel.id}`)]
          ])
        }
      );
      return;
    }

    db.users[userId].credits += 3;
    db.users[userId].completedCount += 1;
    db.users[userId].sponsorCompleted = false;

    await ctx.editMessageText(
      `${E.check} <b>הפעולה אושרה בהצלחה!</b> ${E.flash}\n\n` +
      `התקבלו <b>3 ${E.diamond}</b> לחשבונך האישי.\n` +
      `יתרה מעודכנת: <b>${db.users[userId].credits} ${E.diamond}</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`המשך לקלף הבא ${E.next}`, 'next_card')]
        ])
      }
    );

  } catch (err) {
    console.error("Verification error:", err);
    await ctx.editMessageText(
      `⚠️ <b>שגיאה בביצוע האימות.</b>\nאנא וודא שהצטרפת כראוי ונסה שוב.`,
      Markup.inlineKeyboard([[Markup.button.callback('חזור', 'next_card')]])
    );
  }
});

bot.action('verify_sponsor', async (ctx) => {
  const userId = ctx.from.id;
  try {
    await ctx.editMessageText(`⌛ <b>מאמת הצטרפות לערוץ הרשמי...</b>`, { parse_mode: 'HTML' });
    await sleep(1000);
    
    const member = await bot.telegram.getChatMember(db.settings.sponsorChannel, userId);
    if (['member', 'creator', 'administrator'].includes(member.status)) {
      db.users[userId].sponsorCompleted = true;
      db.users[userId].credits += 1;

      await ctx.editMessageText(
        `${E.check} <b>האימות הושלם בהצלחה!</b> ${E.flash}\n\n` +
        `קיבלת <b>1 ${E.diamond}</b> במתנה. תוכל להמשיך להרוויח קרדיטים בחופשיות!`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback(`המשך ${E.next}`, 'next_card')]])
        }
      );
    } else {
      await ctx.editMessageText(
        `❌ <b>טרם הצטרפת לערוץ הרשמי.</b>\nאנא הצטרף ונסה שוב.`,
        Markup.inlineKeyboard([
          [Markup.button.url('📢 מעבר לערוץ', `https://t.me/${db.settings.sponsorChannel.replace('@','')}`)],
          [Markup.button.callback('אמת שוב', 'verify_sponsor')]
        ])
      );
    }
  } catch (e) {
    db.users[userId].sponsorCompleted = true;
    db.users[userId].credits += 1;
    await ctx.editMessageText(`${E.check} <b>אומת בהצלחה!</b> קיבלת 1 ${E.diamond}.`);
  }
});

bot.action('next_card', async (ctx) => {
  await ctx.deleteMessage();
  ctx.emit('hears', '💎 הרווח קרדיטים חינם', ctx);
});

// ==========================================
//     הוספת מנויים / פרסום ערוץ
// ==========================================
bot.hears('⚡ MemberFlow | הוספת מנויים', async (ctx) => {
  const userId = ctx.from.id;
  db.users[userId].state = 'WAITING_FOR_CHANNEL_INFO';

  await ctx.replyWithHTML(
    `🪪 <b>יצירת קלף משתמש לקידום וחשיפה ${E.flash}</b>\n\n` +
    `כדי להוסיף את הערוץ/קבוצה שלך למאגר, שלח כעת את <b>השם והקישור הישיר</b> בפורמט הבא:\n\n` +
    `<code>שם הערוץ | https://t.me/your_channel</code>`
  );
});

bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  const user = db.users[userId];

  if (user && user.state === 'WAITING_FOR_CHANNEL_INFO') {
    const text = ctx.message.text.trim();
    const parts = text.split('|');

    if (parts.length < 2) {
      return ctx.replyWithHTML(`❌ <b>פורמט שגוי.</b> אנא שלח בצורה: <code>שם | קישור</code>`);
    }

    const name = parts[0].trim();
    const link = parts[1].trim();
    const usernameOrId = link.split('t.me/')[1]?.split('/')[0];

    const cardId = Date.now();
    db.channels.push({
      id: cardId,
      name,
      link,
      usernameOrId: `@${usernameOrId}`,
      ownerId: userId,
      active: true
    });

    user.state = null;

    return ctx.replyWithHTML(
      `🪪 <b>תצוגה מקדימה לקלף הקידום שלך:</b>\n\n` +
      `• שם: <b>${name}</b>\n` +
      `• קישור: ${link}\n\n` +
      `מאשר להוסיף את הקלף למערכת הרשמית? ${E.confirm}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`${E.check} אישור והוספה`, `approve_card_${cardId}`)],
        [Markup.button.callback('❌ ביטול', 'cancel_card')]
      ])
    );
  }

  if (userId === ADMIN_ID && user && user.state === 'WAITING_FOR_BROADCAST') {
    user.state = null;
    const msg = ctx.message.text;
    let count = 0;
    for (const uid of Object.keys(db.users)) {
      try {
        await bot.telegram.sendMessage(uid, `📢 <b>הודעה רשמית מהנהלת המערכת:</b>\n\n${msg}`, { parse_mode: 'HTML' });
        count++;
      } catch (e) {}
    }
    return ctx.replyWithHTML(`${E.check} ההודעה נשלחה בהצלחה ל-<b>${count}</b> משתמשים!`);
  }

  if (userId === ADMIN_ID && user && user.state === 'WAITING_FOR_CREDIT_SET') {
    user.state = null;
    const [targetId, amount] = ctx.message.text.split(' ');
    if (db.users[targetId]) {
      db.users[targetId].credits += parseInt(amount);
      return ctx.replyWithHTML(`${E.check} עודכנו <b>${amount}</b> קרדיטים למשתמש <code>${targetId}</code>`);
    } else {
      return ctx.replyWithHTML(`❌ משתמש לא נמצא.`);
    }
  }

  if (userId === ADMIN_ID && user && user.state === 'WAITING_FOR_SPONSOR_SET') {
    user.state = null;
    db.settings.sponsorChannel = ctx.message.text.trim();
    return ctx.replyWithHTML(`${E.check} ערוץ החובה עודכן ל-<b>${db.settings.sponsorChannel}</b>`);
  }

  return next();
});

bot.action(/^approve_card_(.+)$/, async (ctx) => {
  const cardId = ctx.match[1];
  
  await ctx.editMessageText(
    `${E.check} <b>הקלף אושר ונוסף למאגר!</b> ${E.flash}\n\n` +
    `בחר כמה קרדיטים להשקיע בקידום הערוץ:\n` +
    `<i>(יחס המרה: 30 קרדיטים = 10 מנויים)</i>`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(`0 קרדיטים`, `add_credits_${cardId}_0`),
        Markup.button.callback(`30 קרדיטים (10 מנויים)`, `add_credits_${cardId}_30`),
        Markup.button.callback(`60 קרדיטים (20 מנויים)`, `add_credits_${cardId}_60`)
      ]
    ])
  );
});

bot.action(/^add_credits_(.+)_(.+)$/, async (ctx) => {
  const cardId = ctx.match[1];
  const creditsAmount = parseInt(ctx.match[2]);
  const userId = ctx.from.id;

  if (db.users[userId].credits < creditsAmount) {
    return ctx.answerCbQuery('❌ אין לך מספיק קרדיטים בחשבון!', { show_alert: true });
  }

  db.users[userId].credits -= creditsAmount;
  const orderCode = 'ORD-' + Math.floor(100000 + Math.random() * 900000);

  db.orders[orderCode] = {
    userId,
    creditsSpent: creditsAmount,
    subsCount: creditsAmount / 3,
    status: '⚡ פעיל ומקבל מנויים',
    date: new Date().toLocaleDateString('he-IL')
  };

  await ctx.editMessageText(
    `✨ <b>ההזמנה נוצרה והופעלה בהצלחה!</b> ${E.flash}\n\n` +
    `📊 קוד הזמנה רנדומלי: <code>${orderCode}</code>\n` +
    `💎 קרדיטים הושקעו: <b>${creditsAmount}</b>\n` +
    `👑 מנויים מתוכננים: <b>${creditsAmount / 3}</b>\n` +
    `📌 סטטוס: <b>פעיל במערכת</b>\n\n` +
    `<i>תוכל לעקוב אחר הסטטוס בכל עת דרך כפתור "ההזמנות שלי".</i>`,
    { parse_mode: 'HTML' }
  );
});

// ==========================================
//              ההזמנות שלי
// ==========================================
bot.hears('📊 ההזמנות שלי', async (ctx) => {
  const userId = ctx.from.id;
  const userOrders = Object.entries(db.orders).filter(([code, order]) => order.userId == userId);

  if (userOrders.length === 0) {
    return ctx.replyWithHTML(`📋 <b>אין לך הזמנות פעילות כרגע.</b>`);
  }

  let text = `📊 <b>ההזמנות שלך במערכת MemberFlow:</b> ${E.flash}\n\n`;
  userOrders.forEach(([code, order]) => {
    text += `• קוד: <code>${code}</code>\n  מנויים: <b>${order.subsCount}</b> | סטטוס: ${order.status}\n\n`;
  });

  await ctx.replyWithHTML(text);
});

// ==========================================
//             עזרה והסברים
// ==========================================
bot.hears('❓ עזרה והסברים', async (ctx) => {
  await ctx.replyWithHTML(
    `📖 <b>מדריך שימוש רשמי — MemberFlow ${E.flash}</b>\n\n` +
    `1️⃣ <b>רווח קרדיטים:</b> לחץ על "הרווח קרדיטים חינם", הצטרף לערוצים המוצגים ואשר את ההצטרפות לקבלת קרדיטים ${E.diamond}\n\n` +
    `2️⃣ <b>הוספת מנויים:</b> לחץ על "MemberFlow | הוספת מנויים", הכנס את הפרטים והשקע קרדיטים לקבלת חברים לערוץ שלך ${E.sub}\n\n` +
    `3️⃣ <b>אימות ביטחון:</b> כל 5 פעולות יש לאשר חברות בערוץ הרשמי לקבלת בונוס והמשך עבודה ${E.confirm}`
  );
});

// ==========================================
//       פאנל ניהול אדמין
// ==========================================
bot.hears('⚙️ פאנל ניהול אדמין', async (ctx) => {
  if (!isAdmin(ctx)) return;

  const totalUsers = Object.keys(db.users).length;
  const totalChannels = db.channels.length;
  const totalOrders = Object.keys(db.orders).length;

  const adminText = 
    `⚙️ <b>פאנל שליטה וניהול אדמין — MemberFlow</b> ${E.flash}\n\n` +
    `📊 <b>סטטיסטיקות מערכת:</b>\n` +
    `• סה"כ משתמשים: <b>${totalUsers}</b>\n` +
    `• סה"כ ערוצים במאגר: <b>${totalChannels}</b>\n` +
    `• סה"כ הזמנות שבוצעו: <b>${totalOrders}</b>\n` +
    `• ערוץ חובה נוכחי: <b>${db.settings.sponsorChannel}</b>\n\n` +
    `<i>בחר פעולת ניהול מבוקשת:</i>`;

  await ctx.replyWithHTML(adminText, Markup.inlineKeyboard([
    [Markup.button.callback('📢 שליחת הודעה מערכתית (Broadcast)', 'admin_broadcast')],
    [Markup.button.callback('💎 ניהול קרדיטים למשתמש', 'admin_set_credits')],
    [Markup.button.callback('🛡️ הגדרת ערוץ חובה (Sponsor)', 'admin_set_sponsor')],
    [Markup.button.callback('🗑️ הסרת ערוצים מפרים', 'admin_clean_channels')]
  ]));
});

bot.action('admin_broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return;
  db.users[ADMIN_ID].state = 'WAITING_FOR_BROADCAST';
  await ctx.replyWithHTML(`📢 <b>שלח כעת את הטקסט שברצונך להפיץ לכל המשתמשים:</b>`);
});

bot.action('admin_set_credits', async (ctx) => {
  if (!isAdmin(ctx)) return;
  db.users[ADMIN_ID].state = 'WAITING_FOR_CREDIT_SET';
  await ctx.replyWithHTML(`💎 <b>שלח מזהה משתמש וכמות קרדיטים להוספה בפורמט:</b>\n<code>USER_ID AMOUNT</code>`);
});

bot.action('admin_set_sponsor', async (ctx) => {
  if (!isAdmin(ctx)) return;
  db.users[ADMIN_ID].state = 'WAITING_FOR_SPONSOR_SET';
  await ctx.replyWithHTML(`🛡️ <b>שלח את יוזר ערוץ החובה החדש (כולל @):</b>`);
});

bot.action('admin_clean_channels', async (ctx) => {
  if (!isAdmin(ctx)) return;
  db.channels = [];
  await ctx.replyWithHTML(`${E.check} מאגר הערוצים נוקה בהצלחה!`);
});

// ==========================================
//         הרצת השרת ב-Render
// ==========================================
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('MemberFlow Bot Engine Running...'));

app.listen(PORT, async () => {
  console.log(`🚀 Web Service running on port ${PORT}`);
  bot.launch().then(() => console.log('🤖 Telegram Bot launched successfully!'));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
