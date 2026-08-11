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
  WP_URL,
  WP_USER,
  WP_APP_PASSWORD,
  ALLOWED_CHAT_ID,
  WP_AUTHORS,
  RENDER_EXTERNAL_URL,
  PORT = 3000,
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !OPENAI_API_KEY || !WP_URL || !WP_USER || !WP_APP_PASSWORD) {
  console.error('Faltan variables de entorno. Revisa tu archivo .env');
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const wpAuth = 'Basic ' + Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');

const drafts = new Map();
const mediaGroups = new Map();

// ── Permisos ────────────────────────────────────────────────────────────
function isAllowed(ctx) {
  if (!ALLOWED_CHAT_ID) return true;
  return ALLOWED_CHAT_ID.split(',').map(id => id.trim()).includes(String(ctx.chat.id));
}

function getAuthors() {
  if (!WP_AUTHORS) return [];
  return WP_AUTHORS.split(',').map(par => {
    const [id, nombre] = par.split(':').map(v => v.trim());
    return { id: Number(id), nombre };
  }).filter(a => a.id && a.nombre);
}

// ── Categorías del sitio ───────────────────────────────────────────────────
async function getCategories() {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/categories?per_page=100`);
  if (!res.ok) throw new Error(`No se pudieron obtener categorías: ${res.status}`);
  const data = await res.json();
  return data.map(c => ({ id: c.id, name: c.name }));
}

// ── Buscar posibles noticias duplicadas ya publicadas ──────────────────────
async function buscarPosibleDuplicado(titulo) {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(titulo)}&per_page=5&_fields=id,title,link,date`);
  if (!res.ok) return null;
  const posts = await res.json();
  if (!posts.length) return null;

  const candidatos = posts.map(p => ({ titulo: p.title.rendered, link: p.link, fecha: p.date }));

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Te doy un título de noticia nueva y una lista de títulos ya publicados en el sitio. ' +
          'Responde SOLO un JSON {"duplicado": true/false, "indice": N} donde indicado es el índice (0-based) ' +
          'del título de la lista que trata sobre el MISMO hecho noticioso que el nuevo (aunque esté redactado ' +
          'distinto), o duplicado:false e indice:null si ninguno trata del mismo hecho.',
      },
      { role: 'user', content: JSON.stringify({ tituloNuevo: titulo, publicados: candidatos.map(c => c.titulo) }) },
    ],
  });

  const parsed = JSON.parse(completion.choices[0].message.content);
  if (parsed.duplicado && candidatos[parsed.indice]) return candidatos[parsed.indice];
  return null;
}

