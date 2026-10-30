import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import OpenAI, { toFile } from 'openai';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { TwitterApi } from 'twitter-api-v2';

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

// Modelo principal: verificación con búsqueda web + redacción + ediciones.
// Modelo rápido: tareas simples (palabras clave, comparar duplicados).
const MODELO_PRINCIPAL = process.env.OPENAI_MODEL || 'gpt-5.4';
const MODELO_RAPIDO = process.env.OPENAI_MODEL_RAPIDO || 'gpt-4o-mini';
const MODELO_TRANSCRIPCION = process.env.OPENAI_MODEL_TRANSCRIPCION || 'gpt-4o-transcribe';

// X (Twitter): opcional. Si faltan las credenciales, el bot simplemente no ofrece publicar en X.
const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
const X_INCLUIR_ENLACE = (process.env.X_INCLUIR_ENLACE || 'no').toLowerCase() === 'si';
const xClient = (X_API_KEY && X_API_SECRET && X_ACCESS_TOKEN && X_ACCESS_SECRET)
  ? new TwitterApi({
      appKey: X_API_KEY,
      appSecret: X_API_SECRET,
      accessToken: X_ACCESS_TOKEN,
      accessSecret: X_ACCESS_SECRET,
    }).readWrite
  : null;
const ZONA_HORARIA = 'America/Tegucigalpa';

if (!TELEGRAM_BOT_TOKEN || !OPENAI_API_KEY || !WP_URL || !WP_USER || !WP_APP_PASSWORD) {
  console.error('Faltan variables de entorno. Revisa tu archivo .env');
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN, { handlerTimeout: 10 * 60 * 1000 });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const wpAuth = 'Basic ' + Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');

const drafts = new Map();

// ── Utilidades ─────────────────────────────────────────────────────────────
function isAllowed(ctx) {
  if (!ALLOWED_CHAT_ID) return true;
  return ALLOWED_CHAT_ID.split(',').map(id => id.trim()).includes(String(ctx.chat?.id));
}

function getAuthors() {
  if (!WP_AUTHORS) return [];
  return WP_AUTHORS.split(',').map(par => {
    const [id, nombre] = par.split(':').map(v => v.trim());
    return { id: Number(id), nombre };
  }).filter(a => a.id && a.nombre);
}

// Escapa texto para parse_mode HTML de Telegram
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Quita etiquetas/entidades HTML (títulos que vienen de WordPress)
function limpiarHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#8211;/g, '–').replace(/&#8212;/g, '—')
    .replace(/&#8220;|&#8221;/g, '"').replace(/&#8216;|&#8217;/g, "'")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
}

