const { Telegraf, Scenes, session, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');
require('dotenv').config();

// ============================================================
// 1. SERVER (Render uchun)
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot Status: Active ✅'));
app.listen(PORT, () => console.log(`Server ${PORT}-portda ishlamoqda`));

// ============================================================
// 2. MA'LUMOTLAR BAZASI MODELLARI
// ============================================================
const productSchema = new mongoose.Schema({
  title:       { type: String, required: true },
  description: { type: String, required: true },
  price:       { type: Number, required: true },
  image:       { type: String, required: true },
  sizes:       [String],
  isActive:    { type: Boolean, default: true },
  createdAt:   { type: Date, default: Date.now }
});

const orderSchema = new mongoose.Schema({
  userId:       { type: Number, required: true },
  userName:     String,
  userPhone:    String,
  productId:    mongoose.Schema.Types.ObjectId,
  productTitle: String,
  size:         String,
  // 'Kutilmoqda' | 'Jarayonda' | 'Yetkazildi' | 'Bekor qilindi'
  status:       { type: String, default: 'Kutilmoqda' },
  createdAt:    { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
  telegramId:   { type: Number, unique: true, required: true },
  firstName:    { type: String, default: '' },
  lastName:     { type: String, default: '' },
  phone:        { type: String, default: '' },
  // 'user' | 'admin' | 'superadmin'
  role:         { type: String, default: 'user' },
  isRegistered: { type: Boolean, default: false },
  createdAt:    { type: Date, default: Date.now }
});

const Product = mongoose.model('Product', productSchema);
const Order   = mongoose.model('Order',   orderSchema);
const User    = mongoose.model('User',    userSchema);

// ============================================================
// 3. YORDAMCHI FUNKSIYALAR
// ============================================================

/**
 * Telefon raqamni tekshirish va +998XXXXXXXXX formatiga keltirish.
 * Qabul qilinadigan formatlar:
 *   +998901234567 | 998901234567 | 0901234567 | 901234567
 * Agar yaroqsiz bo'lsa — null qaytaradi.
 */
function parsePhone(text) {
  const digits = text.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('998')) return '+' + digits;
  if (digits.length === 10 && digits.startsWith('0'))   return '+998' + digits.slice(1);
  if (digits.length === 9)                               return '+998' + digits;
  return null;
}

const isSuperAdmin = (ctx) =>
  String(ctx.from.id) === String(process.env.ADMIN_ID);

const isAdmin = async (ctx) => {
  if (isSuperAdmin(ctx)) return true;
  const user = await User.findOne({ telegramId: ctx.from.id });
  return user?.role === 'admin' || user?.role === 'superadmin';
};

/** Barcha admin va superadminlarga bir vaqtda xabar yuborish */
const notifyAllAdmins = async (telegram, sendFn) => {
  const admins = await User.find({ role: { $in: ['admin', 'superadmin'] } });
  await Promise.all(
    admins.map(a =>
      sendFn(a.telegramId).catch(err =>
        console.error(`Admin ${a.telegramId} ga xabar yuborishda xato:`, err)
      )
    )
  );
};

// ============================================================
// 4. KLAVIATURALAR
// ============================================================
const getSuperAdminKB = () => Markup.keyboard([
  ["➕ Kiyim qo'shish", '📊 Statistika'],
  ["👤 Adminlarni boshqarish", '📦 Hamma buyurtmalar']
]).resize();

const getAdminKB = () => Markup.keyboard([
  ["➕ Kiyim qo'shish", '📊 Statistika'],
  ['📦 Hamma buyurtmalar']
]).resize();

const getUserKB = () => Markup.keyboard([
  ['📦 Buyurtmalarim holati', "👤 Mening ma'lumotlarim"]
]).resize();

const getKeyboardForUser = async (ctx) => {
  if (isSuperAdmin(ctx)) return getSuperAdminKB();
  if (await isAdmin(ctx)) return getAdminKB();
  return getUserKB();
};

// ============================================================
// 5. SCENE: YANGI FOYDALANUVCHI RO'YXATDAN O'TISH
// ============================================================
const registerWizard = new Scenes.WizardScene(
  'REGISTER_SCENE',

  // Qadam 1: Ism so'rash
  async (ctx) => {
    await ctx.reply(
      "👋 *Do'konimizga xush kelibsiz!*\n\n" +
      "Buyurtma berish uchun ro'yxatdan o'ting.\n\n" +
      "📝 *Ismingizni* kiriting:",
      { parse_mode: 'Markdown', ...Markup.removeKeyboard() }
    );
    return ctx.wizard.next();
  },

  // Qadam 2: Familiya so'rash
  async (ctx) => {
    if (!ctx.message?.text || ctx.message.text.trim().length < 2) {
      return ctx.reply("❌ Iltimos, to'g'ri ism kiriting (kamida 2 harf):");
    }
    ctx.wizard.state.firstName = ctx.message.text.trim();
    await ctx.reply("📝 *Familiyangizni* kiriting:", { parse_mode: 'Markdown' });
    return ctx.wizard.next();
  },

  // Qadam 3: Telefon so'rash
  async (ctx) => {
    if (!ctx.message?.text || ctx.message.text.trim().length < 2) {
      return ctx.reply("❌ Iltimos, to'g'ri familiya kiriting:");
    }
    ctx.wizard.state.lastName = ctx.message.text.trim();
    await ctx.reply(
      "📱 *Telefon raqamingizni* yuboring:\n\n" +
      "Tugma orqali yoki qo'lda yozishingiz mumkin.\n" +
      "_Masalan: +998901234567 yoki 901234567_",
      {
        parse_mode: 'Markdown',
        ...Markup.keyboard([
          [Markup.button.contactRequest("📱 Raqamni yuborish")]
        ]).oneTime().resize()
      }
    );
    return ctx.wizard.next();
  },

  // Qadam 4: Telefon qabul qilish (tugma yoki matn)
  async (ctx) => {
    let phone = null;

    if (ctx.message?.contact) {
      // Telegram tugmasi orqali yuborilgan
      const raw = ctx.message.contact.phone_number;
      phone = raw.startsWith('+') ? raw : '+' + raw;
    } else if (ctx.message?.text) {
      // Qo'lda yozilgan — validatsiya
      phone = parsePhone(ctx.message.text.trim());
    }

    // Yaroqsiz raqam — qaytadan so'rash
    if (!phone) {
      return ctx.reply(
        "❌ *Telefon raqam noto'g'ri!*\n\n" +
        "Iltimos, to'g'ri formatda kiriting:\n" +
        "_+998901234567 yoki 901234567_",
        {
          parse_mode: 'Markdown',
          ...Markup.keyboard([
            [Markup.button.contactRequest("📱 Raqamni yuborish")]
          ]).oneTime().resize()
        }
      );
      // return yo'q → qadam o'zgarmaydi, handler qayta chaqiriladi
    }

    const { firstName, lastName } = ctx.wizard.state;

    await User.findOneAndUpdate(
      { telegramId: ctx.from.id },
      { firstName, lastName, phone, isRegistered: true },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await ctx.reply(
      `✅ *Ro'yxatdan o'tdingiz!*\n\n` +
      `👤 Ism: ${firstName}\n` +
      `👤 Familiya: ${lastName}\n` +
      `📞 Telefon: ${phone}`,
      { parse_mode: 'Markdown', ...getUserKB() }
    );

    // Agar buyurtma kutib turgan bo'lsa — davom etish
    if (ctx.session.pendingProductId) {
      const product = await Product.findById(ctx.session.pendingProductId);
      ctx.session.pendingProductId = null;
      if (product) setTimeout(() => sendSizeSelection(ctx, product), 500);
    }

    return ctx.scene.leave();
  }
);

registerWizard.command('cancel', async (ctx) => {
  await ctx.reply("❌ Bekor qilindi.", Markup.removeKeyboard());
  return ctx.scene.leave();
});

// ============================================================
// 6. SCENE: PROFIL TAHRIRLASH
// ============================================================
const editProfileWizard = new Scenes.WizardScene(
  'EDIT_PROFILE_SCENE',

  // Qadam 0: Ma'lumotlarni ko'rsatish va nima o'zgartirishni tanlash
  async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    await ctx.reply(
      `👤 *Mening ma'lumotlarim*\n\n` +
      `Ism: *${user?.firstName || '—'}*\n` +
      `Familiya: *${user?.lastName || '—'}*\n` +
      `Telefon: *${user?.phone || '—'}*\n\n` +
      `Qaysi ma'lumotni o'zgartirmoqchisiz?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✏️ Ismni o'zgartirish",      'edit_firstname')],
          [Markup.button.callback("✏️ Familiyani o'zgartirish", 'edit_lastname')],
          [Markup.button.callback("📱 Telefon raqamni o'zgartirish", 'edit_phone')],
          [Markup.button.callback("❌ Yopish", 'edit_close')]
        ])
      }
    );
    return ctx.wizard.next();
  },

  // Qadam 1: Kiritilgan yangi qiymatni saqlash
  async (ctx) => {
    const field = ctx.wizard.state.editingField;
    if (!field) return; // inline button bosilishini kutmoqda

    if (field === 'phone') {
      let phone = null;
      if (ctx.message?.contact) {
        const raw = ctx.message.contact.phone_number;
        phone = raw.startsWith('+') ? raw : '+' + raw;
      } else if (ctx.message?.text) {
        phone = parsePhone(ctx.message.text.trim());
      }

      if (!phone) {
        return ctx.reply(
          "❌ Noto'g'ri format! Qaytadan kiriting:\n_Masalan: +998901234567_",
          {
            parse_mode: 'Markdown',
            ...Markup.keyboard([[Markup.button.contactRequest("📱 Yuborish")]]).oneTime().resize()
          }
        );
      }
      await User.findOneAndUpdate({ telegramId: ctx.from.id }, { phone });
      await ctx.reply("✅ Telefon raqam yangilandi!", getUserKB());

    } else {
      const value = ctx.message?.text?.trim();
      if (!value || value.length < 2) {
        return ctx.reply("❌ Kamida 2 ta harf kiriting:");
      }
      const update = field === 'firstName' ? { firstName: value } : { lastName: value };
      await User.findOneAndUpdate({ telegramId: ctx.from.id }, update);
      const label = field === 'firstName' ? 'Ism' : 'Familiya';
      await ctx.reply(`✅ ${label} yangilandi!`, getUserKB());
    }

    ctx.wizard.state.editingField = null;
    return ctx.scene.leave();
  }
);

// Inline tugmalar
editProfileWizard.action('edit_firstname', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.wizard.state.editingField = 'firstName';
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply("✏️ Yangi ismingizni kiriting:", Markup.removeKeyboard());
});
editProfileWizard.action('edit_lastname', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.wizard.state.editingField = 'lastName';
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply("✏️ Yangi familiyangizni kiriting:", Markup.removeKeyboard());
});
editProfileWizard.action('edit_phone', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.wizard.state.editingField = 'phone';
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply(
    "📱 Yangi telefon raqamingizni kiriting:\n_Masalan: +998901234567_",
    {
      parse_mode: 'Markdown',
      ...Markup.keyboard([[Markup.button.contactRequest("📱 Yuborish")]]).oneTime().resize()
    }
  );
});
editProfileWizard.action('edit_close', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply("👍 Yopildi.", getUserKB());
  return ctx.scene.leave();
});
editProfileWizard.command('cancel', async (ctx) => {
  const kb = await getKeyboardForUser(ctx);
  await ctx.reply("❌ Bekor qilindi.", kb);
  return ctx.scene.leave();
});

// ============================================================
// 7. SCENE: KIYIM QO'SHISH (Wizard)
// ============================================================
const clothAddWizard = new Scenes.WizardScene(
  'ADD_CLOTH_SCENE',

  (ctx) => {
    ctx.reply("👕 Kiyim nomini kiriting:\n\n/cancel — bekor qilish", Markup.removeKeyboard());
    return ctx.wizard.next();
  },
  (ctx) => {
    if (!ctx.message?.text) return ctx.reply("Iltimos, matn kiriting:");
    ctx.wizard.state.title = ctx.message.text;
    ctx.reply("📝 Tavsif kiriting:");
    return ctx.wizard.next();
  },
  (ctx) => {
    if (!ctx.message?.text) return ctx.reply("Iltimos, matn kiriting:");
    ctx.wizard.state.description = ctx.message.text;
    ctx.reply("📏 O'lchamlarni kiriting (vergul bilan, masalan: S, M, L, XL):");
    return ctx.wizard.next();
  },
  (ctx) => {
    if (!ctx.message?.text) return ctx.reply("Iltimos, matn kiriting:");
    ctx.wizard.state.sizes = ctx.message.text
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    ctx.reply("💰 Narxini kiriting (faqat raqam, so'mda):");
    return ctx.wizard.next();
  },
  (ctx) => {
    const price = parseInt(ctx.message?.text);
    if (isNaN(price) || price <= 0) return ctx.reply("❌ To'g'ri raqam kiriting:");
    ctx.wizard.state.price = price;
    ctx.reply("🖼 Rasmini yuboring:");
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message?.photo) return ctx.reply("❌ Rasm yuboring!");

    const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const { title, description, price, sizes } = ctx.wizard.state;

    try {
      const product = await Product.create({ title, description, price, image: photoId, sizes });
      const caption =
        `🛍 *${title}*\n\n` +
        `ℹ️ ${description}\n` +
        `📏 O'lchamlar: ${sizes.join(', ')}\n\n` +
        `💰 Narxi: ${price.toLocaleString()} so'm`;

      await ctx.telegram.sendPhoto(process.env.CHANNEL_ID, photoId, {
        caption,
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[
          Markup.button.url(
            '🛒 Buyurtma berish',
            `https://t.me/${ctx.botInfo.username}?start=buy_${product._id}`
          )
        ]])
      });

      const kb = await getKeyboardForUser(ctx);
      await ctx.reply("✅ Mahsulot kanalga muvaffaqiyatli joylandi!", kb);
    } catch (err) {
      console.error("Kiyim qo'shishda xato:", err);
      await ctx.reply("❌ Xatolik yuz berdi. Qaytadan urinib ko'ring.");
    }
    return ctx.scene.leave();
  }
);

