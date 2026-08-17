/**
 * Design system for the staff console.
 *
 * The console used to be a wall of bordered tables with an owner-facing verdict of
 * "the worst UI I have ever seen". Everything visual now lives here so routes.ts can
 * describe screens instead of gluing tags: tokens, the shell, and the handful of
 * components the screens are built from.
 *
 * Two rules the whole system rests on:
 *  - saturated colour has exactly ONE job — "a guest is waiting for a human". Anywhere
 *    else it would drown out the only thing on screen that has a clock running.
 *  - the console stays usable with JavaScript off. Every form is POST → redirect; JS only
 *    smooths edges (textarea autogrow, double-submit guard, preview, polling).
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Bumped whenever CSS changes — the URL is immutable so browsers cache it forever. */
export const CSS_VERSION = 'v1';

export const CSS = `
:root{
  --bg:#F6F8FB; --surface:#FFFFFF; --surface-2:#EEF2F7; --hover:#F4F7FA;
  --border:#E3E8EF; --border-input:#7A8698;
  --text:#12181F; --text-2:#4A5A6E; --text-3:#66768A;
  --brand:#14385F; --brand-hover:#0E2947; --brand-tint:#E8EFF7;
  --wait-bg:#FFF6DE; --wait-br:#FFDC73; --wait-tx:#AA4D00;
  --err-bg:#FDECEA; --err-br:#F5C6C2; --err-tx:#B3261E;
  --ok:#107D32; --ok-bg:#E6F4EC;
  --ring:#14385F;
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:24px; --sp-6:32px; --sp-7:48px;
  --r-ctl:8px; --r-card:10px; --r-pill:999px;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box;}
html,body{margin:0;}
body{font:400 15px/1.55 var(--font);color:var(--text);background:var(--bg);
  -webkit-text-size-adjust:100%;}
a{color:var(--brand);}
:focus-visible{outline:none;box-shadow:0 0 0 2px #fff,0 0 0 4px var(--ring);}

/* ---------- shell ---------- */
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:var(--sp-4);
  height:56px;padding:0 var(--sp-4);background:var(--surface);border-bottom:1px solid var(--border);}
.topbar__brand{font-weight:600;font-size:15px;color:var(--text);text-decoration:none;}
.topbar__brand span{font-weight:400;font-size:13px;color:var(--text-3);margin-left:6px;}
.topbar nav{display:flex;gap:var(--sp-4);margin-left:var(--sp-4);}
.topbar nav a{font-size:15px;font-weight:500;color:var(--text-2);text-decoration:none;
  line-height:56px;}
.topbar nav a[aria-current="page"]{color:var(--text);font-weight:600;
  box-shadow:inset 0 -2px 0 var(--brand);}
.count{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:var(--r-pill);
  background:var(--wait-bg);color:var(--wait-tx);font:600 12px/1.5 var(--font);
  font-variant-numeric:tabular-nums;}
.tabbar a span{white-space:nowrap;}
.topbar__right{margin-left:auto;position:relative;}
main{max-width:1100px;margin:0 auto;padding:var(--sp-4);}
@media(min-width:641px){main{padding:var(--sp-5);}}
h1{font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.01em;margin:0 0 var(--sp-4);}
.narrow{max-width:720px;margin:0 auto;}

/* mobile: title bar + bottom tabs */
.mobar{display:none;}
.tabbar{display:none;}
@media(max-width:640px){
  .topbar{display:none;}
  .mobar{display:flex;align-items:center;gap:var(--sp-3);height:48px;padding:0 var(--sp-3);
    position:sticky;top:0;z-index:20;background:var(--surface);border-bottom:1px solid var(--border);}
  .mobar__title{font-size:16px;font-weight:600;}
  .mobar a.back{color:var(--text-2);text-decoration:none;font-size:20px;line-height:1;}
  .tabbar{position:fixed;left:0;right:0;bottom:0;z-index:20;display:grid;grid-auto-flow:column;
    grid-auto-columns:1fr;background:var(--surface);border-top:1px solid var(--border);
    height:calc(56px + env(safe-area-inset-bottom));padding-bottom:env(safe-area-inset-bottom);}
  .tabbar a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
    font-size:12px;font-weight:500;color:var(--text-3);text-decoration:none;}
  .tabbar a[aria-current="page"]{color:var(--brand);}
  .tabbar svg{width:22px;height:22px;stroke:currentColor;stroke-width:1.5;fill:none;}
  main{padding-bottom:76px;}
  /* Заголовок уже стоит в шапке телефона — в контенте он дублируется. */
  main>h1,main>.narrow>h1{display:none;}
  .chat__head .who{display:none;}
  .chat__head{padding:8px 16px;top:48px;}
}

/* ---------- popover (Ещё) ---------- */
details.more{position:relative;}
details.more>summary{list-style:none;cursor:pointer;font-size:14px;color:var(--text-2);
  padding:8px;border-radius:var(--r-ctl);}
details.more>summary::-webkit-details-marker{display:none;}
details.more>summary:hover{background:var(--hover);}
details.more .pop{position:absolute;right:0;top:calc(100% + 4px);min-width:220px;z-index:30;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r-card);
  box-shadow:0 8px 24px rgba(18,24,31,.10);padding:var(--sp-2);}
details.more .pop a,details.more .pop button{display:block;width:100%;text-align:left;
  padding:10px 12px;border-radius:var(--r-ctl);font-size:15px;color:var(--text);
  text-decoration:none;background:none;border:0;cursor:pointer;font-family:var(--font);}
details.more .pop a:hover,details.more .pop button:hover{background:var(--hover);}
details.more .pop .who{padding:6px 12px 10px;font-size:13px;color:var(--text-3);
  border-bottom:1px solid var(--border);margin-bottom:var(--sp-2);}

/* ---------- buttons ---------- */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:44px;
  padding:0 20px;border-radius:var(--r-ctl);font:600 15px/1 var(--font);cursor:pointer;
  border:1px solid transparent;text-decoration:none;
  transition:background-color .12s,border-color .12s;}
.btn--primary{background:var(--brand);color:#fff;}
.btn--primary:hover{background:var(--brand-hover);}
.btn--secondary{background:var(--surface);border-color:var(--border-input);color:var(--text);}
.btn--secondary:hover{background:var(--hover);}
.btn--ghost{background:transparent;color:var(--brand);}
.btn--ghost:hover{background:var(--brand-tint);}
.btn--danger{background:transparent;color:var(--err-tx);}
.btn--danger:hover{background:var(--err-bg);}
.btn[disabled]{opacity:.5;cursor:not-allowed;}
.btn--sm{height:36px;padding:0 14px;font-size:14px;}

/* ---------- fields ---------- */
.field{margin-bottom:var(--sp-4);}
.field>label{display:block;font:600 13px/1.4 var(--font);color:var(--text-2);margin-bottom:6px;}
.field .hint{font-size:13px;color:var(--text-3);margin-top:6px;}
input[type=text],input[type=password],input[type=url],input[type=date],textarea,select{
  width:100%;min-height:44px;font:400 16px/1.5 var(--font);padding:10px 12px;color:var(--text);
  background:var(--surface);border:1px solid var(--border-input);border-radius:var(--r-ctl);}
textarea{resize:vertical;}
.field--err input,.field--err textarea{border-color:var(--err-tx);}
.field .err{font-size:13px;color:var(--err-tx);margin-top:6px;}

/* ---------- banners ---------- */
.banner{padding:12px 16px;border-radius:var(--r-card);border:1px solid;font-size:15px;
  margin-bottom:var(--sp-4);}
.banner--err{background:var(--err-bg);border-color:var(--err-br);color:var(--err-tx);}
.banner--warn{background:var(--wait-bg);border-color:var(--wait-br);color:var(--wait-tx);}
.banner--ok{background:var(--ok-bg);border-color:var(--ok);color:var(--ok);}
.banner--info{background:var(--brand-tint);border-color:var(--brand);color:var(--brand);}
.banner a,.banner button.link{color:inherit;font-weight:600;}

/* ---------- badges / status ---------- */
.badge{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:var(--r-pill);
  font:500 12px/1.5 var(--font);}
.badge--on{background:var(--ok-bg);color:var(--ok);}
.badge--off{background:var(--surface-2);color:var(--text-3);}
.badge--wait{background:var(--wait-bg);color:var(--wait-tx);}
.badge--brand{background:var(--brand-tint);color:var(--brand);}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none;}
.dot--hollow{background:transparent;border:1.5px solid currentColor;width:8px;height:8px;}

/* ---------- section / cards ---------- */
.section{margin-bottom:var(--sp-6);}
.section__head{display:flex;align-items:baseline;gap:var(--sp-2);margin-bottom:var(--sp-3);}
.section__head h2{font:600 15px/1.4 var(--font);color:var(--text-2);margin:0;}
.card{display:block;background:var(--surface);border:1px solid var(--border);
  border-radius:var(--r-card);padding:14px 16px;margin-bottom:var(--sp-2);
  text-decoration:none;color:inherit;transition:background-color .12s,border-color .12s;}
@media(min-width:641px){.card{padding:16px 20px;}}
.card--wait{background:var(--wait-bg);border-color:var(--wait-br);}
.card--mine{border-left:3px solid var(--brand);padding-left:13px;}
.card--overdue{border-left:3px solid var(--err-tx);padding-left:13px;}
.card--off{background:var(--surface-2);}
.card__top{display:flex;align-items:center;gap:var(--sp-2);}
.card__who{font:600 16px/1.35 var(--font);}
.card__wait{margin-left:auto;font:400 13px/1.45 var(--font);color:var(--text-3);
  font-variant-numeric:tabular-nums;}
.card--wait .card__wait{color:var(--wait-tx);}
.card--overdue .card__wait{font-weight:600;color:var(--err-tx);}
.card__preview{margin:6px 0 0;font-size:15px;line-height:1.5;color:var(--text);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.card__body{margin:6px 0 0;font-size:15px;line-height:1.55;color:var(--text);
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;
  white-space:pre-wrap;}
.card__meta{margin:8px 0 0;font-size:13px;color:var(--text-3);}
@media(hover:hover){.card:hover{background:var(--hover);}
  .card--wait:hover{filter:brightness(.985);}}
.flash{animation:flash .6s ease-out;}
@keyframes flash{from{background:var(--brand-tint);}to{background:var(--surface);}}

details.quiet>summary{cursor:pointer;font:600 15px/1.4 var(--font);color:var(--text-2);
  padding:var(--sp-2) 0;}
.row{display:flex;align-items:center;gap:var(--sp-2);padding:12px 16px;background:var(--surface);
  border:1px solid var(--border);border-radius:var(--r-card);margin-bottom:var(--sp-1);
  text-decoration:none;color:inherit;font-size:15px;}
.row .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--text-3);}
.row .name{font-weight:600;color:var(--text);flex:none;}
.row time{font-size:13px;color:var(--text-3);flex:none;}

/* ---------- empty state ---------- */
.empty{max-width:360px;margin:0 auto;padding:var(--sp-7) var(--sp-4);text-align:center;}
.empty h3{font:600 17px/1.4 var(--font);margin:var(--sp-3) 0 var(--sp-2);}
.empty p{font-size:15px;line-height:1.55;color:var(--text-2);margin:0 0 var(--sp-4);}
.empty svg{width:32px;height:32px;stroke-width:1.5;fill:none;}

/* ---------- tiles (Итоги) ---------- */
.lede{font:600 22px/1.35 var(--font);margin:0 0 var(--sp-5);}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--sp-3);
  margin-bottom:var(--sp-5);}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-card);
  padding:20px;}
.tile .num{font:600 32px/1.1 var(--font);letter-spacing:-.02em;font-variant-numeric:tabular-nums;}
.tile .cap{font-size:13px;color:var(--text-2);margin-top:4px;}

/* ---------- pills (tabs / property filter) ---------- */
.pills{display:flex;gap:var(--sp-2);overflow-x:auto;scroll-snap-type:x mandatory;
  margin-bottom:var(--sp-3);padding-bottom:2px;-webkit-overflow-scrolling:touch;}
.pills a{scroll-snap-align:start;flex:none;padding:8px 14px;border-radius:var(--r-pill);
  font:500 14px/1.4 var(--font);text-decoration:none;color:var(--text-2);
  background:var(--surface);border:1px solid var(--border);}
.pills a[aria-current]{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600;}
.note{font-size:13px;color:var(--text-3);margin:0 0 var(--sp-3);}

/* ---------- chat ---------- */
.chat{max-width:720px;margin:0 auto;}
.chat__head{position:sticky;top:56px;z-index:10;background:var(--surface);
  border-bottom:1px solid var(--border);padding:12px 16px;}
.chat__head .who{font:600 16px/1.35 var(--font);}
.chat__head .meta{font-size:13px;color:var(--text-3);margin-top:2px;}
.chat__log{display:flex;flex-direction:column;padding:var(--sp-4) 0;}
.msg{max-width:min(78%,540px);padding:10px 14px;border-radius:var(--r-card);font-size:15px;
  line-height:1.5;white-space:pre-wrap;margin-bottom:var(--sp-2);overflow-wrap:anywhere;}
.msg--guest{background:var(--surface);border:1px solid var(--border);border-bottom-left-radius:3px;}
.msg--bot{background:var(--surface-2);margin-left:auto;border-bottom-right-radius:3px;}
.msg--staff{background:var(--brand-tint);border:1px solid var(--brand);margin-left:auto;
  border-bottom-right-radius:3px;}
.msg--pending{opacity:.5;}
.msg__meta{font:500 12px/1.4 var(--font);color:var(--text-3);margin:0 4px 4px;}
.msg__meta--right{text-align:right;}
.daysep{text-align:center;font-size:12px;color:var(--text-3);margin:var(--sp-4) 0 var(--sp-2);}
.handoff{background:var(--surface-2);padding:12px 16px;border-radius:var(--r-card);
  display:flex;align-items:center;gap:var(--sp-3);flex-wrap:wrap;margin-bottom:var(--sp-4);}
.handoff p{margin:0;flex:1;min-width:200px;}
.handoff .sub{font-size:13px;color:var(--text-3);margin-top:2px;}
.composer{position:sticky;bottom:0;background:var(--surface);border-top:1px solid var(--border);
  box-shadow:0 -1px 2px rgba(18,24,31,.05);padding:12px 16px max(12px,env(safe-area-inset-bottom));
  display:flex;gap:var(--sp-2);align-items:flex-end;}
.composer textarea{flex:1;min-height:44px;max-height:132px;}
@media(max-width:640px){.composer{margin-bottom:56px;}}
.tech{margin-top:var(--sp-4);}
.tech summary{cursor:pointer;font-size:13px;color:var(--text-3);}
.tech code{font-family:var(--mono);font-size:12px;color:var(--text-3);word-break:break-all;}

/* ---------- preview block ---------- */
.preview{background:var(--surface-2);border-radius:var(--r-card);padding:12px 14px;
  font:400 13px/1.5 var(--mono);color:var(--text-2);white-space:pre-wrap;}

/* ---------- responsive table ---------- */
.tablewrap{overflow-x:auto;}
table{border-collapse:collapse;width:100%;background:var(--surface);font-size:15px;
  border:1px solid var(--border);border-radius:var(--r-card);overflow:hidden;}
th,td{padding:10px 14px;text-align:left;vertical-align:top;border-bottom:1px solid var(--border);}
th{background:var(--surface-2);font:600 13px/1.4 var(--font);color:var(--text-2);
  white-space:nowrap;}
tbody tr:last-child td{border-bottom:0;}
@media(max-width:900px){
  .tablewrap{overflow-x:visible;}
  table,tbody,tr,td{display:block;width:auto;}
  thead{display:none;}
  table{border:0;background:transparent;}
  tr{border:1px solid var(--border);border-radius:var(--r-card);padding:12px;
    margin-bottom:var(--sp-2);background:var(--surface);}
  td{border:0;padding:3px 0;font-size:15px;}
  td::before{content:attr(data-label);display:block;font-size:12px;color:var(--text-3);}
  td:empty{display:none;}
}

/* ---------- login ---------- */
.login{max-width:360px;margin:12vh auto;background:var(--surface);border:1px solid var(--border);
  border-radius:var(--r-card);padding:var(--sp-5);}
.login .logo{font:600 20px/1.3 var(--font);color:var(--brand);}
.login .sub{font-size:15px;color:var(--text-3);margin:2px 0 var(--sp-5);}
.login .btn{width:100%;}

.inline{display:inline;}
.stack{display:flex;gap:var(--sp-2);flex-wrap:wrap;align-items:center;}
.sticky-actions{position:sticky;bottom:0;background:var(--surface);border-top:1px solid var(--border);
  padding:12px 0 max(12px,env(safe-area-inset-bottom));display:flex;gap:var(--sp-2);
  flex-wrap:wrap;margin-top:var(--sp-5);z-index:15;}
/* Липкая панель действий обязана стоять НАД таб-панелью, иначе «Сохранить»
   физически прячется под ней и правку невозможно применить с телефона. */
@media(max-width:640px){.sticky-actions{bottom:calc(56px + env(safe-area-inset-bottom));}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;}}
`.trim();