function fechaHoy() {
  return new Date().toLocaleDateString('es-HN', {
    timeZone: ZONA_HORARIA, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

// Extrae el primer objeto JSON de una respuesta de texto
function parsearJson(texto) {
  const inicio = texto.indexOf('{');
  const fin = texto.lastIndexOf('}');
  if (inicio === -1 || fin === -1) throw new Error('La IA no devolvió un JSON válido.');
  return JSON.parse(texto.slice(inicio, fin + 1));
}

// Envía un texto largo partido en varios mensajes (límite de Telegram: 4096).
// El teclado (botones) va solo en el último mensaje.
async function enviarLargo(ctx, html, extra = {}) {
  const LIMITE = 3900;
  const partes = [];
  let actual = '';
  for (const linea of html.split('\n')) {
    if ((actual + '\n' + linea).length > LIMITE && actual) {
      partes.push(actual);
      actual = linea;
    } else {
      actual = actual ? actual + '\n' + linea : linea;
    }
    while (actual.length > LIMITE) {
      // línea gigante sin saltos: cortar en un espacio
      let corte = actual.lastIndexOf(' ', LIMITE);
      if (corte < LIMITE / 2) corte = LIMITE;
      partes.push(actual.slice(0, corte));
      actual = actual.slice(corte).trimStart();
    }
  }
  if (actual) partes.push(actual);

  for (let i = 0; i < partes.length; i++) {
    const esUltimo = i === partes.length - 1;
    await ctx.reply(partes[i], {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(esUltimo ? extra : {}),
    });
  }
}

// ── Categorías del sitio ───────────────────────────────────────────────────
async function getCategories() {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/categories?per_page=100`);
  if (!res.ok) throw new Error(`No se pudieron obtener categorías: ${res.status}`);
  const data = await res.json();
  return data.map(c => ({ id: c.id, name: limpiarHtml(c.name) }));
}

// ── Verificación: investiga en la web, ubica el lugar y corrobora datos ────
async function verificarNoticia(textoCrudo) {
  const instrucciones =
    `Eres el editor de verificación (fact-checker) de colonaldia.hn, un periódico regional con sede en Tocoa, ` +
    `Colón, Honduras. Hoy es ${fechaHoy()}. Te llega material crudo para publicar: puede venir de WhatsApp, ` +
    `redes sociales, comunicados oficiales o de otros medios. El periódico NO puede publicar información falsa, ` +
    `así que antes de redactar debes investigar en la web.\n\n` +
    `Tareas:\n` +
    `1. LUGAR: determina dónde ocurrió el hecho (ciudad o municipio, departamento y país). NO asumas que es de ` +
    `Tocoa ni de Colón: muchas noticias son de otras ciudades de Honduras o de otros países. Usa las pistas del ` +
    `texto (nombres de colonias, barrios, aldeas, instituciones, autoridades locales, hospitales, carreteras) y ` +
    `la búsqueda web. Si no se puede determinar con razonable seguridad, deja la ciudad vacía y confianza "baja".\n` +
    `2. HECHOS: identifica las afirmaciones verificables clave (qué pasó, cifras, nombres, cargos, fechas, ` +
    `instituciones) y búscalas en fuentes confiables (medios reconocidos, sitios oficiales del gobierno, ` +
    `policía, Ministerio Público, instituciones). Marca cada una como "confirmado" (una fuente confiable lo ` +
    `respalda), "no_confirmado" (no se encontró respaldo, lo cual es normal en hechos locales muy recientes) o ` +
    `"contradicho" (fuentes confiables dicen otra cosa; indica el dato correcto en "dato_correcto").\n` +
    `3. ALERTAS: señala si parece noticia vieja reciclada, rumor, cadena de WhatsApp, sátira, imagen o dato ` +
    `manipulado, acusaciones graves sin respaldo, o si el material parece copiado de otro medio (indica cuál).\n` +
    `4. VEREDICTO: "apto" (lo esencial está confirmado o es un hecho local verosímil sin contradicciones), ` +
    `"revisar" (hay datos sin confirmar importantes o dudas) o "no_publicar" (falso, contradicho en lo ` +
    `esencial, viejo presentado como nuevo, o acusación grave sin ningún respaldo).\n\n` +
    `Nunca inventes fuentes: en "fuentes" pon solo URLs que realmente encontraste en la búsqueda.\n\n` +
    `Responde SOLO con un JSON (sin texto antes ni después) con esta forma:\n` +
    `{"lugar":{"ciudad":"","departamento":"","pais":"","confianza":"alta|media|baja","evidencia":""},` +
    `"fecha_del_hecho":"","es_reciente":true,` +
    `"hechos":[{"afirmacion":"","estado":"confirmado|no_confirmado|contradicho","dato_correcto":"","nota":"","fuentes":[""]}],` +
    `"fuente_original":"","alertas":[""],"veredicto":"apto|revisar|no_publicar","resumen":""}`;

  const resp = await openai.responses.create({
    model: MODELO_PRINCIPAL,
    tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'HN', timezone: ZONA_HORARIA } }],
    instructions: instrucciones,
    input: `Material crudo recibido:\n\n${textoCrudo}`,
    max_output_tokens: 16000,
  });

  const verificacion = parsearJson(resp.output_text || '');

  // Fuentes que la búsqueda realmente consultó (citas de la API)
  const citas = new Map();
  for (const item of resp.output || []) {
    if (item.type !== 'message') continue;
    for (const c of item.content || []) {
      for (const a of c.annotations || []) {
        if (a.type === 'url_citation' && a.url && !citas.has(a.url)) citas.set(a.url, a.title || a.url);
      }
    }
  }
  verificacion.citas = Array.from(citas, ([url, titulo]) => ({ url, titulo }));
  verificacion.busquedas = (resp.output || []).filter(i => i.type === 'web_search_call').length;
  return verificacion;
}

function lugarDefinido(v) {
  return v?.lugar?.ciudad && v.lugar.confianza !== 'baja';
}

function textoLugar(lugar) {
  if (!lugar) return '';
  return [lugar.ciudad, lugar.departamento, lugar.pais].filter(Boolean).join(', ');
}

// ── Extrae palabras clave del hecho noticioso (nombres, lugares, tema) ────
async function extraerPalabrasClave(titulo, cuerpo) {
  const completion = await openai.chat.completions.create({
    model: MODELO_RAPIDO,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Lee esta noticia y extrae de 2 a 4 términos de búsqueda cortos que identifiquen el HECHO concreto ' +
          '(nombres de personas, instituciones, lugares o el tema específico), útiles para buscarla en el buscador ' +
          'de un sitio de noticias aunque esté redactada con otras palabras. Responde SOLO un JSON: ' +
          '{"terminos": ["...", "..."]}.',
      },
      { role: 'user', content: `Título: ${titulo}\n\nCuerpo: ${cuerpo}` },
    ],
  });
  const parsed = JSON.parse(completion.choices[0].message.content);
  return Array.isArray(parsed.terminos) ? parsed.terminos.filter(Boolean) : [];
}

// ── Buscar posibles noticias duplicadas ya publicadas ──────────────────────
async function buscarPosibleDuplicado(titulo, cuerpo) {
  const terminos = await extraerPalabrasClave(titulo, cuerpo);
  const consultas = [titulo, ...terminos];

  const candidatosPorId = new Map();
  for (const termino of consultas) {
    try {
      const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(termino)}&per_page=4&_fields=id,title,link,date`);
      if (!res.ok) continue;
      const posts = await res.json();
      for (const p of posts) {
        if (!candidatosPorId.has(p.id)) {
          candidatosPorId.set(p.id, { titulo: limpiarHtml(p.title.rendered), link: p.link, fecha: p.date });
        }
      }
    } catch { /* si una búsqueda falla, seguimos con las demás */ }
  }

  const candidatos = Array.from(candidatosPorId.values()).slice(0, 10);
  if (candidatos.length === 0) return null;

  const completion = await openai.chat.completions.create({
    model: MODELO_RAPIDO,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Te doy una noticia nueva (título y cuerpo) y una lista de títulos ya publicados en el sitio. ' +
          'Responde SOLO un JSON {"duplicado": true/false, "indice": N} donde indice es el índice (0-based) ' +
          'del título de la lista que trata sobre el MISMO hecho noticioso concreto que la noticia nueva ' +
          '(mismo suceso, mismas personas/lugar involucrados), aunque esté redactado distinto. Si ningún título ' +
          'trata del mismo hecho (aunque sea un tema parecido pero otro suceso), responde duplicado:false, indice:null.',
      },
      { role: 'user', content: JSON.stringify({ tituloNuevo: titulo, cuerpoNuevo: cuerpo, publicados: candidatos.map(c => c.titulo) }) },
    ],
  });

  const parsed = JSON.parse(completion.choices[0].message.content);
  if (parsed.duplicado && candidatos[parsed.indice]) return candidatos[parsed.indice];
  return null;
}