clothAddWizard.command('cancel', async (ctx) => {
  const kb = await getKeyboardForUser(ctx);
  await ctx.reply("❌ Bekor qilindi.", kb);
  return ctx.scene.leave();
});

// ============================================================
// 8. BOT SOZLAMALARI
// ============================================================
const bot = new Telegraf(process.env.BOT_TOKEN);
const stage = new Scenes.Stage([registerWizard, editProfileWizard, clothAddWizard]);

bot.use(session());
bot.use(stage.middleware());

bot.catch((err, ctx) => {
  console.error(`[Bot Error] ${ctx.updateType}:`, err);
  ctx.reply("⚠️ Texnik xatolik yuz berdi. Iltimos, keyinroq urinib ko'ring.").catch(() => {});
});

// ============================================================
// 9. /start
// ============================================================
bot.start(async (ctx) => {
  const payload  = ctx.startPayload;
  const tgId     = ctx.from.id;

  let user = await User.findOne({ telegramId: tgId });

  // --- Admin / Superadmin ---
  if (isSuperAdmin(ctx) || user?.role === 'admin' || user?.role === 'superadmin') {
    if (!user) {
      user = await User.create({
        telegramId: tgId,
        firstName:  ctx.from.first_name || '',
        role:       isSuperAdmin(ctx) ? 'superadmin' : 'admin',
        isRegistered: true
      });
    }
    const kb = isSuperAdmin(ctx) ? getSuperAdminKB() : getAdminKB();
    return ctx.reply(
      isSuperAdmin(ctx) ? "👑 Xush kelibsiz, Superadmin!" : "🛠 Xush kelibsiz, Admin!",
      kb
    );
  }

  // --- Yangi foydalanuvchi (ro'yxatdan o'tmagan) ---
  if (!user || !user.isRegistered) {
    if (payload?.startsWith('buy_')) {
      ctx.session.pendingProductId = payload.replace('buy_', '');
    }
    return ctx.scene.enter('REGISTER_SCENE');
  }

  // --- Ro'yxatdan o'tgan foydalanuvchi ---
  if (payload?.startsWith('buy_')) {
    const productId = payload.replace('buy_', '');
    try {
      const product = await Product.findById(productId);
      if (!product || !product.isActive) {
        return ctx.reply("❌ Mahsulot topilmadi yoki mavjud emas.");
      }
      return sendSizeSelection(ctx, product);
    } catch (err) {
      console.error('Buy payload xatosi:', err);
      return ctx.reply("❌ Xatolik yuz berdi.");
    }
  }

  return ctx.reply(
    `👋 Xush kelibsiz, *${user.firstName}*!`,
    { parse_mode: 'Markdown', ...getUserKB() }
  );
});