/* ------------------------------------------------------------------ helpers */

/**
 * A guest identifier a human can read. Conversation ids look like
 * "whatsapp:1112|77012345678" — showing that to a receptionist is why the old
 * console felt machine-facing. Phone numbers are partially masked: enough to
 * recognise the guest, not enough to leak on a shared screen.
 */
export function humanId(convo: { id: string; channel: string; senderId: string }): string {
  const sender = convo.senderId ?? '';
  if (convo.channel === 'whatsapp') {
    const d = sender.replace(/\D/g, '');
    if (d.length >= 10) {
      return `+${d.slice(0, 1)} ${d.slice(1, 4)} ••• ${d.slice(-4, -2)} ${d.slice(-2)}`;
    }
    return sender || 'Гость';
  }
  if (convo.channel === 'telegram') return `Telegram #${sender.slice(-6)}`;
  if (convo.channel === 'instagram') return `Instagram #${sender.slice(-6)}`;
  return `Гость с сайта #${sender.slice(-4)}`;
}

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  instagram: 'Instagram',
  webwidget: 'сайт',
};
export function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel] ?? channel;
}

const PROPERTY_LABEL: Record<string, string> = {
  almaty: 'Kazzhol Алматы',
  astana: 'Kazzhol Астана',
  park_almaty: 'Kazzhol Park Almaty',
  seven: 'Kazzhol Seven',
};
export function propertyLabel(key: string): string {
  return PROPERTY_LABEL[key] ?? (key || 'Вся сеть');
}
export const PROPERTY_KEYS = ['almaty', 'astana', 'park_almaty', 'seven'] as const;