// ── IA: redactar la noticia usando el material + la verificación ───────────
async function redactarNoticia(textoCrudo, verificacion, lugar, categorias, numImagenesAMarcar) {
  const listaCategorias = categorias.map(c => c.name).join(', ');

  let instruccionImagenes = '';
  if (numImagenesAMarcar > 0) {
    const marcadores = Array.from({ length: numImagenesAMarcar }, (_, i) => `{{IMG_${i + 2}}}`).join(', ');
    instruccionImagenes =
      ` Además tienes ${numImagenesAMarcar} imagen(es) adicional(es) para insertar DENTRO del cuerpo ` +
      `(aparte de la foto de portada, que no se menciona en el texto). Marca los lugares donde deberían ir, ` +
      `en los puntos donde tenga más sentido editorialmente, usando exactamente estos marcadores una vez cada uno, ` +
      `cada uno en su propio párrafo: ${marcadores}.`;
  }

  const esHonduras = !lugar.pais || /honduras/i.test(lugar.pais);
  const dateline = esHonduras
    ? `${lugar.ciudad}${lugar.departamento ? ', ' + lugar.departamento : ''}: -`
    : `${lugar.ciudad}${lugar.pais ? ', ' + lugar.pais : ''}: -`;

  const completion = await openai.chat.completions.create({
    model: MODELO_PRINCIPAL,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Eres redactor de colonaldia.hn, un periódico regional con sede en Tocoa, Colón, Honduras. ' +
          `Hoy es ${fechaHoy()}. Redacta una noticia lista para publicar a partir del material crudo y del ` +
          'informe de verificación que te doy.\n\n' +
          'Reglas de rigor periodístico (obligatorias):\n' +
          '- Usa SOLO hechos que estén en el material o en el informe de verificación. No inventes nombres, cifras, ' +
          'fechas, citas ni detalles.\n' +
          '- Hechos "contradicho": NO los afirmes. Si el informe trae el dato correcto de una fuente confiable, usa ' +
          'el dato correcto; si no, omítelos.\n' +
          '- Hechos "no_confirmado": atribúyelos ("según información preliminar", "según reportes", "según ' +
          'familiares", "según el comunicado de...") o omítelos si son acusaciones graves.\n' +
          '- Personas señaladas de delitos: usa presunción de inocencia ("presunto", "supuesto").\n' +
          '- Puedes añadir contexto breve que el informe haya CONFIRMADO con fuentes.\n' +
          '- El material puede ser largo y venir en varias partes: léelo completo y no omitas datos importantes.\n\n' +
          'Responde SOLO un JSON con las claves: ' +
          '"titulo" (llamativo, informativo, sin comillas), ' +
          '"subtitulo" (una frase corta tipo bajada periodística, que amplíe el título sin repetirlo), ' +
          '"descripcion" (resumen de 1-2 frases para SEO/redes), ' +
          '"cuerpo" (noticia completa en formato periodístico, párrafos separados por doble salto de línea. ' +
          `El PRIMER párrafo debe empezar EXACTAMENTE con este dateline: "${dateline}" seguido del primer ` +
          'párrafo en la misma línea. No cambies el lugar del dateline: ya fue verificado.), ' +
          `"categorias" (array con 1 a 3 nombres EXACTOS de esta lista, las que mejor encajen: ${listaCategorias}).` +
          instruccionImagenes,
      },
      {
        role: 'user',
        content:
          `LUGAR VERIFICADO: ${textoLugar(lugar)}\n\n` +
          `INFORME DE VERIFICACIÓN:\n${JSON.stringify({
            fecha_del_hecho: verificacion?.fecha_del_hecho,
            hechos: verificacion?.hechos,
            alertas: verificacion?.alertas,
            resumen: verificacion?.resumen,
          })}\n\n` +
          `MATERIAL CRUDO:\n${textoCrudo}`,
      },
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

// ── IA: aplicar una edición pedida por el usuario ─────────────────────────
async function editarNoticia({ titulo, subtitulo, descripcion, cuerpo }, instruccion) {
  const completion = await openai.chat.completions.create({
    model: MODELO_PRINCIPAL,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Tienes una noticia ya redactada en JSON con las claves titulo, subtitulo, descripcion, cuerpo. ' +
          'El usuario (editor del periódico) pide un cambio específico. Aplica SOLO ese cambio y deja el resto ' +
          'igual, salvo que el cambio lo requiera. Conserva el dateline al inicio del cuerpo ("Ciudad, ' +
          'Departamento: -") salvo que el cambio pedido lo afecte directamente (por ejemplo, si corrige el lugar). ' +
          'Si el cuerpo contiene marcadores tipo {{IMG_2}}, {{IMG_3}}, etc., consérvalos en su lugar salvo que el ' +
          'cambio los afecte. Responde SOLO el JSON actualizado con esas mismas cuatro claves.',
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
  // Marcadores sobrantes (si la IA puso más de los necesarios)
  texto = texto.replace(/\{\{IMG_\d+\}\}/g, '');

  let html = (subtitulo ? `<p><em>${subtitulo}</em></p>` : '') + '<p>' + texto.split('\n\n').join('</p><p>') + '</p>';
  html = html.replace(/<p>\s*<\/p>/g, '');

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

// ── Descargar un archivo de Telegram ───────────────────────────────────────
async function descargarArchivo(telegram, fileId) {
  const fileLink = await telegram.getFileLink(fileId);
  const res = await fetch(fileLink.href);
  if (!res.ok) throw new Error(`No se pudo descargar el archivo de Telegram (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

// ══════════════════════════════════════════════════════════════════════════
//  RECOPILACIÓN: el usuario puede mandar varios mensajes de texto (Telegram
//  corta los textos largos en partes), fotos sueltas o álbumes, y archivos
//  .txt. Todo se junta hasta que toca "✍️ Redactar".
// ══════════════════════════════════════════════════════════════════════════
function nuevoBorrador() {
  return { stage: 'recopilando', textos: [], fotosIds: [], msgEstado: null, timerEstado: null };
}

function obtenerBorradorRecopilando(ctx) {
  let draft = drafts.get(ctx.chat.id);
  if (draft && draft.stage === 'recopilando') return { draft, descartado: false };
  // Si lo pendiente era solo el tuit (la noticia ya está publicada), no es una noticia perdida
  const descartado = !!draft && !String(draft.stage).startsWith('x_');
  draft = nuevoBorrador();
  drafts.set(ctx.chat.id, draft);
  return { draft, descartado };
}

function programarEstado(ctx, draft) {
  clearTimeout(draft.timerEstado);
  draft.timerEstado = setTimeout(() => mostrarEstadoRecopilacion(ctx, draft).catch(console.error), 1500);
}

async function mostrarEstadoRecopilacion(ctx, draft) {
  if (drafts.get(ctx.chat.id) !== draft || draft.stage !== 'recopilando') return;
  const caracteres = draft.textos.reduce((n, t) => n + t.texto.length, 0);
  const texto =
    `📥 Material recibido: ${draft.textos.length} texto(s) (${caracteres.toLocaleString('es-HN')} caracteres)` +
    `${draft.fotosIds.length ? `, ${draft.fotosIds.length} foto(s)` : ''}.\n\n` +
    'Puedes seguir mandando más texto o fotos. Cuando termines, toca ✍️ Redactar.';

  // Se borra el aviso anterior para que los botones queden siempre abajo
  if (draft.msgEstado) {
    ctx.telegram.deleteMessage(ctx.chat.id, draft.msgEstado).catch(() => {});
  }
  const msg = await ctx.reply(texto, Markup.inlineKeyboard([
    [Markup.button.callback('✍️ Redactar', 'redactar')],
    [Markup.button.callback('❌ Cancelar', 'cancelar')],
  ]));
  draft.msgEstado = msg.message_id;
}

async function agregarMaterial(ctx, { texto, fotoId }) {
  const { draft, descartado } = obtenerBorradorRecopilando(ctx);
  if (descartado) {
    await ctx.reply('ℹ️ Tenías una noticia pendiente sin publicar; la descarté y empecé una nueva con este material.');
  }
  const messageId = ctx.message.message_id;
  if (texto && texto.trim()) draft.textos.push({ messageId, texto: texto.trim() });
  if (fotoId) draft.fotosIds.push({ messageId, fileId: fotoId });
  programarEstado(ctx, draft);
}

// ══════════════════════════════════════════════════════════════════════════
//  FLUJO PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════
async function iniciarProceso(ctx, draft) {
  clearTimeout(draft.timerEstado);
  if (draft.msgEstado) ctx.telegram.deleteMessage(ctx.chat.id, draft.msgEstado).catch(() => {});

  const textoCrudo = draft.textos
    .sort((a, b) => a.messageId - b.messageId)
    .map(t => t.texto)
    .join('\n\n');

  if (!textoCrudo.trim()) {
    draft.msgEstado = null;
    return ctx.reply('Todavía no me mandaste el texto de la noticia. Mándalo y luego toca ✍️ Redactar.');
  }

  draft.stage = 'procesando';
  draft.textoCrudo = textoCrudo;

  await ctx.reply(
    `🔎 Investigando y verificando la noticia en la web (${textoCrudo.length.toLocaleString('es-HN')} caracteres` +
    `${draft.fotosIds.length ? `, ${draft.fotosIds.length} foto(s)` : ''}). Esto puede tardar 1–2 minutos...`
  );

  // Descargar fotos en orden
  const ordenadas = draft.fotosIds.sort((a, b) => a.messageId - b.messageId);
  draft.fotos = [];
  for (const f of ordenadas) {
    const buffer = await descargarArchivo(ctx.telegram, f.fileId);
    draft.fotos.push({ buffer, filename: `telegram-${Date.now()}-${draft.fotos.length}.jpg` });
  }

  try {
    draft.verificacion = await verificarNoticia(textoCrudo);
  } catch (err) {
    console.error('Error en verificación:', err);
    draft.verificacion = {
      lugar: { ciudad: '', departamento: '', pais: '', confianza: 'baja', evidencia: '' },
      hechos: [],
      alertas: [`No se pudo verificar en la web (${err.message}). Revisa los datos manualmente.`],
      veredicto: 'revisar',
      resumen: '',
      citas: [],
      error: true,
    };
  }

  await mostrarInformeVerificacion(ctx, draft.verificacion);

  if (lugarDefinido(draft.verificacion)) {
    draft.lugar = draft.verificacion.lugar;
    await continuarConRedaccion(ctx, draft);
  } else {
    draft.stage = 'esperando_lugar';
    await ctx.reply(
      '📍 No pude confirmar dónde ocurrió el hecho' +
      (draft.verificacion.lugar?.ciudad ? ` (lo más probable: ${textoLugar(draft.verificacion.lugar)}, pero no es seguro)` : '') +
      '.\n\nEscríbeme el lugar así: Ciudad, Departamento (ej: "Trujillo, Colón" o "San Pedro Sula, Cortés"). ' +
      'Si es fuera de Honduras: Ciudad, País.'
    );
  }
}

async function continuarConRedaccion(ctx, draft) {
  draft.stage = 'procesando';
  await ctx.reply(`✍️ Redactando la noticia (lugar: ${textoLugar(draft.lugar)})...`);

  const categoriasDisponibles = await getCategories();
  const numAdicionalesAMarcar = draft.fotos.length > 2 ? draft.fotos.length - 1 : 0;
  const resultado = await redactarNoticia(
    draft.textoCrudo, draft.verificacion, draft.lugar, categoriasDisponibles, numAdicionalesAMarcar
  );

  Object.assign(draft, {
    titulo: resultado.titulo,
    subtitulo: resultado.subtitulo,
    descripcion: resultado.descripcion,
    cuerpo: resultado.cuerpo,
    categoriasDisponibles,
    categoriasSeleccionadas: resultado.categoriasSugeridas,
    portada: false,
    msgCategorias: null,
    dupAceptado: false,
    verifAceptada: draft.verificacion.veredicto !== 'no_publicar',
  });

  draft.duplicadoDetectado = await buscarPosibleDuplicado(draft.titulo, draft.cuerpo).catch(err => {
    console.error('Error buscando duplicados:', err);
    return null;
  });

  await siguientePaso(ctx, draft);
}

// Decide qué mostrar según las alertas pendientes
async function siguientePaso(ctx, draft) {
  if (draft.duplicadoDetectado && !draft.dupAceptado) {
    draft.stage = 'revisando_duplicado';
    return mostrarAvisoDuplicado(ctx, draft.duplicadoDetectado);
  }
  if (!draft.verifAceptada) {
    draft.stage = 'revisando_verificacion';
    return ctx.reply(
      '⛔ La verificación recomienda NO publicar esta noticia (revisa el informe de arriba).\n\n' +
      '¿Quieres continuar de todos modos? Podrás revisar y editar el texto antes de publicar.',
      Markup.inlineKeyboard([
        [Markup.button.callback('⚠️ Continuar bajo mi responsabilidad', 'verif_continuar')],
        [Markup.button.callback('❌ Descartar', 'cancelar')],
      ])
    );
  }
  draft.stage = 'categorias';
  await mostrarSeleccionCategorias(ctx, draft);
}

// ── UI: informe de verificación ─────────────────────────────────────────────
async function mostrarInformeVerificacion(ctx, v) {
  const iconoVeredicto = { apto: '✅ Apto para publicar', revisar: '⚠️ Revisar antes de publicar', no_publicar: '⛔ No publicar' };
  const iconoEstado = { confirmado: '✅', no_confirmado: '❓', contradicho: '❌' };

  let html = '<b>🔎 Informe de verificación</b>\n\n';
  html += `<b>Veredicto:</b> ${iconoVeredicto[v.veredicto] || esc(v.veredicto)}\n`;
  if (v.lugar?.ciudad) {
    html += `<b>📍 Lugar:</b> ${esc(textoLugar(v.lugar))} <i>(confianza ${esc(v.lugar.confianza)})</i>\n`;
    if (v.lugar.evidencia) html += `<i>${esc(v.lugar.evidencia)}</i>\n`;
  } else {
    html += '<b>📍 Lugar:</b> no determinado\n';
  }
  if (v.fecha_del_hecho) html += `<b>📅 Fecha del hecho:</b> ${esc(v.fecha_del_hecho)}${v.es_reciente === false ? ' ⚠️ <b>no es reciente</b>' : ''}\n`;
  if (v.fuente_original) html += `<b>📰 Fuente original probable:</b> ${esc(v.fuente_original)}\n`;
  if (v.resumen) html += `\n${esc(v.resumen)}\n`;

  if (v.hechos?.length) {
    html += '\n<b>Datos revisados:</b>\n';
    for (const h of v.hechos) {
      html += `${iconoEstado[h.estado] || '•'} ${esc(h.afirmacion)}`;
      if (h.estado === 'contradicho' && h.dato_correcto) html += ` → <b>dato correcto:</b> ${esc(h.dato_correcto)}`;
      if (h.nota) html += ` <i>(${esc(h.nota)})</i>`;
      const fuentes = (h.fuentes || []).filter(u => /^https?:\/\//.test(u)).slice(0, 2);
      if (fuentes.length) html += ' ' + fuentes.map((u, i) => `<a href="${esc(u)}">[${i + 1}]</a>`).join(' ');
      html += '\n';
    }
  }

  const alertas = (v.alertas || []).filter(Boolean);
  if (alertas.length) {
    html += '\n<b>⚠️ Alertas:</b>\n' + alertas.map(a => `• ${esc(a)}`).join('\n') + '\n';
  }

  if (v.citas?.length) {
    html += `\n<b>Fuentes consultadas</b> (${v.busquedas || 0} búsqueda(s)):\n`;
    html += v.citas.slice(0, 8).map(c => `• <a href="${esc(c.url)}">${esc(c.titulo)}</a>`).join('\n');
  } else if (!v.error) {
    html += '\n<i>No se encontraron fuentes en la web sobre este hecho.</i>';
  }

  await enviarLargo(ctx, html);
}

// ── UI: aviso de posible duplicado ─────────────────────────────────────────
async function mostrarAvisoDuplicado(ctx, duplicado) {
  await ctx.reply(
    `⚠️ Ya existe una noticia parecida:\n\n<b>${esc(duplicado.titulo)}</b>\n${esc(duplicado.link)}\n\n¿La publico de todos modos?`,
    { parse_mode: 'HTML', disable_web_page_preview: true, ...Markup.inlineKeyboard([
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

  const iconoVeredicto = { apto: '✅ Apto', revisar: '⚠️ Revisar', no_publicar: '⛔ No publicar' };

  const preview =
    `📰 <b>${esc(draft.titulo)}</b>\n` +
    `<i>${esc(draft.subtitulo)}</i>\n\n` +
    `${esc(draft.cuerpo)}\n\n` +
    `🏷️ Categorías: <b>${esc(nombresCategorias)}</b>\n` +
    `📍 Lugar: <b>${esc(textoLugar(draft.lugar))}</b>\n` +
    `🔎 Verificación: <b>${iconoVeredicto[draft.verificacion?.veredicto] || '—'}</b>\n` +
    `⭐ Portada: <b>${draft.portada ? 'Sí' : 'No'}</b>\n` +
    (draft.fotos.length ? `🖼️ ${draft.fotos.length} foto(s) adjunta(s)` : '⚠️ Sin fotos');

  const autores = getAuthors();
  await enviarLargo(ctx, preview, Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Editar', 'editar')],
    ...autores.map(a => [Markup.button.callback(`✅ Publicar como ${a.nombre}`, `autor_${a.id}`)]),
    [Markup.button.callback('✅ Publicar (cuenta admin)', 'autor_0')],
    [Markup.button.callback('❌ Cancelar', 'cancelar')],
  ]));
}

// ══════════════════════════════════════════════════════════════════════════
//  X (TWITTER)
// ══════════════════════════════════════════════════════════════════════════
const X_LIMITE = 280;
const X_LARGO_ENLACE = 23; // X cuenta cualquier enlace como 23 caracteres

// Largo aproximado según X: los emojis y caracteres fuera de BMP cuentan doble
function largoX(texto) {
  return Array.from(texto).reduce((n, ch) => n + (ch.codePointAt(0) > 0xffff ? 2 : 1), 0);
}

function recortarParaX(texto, maximo) {
  if (largoX(texto) <= maximo) return texto;
  let recortado = texto;
  while (largoX(recortado + '…') > maximo) {
    const corte = recortado.lastIndexOf(' ');
    recortado = corte > 0 ? recortado.slice(0, corte) : recortado.slice(0, -1);
  }
  return recortado.trimEnd() + '…';
}

function maximoTextoTuit() {
  return X_INCLUIR_ENLACE ? X_LIMITE - X_LARGO_ENLACE - 2 : X_LIMITE;
}

// Sin enlace: quita URLs y dominios (X los convierte en enlace y cobra la tarifa de tuit con enlace)
function quitarEnlaces(texto) {
  return texto
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:hn|com|net|org|info|news|tv|co|io|me|ly)\b\S*/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const REGLA_ENLACE = () => X_INCLUIR_ENLACE
  ? 'NO incluyas enlaces (se agregan aparte).'
  : 'NO escribas enlaces, URLs ni nombres de dominio (ni "colonaldia.hn"): X los convierte en enlace. ' +
    'Termina con una línea corta tipo "📲 Nota completa en nuestro sitio web".';

function armarTuit(texto, link) {
  const limpio = X_INCLUIR_ENLACE ? texto.trim() : quitarEnlaces(texto);
  const cuerpo = recortarParaX(limpio, maximoTextoTuit());
  return X_INCLUIR_ENLACE && link ? `${cuerpo}\n\n${link}` : cuerpo;
}

async function redactarTuit({ titulo, descripcion, cuerpo, lugar }) {
  const maximo = maximoTextoTuit() - 10; // margen de seguridad
  const completion = await openai.chat.completions.create({
    model: MODELO_RAPIDO,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Eres el community manager de un medio de noticias regional de Colón, Honduras. Escribe UN tuit para ' +
          'difundir esta noticia ya publicada. Reglas: informativo y directo, en español de Honduras; que diga qué ' +
          'pasó y dónde; sin exagerar ni agregar datos que no estén en la noticia; sin clickbait engañoso; ' +
          'presunción de inocencia ("presunto") si hay personas señaladas de delitos; puede empezar con un emoji ' +
          'adecuado (ej: 🔴 para hechos urgentes, 📍 para lugar) y llevar como máximo 2 hashtags relevantes al ' +
          `final. ${REGLA_ENLACE()} Máximo ${maximo} caracteres. ` +
          'Responde SOLO un JSON: {"tuit": "..."}',
      },
      {
        role: 'user',
        content: JSON.stringify({ titulo, descripcion, lugar: textoLugar(lugar), cuerpo: cuerpo?.slice(0, 4000) }),
      },
    ],
  });
  return JSON.parse(completion.choices[0].message.content).tuit || titulo;
}

async function editarTuit(textoActual, instruccion) {
  const maximo = maximoTextoTuit() - 10;
  const completion = await openai.chat.completions.create({
    model: MODELO_RAPIDO,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Tienes un tuit de un medio de noticias. El editor te manda un mensaje: si es un tuit completo ya ' +
          'escrito por él, úsalo tal cual (sin cambiar palabras); si es una instrucción ("más corto", "quita el ' +
          'hashtag", "menciona que..."), aplícala al tuit actual. ' + REGLA_ENLACE() + ' ' +
          `Máximo ${maximo} caracteres. Responde SOLO un JSON: {"tuit": "..."}`,
      },
      { role: 'user', content: `Tuit actual: ${textoActual}\n\nMensaje del editor: ${instruccion}` },
    ],
  });
  return JSON.parse(completion.choices[0].message.content).tuit || textoActual;
}

async function mostrarPreviewTuit(ctx, draft) {
  const tuit = armarTuit(draft.x.texto, draft.x.link);
  const largo = largoX(draft.x.texto.trim()) + (X_INCLUIR_ENLACE ? X_LARGO_ENLACE + 2 : 0);
  const html =
    '🐦 <b>Tuit para X</b>\n\n' +
    `${esc(tuit)}\n\n` +
    `<i>${Math.min(largo, X_LIMITE)}/${X_LIMITE} caracteres` +
    `${draft.x.foto ? ' · con la foto de portada' : ' · sin foto'}</i>`;
  await enviarLargo(ctx, html, Markup.inlineKeyboard([
    [Markup.button.callback('🐦 Publicar en X', 'x_publicar')],
    [Markup.button.callback('✏️ Editar tuit', 'x_editar')],
    [Markup.button.callback('⏭️ No publicar en X', 'x_omitir')],
  ]));
}

async function publicarEnX(draft) {
  let mediaIds;
  let avisoFoto = '';
  if (draft.x.foto) {
    try {
      const mediaId = await xClient.v2.uploadMedia(draft.x.foto, { media_type: 'image/jpeg' });
      mediaIds = [mediaId];
    } catch (err) {
      console.error('Error subiendo foto a X:', err);
      avisoFoto = ' (no se pudo subir la foto, se publicó sin imagen)';
    }
  }
  const { data } = await xClient.v2.tweet({
    text: armarTuit(draft.x.texto, draft.x.link),
    ...(mediaIds ? { media: { media_ids: mediaIds } } : {}),
  });
  return { url: `https://x.com/i/web/status/${data.id}`, avisoFoto };
}

function describirErrorX(err) {
  const codigo = err?.code || err?.data?.status;
  if (codigo === 401) return 'credenciales de X inválidas (revisa X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN y X_ACCESS_SECRET).';
  if (codigo === 402) return 'la cuenta de desarrollador de X no tiene saldo/créditos para publicar.';
  if (codigo === 403) return 'X rechazó el tuit (permisos de la app en "Read and write", tuit duplicado o contenido no permitido). ' +
    (err?.data?.detail || '');
  if (codigo === 429) return 'se alcanzó el límite de publicaciones de X; intenta más tarde.';
  return err?.data?.detail || err?.message || String(err);
}

// Convierte lo que el editor escribió o dijo ("es en Trujillo, Colón", "San Pedro Sula")
// en { ciudad, departamento, pais }
async function interpretarLugar(texto) {
  const completion = await openai.chat.completions.create({
    model: MODELO_RAPIDO,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'El editor de un periódico hondureño indica dónde ocurrió una noticia. Extrae el lugar. Si es en ' +
          'Honduras, completa el departamento si es obvio por la ciudad (ej: Trujillo → Colón, San Pedro Sula → ' +
          'Cortés). Respeta lo que dijo el editor; no inventes. Responde SOLO un JSON: ' +
          '{"ciudad": "", "departamento": "", "pais": ""}. Si no menciona ningún lugar, ciudad vacía.',
      },
      { role: 'user', content: texto },
    ],
  });
  const l = JSON.parse(completion.choices[0].message.content);
  return { ciudad: (l.ciudad || '').trim(), departamento: (l.departamento || '').trim(), pais: (l.pais || 'Honduras').trim() };
}

// ══════════════════════════════════════════════════════════════════════════
//  NOTAS DE VOZ / AUDIOS
// ══════════════════════════════════════════════════════════════════════════
const PISTAS_TRANSCRIPCION =
  'Noticia de Colón, Honduras. Lugares: Tocoa, Trujillo, Sabá, Bonito Oriental, Sonaguera, Balfate, Limón, ' +
  'Iriona, Santa Fe, Santa Rosa de Aguán, Valle del Aguán, Francisco Morazán, Tegucigalpa, San Pedro Sula, ' +
  'La Ceiba. Instituciones: Policía Nacional, DPI, Ministerio Público, COPECO, alcaldía, regidor, diputado.';

async function transcribirAudio(buffer, nombreArchivo) {
  const intentar = async (model) => openai.audio.transcriptions.create({
    file: await toFile(buffer, nombreArchivo),
    model,
    language: 'es',
    prompt: PISTAS_TRANSCRIPCION,
  });
  let resultado;
  try {
    resultado = await intentar(MODELO_TRANSCRIPCION);
  } catch (err) {
    if (MODELO_TRANSCRIPCION === 'whisper-1') throw err;
    console.error(`Falló ${MODELO_TRANSCRIPCION}, reintentando con whisper-1:`, err.message);
    resultado = await intentar('whisper-1');
  }
  return (resultado.text || '').trim();
}

async function manejarAudio(ctx, fileId, nombreArchivo, tamano, { esVideo = false } = {}) {
  if (tamano && tamano > 20 * 1024 * 1024) {
    const mb = Math.round(tamano / 1024 / 1024);
    return ctx.reply(esVideo
      ? `El video pesa ${mb} MB y Telegram solo deja a los bots descargar hasta 20 MB. ` +
        'Mándame solo el audio (o una nota de voz contando la noticia), o el video comprimido/recortado.'
      : `El audio pesa ${mb} MB y Telegram solo deja a los bots descargar hasta 20 MB. Mándalo más corto o en partes.`);
  }
  const draft = drafts.get(ctx.chat.id);
  if (draft?.stage === 'procesando' || draft?.stage === 'x_procesando') {
    return ctx.reply('⏳ Estoy trabajando en la noticia, espera un momento.');
  }
  // Se procesa aparte para no bloquear a Telegram mientras se transcribe
  (async () => {
    const aviso = await ctx.reply(esVideo ? '🎬 Transcribiendo el audio del video...' : '🎙️ Transcribiendo audio...');
    try {
      const buffer = await descargarArchivo(ctx.telegram, fileId);
      const texto = await transcribirAudio(buffer, nombreArchivo);
      ctx.telegram.deleteMessage(ctx.chat.id, aviso.message_id).catch(() => {});
      if (!texto) {
        return ctx.reply(esVideo
          ? 'El video no tiene voz que pueda transcribir. Mándame el texto de la noticia o una nota de voz.'
          : 'No entendí nada en el audio. ¿Puedes repetirlo con menos ruido?');
      }
      await enviarLargo(ctx, `🎙️ <b>Transcripción:</b>\n<i>${esc(texto)}</i>`);
      await manejarTexto(ctx, texto, { esAudio: true, esVideo });
    } catch (err) {
      console.error('Error transcribiendo audio:', err);
      ctx.telegram.deleteMessage(ctx.chat.id, aviso.message_id).catch(() => {});
      await ctx.reply(esVideo
        ? `No pude sacar el audio del video (${err.message}). Si no tiene voz, mándame el texto o una nota de voz.`
        : `No pude transcribir el audio: ${err.message}`);
    }
  })().catch(console.error);
}

// Ejecuta un proceso largo sin bloquear el webhook de Telegram
function enSegundoPlano(ctx, draft, fn) {
  fn().catch(async (err) => {
    console.error(err);
    if (draft && drafts.get(ctx.chat.id) === draft && draft.stage === 'procesando') {
      // Permite reintentar sin perder el material
      draft.stage = 'recopilando';
      draft.msgEstado = null;
      await ctx.reply(`Ocurrió un error: ${err.message}`).catch(() => {});
      await mostrarEstadoRecopilacion(ctx, draft).catch(() => {});
    } else {
      await ctx.reply(`Ocurrió un error: ${err.message}`).catch(() => {});
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  HANDLERS DE TELEGRAM
// ══════════════════════════════════════════════════════════════════════════
const AYUDA =
  '👋 Mándame la noticia: puedes pegar textos largos (aunque Telegram los parta en varios mensajes), ' +
  'enviar varias fotos o un álbum, notas de voz 🎙️ (las transcribo), o un archivo .txt. ' +
  'Todo se junta en un solo borrador.\n\n' +
  'También puedes responder con audio cuando te pida el lugar o un cambio.\n\n' +
  'Cuando termines, toca ✍️ Redactar (o escribe /listo). Antes de redactar, investigo el hecho en la web, ' +
  'confirmo dónde ocurrió y corroboro los datos.\n\n' +
  'Comandos: /listo para redactar, /cancelar para descartar.';

bot.start((ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');
  return ctx.reply(AYUDA);
});
bot.help((ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');
  return ctx.reply(AYUDA);
});

bot.command('listo', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft || draft.stage !== 'recopilando') return ctx.reply('No hay material pendiente. Mándame la noticia primero.');
  enSegundoPlano(ctx, draft, () => iniciarProceso(ctx, draft));
});

bot.command('cancelar', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (draft) clearTimeout(draft.timerEstado);
  drafts.delete(ctx.chat.id);
  await ctx.reply('❌ Noticia descartada.');
});

// ── Mensajes de texto ──────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');
  await manejarTexto(ctx, ctx.message.text);
});

// Texto escrito o transcrito de un audio: según el paso en que va la noticia,
// es material nuevo, el lugar del hecho o un cambio pedido.
async function manejarTexto(ctx, texto, { esAudio = false, esVideo = false } = {}) {
  const draft = drafts.get(ctx.chat.id);

  if (draft?.stage === 'procesando') {
    return ctx.reply('⏳ Estoy trabajando en la noticia, espera un momento.');
  }

  if (draft?.stage === 'esperando_lugar') {
    enSegundoPlano(ctx, draft, async () => {
      draft.stage = 'procesando';
      const lugar = await interpretarLugar(texto);
      if (!lugar.ciudad) {
        draft.stage = 'esperando_lugar';
        return ctx.reply('No entendí el lugar. Escríbelo así: Ciudad, Departamento (ej: "Trujillo, Colón").');
      }
      draft.lugar = lugar;
      await continuarConRedaccion(ctx, draft);
    });
    return;
  }

  if (draft?.stage === 'x_editando') {
    enSegundoPlano(ctx, draft, async () => {
      draft.stage = 'x_procesando';
      await ctx.reply('Ajustando el tuit...');
      draft.x.texto = await editarTuit(draft.x.texto, texto);
      draft.stage = 'x_revisando';
      await mostrarPreviewTuit(ctx, draft);
    });
    return;
  }

  if (draft?.stage === 'x_procesando') {
    return ctx.reply('⏳ Estoy trabajando en el tuit, espera un momento.');
  }

  if (draft?.stage === 'editando') {
    enSegundoPlano(ctx, draft, async () => {
      await ctx.reply('Aplicando el cambio...');
      const actualizado = await editarNoticia(draft, texto);
      draft.titulo = actualizado.titulo;
      draft.subtitulo = actualizado.subtitulo;
      draft.descripcion = actualizado.descripcion;
      draft.cuerpo = actualizado.cuerpo;
      draft.stage = 'preview';
      await mostrarPreviewFinal(ctx, draft);
    });
    return;
  }

  const etiqueta = esVideo ? '(Transcripción del audio de un video) ' : esAudio ? '(Transcripción de nota de voz) ' : '';
  await agregarMaterial(ctx, { texto: etiqueta + texto });
}

// ── Notas de voz, audios y videonotas ───────────────────────────────────────
bot.on('voice', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');
  const v = ctx.message.voice;
  await manejarAudio(ctx, v.file_id, 'nota.ogg', v.file_size);
});

bot.on('audio', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');
  const a = ctx.message.audio;
  await manejarAudio(ctx, a.file_id, a.file_name || 'audio.mp3', a.file_size);
});

bot.on('video', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');
  const v = ctx.message.video;
  // El texto que acompaña al video (pie) también es material
  if (ctx.message.caption) await manejarTexto(ctx, ctx.message.caption);
  await manejarAudio(ctx, v.file_id, v.file_name || 'video.mp4', v.file_size, { esVideo: true });
});

