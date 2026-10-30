# telegram-wp-publisher

Bot de Telegram que recibe una noticia cruda (texto + foto opcional), la redacta con ChatGPT
(título, descripción, cuerpo y categoría) y, tras tu confirmación, la publica en WordPress
(colonaldia.hn) vía la API REST.

## Cómo funciona

1. Le mandas al bot el material: texto (aunque sea largo y Telegram lo parta en varios mensajes),
   fotos sueltas o en álbum, o un archivo `.txt`. Todo se junta en un solo borrador.
2. Tocas **✍️ Redactar** (o escribes `/listo`).
3. **Verificación:** la IA investiga en la web (herramienta `web_search` de OpenAI) para:
   - determinar **dónde** ocurrió el hecho (no asume Tocoa ni Colón);
   - corroborar los datos clave (✅ confirmado / ❓ no confirmado / ❌ contradicho, con fuentes);
   - detectar noticias viejas, rumores, cadenas o material copiado de otro medio.
   Te muestra un informe con veredicto (✅ apto / ⚠️ revisar / ⛔ no publicar) y las fuentes consultadas.
4. Si no puede confirmar el lugar, te lo pregunta ("Ciudad, Departamento").
5. Redacta usando solo datos del material o confirmados; atribuye lo no confirmado y no afirma lo contradicho.
6. Revisa duplicados en el sitio. Si el veredicto es ⛔, pide confirmación extra antes de seguir.
7. Eliges categorías, portada, revisas el preview y publicas (o editas).

Comandos: `/listo`, `/cancelar`, `/start` (ayuda).

## 1. Crear el bot en Telegram

1. Habla con [@BotFather](https://t.me/BotFather) en Telegram.
2. `/newbot`, sigue los pasos, y te da un `TELEGRAM_BOT_TOKEN`.
3. Habla con [@userinfobot](https://t.me/userinfobot) para obtener tu `ALLOWED_CHAT_ID` (así nadie más puede usar el bot).

## 2. Conseguir la Application Password de WordPress

1. Entra a `https://colonaldia.hn/wp-admin`
2. Usuarios → Tu perfil → sección "Application Passwords"
3. Genera una nueva (ej: "Telegram Bot") y copia la contraseña que te da (solo se muestra una vez).

## 3. Variables de entorno

Copia `.env.example` a `.env` y llena los valores (para pruebas locales).

## 4. Probar localmente (opcional)

```bash
npm install
npm start
```

En local no hay `RENDER_EXTERNAL_URL`, así que tendrías que configurar el webhook manualmente o
usar `bot.launch()` en modo polling para pruebas. Si quieres, te preparo una variante para
probar en tu Mac antes de subir a Render.

## 5. Desplegar en Render

1. Sube esta carpeta a un repo de GitHub (igual que hiciste con xpublisher).
2. En Render: **New → Web Service**, conecta el repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. En **Environment**, agrega todas las variables de `.env.example` (excepto `RENDER_EXTERNAL_URL`,
   Render la define sola).
6. Deploy. Cuando arranque, el bot configura el webhook automáticamente — revisa los logs, debe
   decir "Webhook configurado en: ...".

## 6. Usarlo

Mándale al bot, por Telegram, el texto de la noticia (con o sin foto) y sigue el flujo de
confirmación.

## Notas

- Las categorías se traen en vivo desde tu sitio (`/wp-json/wp/v2/categories`), así que si
  agregas o cambias categorías en WordPress, el bot las ve automáticamente sin tocar código.
- El post se publica directo (`status: 'publish'`) en cuanto confirmas — no queda como borrador.
- Si quieres que primero quede como borrador para revisar en WordPress antes de salir en vivo,
  se puede cambiar fácilmente (`status: 'draft'`).
