# telegram-wp-publisher

Bot de Telegram que recibe una noticia cruda (texto + foto opcional), la redacta con ChatGPT
(título, descripción, cuerpo y categoría) y, tras tu confirmación, la publica en WordPress
(colonaldia.hn) vía la API REST.

## Cómo funciona

1. Le mandas al bot el texto de la noticia (como pie de foto, o como mensaje de texto).
2. El bot llama a ChatGPT para redactarla y elegir la categoría (de las categorías reales de tu sitio).
3. Te devuelve un preview con botones ✅ Publicar / ❌ Cancelar.
4. Si confirmas, sube la foto y crea el post publicado en tu sitio.

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
