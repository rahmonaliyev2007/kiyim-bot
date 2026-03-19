const { Telegraf, Scenes, session, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express'); // Server uchun
require('dotenv').config();

// --- 1. SERVER SOZLAMALARI (Render uchun shart) ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot Status: Active ✅')); // Server tirikligini bildiradi
app.listen(PORT, () => console.log(`Server ${PORT}-portda ishlamoqda`));

// --- 2. MA'LUMOTLAR BAZASI MODELLARI ---
const Product = mongoose.model('Product', new mongoose.Schema({
  title: String,
  description: String,
  price: Number,
  image: String,
  sizes: [String]
}));

const Order = mongoose.model('Order', new mongoose.Schema({
  userId: Number,
  userName: String,
  userPhone: String,
  productTitle: String,
  size: String,
  status: { type: String, default: 'Kutilmoqda' },
  createdAt: { type: Date, default: Date.now }
}));

const User = mongoose.model('User', new mongoose.Schema({
  telegramId: Number,
  phone: String
}));

// --- 3. BOT VA SCENES SOZLAMALARI ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const isAdmin = (ctx) => ctx.from.id == process.env.ADMIN_ID;

const clothAddWizard = new Scenes.WizardScene(
  'ADD_CLOTH_SCENE',
  (ctx) => { ctx.reply("👕 Kiyim nomini kiriting:"); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.title = ctx.message.text; ctx.reply("📝 Tavsif kiriting:"); return ctx.wizard.next(); },
  (ctx) => { ctx.wizard.state.description = ctx.message.text; ctx.reply("📏 O'lchamlarni kiriting (masalan: S, M, L):"); return ctx.wizard.next(); },
  (ctx) => { 
    ctx.wizard.state.sizes = ctx.message.text.split(',').map(s => s.trim().toUpperCase());
    ctx.reply("💰 Narxini kiriting (faqat raqam):"); 
    return ctx.wizard.next(); 
  },
  (ctx) => {
    const price = parseInt(ctx.message.text);
    if (isNaN(price)) return ctx.reply("Faqat raqam kiriting!");
    ctx.wizard.state.price = price;
    ctx.reply("🖼 Rasmini yuboring:");
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message.photo) return ctx.reply("Rasm yuboring!");
    const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const { title, description, price, sizes } = ctx.wizard.state;

    const product = await Product.create({ title, description, price, image: photoId, sizes });

    const text = `🛍 **${title}**\n\nℹ️ ${description}\n📏 O'lchamlar: ${sizes.join(', ')}\n\n💰 Narxi: ${price.toLocaleString()} so'm`;
    
    await ctx.telegram.sendPhoto(process.env.CHANNEL_ID, photoId, {
      caption: text,
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.url('🛒 Buyurtma berish', `https://t.me/${ctx.botInfo.username}?start=buy_${product._id}`)]])
    });

    ctx.reply("✅ Kanalga joylandi!", adminKeyboard);
    return ctx.scene.leave();
  }
);

const stage = new Scenes.Stage([clothAddWizard]);
bot.use(session());
bot.use(stage.middleware());

const adminKeyboard = Markup.keyboard([['➕ Kiyim qo\'shish', '📊 Statistika'], ['📦 Hamma buyurtmalar']]).resize();
const userKeyboard = Markup.keyboard([['📦 Buyurtmalarim holati']]).resize();

// --- 4. ASOSIY LOGIKA ---
bot.start(async (ctx) => {
  const startPayload = ctx.startPayload;

  if (startPayload && startPayload.startsWith('buy_')) {
    const productId = startPayload.replace('buy_', '');
    const product = await Product.findById(productId);
    if (product) {
      const user = await User.findOne({ telegramId: ctx.from.id });
      if (!user || !user.phone) {
        return ctx.reply("Buyurtma uchun telefon raqamingizni yuboring:", 
          Markup.keyboard([[Markup.button.contactRequest('📱 Raqamni yuborish')]]).oneTime().resize());
      }
      const sizeButtons = product.sizes.map(size => [Markup.button.callback(size, `select_size_${product._id}_${size}`)]);
      return ctx.replyWithPhoto(product.image, {
        caption: `"${product.title}" uchun o'lcham tanlang:`,
        ...Markup.inlineKeyboard(sizeButtons)
      });
    }
  }

  isAdmin(ctx) ? ctx.reply("Xush kelibsiz, Admin!", adminKeyboard) : ctx.reply("Xush kelibsiz!", userKeyboard);
});

bot.on('contact', async (ctx) => {
  await User.findOneAndUpdate({ telegramId: ctx.from.id }, { phone: ctx.message.contact.phone_number }, { upsert: true });
  ctx.reply("Rahmat! Endi buyurtma berishingiz mumkin.", isAdmin(ctx) ? adminKeyboard : userKeyboard);
});

bot.action(/select_size_(.+)_(.+)/, async (ctx) => {
  const product = await Product.findById(ctx.match[1]);
  const user = await User.findOne({ telegramId: ctx.from.id });
  const order = await Order.create({ userId: ctx.from.id, userName: ctx.from.first_name, userPhone: user.phone, productTitle: product.title, size: ctx.match[2] });

  await ctx.telegram.sendPhoto(process.env.ADMIN_ID, product.image, {
    caption: `🔔 **Yangi buyurtma!**\n\nKiyim: ${product.title}\nO'lcham: ${ctx.match[2]}\nMijoz: ${ctx.from.first_name}\nTel: ${user.phone}`,
    ...Markup.inlineKeyboard([[Markup.button.callback('✅ Yetkazildi', `complete_${order._id}`)]])
  });
  await ctx.deleteMessage();
  return ctx.reply(`✅ Rahmat! Buyurtmangiz qabul qilindi.`);
});

bot.action(/complete_(.+)/, async (ctx) => {
  if (isAdmin(ctx)) {
    const order = await Order.findByIdAndUpdate(ctx.match[1], { status: 'Yetkazildi' });
    await ctx.telegram.sendMessage(order.userId, `✅ Sizning "${order.productTitle}" buyurtmangiz yetkazildi!`);
    await ctx.editMessageText(`✅ Buyurtma yakunlandi.`);
  }
});

bot.hears('➕ Kiyim qo\'shish', (ctx) => { if (isAdmin(ctx)) ctx.scene.enter('ADD_CLOTH_SCENE'); });
bot.hears('📊 Statistika', async (ctx) => {
    if (isAdmin(ctx)) {
        const [p, o, u] = await Promise.all([Product.countDocuments(), Order.countDocuments(), User.countDocuments()]);
        ctx.reply(`📊 Statistika:\n- Kiyimlar: ${p}\n- Mijozlar: ${u}\n- Jami buyurtmalar: ${o}`);
    }
});

// --- 5. BAZA VA BOTNI ISHGA TUSHIRISH ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB-ga ulandik.");
    bot.launch();
  })
  .catch(err => console.error("Baza xatosi:", err));

// Xavfsiz to'xtatish
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));