// ============================================================
// 10. O'LCHAM TANLASH XABARI
// ============================================================
async function sendSizeSelection(ctx, product) {
  const buttons = product.sizes.map(s => [
    Markup.button.callback(s, `size_${product._id}_${s}`)
  ]);
  return ctx.replyWithPhoto(product.image, {
    caption:
      `*${product.title}*\n` +
      `💰 ${product.price.toLocaleString()} so'm\n\n` +
      `📏 O'lcham tanlang:`,
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
}

// ============================================================
// 11. O'LCHAM TANLANDI → BUYURTMA YARATISH
// ============================================================
bot.action(/^size_(.+)_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const [, productId, size] = ctx.match;

  try {
    const [product, user] = await Promise.all([
      Product.findById(productId),
      User.findOne({ telegramId: ctx.from.id })
    ]);

    if (!product) return ctx.reply("❌ Mahsulot topilmadi.");
    if (!user?.phone) return ctx.reply("❌ Telefon raqamingiz yo'q. /start bosing.");

    const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim()
      || ctx.from.first_name;

    const order = await Order.create({
      userId:       ctx.from.id,
      userName:     fullName,
      userPhone:    user.phone,
      productId:    product._id,
      productTitle: product.title,
      size
    });

    // BARCHA adminlarga xabar
    const caption =
      `🔔 *Yangi buyurtma!*\n\n` +
      `🛍 Kiyim: ${product.title}\n` +
      `📏 O'lcham: ${size}\n` +
      `👤 Mijoz: ${fullName}\n` +
      `📞 Tel: ${user.phone}\n` +
      `🆔 Order: \`${order._id}\``;

    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('🚚 Jarayonda',    `status_${order._id}_Jarayonda`)],
      [Markup.button.callback('✅ Yetkazildi',   `status_${order._id}_Yetkazildi`)],
      [Markup.button.callback('❌ Bekor qilish', `status_${order._id}_Bekor qilindi`)]
    ]);

    await notifyAllAdmins(ctx.telegram, (adminId) =>
      ctx.telegram.sendPhoto(adminId, product.image, {
        caption,
        parse_mode: 'Markdown',
        ...buttons
      })
    );

    await ctx.deleteMessage();
    await ctx.reply("✅ Buyurtmangiz qabul qilindi!\nTez orada siz bilan bog'lanamiz. 🙏");
  } catch (err) {
    console.error('Buyurtma yaratishda xato:', err);
    ctx.reply("❌ Xatolik yuz berdi. Qaytadan urinib ko'ring.");
  }
});