bot.on('video_note', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');
  const v = ctx.message.video_note;
  await manejarAudio(ctx, v.file_id, 'videonota.mp4', v.file_size);
});

// ── Fotos (sueltas o en álbum) ─────────────────────────────────────────────
bot.on('photo', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (draft?.stage === 'procesando') return ctx.reply('⏳ Estoy trabajando en la noticia, espera un momento.');

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  await agregarMaterial(ctx, { texto: ctx.message.caption || '', fotoId: photo.file_id });
});

// ── Documentos: .txt (texto largo) o imágenes enviadas como archivo ───────
bot.on('document', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (draft?.stage === 'procesando') return ctx.reply('⏳ Estoy trabajando en la noticia, espera un momento.');

  const doc = ctx.message.document;
  const nombre = doc.file_name || '';
  const mime = doc.mime_type || '';

  if (mime.startsWith('image/')) {
    return agregarMaterial(ctx, { texto: ctx.message.caption || '', fotoId: doc.file_id });
  }

  if (mime.startsWith('audio/') || /\.(mp3|m4a|ogg|oga|opus|wav|aac|webm)$/i.test(nombre)) {
    return manejarAudio(ctx, doc.file_id, nombre || 'audio.ogg', doc.file_size);
  }

  if (mime.startsWith('video/') || /\.(mp4|mov|mpeg|mpg)$/i.test(nombre)) {
    // OpenAI no acepta la extensión .mov; los .mov de celular son compatibles con mp4
    return manejarAudio(ctx, doc.file_id, (nombre || 'video.mp4').replace(/\.mov$/i, '.mp4'), doc.file_size, { esVideo: true });
  }

  if (mime.startsWith('text/') || /\.(txt|md)$/i.test(nombre)) {
    if (doc.file_size > 2 * 1024 * 1024) return ctx.reply('El archivo es muy grande (máximo 2 MB).');
    try {
      const buffer = await descargarArchivo(ctx.telegram, doc.file_id);
      const contenido = buffer.toString('utf8');
      const texto = [ctx.message.caption, contenido].filter(Boolean).join('\n\n');
      return agregarMaterial(ctx, { texto });
    } catch (err) {
      console.error(err);
      return ctx.reply(`No pude leer el archivo: ${err.message}`);
    }
  }

  return ctx.reply('Solo acepto archivos de texto (.txt), imágenes o audios. Para Word, copia y pega el texto.');
});