// ── ChatGPT: redactar la noticia ──────────────────────────────────────────
async function redactarNoticia(textoCrudo, categorias, numImagenesAMarcar) {
  const listaCategorias = categorias.map(c => c.name).join(', ');

  let instruccionImagenes = '';
  if (numImagenesAMarcar > 0) {
    const marcadores = Array.from({ length: numImagenesAMarcar }, (_, i) => `{{IMG_${i + 2}}}`).join(', ');
    instruccionImagenes =
      ` Además tienes ${numImagenesAMarcar} imagen(es) adicional(es) para insertar DENTRO del cuerpo ` +
      `(aparte de la foto de portada, que no se menciona en el texto). Marca los lugares donde deberían ir, ` +
      `en los puntos donde tenga más sentido editorialmente, usando exactamente estos marcadores una vez cada uno: ${marcadores}.`;
  }

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Eres redactor de un portal de noticias regional en Colón, Honduras (colonaldia.hn). ' +
          'A partir del material crudo que te dan, redacta una noticia lista para publicar. ' +
          'Responde SOLO un JSON con las claves: ' +
          '"titulo" (llamativo, informativo, sin comillas), ' +
          '"subtitulo" (una frase corta tipo bajada periodística, que amplíe el título sin repetirlo), ' +
          '"descripcion" (resumen de 1-2 frases para SEO/redes), ' +
          '"cuerpo" (noticia completa en formato periodístico, párrafos separados por doble salto de línea. ' +
          'El PRIMER párrafo debe empezar con un dateline en este formato exacto: "Tocoa, Colón: -" seguido del ' +
          'primer párrafo de la noticia en la misma línea. Si el texto original menciona claramente que el hecho ' +
          'ocurrió en otro municipio del departamento de Colón, usa ese municipio en vez de Tocoa, siempre con ' +
          'el mismo formato "Municipio, Colón: -"), ' +
          `"categorias" (array con 1 a 3 nombres EXACTOS de esta lista, las que mejor encajen: ${listaCategorias}).` +
          instruccionImagenes,
      },
      { role: 'user', content: textoCrudo },
    ],
  });

  const parsed = JSON.parse(completion.choices[0].message.content);

  const nombresSugeridos = Array.isArray(parsed.categorias) ? parsed.categorias : [parsed.categorias].filter(Boolean);
  let idsSugeridos = nombresSugeridos
    .map(nombre => categorias.find(c => c.name.toLowerCase() === String(nombre).toLowerCase())?.id)
    .filter(Boolean);
  if (idsSugeridos.length === 0) idsSugeridos = [categorias[0].id];

  return {
    titulo: parsed.titulo,
    subtitulo: parsed.subtitulo,
    descripcion: parsed.descripcion,
    cuerpo: parsed.cuerpo,
    categoriasSugeridas: idsSugeridos,
  };
}

// ── ChatGPT: aplicar una edición pedida por el usuario ─────────────────────
async function editarNoticia({ titulo, subtitulo, descripcion, cuerpo }, instruccion) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Tienes una noticia ya redactada en JSON con las claves titulo, subtitulo, descripcion, cuerpo. ' +
          'El usuario pide un cambio específico. Aplica SOLO ese cambio y deja el resto igual, salvo que el cambio ' +
          'lo requiera. Conserva el formato de dateline al inicio del cuerpo ("Municipio, Colón: -") salvo que el ' +
          'cambio pedido lo afecte directamente. Si el cuerpo contiene marcadores tipo {{IMG_2}}, {{IMG_3}}, etc., ' +
          'consérvalos en su lugar salvo que el cambio los afecte. Responde SOLO el JSON actualizado con esas ' +
          'mismas cuatro claves.',
      },
      { role: 'user', content: JSON.stringify({ titulo, subtitulo, descripcion, cuerpo }) },
      { role: 'user', content: `Cambio pedido: ${instruccion}` },
    ],
  });
  return JSON.parse(completion.choices[0].message.content);
}