// ============================================================
// 12. BUYURTMA HOLATI O'ZGARTIRISH (Admin)
// ============================================================
bot.action(/^status_(.+)_(.+)$/, async (ctx) => {
  if (!await isAdmin(ctx)) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
  const [, orderId, newStatus] = ctx.match;

  try {
    const order = await Order.findByIdAndUpdate(orderId, { status: newStatus }, { new: true });
    if (!order) return ctx.answerCbQuery("❌ Buyurtma topilmadi.");

    const emoji = { Jarayonda: '🚚', Yetkazildi: '✅', 'Bekor qilindi': '❌' }[newStatus] || 'ℹ️';

    // Foydalanuvchiga bildirish
    await ctx.telegram.sendMessage(
      order.userId,
      `${emoji} *"${order.productTitle}"* buyurtmangiz holati:\n*${newStatus}*`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});

    await ctx.answerCbQuery(`✅ ${newStatus}`);
    await ctx.editMessageCaption(
      (ctx.callbackQuery.message.caption || '') + `\n\n${emoji} *Status:* ${newStatus}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Status yangilashda xato:', err);
    ctx.answerCbQuery("❌ Xatolik yuz berdi.");
  }
});

// ============================================================
// 13. FOYDALANUVCHI: BUYURTMALARIM HOLATI
// ============================================================
bot.hears('📦 Buyurtmalarim holati', async (ctx) => {
  if (await isAdmin(ctx)) return handleAllOrders(ctx);

  const orders = await Order.find({ userId: ctx.from.id })
    .sort({ createdAt: -1 }).limit(10);

  if (!orders.length) return ctx.reply("📭 Sizda hozircha buyurtmalar yo'q.");

  const emo = { Kutilmoqda: '⏳', Jarayonda: '🚚', Yetkazildi: '✅', 'Bekor qilindi': '❌' };
  const text = orders.map((o, i) =>
    `${i + 1}. *${o.productTitle}* — ${o.size}\n` +
    `   ${emo[o.status] || '•'} ${o.status}\n` +
    `   📅 ${o.createdAt.toLocaleDateString('uz-UZ')}`
  ).join('\n\n');

  ctx.reply(`📦 *Oxirgi buyurtmalaringiz:*\n\n${text}`, { parse_mode: 'Markdown' });
});

// ============================================================
// 14. FOYDALANUVCHI: PROFIL
// ============================================================
bot.hears("👤 Mening ma'lumotlarim", async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  if (!user) return ctx.reply("Ma'lumot topilmadi. /start bosing.");
  return ctx.scene.enter('EDIT_PROFILE_SCENE');
});

// ============================================================
// 15. ADMIN: STATISTIKA (barcha adminlarga ko'rinadi)
// ============================================================
bot.hears('📊 Statistika', async (ctx) => {
  if (!await isAdmin(ctx)) return;

  const [products, totalOrders, users, pending, inProgress, delivered, cancelled] =
    await Promise.all([
      Product.countDocuments({ isActive: true }),
      Order.countDocuments(),
      User.countDocuments({ isRegistered: true }),
      Order.countDocuments({ status: 'Kutilmoqda' }),
      Order.countDocuments({ status: 'Jarayonda' }),
      Order.countDocuments({ status: 'Yetkazildi' }),
      Order.countDocuments({ status: 'Bekor qilindi' })
    ]);

  ctx.reply(
    `📊 *Bot statistikasi:*\n\n` +
    `👕 Faol mahsulotlar: *${products}*\n` +
    `👥 Ro'yxatdan o'tgan foydalanuvchilar: *${users}*\n\n` +
    `📦 *Buyurtmalar:*\n` +
    `├ Jami: *${totalOrders}*\n` +
    `├ ⏳ Kutilmoqda: *${pending}*\n` +
    `├ 🚚 Jarayonda: *${inProgress}*\n` +
    `├ ✅ Yetkazildi: *${delivered}*\n` +
    `└ ❌ Bekor qilindi: *${cancelled}*`,
    { parse_mode: 'Markdown' }
  );
});

// ============================================================
// 16. ADMIN: HAMMA BUYURTMALAR (barcha adminlarga)
// ============================================================
async function handleAllOrders(ctx) {
  const orders = await Order.find({ status: { $in: ['Kutilmoqda', 'Jarayonda'] } })
    .sort({ createdAt: -1 }).limit(20);

  if (!orders.length) return ctx.reply("✅ Faol buyurtmalar yo'q.");

  for (const order of orders) {
    await ctx.reply(
      `📦 *Buyurtma*\n\n` +
      `🛍 ${order.productTitle} — *${order.size}*\n` +
      `👤 ${order.userName}\n` +
      `📞 ${order.userPhone}\n` +
      `⏳ ${order.status}\n` +
      `📅 ${order.createdAt.toLocaleString('uz-UZ')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🚚 Jarayonga olish', `status_${order._id}_Jarayonda`)],
          [Markup.button.callback('✅ Yetkazildi',      `status_${order._id}_Yetkazildi`)],
          [Markup.button.callback('❌ Bekor qilish',    `status_${order._id}_Bekor qilindi`)]
        ])
      }
    );
  }
}