// ── Botón: Redactar ─────────────────────────────────────────────────────────
bot.action('redactar', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft || draft.stage !== 'recopilando') return ctx.answerCbQuery('No hay material pendiente.');
  await ctx.answerCbQuery();
  enSegundoPlano(ctx, draft, () => iniciarProceso(ctx, draft));
});

// ── Aviso de duplicado / verificación: continuar ───────────────────────────
bot.action('dup_continuar', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft || draft.stage !== 'revisando_duplicado') return ctx.answerCbQuery('No hay ninguna noticia pendiente.');
  await ctx.answerCbQuery();
  draft.dupAceptado = true;
  await siguientePaso(ctx, draft);
});

bot.action('verif_continuar', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft || draft.stage !== 'revisando_verificacion') return ctx.answerCbQuery('No hay ninguna noticia pendiente.');
  await ctx.answerCbQuery();
  draft.verifAceptada = true;
  await siguientePaso(ctx, draft);
});

// ── Toggle de categorías ────────────────────────────────────────────────────
bot.action(/^cat_(\d+)$/, async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft || !draft.categoriasDisponibles) return ctx.answerCbQuery('No hay ninguna noticia pendiente.');

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
  if (!draft || !draft.categoriasDisponibles) return ctx.answerCbQuery('No hay ninguna noticia pendiente.');

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
  if (!draft || !draft.titulo) return ctx.answerCbQuery('No hay ninguna noticia pendiente.');

  draft.portada = ctx.match[1] === 'si';
  draft.stage = 'preview';
  await ctx.answerCbQuery();
  await mostrarPreviewFinal(ctx, draft);
});