/** "ждёт 14 мин" beats an ISO timestamp when you are deciding who to answer first. */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const min = Math.floor((now - then) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'вчера';
  return `${d} дн`;
}

/** «ждёт 14 мин», но для только что пришедшего — просто «только что». */
export function waitLabel(iso: string | undefined, now = Date.now()): string {
  const label = ago(iso, now);
  return label === 'только что' || label === 'вчера' ? label : `ждёт ${label}`;
}

/** «14 мин назад», но «только что» и «вчера» — как есть: «только что назад» не по-русски. */
export function agoLabel(iso: string | undefined, now = Date.now()): string {
  const label = ago(iso, now);
  return label === 'только что' || label === 'вчера' ? label : `${label} назад`;
}

export function minutesSince(iso: string | undefined, now = Date.now()): number {
  if (!iso) return 0;
  const then = Date.parse(iso);
  return Number.isNaN(then) ? 0 : Math.floor((now - then) / 60000);
}

/** Why this conversation landed on a human's desk, in words. */
const ESCALATION_REASON: Record<string, string> = {
  complaint: 'Жалоба гостя',
  human_requested: 'Гость просил человека',
  cannot_help: 'Бот не смог помочь',
  data_deletion: 'Просит удалить данные',
};
export function escalationReason(type: string | undefined): string {
  return (type && ESCALATION_REASON[type]) || 'Бот передал вам';
}