bot.hears('📦 Hamma buyurtmalar', async (ctx) => {
  if (!await isAdmin(ctx)) return;
  return handleAllOrders(ctx);
});

// ============================================================
// 17. ADMIN: KIYIM QO'SHISH
// ============================================================
bot.hears("➕ Kiyim qo'shish", async (ctx) => {
  if (await isAdmin(ctx)) ctx.scene.enter('ADD_CLOTH_SCENE');
});

// ============================================================
// 18. SUPERADMIN: ADMIN BOSHQARUVI
// ============================================================
bot.hears("👤 Adminlarni boshqarish", async (ctx) => {
  if (!isSuperAdmin(ctx)) return;

  const admins = await User.find({ role: 'admin' });
  const buttons = admins.map(a => [
    Markup.button.callback(
      `❌ ${a.firstName || ''} ${a.lastName || ''} (ID: ${a.telegramId})`.trim(),
      `remove_admin_${a.telegramId}`
    )
  ]);

  ctx.reply(
    admins.length
      ? `👥 *Adminlar ro'yxati (${admins.length} ta):*`
      : "👥 Hozircha qo'shimcha adminlar yo'q.",
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        ...buttons,
        [Markup.button.callback("➕ Yangi admin qo'shish", 'add_new_admin')]
      ])
    }
  );
});

