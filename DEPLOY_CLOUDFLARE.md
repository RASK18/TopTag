# Deploy de TopTag con Cloudflare Worker

## 1. Crear el Worker

Instala y autentica Wrangler:

```bash
npm create cloudflare@latest toptag-steam-proxy
```

Cuando pregunte, elige un Worker sencillo sin framework. Despues sustituye el Worker generado por `cloudflare-worker.js` de este repo, o usa este repo directamente con `wrangler.toml.example` como base.

## 2. Configurar Wrangler

Cambia en `wrangler.toml`:

```toml
ALLOWED_ORIGINS = "null,https://TU_USUARIO.github.io"
```

Por el origen real de GitHub Pages. Ejemplos:

```toml
ALLOWED_ORIGINS = "null,https://rafa.github.io"
```

Nota: CORS compara solo el origen, no la ruta. Para GitHub Pages normalmente basta `https://TU_USUARIO.github.io`.

## 3. Guardar la Steam API key como secreto

```bash
npx wrangler secret put STEAM_API_KEY
```

Pega la key cuando Wrangler la pida. No la pongas en `index.html`, `app.js`, `wrangler.toml` ni en GitHub.

## 4. Desplegar

```bash
npx wrangler deploy
```

Wrangler devolvera una URL parecida a:

```text
https://toptag-steam-proxy.TU_SUBDOMINIO.workers.dev
```

Pon esa URL en `config.js` para que los usuarios no tengan que configurar nada:

```js
window.TOPTAG_CONFIG = {
  workerEndpoint: "https://toptag-steam-proxy.TU_SUBDOMINIO.workers.dev"
};
```

## 5. Probar

Abre:

```text
https://toptag-steam-proxy.TU_SUBDOMINIO.workers.dev/health
```

Debe devolver:

```json
{"ok":true}
```

## Endpoints del Worker

- `GET /health`
- `GET /resolve-vanity?vanity=...`
- `GET /owned-games?steamid=...`
- `GET /player-summary?steamid=...`
- `GET /appdetails?appid=...`
- `GET /steam-tags?appids=...`

El Worker no es un proxy abierto: solo permite esos endpoints concretos.