// ── WordPress: subir imagen ───────────────────────────────────────────────
async function subirImagen(buffer, filename) {
  const form = new FormData();
  form.append('file', buffer, filename);

  const res = await fetch(`${WP_URL}/wp-json/wp/v2/media`, {
    method: 'POST',
    headers: { Authorization: wpAuth, 'Content-Disposition': `attachment; filename="${filename}"`, ...form.getHeaders() },
    body: form,
  });

  if (!res.ok) throw new Error(`Error subiendo imagen: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { id: data.id, url: data.source_url };
}

// ── Arma el HTML del cuerpo, con subtítulo e imágenes insertadas ──────────
function construirCuerpoHtml(subtitulo, cuerpoRaw, fotosAdicionalesSubidas) {
  let texto = cuerpoRaw;
  const usados = new Set();

  fotosAdicionalesSubidas.forEach((foto, idx) => {
    const marker = `{{IMG_${idx + 2}}}`;
    if (texto.includes(marker)) {
      texto = texto.replace(marker, `</p><img src="${foto.url}" alt="" /><p>`);
      usados.add(idx);
    }
  });

  let html = (subtitulo ? `<p><em>${subtitulo}</em></p>` : '') + '<p>' + texto.split('\n\n').join('</p><p>') + '</p>';

  fotosAdicionalesSubidas.forEach((foto, idx) => {
    if (!usados.has(idx)) html += `<img src="${foto.url}" alt="" />`;
  });

  return html;
}

// ── WordPress: crear el post ──────────────────────────────────────────────
async function crearPost({ titulo, descripcion, cuerpoHtml, categoriaIds, mediaId, authorId, sticky }) {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts`, {
    method: 'POST',
    headers: { Authorization: wpAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: titulo,
      excerpt: descripcion,
      content: cuerpoHtml,
      status: 'publish',
      categories: categoriaIds,
      sticky: !!sticky,
      ...(mediaId ? { featured_media: mediaId } : {}),
      ...(authorId ? { author: authorId } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Error creando post: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Descargar una foto de Telegram ─────────────────────────────────────────
async function descargarFoto(ctx, fileId) {
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(fileLink.href);
  return Buffer.from(await res.arrayBuffer());
}

// ── UI: aviso de posible duplicado ─────────────────────────────────────────
async function mostrarAvisoDuplicado(ctx, duplicado) {
  await ctx.reply(
    `⚠️ Ya existe una noticia parecida:\n\n*${duplicado.titulo}*\n${duplicado.link}\n\n¿La publico de todos modos?`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      Markup.button.callback('✅ Publicar de todos modos', 'dup_continuar'),
      Markup.button.callback('❌ Cancelar', 'cancelar'),
    ]) }
  );
}

// ── UI: mostrar selección de categorías (checklist) ────────────────────────
async function mostrarSeleccionCategorias(ctx, draft) {
  const botones = draft.categoriasDisponibles.map(cat => {
    const marcado = draft.categoriasSeleccionadas.includes(cat.id) ? '✅ ' : '⬜ ';
    return [Markup.button.callback(marcado + cat.name, `cat_${cat.id}`)];
  });
  botones.push([Markup.button.callback('➡️ Continuar', 'cat_continuar')]);

  const texto = '🏷️ Elige una o varias categorías (toca para marcar/desmarcar):';
  if (draft.msgCategorias) {
    await ctx.telegram.editMessageText(ctx.chat.id, draft.msgCategorias, undefined, texto, Markup.inlineKeyboard(botones));
  } else {
    const msg = await ctx.reply(texto, Markup.inlineKeyboard(botones));
    draft.msgCategorias = msg.message_id;
  }
}

// ── UI: preview final + botones de publicar/editar ─────────────────────────
async function mostrarPreviewFinal(ctx, draft) {
  const nombresCategorias = draft.categoriasDisponibles
    .filter(c => draft.categoriasSeleccionadas.includes(c.id))
    .map(c => c.name)
    .join(', ');

  const preview =
    `📰 *${draft.titulo}*\n` +
    `_${draft.subtitulo}_\n\n` +
    `${draft.cuerpo}\n\n` +
    `🏷️ Categorías: *${nombresCategorias}*\n` +
    `⭐ Portada: *${draft.portada ? 'Sí' : 'No'}*\n` +
    (draft.fotos.length ? `🖼️ ${draft.fotos.length} foto(s) adjunta(s)` : '⚠️ Sin fotos');

  const autores = getAuthors();
  await ctx.reply(preview, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Editar', 'editar')],
      ...autores.map(a => [Markup.button.callback(`✅ Publicar como ${a.nombre}`, `autor_${a.id}`)]),
      [Markup.button.callback('✅ Publicar (cuenta admin)', 'autor_0')],
      [Markup.button.callback('❌ Cancelar', 'cancelar')],
    ]),
  });
}