// ── Editar ───────────────────────────────────────────────────────────────
bot.action('editar', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft || !draft.titulo) return ctx.answerCbQuery('No hay ninguna noticia pendiente.');

  draft.stage = 'editando';
  await ctx.answerCbQuery();
  await ctx.reply(
    '✏️ Escribe qué quieres cambiar (ej: "cambia el título a...", "acorta la descripción", ' +
    '"el hecho fue en Trujillo, no en Tocoa", "agrega un párrafo sobre..."). Te muestro la noticia actualizada después.'
  );
});

// ── Seleccionar autor y publicar ──────────────────────────────────────────
bot.action(/^autor_(\d+)$/, async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft || draft.stage !== 'preview') return ctx.answerCbQuery('No hay ninguna noticia pendiente.');

  const authorId = Number(ctx.match[1]) || undefined;
  draft.stage = 'publicando';

  await ctx.answerCbQuery();
  await ctx.reply('Publicando en colonaldia.hn...');

  try {
    let mediaId = null;
    let cuerpoHtml = construirCuerpoHtml(draft.subtitulo, draft.cuerpo, []);

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

    await ctx.reply(`✅ Publicado: ${post.link}`);

    if (!xClient) {
      drafts.delete(ctx.chat.id);
      return;
    }

    // Preparar el tuit (la noticia ya está publicada; esto es solo para X)
    draft.stage = 'x_procesando';
    draft.x = { link: post.link, foto: draft.fotos[0]?.buffer || null, texto: '' };
    try {
      draft.x.texto = await redactarTuit(draft);
    } catch (err) {
      console.error('Error redactando tuit:', err);
      draft.x.texto = draft.titulo;
    }
    draft.stage = 'x_revisando';
    await mostrarPreviewTuit(ctx, draft);
  } catch (err) {
    console.error(err);
    draft.stage = 'preview';
    await ctx.reply(`Error al publicar: ${err.message}`);
  }
});

