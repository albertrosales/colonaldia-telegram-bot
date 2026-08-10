import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import FormData from 'form-data';

// ── Config desde variables de entorno ────────────────────────────────────
const {
  TELEGRAM_BOT_TOKEN,
  OPENAI_API_KEY,
  WP_URL,              // ej: https://colonaldia.hn
  WP_USER,             // tu usuario de WordPress
  WP_APP_PASSWORD,     // la Application Password generada en tu perfil de WP
  ALLOWED_CHAT_ID,     // tu chat_id de Telegram (para que solo tú uses el bot)
  RENDER_EXTERNAL_URL, // Render la define sola en producción
  PORT = 3000,
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !OPENAI_API_KEY || !WP_URL || !WP_USER || !WP_APP_PASSWORD) {
  console.error('Faltan variables de entorno. Revisa tu archivo .env');
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const wpAuth = 'Basic ' + Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');

// Borradores pendientes de confirmación, guardados en memoria por chatId
const drafts = new Map();

// ── Utilidad: verificar que solo tú puedas usar el bot ───────────────────
function isAllowed(ctx) {
  if (!ALLOWED_CHAT_ID) return true; // si no se define, no restringe (no recomendado)
  return String(ctx.chat.id) === String(ALLOWED_CHAT_ID);
}

// ── Traer categorías reales del sitio WordPress ───────────────────────────
async function getCategories() {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/categories?per_page=100`);
  if (!res.ok) throw new Error(`No se pudieron obtener categorías: ${res.status}`);
  const data = await res.json();
  return data.map(c => ({ id: c.id, name: c.name }));
}

// ── ChatGPT: redactar la noticia y elegir categoría ───────────────────────
async function redactarNoticia(textoCrudo, categorias) {
  const listaCategorias = categorias.map(c => c.name).join(', ');

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Eres redactor de un portal de noticias regional en Colón, Honduras (colonaldia.hn). ' +
          'A partir del material crudo que te dan (puede venir desordenado, copiado de otra fuente o como nota rápida), ' +
          'redacta una noticia lista para publicar. Responde SOLO un JSON con las claves: ' +
          '"titulo" (llamativo, informativo, sin comillas), ' +
          '"descripcion" (resumen de 1-2 frases para SEO/redes), ' +
          '"cuerpo" (noticia completa en formato periodístico, con párrafos separados por doble salto de línea), ' +
          `"categoria" (elige EXACTAMENTE una de esta lista, la que mejor encaje: ${listaCategorias}).`,
      },
      { role: 'user', content: textoCrudo },
    ],
  });

  const parsed = JSON.parse(completion.choices[0].message.content);

  // Aseguramos que la categoría elegida exista en el sitio; si no, usamos la primera de la lista
  const match = categorias.find(c => c.name.toLowerCase() === parsed.categoria?.toLowerCase());
  const categoria = match || categorias[0];

  return { ...parsed, categoriaId: categoria.id, categoriaNombre: categoria.name };
}

// ── WordPress: subir imagen ───────────────────────────────────────────────
async function subirImagen(buffer, filename) {
  const form = new FormData();
  form.append('file', buffer, filename);

  const res = await fetch(`${WP_URL}/wp-json/wp/v2/media`, {
    method: 'POST',
    headers: {
      Authorization: wpAuth,
      'Content-Disposition': `attachment; filename="${filename}"`,
      ...form.getHeaders(),
    },
    body: form,
  });

  if (!res.ok) throw new Error(`Error subiendo imagen: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.id; // ID del media, se usa como featured_media
}

// ── WordPress: crear el post ──────────────────────────────────────────────
async function crearPost({ titulo, descripcion, cuerpo, categoriaId, mediaId }) {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts`, {
    method: 'POST',
    headers: {
      Authorization: wpAuth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: titulo,
      excerpt: descripcion,
      content: cuerpo.replace(/\n\n/g, '</p><p>').replace(/^/, '<p>').replace(/$/, '</p>'),
      status: 'publish',
      categories: [categoriaId],
      ...(mediaId ? { featured_media: mediaId } : {}),
    }),
  });

  if (!res.ok) throw new Error(`Error creando post: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Manejo de mensajes entrantes (texto y/o foto) ─────────────────────────
bot.on(['photo', 'text'], async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');

  try {
    const caption = ctx.message.caption || ctx.message.text || '';
    if (!caption.trim()) {
      return ctx.reply('Mándame el texto de la noticia (puede ir junto con la foto, como pie de foto).');
    }

    let photoBuffer = null;
    let photoFilename = null;

    if (ctx.message.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1]; // la de mayor resolución
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);
      const res = await fetch(fileLink.href);
      photoBuffer = Buffer.from(await res.arrayBuffer());
      photoFilename = `telegram-${Date.now()}.jpg`;
    }

    await ctx.reply('Redactando noticia con IA, un momento...');

    const categorias = await getCategories();
    const draft = await redactarNoticia(caption, categorias);

    drafts.set(ctx.chat.id, { ...draft, photoBuffer, photoFilename });

    const preview =
      `📰 *${draft.titulo}*\n\n` +
      `_${draft.descripcion}_\n\n` +
      `${draft.cuerpo}\n\n` +
      `🏷️ Categoría: *${draft.categoriaNombre}*` +
      (photoBuffer ? '\n🖼️ Con foto adjunta' : '\n⚠️ Sin foto');

    await ctx.reply(preview, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        Markup.button.callback('✅ Publicar', 'confirmar'),
        Markup.button.callback('❌ Cancelar', 'cancelar'),
      ]),
    });
  } catch (err) {
    console.error(err);
    ctx.reply(`Ocurrió un error: ${err.message}`);
  }
});

// ── Confirmar publicación ─────────────────────────────────────────────────
bot.action('confirmar', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');

  const draft = drafts.get(ctx.chat.id);
  if (!draft) return ctx.answerCbQuery('No hay ninguna noticia pendiente.');

  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(); // quita los botones
  await ctx.reply('Publicando en colonaldia.hn...');

  try {
    let mediaId = null;
    if (draft.photoBuffer) {
      mediaId = await subirImagen(draft.photoBuffer, draft.photoFilename);
    }

    const post = await crearPost({
      titulo: draft.titulo,
      descripcion: draft.descripcion,
      cuerpo: draft.cuerpo,
      categoriaId: draft.categoriaId,
      mediaId,
    });

    drafts.delete(ctx.chat.id);
    await ctx.reply(`✅ Publicado: ${post.link}`);
  } catch (err) {
    console.error(err);
    await ctx.reply(`Error al publicar: ${err.message}`);
  }
});

// ── Cancelar ───────────────────────────────────────────────────────────────
bot.action('cancelar', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  drafts.delete(ctx.chat.id);
  await ctx.answerCbQuery('Cancelado');
  await ctx.editMessageReplyMarkup();
  await ctx.reply('❌ Noticia descartada.');
});

// ── Servidor Express + Webhook de Telegram (para Render) ─────────────────
const app = express();
const webhookPath = `/telegraf/${TELEGRAM_BOT_TOKEN}`;

app.use(bot.webhookCallback(webhookPath));
app.get('/', (req, res) => res.send('Bot activo.'));

app.listen(PORT, async () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);

  if (RENDER_EXTERNAL_URL) {
    const webhookUrl = `${RENDER_EXTERNAL_URL}${webhookPath}`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`Webhook configurado en: ${webhookUrl}`);
  } else {
    console.log('RENDER_EXTERNAL_URL no está definida: configura el webhook manualmente si no estás en Render.');
  }
});