// ── Procesa una entrada nueva (texto solo, o texto + 1 o varias fotos) ────
async function procesarEntrada(ctx, fotosBuffers, textoCrudo) {
  if (!textoCrudo || !textoCrudo.trim()) {
    return ctx.reply('Mándame el texto de la noticia (puede ir junto con la(s) foto(s), como pie de foto).');
  }

  await ctx.reply(`Redactando noticia con IA${fotosBuffers.length ? ` (${fotosBuffers.length} foto(s))` : ''}, un momento...`);

  const categoriasDisponibles = await getCategories();
  const numAdicionalesAMarcar = fotosBuffers.length > 2 ? fotosBuffers.length - 1 : 0;
  const resultado = await redactarNoticia(textoCrudo, categoriasDisponibles, numAdicionalesAMarcar);

  const draft = {
    titulo: resultado.titulo,
    subtitulo: resultado.subtitulo,
    descripcion: resultado.descripcion,
    cuerpo: resultado.cuerpo,
    categoriasDisponibles,
    categoriasSeleccionadas: resultado.categoriasSugeridas,
    portada: false,
    fotos: fotosBuffers,
    stage: 'revisando_duplicado',
    msgCategorias: null,
  };
  drafts.set(ctx.chat.id, draft);

  const duplicado = await buscarPosibleDuplicado(draft.titulo);
  if (duplicado) {
    draft.duplicadoDetectado = duplicado;
    await mostrarAvisoDuplicado(ctx, duplicado);
    return;
  }

  draft.stage = 'categorias';
  await mostrarSeleccionCategorias(ctx, draft);
}

// ── Mensajes de texto ──────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');

  const draft = drafts.get(ctx.chat.id);

  if (draft && draft.stage === 'editando') {
    try {
      await ctx.reply('Aplicando el cambio...');
      const actualizado = await editarNoticia(draft, ctx.message.text);
      draft.titulo = actualizado.titulo;
      draft.subtitulo = actualizado.subtitulo;
      draft.descripcion = actualizado.descripcion;
      draft.cuerpo = actualizado.cuerpo;
      draft.stage = 'preview';
      await mostrarPreviewFinal(ctx, draft);
    } catch (err) {
      console.error(err);
      ctx.reply(`Ocurrió un error al editar: ${err.message}`);
    }
    return;
  }

  try {
    await procesarEntrada(ctx, [], ctx.message.text);
  } catch (err) {
    console.error(err);
    ctx.reply(`Ocurrió un error: ${err.message}`);
  }
});

// ── Mensajes con foto (agrupa álbumes antes de procesar) ───────────────────
bot.on('photo', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const groupId = ctx.message.media_group_id;
  const caption = ctx.message.caption || '';

  if (!groupId) {
    try {
      const buffer = await descargarFoto(ctx, photo.file_id);
      await procesarEntrada(ctx, [{ buffer, filename: `telegram-${Date.now()}.jpg` }], caption);
    } catch (err) {
      console.error(err);
      ctx.reply(`Ocurrió un error: ${err.message}`);
    }
    return;
  }

  const key = `${ctx.chat.id}_${groupId}`;
  if (!mediaGroups.has(key)) mediaGroups.set(key, { items: [], caption: '' });
  const grupo = mediaGroups.get(key);
  grupo.items.push({ message_id: ctx.message.message_id, file_id: photo.file_id });
  if (caption) grupo.caption = caption;

  clearTimeout(grupo.timer);
  grupo.timer = setTimeout(async () => {
    mediaGroups.delete(key);
    try {
      const ordenadas = grupo.items.sort((a, b) => a.message_id - b.message_id);
      const fotos = [];
      for (const item of ordenadas) {
        const buffer = await descargarFoto(ctx, item.file_id);
        fotos.push({ buffer, filename: `telegram-${Date.now()}-${fotos.length}.jpg` });
      }
      await procesarEntrada(ctx, fotos, grupo.caption);
    } catch (err) {
      console.error(err);
      ctx.reply(`Ocurrió un error: ${err.message}`);
    }
  }, 1200);
});

// ── Aviso de duplicado: continuar o cancelar ───────────────────────────────
bot.action('dup_continuar', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft) return ctx.answerCbQuery('No hay ninguna noticia pendiente.');

  await ctx.answerCbQuery();
  draft.stage = 'categorias';
  await mostrarSeleccionCategorias(ctx, draft);
});

