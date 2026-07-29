# Playbook: replicar el reporte diario en otra tienda

Este archivo **es el prompt**. Copialo entero y pegalo en Claude Code abierto en
el repo de la tienda que vas a montar o corregir.

`daily-report-zendi` es la implementacion de referencia. No la copies a ciegas:
lleva dentro decisiones que solo valen para esa tienda.

---

## PROMPT — copiar desde aqui

Vas a montar (o corregir) el reporte diario a Slack de esta tienda, tomando como
referencia el repo `diegordzsa/daily-report-zendi`, que ya esta resuelto.

### Reglas que no se negocian

1. **Mide, no asumas.** Cada dato que uses para decidir (zona horaria, moneda,
   retraso, deriva) tiene que venir de una llamada a la API o de un log real. Si
   no lo has medido, no lo afirmes: dilo y mide.
2. **Antes no publicar que publicar mal.** Si el gasto de Meta no esta
   consolidado, el reporte no sale. Un gasto subestimado infla ROAS y MER, y eso
   es peor que no tener reporte.
3. **No copies la config de Zendi.** Zona horaria, moneda y horas minimas son
   distintas en cada tienda. Copiar esos valores es el error mas probable de
   toda esta tarea.
4. **No crees un PAT nuevo de GitHub.** Ya existe uno con acceso a todos los
   repos, guardado en cron-job.org. Reutilizalo.
5. **Verifica antes de decir que funciona.** Nada de "deberia funcionar":
   ejecuta, lee la salida, pega la evidencia.

### Lo que tienes que preguntarme antes de empezar

- Nombre de la tienda y repo destino.
- **En que zona horaria se lee el reporte** (donde esta quien lo recibe). No es
  la de la tienda ni la de la cuenta de ads.
- Si ya existe el repo o hay que crearlo desde la referencia.
- Canal de Slack y si los secrets ya estan cargados en GitHub.

---

## Fase 0 — Inventario

Lee el repo destino y dime en una tabla corta:

- Que hay en `.github/workflows/` y si tiene `schedule:` o `workflow_dispatch:`.
- Que secrets espera (`src/config.js`) y cuales faltan por cargar.
- Si ya existe `src/freshness.js` y el guard en `report.js`.
- Que esta **hardcodeado y no parametrizado**. En la referencia esto pasa, y hay
  que arreglarlo por tienda:
  - `STORE_CURRENCY` esta declarado en `config.js` pero **no se usa en ningun
    sitio**; el simbolo `€` esta escrito a mano en `slack.js` y `claude.js`.
  - El codigo asume **Shopify factura en MXN y Meta gasta en EUR**
    (`fromMxn = n => n / eurToMxn`). Si esta tienda no cumple ambas cosas, esas
    conversiones dan cifras falsas sin fallar.

## Fase 1 — Diagnostico (antes de tocar codigo)

Los secrets viven en GitHub, no en local, asi que el diagnostico se hace con un
workflow temporal `workflow_dispatch` que **solo lee y loguea, nunca escribe a
Slack**. Crealo, hazle push a la rama por defecto (`workflow_dispatch` solo
funciona si el archivo esta ahi), dispara con `gh workflow run`, lee con
`gh run view <id> --log`, y **borralo al terminar**.

### 1.1 Cuenta de Meta — zona horaria y moneda

```
GET https://graph.facebook.com/v21.0/act_<META_AD_ACCOUNT_ID>
    ?fields=name,timezone_name,timezone_offset_hours_utc,currency
```

`timezone_name` es **el dato que gobierna todo**: define cuando cierra el dia
para Meta y por tanto la hora mas temprana a la que puede existir un reporte
fiable. En Zendi salio `America/Mexico_City` (UTC-6, sin horario de verano), o
sea que el dia cierra a las 06:00 UTC.

### 1.2 Shopify — zona horaria y moneda

```
GET https://<SHOPIFY_STORE_DOMAIN>/admin/api/<ver>/shop.json
Header: X-Shopify-Access-Token
```

Mira `iana_timezone`, `currency` y `money_format`. Compara `currency` con la de
Meta: **si no coinciden, el codigo de la referencia esta convirtiendo mal** y
hay que rehacer el formateo de moneda para esta tienda.