bot.action('add_new_admin', async (ctx) => {
  if (!isSuperAdmin(ctx)) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
  await ctx.answerCbQuery();
  ctx.session.awaitingNewAdminId = true;
  ctx.reply(
    "👤 Yangi adminning Telegram ID raqamini yozing:\n\n" +
    "_(Foydalanuvchi avval botga /start bosgan bo'lishi kerak)_",
    { parse_mode: 'Markdown' }
  );
});

bot.action(/^remove_admin_(\d+)$/, async (ctx) => {
  if (!isSuperAdmin(ctx)) return ctx.answerCbQuery("❌ Ruxsat yo'q.");
  const telegramId = parseInt(ctx.match[1]);
  await User.findOneAndUpdate({ telegramId }, { role: 'user' });
  await ctx.answerCbQuery('✅ Admin olib tashlandi.');
  await ctx.editMessageText("✅ Foydalanuvchi admin ro'yxatidan chiqarildi.");
});

// ============================================================
// 19. MATN HANDLER — Admin ID kiritish (eng oxirida bo'lishi kerak)
// ============================================================
bot.on('text', async (ctx, next) => {
  if (!isSuperAdmin(ctx) || !ctx.session.awaitingNewAdminId) return next();

  const newId = parseInt(ctx.message.text.trim());
  if (isNaN(newId)) return ctx.reply("❌ Faqat raqam kiriting:");

  ctx.session.awaitingNewAdminId = false;

  const user = await User.findOneAndUpdate(
    { telegramId: newId },
    { role: 'admin' },
    { new: true }
  );

  if (user) {
    const name = `${user.firstName || ''} ${user.lastName || ''}`.trim() || "Noma'lum";
    ctx.reply(
      `✅ *${name}* (ID: ${newId}) admin etib tayinlandi!`,
      { parse_mode: 'Markdown', ...getSuperAdminKB() }
    );
  } else {
    ctx.reply("❌ Foydalanuvchi topilmadi. Avval botga /start bosishi kerak.");
  }
});

// ============================================================
// 20. BAZAGA ULANISH VA BOTNI ISHGA TUSHIRISH
// ============================================================
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('✅ MongoDB-ga ulandi.');
    await User.findOneAndUpdate(
      { telegramId: parseInt(process.env.ADMIN_ID) },
      { role: 'superadmin', isRegistered: true },
      { upsert: true }
    );
    await bot.launch();
    console.log('✅ Bot ishga tushdi!');
  })
  .catch(err => {
    console.error('❌ MongoDB ulanish xatosi:', err);
    process.exit(1);
  });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));