// ── Toggle de categorías ────────────────────────────────────────────────────
bot.action(/^cat_(\d+)$/, async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft) return ctx.answerCbQuery('No hay ninguna noticia pendiente.');

  const id = Number(ctx.match[1]);
  if (draft.categoriasSeleccionadas.includes(id)) {
    draft.categoriasSeleccionadas = draft.categoriasSeleccionadas.filter(c => c !== id);
  } else {
    draft.categoriasSeleccionadas.push(id);
  }
  await ctx.answerCbQuery();
  await mostrarSeleccionCategorias(ctx, draft);
});

bot.action('cat_continuar', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft) return ctx.answerCbQuery('No hay ninguna noticia pendiente.');

  if (draft.categoriasSeleccionadas.length === 0) {
    return ctx.answerCbQuery('Elige al menos una categoría.');
  }

  await ctx.answerCbQuery();
  draft.stage = 'portada';
  await ctx.reply('⭐ ¿Esta noticia va en portada?', Markup.inlineKeyboard([
    Markup.button.callback('Sí', 'portada_si'),
    Markup.button.callback('No', 'portada_no'),
  ]));
});

// ── Portada sí/no ───────────────────────────────────────────────────────────
bot.action(/^portada_(si|no)$/, async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft) return ctx.answerCbQuery('No hay ninguna noticia pendiente.');

  draft.portada = ctx.match[1] === 'si';
  draft.stage = 'preview';
  await ctx.answerCbQuery();
  await mostrarPreviewFinal(ctx, draft);
});

// ── Editar ───────────────────────────────────────────────────────────────
bot.action('editar', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft) return ctx.answerCbQuery('No hay ninguna noticia pendiente.');

  draft.stage = 'editando';
  await ctx.answerCbQuery();
  await ctx.reply(
    '✏️ Escribe qué quieres cambiar (ej: "cambia el título a...", "acorta la descripción", ' +
    '"agrega un párrafo sobre..."). Te muestro la noticia actualizada después.'
  );
});

// ── Seleccionar autor y publicar ──────────────────────────────────────────
bot.action(/^autor_(\d+)$/, async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft) return ctx.answerCbQuery('No hay ninguna noticia pendiente.');

  const authorId = Number(ctx.match[1]) || undefined;

  await ctx.answerCbQuery();
  await ctx.reply('Publicando en colonaldia.hn...');

  try {
    let mediaId = null;
    let cuerpoHtml = (draft.subtitulo ? `<p><em>${draft.subtitulo}</em></p>` : '') +
      '<p>' + draft.cuerpo.split('\n\n').join('</p><p>') + '</p>';

    if (draft.fotos.length > 0) {
      const portadaSubida = await subirImagen(draft.fotos[0].buffer, draft.fotos[0].filename);
      mediaId = portadaSubida.id;

      if (draft.fotos.length > 1) {
        const adicionalesSubidas = [];
        for (const foto of draft.fotos.slice(1)) {
          adicionalesSubidas.push(await subirImagen(foto.buffer, foto.filename));
        }
        cuerpoHtml = construirCuerpoHtml(draft.subtitulo, draft.cuerpo, adicionalesSubidas);
      }
    }

    const post = await crearPost({
      titulo: draft.titulo,
      descripcion: draft.descripcion,
      cuerpoHtml,
      categoriaIds: draft.categoriasSeleccionadas,
      mediaId,
      authorId,
      sticky: draft.portada,
    });

    drafts.delete(ctx.chat.id);
    await ctx.reply(`✅ Publicado: ${post.link}`);
  } catch (err) {
    console.error(err);
    await ctx.reply(`Error al publicar: ${err.message}`);
  }
});

// ── Cancelar ─────────────────────────────────────────────────────────────
bot.action('cancelar', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  drafts.delete(ctx.chat.id);
  await ctx.answerCbQuery('Cancelado');
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