/* --------------------------------------------------------------- components */

export function btn(
  label: string,
  opts: { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; href?: string; type?: string; sm?: boolean; attrs?: string } = {},
): string {
  const cls = `btn btn--${opts.variant ?? 'secondary'}${opts.sm ? ' btn--sm' : ''}`;
  const extra = opts.attrs ? ` ${opts.attrs}` : '';
  if (opts.href) return `<a class="${cls}" href="${opts.href}"${extra}>${escapeHtml(label)}</a>`;
  return `<button class="${cls}" type="${opts.type ?? 'submit'}"${extra}>${escapeHtml(label)}</button>`;
}

export function banner(kind: 'err' | 'warn' | 'ok' | 'info', html: string): string {
  return `<div class="banner banner--${kind}">${html}</div>`;
}

export function badge(kind: 'on' | 'off' | 'wait' | 'brand', label: string, hollow = false): string {
  return `<span class="badge badge--${kind}"><span class="dot${hollow ? ' dot--hollow' : ''}"></span>${escapeHtml(label)}</span>`;
}

export function field(
  name: string,
  label: string,
  opts: { value?: string; hint?: string; type?: string; textarea?: boolean; rows?: number; required?: boolean; placeholder?: string; attrs?: string } = {},
): string {
  const hint = opts.hint ? `<p class="hint">${escapeHtml(opts.hint)}</p>` : '';
  const req = opts.required ? ' required' : '';
  const ph = opts.placeholder ? ` placeholder="${escapeHtml(opts.placeholder)}"` : '';
  const extra = opts.attrs ? ` ${opts.attrs}` : '';
  const input = opts.textarea
    ? `<textarea name="${name}" id="${name}" rows="${opts.rows ?? 5}"${req}${ph}${extra}>${escapeHtml(opts.value ?? '')}</textarea>`
    : `<input type="${opts.type ?? 'text'}" name="${name}" id="${name}" value="${escapeHtml(opts.value ?? '')}"${req}${ph}${extra}>`;
  return `<div class="field"><label for="${name}">${escapeHtml(label)}</label>${input}${hint}</div>`;
}