// ── X: publicar / editar / omitir ──────────────────────────────────────────
bot.action('x_publicar', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft || draft.stage !== 'x_revisando' || !xClient) return ctx.answerCbQuery('No hay ningún tuit pendiente.');

  draft.stage = 'x_procesando';
  await ctx.answerCbQuery();
  await ctx.reply('Publicando en X...');
  try {
    const { url, avisoFoto } = await publicarEnX(draft);
    drafts.delete(ctx.chat.id);
    await ctx.reply(`✅ Publicado en X${avisoFoto}: ${url}`);
  } catch (err) {
    console.error('Error publicando en X:', err);
    draft.stage = 'x_revisando';
    await ctx.reply(`❌ No se pudo publicar en X: ${describirErrorX(err)}`, Markup.inlineKeyboard([
      [Markup.button.callback('🔁 Reintentar', 'x_publicar')],
      [Markup.button.callback('⏭️ No publicar en X', 'x_omitir')],
    ]));
  }
});

bot.action('x_editar', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (!draft || draft.stage !== 'x_revisando') return ctx.answerCbQuery('No hay ningún tuit pendiente.');
  draft.stage = 'x_editando';
  await ctx.answerCbQuery();
  await ctx.reply(
    '✏️ Escribe el tuit como lo quieres, o dime qué cambiar (ej: "más corto", "quita los hashtags", ' +
    '"empieza con 🔴 ÚLTIMA HORA").' + (X_INCLUIR_ENLACE ? ' El enlace se agrega solo.' : ' Va sin enlace ni dominio.')
  );
});