### 1.3 Retraso real del scheduler de GitHub

Solo si el repo ya venia con `schedule:`. Compara la hora del cron contra el
arranque real:

```
gh run list --workflow=<wf>.yml --limit 30 --json createdAt,event,conclusion
```

En Zendi, 25 ejecuciones dieron entre **+2 h 01 min y +3 h 44 min** de retraso,
sin patron. Da igual cual sea aqui: el resultado es que el cron de GitHub no
sirve para una hora fija. Lo unico util de esta medicion es saber cuanto se
desviaron los datos historicos.

### 1.4 Deriva de consolidacion de Meta

Esta es la medicion que decide la hora. En el mismo workflow temporal pide el
gasto **ya consolidado** de los ultimos 6 dias:

```
GET .../act_<id>/insights?time_range={since,until}&time_increment=1&level=account
    &fields=spend,impressions,clicks
```

Cruza cada dia contra lo que reporto la ejecucion de ese dia (los logs traen
`[Meta] Raw spend for <fecha>: <valor>`; si no existe esa linea, añadela al
codigo y mide hacia adelante). Sacas una tabla asi:

| Fecha | Reportado | Hora UTC | h post-cierre | Consolidado | Error |
|---|---|---|---|---|---|

En Zendi, a 3-4.7 h del cierre el error fue **-0.2 % a -0.7 %**, siempre por
debajo, y **plano** dentro de esa franja. Mas temprano no esta medido.

## Fase 2 — Decidir la hora de entrega

Calcula, en este orden:

1. **Cierre del dia** = 00:00 del dia siguiente en `timezone_name` de Meta,
   expresado en UTC.
2. **Hora mas temprana defendible** = cierre + `MIN_HOURS_AFTER_CLOSE`.
   Usa **3 h por defecto**. Solo baja de ahi si lo has medido con el probe de la
   Fase 5; nunca por corazonada.
3. **Traducelo a la zona de quien lo lee** y dimelo antes de configurar nada.

Si la hora que sale es mas tarde de lo que yo esperaba, **dimelo claro y
explicame por que**, con el calculo. No la adelantes para complacerme. En Zendi
la respuesta honesta fue "las 9:00 que pides son fisicamente imposibles porque
la tienda cierra el dia a las 08:00 de tu hora".

**Ojo con el horario de verano:** si la cuenta de Meta no cambia la hora
(Mexico) pero quien lee el reporte si (Madrid), configura el cron externo en la
zona **del lector**, no en UTC. Asi la hora local se mantiene todo el año y en
invierno el dato llega incluso mas consolidado. Comprueba en que direccion cae
antes de fijarlo.

## Fase 3 — Implementar

1. **Porta `src/freshness.js`** desde la referencia. Calcula el instante de
   cierre con `Intl.DateTimeFormat`, correcto en cambios de horario.
2. **Guard en `report.js`**, antes de cualquier fetch de datos: lee
   `timezone_name` de la API de Meta en cada ejecucion (con
   `META_ACCOUNT_TIMEZONE` como fallback), calcula las horas desde el cierre y,
   si no llega al minimo, manda aviso a Slack y `process.exit(1)`. Que se vea en
   rojo en Actions.
3. **Quita el bloque `schedule:`** del workflow. Deja solo `workflow_dispatch`.
4. **Variables de entorno** en el workflow, con los valores **medidos en la
   Fase 1**, no copiados: `META_ACCOUNT_TIMEZONE`, `MIN_HOURS_AFTER_CLOSE`,
   `REPORT_TIME_LABEL`, `STORE_LOCALE`.
5. **Moneda**: si Fase 1.2 revelo monedas distintas a las de Zendi, arregla
   `slack.js` y `claude.js`. No dejes el `€` a mano.
6. **Pie del reporte**: que diga cuantas horas llevaba consolidado el dato, y
   que `REPORT_TIME_LABEL` diga la hora real de envio. En la referencia decia
   "9:00 AM" cuando nunca salio a esa hora.

## Fase 4 — Verificar (con evidencia, no con fe)