const EMPTY_ICONS = {
  ok: { path: '<path d="M20 6 9 17l-5-5"/>', color: 'var(--ok)' },
  none: { path: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>', color: 'var(--text-3)' },
  lost: { path: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>', color: 'var(--text-3)' },
};

/**
 * Иконка несёт смысл: галочка означает «всё в порядке» и не должна встречать
 * человека на экране «диалог не найден» или на пустом списке заявок.
 */
export function emptyState(
  title: string,
  text: string,
  action?: string,
  icon: keyof typeof EMPTY_ICONS = 'none',
): string {
  const { path, color } = EMPTY_ICONS[icon];
  return (
    `<div class="empty">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true" style="stroke:${color}">${path}</svg>` +
    `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${action ?? ''}</div>`
  );
}

export function pills(items: Array<{ href: string; label: string; active: boolean }>): string {
  return (
    `<div class="pills">` +
    items
      .map(
        (i) =>
          `<a href="${i.href}"${i.active ? ' aria-current="true"' : ''}>${escapeHtml(i.label)}</a>`,
      )
      .join('') +
    `</div>`
  );
}

/* -------------------------------------------------------------------- shell */

const ICONS: Record<string, string> = {
  inbox: '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M5 5h14l2 7v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M9 7h7M9 11h7"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
};

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  count?: number;
}

/** Four tabs, not eight. A receptionist sees two — the rest is not theirs. */
export function navItems(role: string, waiting: number): NavItem[] {
  const items: NavItem[] = [
    { href: '/console', label: 'Входящие', icon: 'inbox', count: waiting },
  ];
  if (role === 'admin') items.push({ href: '/console/kb', label: 'Знания', icon: 'book' });
  items.push({ href: '/console/requests', label: 'Заявки', icon: 'list' });
  if (role === 'admin') items.push({ href: '/console/summary', label: 'Итоги', icon: 'chart' });
  return items;
}

export interface ShellOpts {
  staff?: { login: string; role: string; property?: string };
  csrf?: string;
  active?: string;
  /** Mobile title bar back link — set on detail screens. */
  back?: { href: string; label: string };
  waiting?: number;
  /** Заголовок на телефоне: у вкладки браузера может быть счётчик «(2) …», в шапке он лишний. */
  heading?: string;
  /** Poll the page and swap #live. Inbox only — see the polling notes in the CSS header. */
  refresh?: boolean;
  bare?: boolean;
}

export function shell(title: string, body: string, opts: ShellOpts = {}): string {
  const { staff, csrf, active, back, waiting = 0, refresh, bare, heading } = opts;
  const head =
    `<!doctype html><html lang="ru"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
    `<meta name="color-scheme" content="light">` +
    `<title>${escapeHtml(title)}</title>` +
    `<link rel="stylesheet" href="/console/app.${CSS_VERSION}.css">` +
    `</head><body>`;
  if (bare || !staff) return `${head}<main>${body}</main></body></html>`;

  const items = navItems(staff.role, waiting);
  const isActive = (href: string): boolean => (active ?? '') === href;
  // Счётчик — единственное место в навигации с сигнальным цветом: у него тикают часы.
  const label = (i: NavItem): string =>
    i.count
      ? `${escapeHtml(i.label)}<span class="count">${i.count}</span>`
      : escapeHtml(i.label);

  const topbar =
    `<header class="topbar"><a class="topbar__brand" href="/console">Kazzhol<span>консоль</span></a>` +
    `<nav>` +
    items
      .map(
        (i) =>
          `<a href="${i.href}"${isActive(i.href) ? ' aria-current="page"' : ''}>${label(i)}</a>`,
      )
      .join('') +
    `</nav><div class="topbar__right">${moreMenu(staff, csrf)}</div></header>`;

  const mobar =
    `<div class="mobar">` +
    (back ? `<a class="back" href="${back.href}" aria-label="${escapeHtml(back.label)}">‹</a>` : '') +
    `<span class="mobar__title">${escapeHtml(heading ?? title)}</span>` +
    `<div style="margin-left:auto">${moreMenu(staff, csrf)}</div></div>`;

  const tabbar =
    `<nav class="tabbar">` +
    items
      .map(
        (i) =>
          `<a href="${i.href}"${isActive(i.href) ? ' aria-current="page"' : ''}>` +
          `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[i.icon]}</svg>` +
          `<span>${label(i)}</span></a>`,
      )
      .join('') +
    `</nav>`;

  return (
    head +
    topbar +
    mobar +
    `<main>${body}</main>` +
    tabbar +
    (refresh ? REFRESH_SCRIPT : '') +
    BASE_SCRIPT +
    `</body></html>`
  );
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'владелец',
  mice_manager: 'ресепшен',
};

function moreMenu(staff: { login: string; role: string; property?: string }, csrf?: string): string {
  const admin = staff.role === 'admin';
  return (
    `<details class="more"><summary>Ещё</summary><div class="pop">` +
    `<div class="who">${escapeHtml(staff.login)} · ${escapeHtml(ROLE_LABEL[staff.role] ?? staff.role)}` +
    (staff.property ? `<br>${escapeHtml(propertyLabel(staff.property))}` : '') +
    `</div>` +
    `<a href="/console/profile">Профиль и пароль</a>` +
    (admin ? `<a href="/console/kb/archive">Архив знаний</a>` : '') +
    (admin ? `<a href="/console/data-deletion">Удаление данных гостя</a>` : '') +
    `<form method="post" action="/console/logout">` +
    `<input type="hidden" name="_csrf" value="${escapeHtml(csrf ?? '')}">` +
    `<button type="submit">Выйти</button></form>` +
    `</div></details>`
  );
}

/**
 * Polling, fixed rather than removed. The old version replaced #live every 5s
 * unconditionally, which collapsed any open <select> and fought with typing.
 */
const REFRESH_SCRIPT = `<script>
(function(){
  var live=document.getElementById('live'); if(!live) return;
  var delay=function(){return document.hidden?20000:10000;};
  var timer=setTimeout(tick,delay());
  function tick(){
    if(document.hidden||live.contains(document.activeElement)){
      timer=setTimeout(tick,delay()); return;
    }
    fetch(location.href,{headers:{'X-Requested-With':'poll'}}).then(function(r){return r.text();})
      .then(function(html){
        var doc=new DOMParser().parseFromString(html,'text/html');
        var next=doc.getElementById('live');
        if(next&&next.innerHTML!==live.innerHTML&&!live.contains(document.activeElement)){
          live.innerHTML=next.innerHTML;
          var t=doc.title; if(t) document.title=t;
        }
      }).catch(function(){}).then(function(){timer=setTimeout(tick,delay());});
  }
})();
</script>`;

/** Edges only: autogrow, Enter-to-send, double-submit guard, live preview. */
const BASE_SCRIPT = `<script>
(function(){
  document.querySelectorAll('textarea[data-autogrow]').forEach(function(t){
    var grow=function(){t.style.height='auto';t.style.height=Math.min(t.scrollHeight,132)+'px';};
    t.addEventListener('input',grow); grow();
    t.addEventListener('keydown',function(e){
      if(e.key==='Enter'&&!e.shiftKey&&window.matchMedia('(min-width:641px)').matches){
        e.preventDefault(); t.form&&t.form.requestSubmit&&t.form.requestSubmit();
      }
    });
  });
  document.addEventListener('submit',function(e){
    var f=e.target; if(!f.matches('form[data-once]')) return;
    var b=f.querySelector('button[type=submit]');
    if(b){ if(b.disabled){e.preventDefault();return;} b.disabled=true; b.setAttribute('aria-busy','true');
      if(b.dataset.busy) b.textContent=b.dataset.busy; }
  });
  var prev=document.getElementById('kb-preview');
  if(prev){
    var t=document.getElementById('title'), b=document.getElementById('body');
    var head=prev.dataset.head||'ДОПОЛНИТЕЛЬНЫЕ СВЕДЕНИЯ ОТ ОТЕЛЯ:';
    var render=function(){
      prev.textContent=head+'\\n- '+((t&&t.value)||'…')+': '+((b&&b.value)||'…');
    };
    t&&t.addEventListener('input',render); b&&b.addEventListener('input',render); render();
  }
  var price=document.getElementById('price-warn');
  if(price){
    var body=document.getElementById('body');
    var check=function(){
      price.hidden=!/\\d[\\d\\s]{2,}\\s*(₸|тг|тенге|kzt)/i.test(body.value||'');
    };
    body&&body.addEventListener('input',check); check();
  }
})();
</script>`;