bot.action('x_omitir', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (draft && String(draft.stage).startsWith('x_')) drafts.delete(ctx.chat.id);
  await ctx.answerCbQuery('Listo');
  await ctx.reply('👍 No se publicó en X. La noticia ya está en el sitio.');
});

// ── Cancelar ─────────────────────────────────────────────────────────────
bot.action('cancelar', async (ctx) => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery('No autorizado.');
  const draft = drafts.get(ctx.chat.id);
  if (draft) clearTimeout(draft.timerEstado);
  drafts.delete(ctx.chat.id);
  await ctx.answerCbQuery('Cancelado');
  await ctx.reply('❌ Noticia descartada.');
});

bot.catch((err, ctx) => {
  console.error('Error no controlado:', err);
  ctx?.reply?.(`Ocurrió un error: ${err.message}`).catch(() => {});
});

// ── Servidor Express + Webhook de Telegram (para Render) ─────────────────
const app = express();
const webhookPath = `/telegraf/${TELEGRAM_BOT_TOKEN}`;

app.use(bot.webhookCallback(webhookPath));
app.get('/', (req, res) => res.send('Bot activo.'));

app.listen(PORT, async () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
  console.log(`Modelo principal: ${MODELO_PRINCIPAL} | Modelo rápido: ${MODELO_RAPIDO}`);
  console.log(xClient
    ? `Publicación en X: activada (${X_INCLUIR_ENLACE ? 'con' : 'sin'} enlace)`
    : 'Publicación en X: desactivada (faltan credenciales X_*)');
  if (RENDER_EXTERNAL_URL) {
    const webhookUrl = `${RENDER_EXTERNAL_URL}${webhookPath}`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`Webhook configurado en: ${RENDER_EXTERNAL_URL}/telegraf/***`);
  } else {
    console.log('RENDER_EXTERNAL_URL no está definida: configura el webhook manualmente si no estás en Render.');
  }
});