1. `node --check` sobre todos los archivos de `src/`.
2. **Prueba la logica de fechas con casos concretos** antes de confiar en ella:
   verano e invierno de la zona de la cuenta, los dos saltos de horario de la
   zona del lector, fin de mes y fin de año. En la referencia esto pillo un
   error de mi expectativa, no del codigo — pero por eso se prueba.
3. Renderiza el reporte con datos falsos y enseñame el pie.
4. Verifica que los endpoints existen antes de configurar el cron externo:
   ```
   gh api repos/<owner>/<repo>/actions/workflows/<wf>.yml --jq '{name,state,path}'
   ```

## Fase 5 — Cron externo en cron-job.org

**Reutiliza el PAT existente** (ya tiene acceso a todos los repos). Un cronjob
por tienda; lo unico que cambia entre ellos es la URL y la hora.

- **URL:** `https://api.github.com/repos/<owner>/<repo>/actions/workflows/daily-report.yml/dispatches`
- **Method:** POST · **Body:** `{"ref":"main"}`
- **Headers:** `Accept: application/vnd.github+json`,
  `Authorization: Bearer <PAT>`, `X-GitHub-Api-Version: 2022-11-28`,
  `Content-Type: application/json`
- **Respuesta correcta: 204 No Content.** 401 = token mal copiado ·
  403 = falta permiso *Actions: Read and write* · 404 = URL con errata
- **Schedule:** modo *Custom*. Las listas son multiseleccion: `Ctrl`+clic, o
  escribe la expresion directamente en el campo *Crontab expression*.
  **Deja MINUTES con un solo valor** — si queda en *every*, dispara 120 veces al
  dia.
- Activa aviso por email al fallar. Sin cron de GitHub no hay red de seguridad.

**Para mantenerlo organizado con varias tiendas:**

- Usa **MANAGE FOLDERS** y mete todos los reportes en una carpeta.
- Nombra igual siempre: `<Tienda> reporte diario`, `<Tienda> probe frescura`.
- Manten una tabla, en el README de cada repo o en un doc comun:

  | Tienda | Repo | TZ cuenta Meta | Cierre UTC | Entrega | Moneda Shopify / Meta |
  |---|---|---|---|---|---|

- **Prueba con el probe, no con el reporte.** Ambos usan el mismo token y
  cabeceras, pero el probe no escribe en Slack. Asi validas la autenticacion sin
  mandar un reporte duplicado. Solo despues, si hace falta, prueba el del
  reporte asumiendo el duplicado.

### Probe opcional, para bajar la hora con datos

Si quiero el reporte antes de la hora que salio en la Fase 2, **no la bajes**:
monta `meta-freshness-probe.yml` (`workflow_dispatch`, solo loguea, nada de
Slack), disparalo 1 h y 2 h antes de la hora actual, deja correr ~5 dias y
compara cada muestra contra el valor consolidado. Si el error se mantiene en el
rango de la Fase 1.4, entonces si bajas la hora y `MIN_HOURS_AFTER_CLOSE`. Si se
dispara, se queda como esta y borras el probe.

## Fase 6 — Cerrar

- Borra los workflows temporales de diagnostico. No dejes basura en `main`.
- Documenta en `SETUP.md` del repo: por que no hay cron de GitHub, cual es la
  timezone de la cuenta, cuando cierra el dia, y por que la hora es esa.
- Resumeme: hora de entrega y su justificacion, que medi, que cambio respecto a
  la referencia, y que quedo pendiente.

---

## Valores de referencia (Zendi — no los copies, comparalos)

| Dato | Valor |
|---|---|
| Cuenta Meta | `Zendi MX 1` |
| TZ cuenta Meta | `America/Mexico_City` (UTC-6, sin DST) |
| Moneda Meta | EUR |
| Moneda Shopify | MXN |
| Cierre del dia | 06:00 UTC = 08:00 Madrid |
| `MIN_HOURS_AFTER_CLOSE` | 3 |
| Entrega | 11:00 Europe/Madrid |
| Deriva medida a 3-4.7 h | -0.2 % a -0.7 % |
| Retraso del cron de GitHub | +2 h 01 min a +3 h 44 min |
