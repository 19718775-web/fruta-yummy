const PAGE = window.PAGE || 'cliente'; // 'cliente' en tienda.html, 'admin' en admin.html

// ---------- Utilidades ----------
const $app = document.getElementById('app');
const DB = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} try { Sync.push(k, v); } catch {} }
};

// ---------- Sincronización entre dispositivos (Firebase Realtime Database, sin SDK) ----------
// Sin URL, la app guarda todo solo en este navegador. Con URL, los pedidos (con la ubicación del cliente), los precios, el horario y el envío
// se comparten entre el celular del cliente y el del administrador. Pasos en Ajustes → Sincronización.
const SYNC_URL = ''; // ← pega aquí tu URL, por ejemplo: 'https://mi-tienda-default-rtdb.firebaseio.com'
const canon = v => { // forma estable para comparar (Firebase ordena las llaves y descarta null y vacíos)
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] != null && !(Array.isArray(v[k]) && !v[k].length)).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
};
const Sync = (() => {
  const on = !!SYNC_URL, url = SYNC_URL.replace(/\/+$/, '');
  const isAdmin = () => PAGE === 'admin';
  const DOCS = ['products', 'schedule', 'ship', 'biz']; // los escribe solo el administrador
  const sent = {}, lastPush = {}; let status = on ? 'connecting' : 'off', pulling = false, first = true, tick = 0, onChange = () => {};
  const req = (path, method = 'GET', body) => fetch(`${url}/${path.replace('?', '.json?')}${path.includes('?') ? '' : '.json'}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const mailKey = e => e.replace(/\./g, ',');
  const setStatus = s => { if (status !== s) { status = s; document.dispatchEvent(new Event('syncstatus')); } };
  const ok = () => setStatus('online'), bad = () => setStatus('error');
  const raw = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  function pushOrders(list) {
    const me = state.session?.email;
    list.forEach(o => {
      if (!isAdmin() && o.clientEmail !== me) return;
      const c = canon(o);
      if (sent[o.id] === c || sent['p' + o.id] === c) return;
      sent['p' + o.id] = c;
      req('orders/' + o.id, 'PUT', o).then(() => { sent[o.id] = c; ok(); }, () => { delete sent['p' + o.id]; bad(); });
    });
  }
  function push(key, val) {
    if (!on) return;
    if (key === 'orders') pushOrders(val);
    else if (key === 'clients' && !isAdmin()) val.forEach(c => { const { photo, ...rest } = c; const cc = canon(rest); if (sent['c' + c.email] === cc) return; sent['c' + c.email] = cc; req('clients/' + mailKey(c.email), 'PUT', rest).then(ok, bad); });
    else if (DOCS.includes(key) && isAdmin()) { lastPush[key] = Date.now(); req(key, 'PUT', val).then(ok, bad); }
  }
  function applyDoc(key, remote, startedAt) {
    const local = DB.get(key, null);
    if (remote == null) { if (isAdmin() && local != null) { lastPush[key] = Date.now(); req(key, 'PUT', local).then(ok, bad); } return false; }
    if ((lastPush[key] || 0) >= startedAt) return false; // acabo de editarlo aquí: no lo pises con algo viejo
    if (canon(remote) === canon(local)) return false;
    raw(key, remote); return true;
  }
  async function pullOrders(startedAt) {
    const me = state.session?.email;
    let map;
    if (isAdmin()) map = await req('orders');
    else if (me) {
      try { map = await req('orders?orderBy=' + encodeURIComponent('"clientEmail"') + '&equalTo=' + encodeURIComponent(JSON.stringify(me))); }
      catch { const all = await req('orders'); map = Object.fromEntries(Object.entries(all || {}).filter(([, o]) => o && o.clientEmail === me)); }
    } else return [];
    const remote = Object.values(map || {}).filter(Boolean);
    const local = DB.get('orders', []), byId = Object.fromEntries(local.map(o => [o.id, o]));
    const merged = [], fresh = [];
    remote.forEach(r => {
      const l = byId[r.id]; delete byId[r.id];
      if (l && sent[r.id] !== undefined && canon(l) !== sent[r.id] && canon(l) !== canon(r)) { merged.push(l); return; } // cambio local pendiente
      if (!l) fresh.push(r);
      sent[r.id] = canon(r); merged.push(r);
    });
    Object.values(byId).forEach(l => merged.push(l)); // aún no subidos
    merged.sort((a, b) => (a.num || 0) - (b.num || 0));
    const changed = canon(merged) !== canon(local);
    if (changed) raw('orders', merged);
    pushOrders(merged);
    return changed ? fresh : null;
  }
  async function pull() {
    if (!on || pulling) return;
    pulling = true; const startedAt = Date.now();
    try {
      const docs = await Promise.all(DOCS.map(k => req(k)));
      const changedKeys = DOCS.filter((k, i) => applyDoc(k, docs[i], startedAt));
      const fresh = await pullOrders(startedAt);
      if (isAdmin() && tick++ % 5 === 0) {
        const cl = await req('clients'), local = DB.get('clients', []), have = new Set(local.map(c => c.email));
        const add = Object.values(cl || {}).filter(c => c && c.email && !have.has(c.email));
        if (add.length) { raw('clients', [...local, ...add]); changedKeys.push('clients'); }
      }
      ok();
      if (fresh !== null) { changedKeys.push('orders'); if (isAdmin() && !first) fresh.filter(o => o.status === 'nuevo').forEach(notifyNewOrder); }
      first = false;
      if (changedKeys.length) onChange(changedKeys);
    } catch { bad(); } finally { pulling = false; }
  }
  // Número de factura único aunque pidan dos clientes a la vez (transacción con ETag)
  async function nextNum() {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(url + '/counter.json', { headers: { 'X-Firebase-ETag': 'true' } });
      const etag = r.headers.get('ETag'), cur = Number(await r.json()) || 0;
      const w = await fetch(url + '/counter.json', { method: 'PUT', headers: { 'if-match': etag, 'Content-Type': 'application/json' }, body: JSON.stringify(cur + 1) });
      if (w.ok) return cur + 1;
    }
    throw new Error('num');
  }
  return {
    on, push, nextNum, pull, get status() { return status; },
    start(cb) { onChange = cb; if (!on) return; pull(); setInterval(() => { if (!document.hidden) pull(); }, 5000); document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); }); }
  };
})();
const syncDot = () => h('span', { class: 'syncdot ' + Sync.status, title: t('sync.' + Sync.status) }, { off: '💾', connecting: '⏳', online: '🟢', error: '🔴' }[Sync.status]);
document.addEventListener('syncstatus', () => document.querySelectorAll('.syncdot').forEach(el => { el.className = 'syncdot ' + Sync.status; el.title = t('sync.' + Sync.status); el.textContent = { off: '💾', connecting: '⏳', online: '🟢', error: '🔴' }[Sync.status]; }));

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const money = n => '$' + Number(n || 0).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Crea elementos del DOM: h('div', {class:'x', onclick: fn}, hijos...)
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  kids.flat().forEach(c => { if (c == null || c === false) return; e.append(c.nodeType ? c : document.createTextNode(c)); });
  return e;
}

// ---------- Idiomas ----------
// Para agregar otro idioma: copia el bloque "en", cámbiale la clave (ej. fr) y tradúcelo; luego agrégalo en LANGS y LOCALES.
const LANGS = { es: 'Español', en: 'English' };
const LOCALES = { es: 'es-SV', en: 'en-US' };
const I18N = {
  es: {
    brand: 'Frutas y Curtido', adminTitle: 'Panel del dueño',
    tagline: 'Fresco, natural y hecho con cariño.', adminTagline: 'Administra tu menú, tus precios y tus pedidos.',
    language: 'Idioma', logout: 'Salir', cart: 'Carrito',
    'cat.all': 'Todo', 'cat.fruta': 'Fruta', 'cat.curtido': 'Curtido',
    'login.hint': 'Escribe tu Gmail para entrar. Si ya tienes cuenta, solo necesitas el correo.',
    'login.welcomeBack': '¡Qué bueno verte de nuevo! Toca Entrar.',
    'login.newAccount': 'Cuenta nueva: dinos tu nombre para crearla.',
    'login.google': 'Entra con tu cuenta de Google. Solo se aceptan correos Gmail reales y verificados.',
    'ph.email': 'tucorreo@gmail.com', 'ph.name': 'Tu nombre', 'ph.phone': 'Teléfono (opcional)',
    'ph.user': 'Usuario', 'ph.pass': 'Contraseña', 'ph.pass2': 'Repite la contraseña', 'ph.mail': 'Correo',
    'btn.enter': 'Entrar', 'btn.createEnter': 'Crear cuenta y entrar',
    remember: 'Mantener la sesión iniciada en este dispositivo',
    'err.gmail': 'Escribe un Gmail real: 6 a 30 letras, números o puntos, y que termine en @gmail.com.',
    'err.needName': 'Escribe tu nombre para crear tu cuenta.',
    'err.notVerified': 'Ese correo no está verificado por Google.',
    'err.googleFail': 'No se pudo iniciar sesión con Google. Inténtalo otra vez.',
    'err.googleLoad': 'No se pudo cargar Google. Revisa tu internet y abre la página desde http(s), no desde un archivo.',
    'err.user3': 'El usuario debe tener al menos 3 caracteres.', 'err.pass6': 'La contraseña debe tener al menos 6 caracteres.',
    'err.passMatch': 'Las contraseñas no coinciden.', 'err.badLogin': 'Usuario o contraseña incorrectos.',
    'err.curPass': 'La contraseña actual no es correcta.', 'err.name': 'Escribe tu nombre.',
    'toast.accountCreated': '✅ Cuenta creada y guardada', 'toast.adminCreated': '✅ Cuenta de administrador creada',
    'admin.first': 'Primera vez: elige tu usuario y tu contraseña de administrador.', 'admin.only': 'Acceso exclusivo del administrador.',
    'admin.forgot': '¿Olvidaste tu contraseña?',
    'admin.resetConfirm': 'Se borrará solo tu usuario y tu contraseña de administrador. Tus productos, pedidos y clientes se quedan. Luego crearás un usuario y una contraseña nuevos. ¿Continuar?',
    'toast.resetDone': 'Listo. Crea tu nuevo usuario y tu nueva contraseña.',
    'tab.schedule': '🕒 Horario',
    'when.title': '¿Para cuándo lo quieres?', 'when.asap': 'Lo antes posible', 'when.later': 'Programar',
    'when.day': 'Día', 'when.time': 'Hora', 'when.today': 'Hoy', 'when.tomorrow': 'Mañana',
    'when.closedNow': 'Ahora estamos cerrados. Programa tu pedido para cuando abrimos.',
    'when.none': 'No hay horarios disponibles por ahora. Vuelve más tarde.',
    'when.for': 'Para: {when}', 'err.slotGone': 'Ese horario ya no está disponible. Elige otro.',
    'inv.when': 'Entrega',
    'sch.title': 'Horario de entrega',
    'sch.hint': 'Marca los días que atiendes y a qué horas puedes dar los pedidos. Los clientes solo podrán escoger esos horarios.',
    'sch.open': 'Atiendo', 'sch.closed': 'Cerrado', 'sch.from': 'Desde', 'sch.to': 'Hasta',
    'pay.cardMin': 'La tarjeta se acepta en pedidos de más de {min}. Para menos, paga en efectivo.',
    'deliv.title': '¿Cómo lo recibes?', 'deliv.delivery': 'Entrega a domicilio', 'deliv.pickup': 'Recoger en el local', 'deliv.pickupHint': 'Sin costo de envío.',
    'deliv.addr': 'Dirección de entrega (colonia, calle, casa)', 'deliv.ref': 'Referencia (ej. portón verde, frente a la tienda)', 'deliv.useGps': 'Usar mi ubicación', 'deliv.find': 'Ubicar mi dirección',
    'deliv.locating': 'Buscando tu ubicación…', 'deliv.searching': 'Buscando la dirección…', 'deliv.gpsFail': 'No se pudo obtener tu ubicación. Permite el acceso a la ubicación o escribe tu dirección.',
    'deliv.notFound': 'No encontramos esa dirección en el mapa. Puedes usar “Usar mi ubicación”; si no, el administrador te confirmará el envío.', 'deliv.saved': 'Ubicación guardada', 'deliv.seeMap': 'Ver en el mapa',
    'deliv.dist': 'Distancia aprox. {km}', 'deliv.fee': 'Envío', 'deliv.tbd': 'por confirmar', 'deliv.pending': 'Para calcular el envío toca “Usar mi ubicación” o “Ubicar mi dirección”. Si no, el administrador te confirmará el costo.',
    'deliv.out': 'Estás fuera de la zona de entrega (máximo {km} km).', 'deliv.gpsOnly': 'Ubicación por GPS', 'deliv.route': 'Ruta desde el local', 'deliv.tbdAdmin': 'Envío por confirmar', 'deliv.setFee': 'Poner envío',
    'deliv.tbdClient': 'Envío por confirmar: te avisaremos el costo.', 'err.addr': 'Escribe tu dirección o usa tu ubicación.', 'err.fee': 'Escribe un costo de envío válido.', 'pay.cardFee': 'Para pagar con tarjeta primero calcula el envío (usa tu ubicación) o elige recoger en el local.',
    'ship.title': 'Envío a domicilio', 'ship.help': 'Pon la ubicación de tu local para medir la distancia a cada cliente. El envío = base + precio por km. La distancia es en línea recta, no por calles.',
    'ship.lat': 'Latitud del local', 'ship.lng': 'Longitud del local', 'ship.here': 'Usar mi ubicación actual', 'ship.base': 'Envío base ($)', 'ship.perKm': 'Precio por km ($)', 'ship.max': 'Distancia máxima (km, 0 = sin límite)',
    'ship.got': 'Ubicación tomada. Guarda los cambios.', 'ship.badLoc': 'Latitud y longitud no son válidas.', 'ship.saved': 'Envío guardado',
    'tab.map': '🗺️ Mapa', 'map.loading': 'Cargando mapa…', 'map.fail': 'No se pudo cargar el mapa (revisa tu conexión a internet).', 'map.shop': 'Nuestro local', 'map.hint': 'Toca el mapa o arrastra el pin 📍 para ajustar el punto de entrega.',
    'map.noShop': 'Aún no pones la ubicación de tu local: ve a Ajustes → Envío a domicilio.', 'map.count': 'Pedidos con ubicación: {n}. Toca un pin para ver los datos.', 'map.countOld': '{n} pedidos con ubicación en el mapa. Toca un pin para ver los datos.', 'map.noLoc': 'Pedidos sin ubicación en el mapa',
    'map.pickHint': 'Toca el mapa para marcar dónde está tu local (puedes arrastrar el pin).',
    'sync.off': 'Modo local: los datos solo están en este navegador', 'sync.connecting': 'Conectando…', 'sync.online': 'Sincronizado', 'sync.error': 'Sin conexión con el servidor; se reintenta solo',
    'sync.title': '☁️ Sincronización entre dispositivos', 'sync.noteOff': 'Ahora mismo la app está en MODO LOCAL: los pedidos y la ubicación de los clientes NO llegan a tu celular, porque cada navegador guarda sus datos aparte. Para verlos de verdad, conecta una base de datos gratis (Firebase):',
    'sync.noteOn': 'Conectada. Los pedidos, precios, horario y envío se comparten entre todos los dispositivos.', 'sync.s1': '1. Entra a console.firebase.google.com, crea un proyecto y activa “Realtime Database” (modo de prueba).',
    'sync.s2': '2. En la pestaña “Reglas” pega: {"rules":{".read":true,".write":true,"orders":{".indexOn":["clientEmail"]}}} y publica.', 'sync.s3': '3. Copia la URL de la base de datos (termina en firebaseio.com) y pégala en app.js, en la línea  const SYNC_URL = \'\';',
    'sync.warn': 'Importante: con esas reglas cualquiera que conozca la URL podría leer los pedidos. Sirve para empezar; para uso real hace falta Firebase Authentication y reglas más estrictas.', 'sync.mapOff': 'Modo local: aquí solo aparecen los pedidos hechos en este mismo navegador. Activa la sincronización en Ajustes para ver la ubicación de clientes en otros celulares.',
    'aria.qty': 'Cantidad', 'sch.bulk1': 'Pedir más de', 'sch.bulk2': 'unidades de la misma fruta o curtido solo se puede agendando', 'bulk.warn': 'Más de {n} unidades de la misma fruta o curtido ({names}) se piden agendando el día. Elige “Programar” o baja la cantidad.',
    'err.bulk': 'Más de {n} unidades de la misma fruta solo se pueden pedir agendando: elige “Programar”.',
    'theme.dark': 'Modo oscuro', 'theme.light': 'Modo claro',
    'cal.prev': 'Mes anterior', 'cal.next': 'Mes siguiente', 
    'card.num': 'Número de tarjeta', 'card.name': 'Nombre en la tarjeta', 'card.exp': 'Vencimiento', 'card.pay': 'Pagar {total}', 'card.processing': 'Procesando…',
    'card.badNum': 'El número de tarjeta no es válido.', 'card.badName': 'Escribe el nombre que aparece en la tarjeta.', 'card.badExp': 'La fecha de vencimiento no es válida.', 'card.badCvv': 'El CVV debe tener 3 o 4 dígitos.',
    'card.declined': 'Tarjeta rechazada. Prueba con otra.', 'card.sim': 'PAGO SIMULADO · no se cobra dinero real', 'card.testHint': 'Tarjeta de prueba: 4242 4242 4242 4242, cualquier fecha futura y cualquier CVV. Para ver un rechazo usa 4000 0000 0000 0002.', 'pay.paid': 'Pagado con tarjeta',
    'sch.step': 'Horarios cada', 'sch.lead': 'Aviso mínimo antes de la entrega', 'sch.ahead': 'Los clientes pueden pedir con hasta',
    'sch.aheadEnd': 'de anticipación', 'sch.noNotice': 'Sin aviso', 'day.one': 'día', 'day.many': 'días',
    'sch.closedTitle': 'Días que no puedo', 'sch.closedHint': 'Cierra un día completo: feriado, viaje, no hay fruta…',
    'sch.closeDay': 'Cerrar ese día', 'sch.closeToday': 'Cerrar hoy', 'sch.noClosed': 'No hay días cerrados.', 'sch.reopen': 'Abrir de nuevo',
    'sch.hasOrders': 'Ojo: ya hay {n} pedido(s) programado(s) para ese día.',
    'toast.schSaved': 'Horario guardado', 'err.pickDate': 'Elige una fecha.', 'err.hours': 'La hora final debe ser después de la inicial.',
    'tab.menu': '🛍️ Menú', 'tab.orders': '🧾 Mis pedidos', 'tab.profile': '👤 Mi perfil',
    'tab.sales': '💰 Ventas', 'sales.month': 'Mes', 'sales.total': 'Vendido en el mes', 'sales.count': 'Pedidos entregados', 'sales.expenses': 'Gastos del mes ($)',
    'sales.expHint': 'frutas, bolsas, transporte… lo que gastaste', 'sales.profit': 'Ganancia del mes (ventas − gastos)', 'sales.csv': 'Descargar el mes (Excel)', 'sales.find': 'Buscar una venta',
    'sales.search': 'Cliente, producto, # factura o fecha…', 'sales.day': 'Día', 'sales.clear': 'Limpiar', 'sales.none': 'No hay ventas para mostrar.',
    'sales.inMonth': '{n} ventas en este mes. Una venta se registra cuando marcas el pedido como entregado.', 'sales.found': '{n} resultados en todas las fechas · {total}',
    'tab.aorders': '📋 Pedidos', 'tab.products': '🏷️ Productos', 'tab.clients': '👥 Clientes', 'tab.settings': '🔑 Ajustes',
    'profile.admin': 'Perfil del administrador', 'profile.mine': 'Mi perfil', 'profile.mailLocked': 'El correo de tu cuenta no se puede cambiar.',
    'btn.saveProfile': 'Guardar perfil', 'toast.profileSaved': '✅ Perfil guardado',
    'stat.new': 'Pedidos nuevos', 'stat.today': 'Vendido hoy', 'stat.clients': 'Clientes',
    'f.active': 'Por atender', 'f.done': 'Entregados', 'f.all': 'Todos',
    'next.preparando': 'Empezar a preparar', 'next.camino': 'Enviar: en camino', 'next.entregado': 'Marcar como entregado',
    'empty.noDelivered': 'Todavía no hay pedidos entregados', 'empty.noActive': 'No hay pedidos por atender',
    'empty.hint': 'Cuando alguien pida, te avisamos aquí con sonido.',
    'st.nuevo': 'Nuevo', 'st.preparando': 'Preparando', 'st.camino': 'En camino', 'st.entregado': 'Entregado',
    'tr.nuevo': 'Recibido', 'tr.preparando': 'Preparando', 'tr.camino': 'En camino', 'tr.entregado': 'Entregado',
    'pay.efectivo': '💵 Efectivo', 'pay.tarjeta': '💳 Tarjeta', 'payw.efectivo': 'efectivo', 'payw.tarjeta': 'tarjeta',
    total: 'Total', invoice: 'Factura',
    'notify.title': 'Nuevo pedido', 'notify.toast': '🔔 Nuevo pedido de {name}: {total} ({pay}). {when}',
    'bank.title': '🍉 Banco de fruta',
    'bank.hint': 'Todas las frutas ya están aquí. Ponle precio y marca "Hay" para que los clientes la vean en el menú.',
    'bank.search': 'Buscar fruta…', 'bank.count': '{n} de {total} con existencia',
    'bank.allOut': 'Marcar todas como "No hay"', 'bank.confirmAllOut': '¿Marcar todas las frutas como "No hay"?',
    'bank.noMatch': 'No encontré esa fruta. Puedes agregarla abajo.', 'bank.addTitle': 'Agregar otra fruta',
    'stock.yes': 'Hay', 'stock.no': 'No hay',
    'toast.needPrice': 'Ponle un precio antes de marcarla como "Hay".', 'toast.priceUpdated': 'Precio actualizado',
    'ph.fruitName': 'Nombre (ej. Rambután)', 'ph.curtidoName': 'Nombre (ej. Curtido de 1 libra)', 'ph.price': 'Precio',
    'curtido.title': '🥬 Venta de curtido', photoOpt: 'Foto (opcional)', 'btn.add': 'Agregar',
    'err.productName': 'Escribe el nombre del producto.',
    'empty.noneHere': 'Todavía no hay nada aquí. Escribe un nombre y un precio para agregar el primero.',
    'btn.removePhoto': 'Quitar foto', 'btn.delete': 'Eliminar', 'confirm.delete': '¿Eliminar {name}?',
    'thumb.title': 'Toca para poner o cambiar la foto (opcional)',
    'empty.noClients': 'Aún no hay clientes', 'empty.noClientsHint': 'Cuando alguien entre con su Gmail, su cuenta aparecerá aquí.',
    'client.since': 'Desde {date}. {n} {w}, {total} en compras.', 'order.one': 'pedido', 'order.many': 'pedidos',
    'set.access': 'Mi usuario y contraseña', 'ph.newPass': 'Nueva contraseña (vacía = no cambiarla)', 'ph.curPass': 'Contraseña actual',
    'btn.saveChanges': 'Guardar cambios', 'toast.accessUpdated': '✅ Datos de acceso actualizados',
    'set.notif': '🔔 Activar notificaciones del navegador', 'toast.notifState': 'Notificaciones del navegador: {s}',
    'set.biz': 'Datos del negocio (salen en la factura)', 'ph.bizName': 'Nombre del negocio', 'ph.bizPhone': 'Teléfono del negocio',
    'ph.bizAddr': 'Dirección', 'ph.bizNote': 'Nota al pie (ej. ¡Gracias por tu compra!)', 'toast.bizSaved': '✅ Datos del negocio guardados',
    hello: 'Hola, {name}', 'hello.sub': 'Escoge lo que quieras y lo preparamos.',
    'menu.empty': 'Todavía no hay productos aquí', 'menu.emptyHint': 'Vuelve en un rato, estamos preparando el menú.',
    'btn.addOne': 'Agregar', 'aria.less': 'Quitar uno', 'aria.more': 'Agregar uno',
    'item.one': 'producto', 'item.many': 'productos', 'btn.viewCart': 'Ver carrito',
    'cart.title': 'Tu carrito', 'cart.each': '{price} cada uno', 'cart.payq': '¿Cómo vas a pagar?',
    'cart.keep': 'Seguir comprando', 'cart.send': 'Enviar pedido', 'cart.empty': 'Tu carrito está vacío',
    'cart.emptyHint': 'Agrega frutas o curtido desde el menú.', 'cart.clear': 'Vaciar carrito',
    'err.pay': 'Elige cómo vas a pagar: efectivo o tarjeta.', 'toast.sent': '✅ Pedido enviado. ¡Gracias!',
    'empty.noOrders': 'Todavía no has pedido nada', 'empty.noOrdersHint': 'Cuando pidas, aquí verás la ruta de tu pedido.',
    'btn.seeMenu': 'Ver el menú', route: 'Ruta de tu pedido',
    'inv.no': 'Factura N.º {n}', 'inv.date': 'Fecha', 'inv.client': 'Cliente', 'inv.pay': 'Forma de pago',
    'inv.item': 'Producto', 'inv.qty': 'Cant.', 'inv.unit': 'Precio', 'inv.amount': 'Importe',
    'inv.thanks': '¡Gracias por tu compra!', 'inv.notice': 'Comprobante de compra. No es un documento tributario (DTE).',
    'inv.download': 'Descargar', 'inv.print': 'Imprimir / guardar PDF', 'inv.close': 'Cerrar', 'inv.file': 'factura'
  },
  en: {
    brand: 'Fruit & Curtido', adminTitle: 'Owner panel',
    tagline: 'Fresh, natural and made with love.', adminTagline: 'Manage your menu, prices and orders.',
    language: 'Language', logout: 'Log out', cart: 'Cart',
    'cat.all': 'All', 'cat.fruta': 'Fruit', 'cat.curtido': 'Curtido',
    'login.hint': 'Enter your Gmail to sign in. If you already have an account, your email is all you need.',
    'login.welcomeBack': 'Good to see you again! Tap Sign in.',
    'login.newAccount': 'New account: tell us your name to create it.',
    'login.google': 'Sign in with your Google account. Only real, verified Gmail addresses are accepted.',
    'ph.email': 'youremail@gmail.com', 'ph.name': 'Your name', 'ph.phone': 'Phone (optional)',
    'ph.user': 'Username', 'ph.pass': 'Password', 'ph.pass2': 'Repeat the password', 'ph.mail': 'Email',
    'btn.enter': 'Sign in', 'btn.createEnter': 'Create account and sign in',
    remember: 'Keep me signed in on this device',
    'err.gmail': 'Enter a real Gmail address: 6 to 30 letters, numbers or dots, ending in @gmail.com.',
    'err.needName': 'Enter your name to create your account.',
    'err.notVerified': 'Google has not verified that email.',
    'err.googleFail': 'Could not sign in with Google. Please try again.',
    'err.googleLoad': 'Could not load Google. Check your internet and open the page from http(s), not from a file.',
    'err.user3': 'The username must have at least 3 characters.', 'err.pass6': 'The password must have at least 6 characters.',
    'err.passMatch': 'The passwords do not match.', 'err.badLogin': 'Wrong username or password.',
    'err.curPass': 'The current password is not correct.', 'err.name': 'Enter your name.',
    'toast.accountCreated': '✅ Account created and saved', 'toast.adminCreated': '✅ Administrator account created',
    'admin.first': 'First time: choose your administrator username and password.', 'admin.only': 'Administrator access only.',
    'admin.forgot': 'Forgot your password?',
    'admin.resetConfirm': 'Only your administrator username and password will be erased. Your products, orders and clients stay. Then you will create a new username and password. Continue?',
    'toast.resetDone': 'Done. Create your new username and password.',
    'tab.schedule': '🕒 Schedule',
    'when.title': 'When do you want it?', 'when.asap': 'As soon as possible', 'when.later': 'Schedule it',
    'when.day': 'Day', 'when.time': 'Time', 'when.today': 'Today', 'when.tomorrow': 'Tomorrow',
    'when.closedNow': 'We are closed right now. Schedule your order for when we open.',
    'when.none': 'No times available right now. Please come back later.',
    'when.for': 'For: {when}', 'err.slotGone': 'That time is no longer available. Pick another one.',
    'inv.when': 'Delivery',
    'sch.title': 'Delivery hours',
    'sch.hint': 'Mark the days you work and the hours you can hand over orders. Customers can only pick those times.',
    'sch.open': 'Open', 'sch.closed': 'Closed', 'sch.from': 'From', 'sch.to': 'To',
    'pay.cardMin': 'Card is accepted on orders over {min}. For less, pay in cash.',
    'deliv.title': 'How do you want it?', 'deliv.delivery': 'Home delivery', 'deliv.pickup': 'Pick up at the shop', 'deliv.pickupHint': 'No delivery fee.',
    'deliv.addr': 'Delivery address (area, street, house)', 'deliv.ref': 'Landmark (e.g. green gate, in front of the shop)', 'deliv.useGps': 'Use my location', 'deliv.find': 'Locate my address',
    'deliv.locating': 'Finding your location…', 'deliv.searching': 'Looking up the address…', 'deliv.gpsFail': 'Could not get your location. Allow location access or type your address.',
    'deliv.notFound': 'We could not find that address on the map. Try “Use my location”; otherwise the admin will confirm the delivery fee.', 'deliv.saved': 'Location saved', 'deliv.seeMap': 'See on map',
    'deliv.dist': 'Approx. distance {km}', 'deliv.fee': 'Delivery', 'deliv.tbd': 'to be confirmed', 'deliv.pending': 'To calculate delivery tap “Use my location” or “Locate my address”. Otherwise the admin will confirm the cost.',
    'deliv.out': 'You are outside the delivery area (max {km} km).', 'deliv.gpsOnly': 'GPS location', 'deliv.route': 'Route from the shop', 'deliv.tbdAdmin': 'Delivery fee to confirm', 'deliv.setFee': 'Set fee',
    'deliv.tbdClient': 'Delivery fee to be confirmed: we will let you know.', 'err.addr': 'Type your address or use your location.', 'err.fee': 'Enter a valid delivery fee.', 'pay.cardFee': 'To pay by card first calculate delivery (use your location) or choose pick up.',
    'ship.title': 'Home delivery', 'ship.help': 'Set your shop location to measure the distance to each customer. Delivery = base + price per km. Distance is straight-line, not by road.',
    'ship.lat': 'Shop latitude', 'ship.lng': 'Shop longitude', 'ship.here': 'Use my current location', 'ship.base': 'Base fee ($)', 'ship.perKm': 'Price per km ($)', 'ship.max': 'Max distance (km, 0 = no limit)',
    'ship.got': 'Location captured. Save the changes.', 'ship.badLoc': 'Latitude and longitude are not valid.', 'ship.saved': 'Delivery settings saved',
    'tab.map': '🗺️ Map', 'map.loading': 'Loading map…', 'map.fail': 'Could not load the map (check your internet connection).', 'map.shop': 'Our shop', 'map.hint': 'Tap the map or drag the 📍 pin to adjust the delivery point.',
    'map.noShop': 'You have not set your shop location yet: go to Settings → Home delivery.', 'map.count': 'Orders with a location: {n}. Tap a pin for details.', 'map.countOld': '{n} orders with a location on the map. Tap a pin for details.', 'map.noLoc': 'Orders without a map location',
    'map.pickHint': 'Tap the map to mark where your shop is (you can drag the pin).',
    'sync.off': 'Local mode: data lives only in this browser', 'sync.connecting': 'Connecting…', 'sync.online': 'Synced', 'sync.error': 'Cannot reach the server; retrying automatically',
    'sync.title': '☁️ Cross-device sync', 'sync.noteOff': 'Right now the app is in LOCAL MODE: orders and customer locations do NOT reach your phone, because each browser keeps its own data. To really see them, connect a free database (Firebase):',
    'sync.noteOn': 'Connected. Orders, prices, schedule and delivery are shared across all devices.', 'sync.s1': '1. Go to console.firebase.google.com, create a project and enable “Realtime Database” (test mode).',
    'sync.s2': '2. In the “Rules” tab paste: {"rules":{".read":true,".write":true,"orders":{".indexOn":["clientEmail"]}}} and publish.', 'sync.s3': '3. Copy the database URL (ends in firebaseio.com) and paste it in app.js, on the line  const SYNC_URL = \'\';',
    'sync.warn': 'Important: with those rules anyone who knows the URL could read the orders. Fine to get started; for real use you need Firebase Authentication and stricter rules.', 'sync.mapOff': 'Local mode: only orders made in this same browser appear here. Turn on sync in Settings to see customer locations from other phones.',
    'aria.qty': 'Quantity', 'sch.bulk1': 'Ordering more than', 'sch.bulk2': 'units of the same item is only possible when scheduled', 'bulk.warn': 'More than {n} units of the same item ({names}) must be scheduled. Choose “Schedule” or lower the quantity.',
    'err.bulk': 'More than {n} units of the same item can only be ordered when scheduled: choose “Schedule”.',
    'theme.dark': 'Dark mode', 'theme.light': 'Light mode',
    'cal.prev': 'Previous month', 'cal.next': 'Next month', 
    'card.num': 'Card number', 'card.name': 'Name on card', 'card.exp': 'Expiry', 'card.pay': 'Pay {total}', 'card.processing': 'Processing…',
    'card.badNum': 'The card number is not valid.', 'card.badName': 'Enter the name shown on the card.', 'card.badExp': 'The expiry date is not valid.', 'card.badCvv': 'CVV must be 3 or 4 digits.',
    'card.declined': 'Card declined. Try another one.', 'card.sim': 'SIMULATED PAYMENT · no real money is charged', 'card.testHint': 'Test card: 4242 4242 4242 4242, any future date and any CVV. For a decline use 4000 0000 0000 0002.', 'pay.paid': 'Paid by card',
    'sch.step': 'Time slots every', 'sch.lead': 'Minimum notice before delivery', 'sch.ahead': 'Customers can order up to',
    'sch.aheadEnd': 'ahead', 'sch.noNotice': 'No notice', 'day.one': 'day', 'day.many': 'days',
    'sch.closedTitle': 'Days I cannot', 'sch.closedHint': 'Close a whole day: holiday, trip, no fruit…',
    'sch.closeDay': 'Close that day', 'sch.closeToday': 'Close today', 'sch.noClosed': 'No closed days.', 'sch.reopen': 'Reopen',
    'sch.hasOrders': 'Heads up: {n} order(s) already scheduled for that day.',
    'toast.schSaved': 'Schedule saved', 'err.pickDate': 'Pick a date.', 'err.hours': 'The end time must be after the start time.',
    'tab.menu': '🛍️ Menu', 'tab.orders': '🧾 My orders', 'tab.profile': '👤 My profile',
    'tab.sales': '💰 Sales', 'sales.month': 'Month', 'sales.total': 'Sold this month', 'sales.count': 'Delivered orders', 'sales.expenses': 'Expenses this month ($)',
    'sales.expHint': 'fruit, bags, transport… what you spent', 'sales.profit': 'Profit this month (sales − expenses)', 'sales.csv': 'Download month (Excel)', 'sales.find': 'Find a sale',
    'sales.search': 'Client, product, invoice # or date…', 'sales.day': 'Day', 'sales.clear': 'Clear', 'sales.none': 'No sales to show.',
    'sales.inMonth': '{n} sales this month. A sale is recorded when you mark the order as delivered.', 'sales.found': '{n} results across all dates · {total}',
    'tab.aorders': '📋 Orders', 'tab.products': '🏷️ Products', 'tab.clients': '👥 Clients', 'tab.settings': '🔑 Settings',
    'profile.admin': 'Administrator profile', 'profile.mine': 'My profile', 'profile.mailLocked': 'Your account email cannot be changed.',
    'btn.saveProfile': 'Save profile', 'toast.profileSaved': '✅ Profile saved',
    'stat.new': 'New orders', 'stat.today': 'Sold today', 'stat.clients': 'Clients',
    'f.active': 'To handle', 'f.done': 'Delivered', 'f.all': 'All',
    'next.preparando': 'Start preparing', 'next.camino': 'Send: on the way', 'next.entregado': 'Mark as delivered',
    'empty.noDelivered': 'No delivered orders yet', 'empty.noActive': 'No orders to handle',
    'empty.hint': 'When someone orders, we will let you know here with a sound.',
    'st.nuevo': 'New', 'st.preparando': 'Preparing', 'st.camino': 'On the way', 'st.entregado': 'Delivered',
    'tr.nuevo': 'Received', 'tr.preparando': 'Preparing', 'tr.camino': 'On the way', 'tr.entregado': 'Delivered',
    'pay.efectivo': '💵 Cash', 'pay.tarjeta': '💳 Card', 'payw.efectivo': 'cash', 'payw.tarjeta': 'card',
    total: 'Total', invoice: 'Invoice',
    'notify.title': 'New order', 'notify.toast': '🔔 New order from {name}: {total} ({pay}). {when}',
    'bank.title': '🍉 Fruit bank',
    'bank.hint': 'Every fruit is already here. Set a price and mark it "In stock" so customers see it on the menu.',
    'bank.search': 'Search fruit…', 'bank.count': '{n} of {total} in stock',
    'bank.allOut': 'Mark all as "Out of stock"', 'bank.confirmAllOut': 'Mark every fruit as "Out of stock"?',
    'bank.noMatch': "I couldn't find that fruit. You can add it below.", 'bank.addTitle': 'Add another fruit',
    'stock.yes': 'In stock', 'stock.no': 'Out of stock',
    'toast.needPrice': 'Set a price before marking it "In stock".', 'toast.priceUpdated': 'Price updated',
    'ph.fruitName': 'Name (e.g. Rambutan)', 'ph.curtidoName': 'Name (e.g. 1 lb curtido)', 'ph.price': 'Price',
    'curtido.title': '🥬 Curtido (pickled slaw)', photoOpt: 'Photo (optional)', 'btn.add': 'Add',
    'err.productName': 'Enter the product name.',
    'empty.noneHere': 'Nothing here yet. Type a name and a price to add the first one.',
    'btn.removePhoto': 'Remove photo', 'btn.delete': 'Delete', 'confirm.delete': 'Delete {name}?',
    'thumb.title': 'Tap to add or change the photo (optional)',
    'empty.noClients': 'No clients yet', 'empty.noClientsHint': 'When someone signs in with their Gmail, their account will show up here.',
    'client.since': 'Since {date}. {n} {w}, {total} in purchases.', 'order.one': 'order', 'order.many': 'orders',
    'set.access': 'My username and password', 'ph.newPass': 'New password (leave empty to keep it)', 'ph.curPass': 'Current password',
    'btn.saveChanges': 'Save changes', 'toast.accessUpdated': '✅ Sign-in details updated',
    'set.notif': '🔔 Turn on browser notifications', 'toast.notifState': 'Browser notifications: {s}',
    'set.biz': 'Business details (shown on the invoice)', 'ph.bizName': 'Business name', 'ph.bizPhone': 'Business phone',
    'ph.bizAddr': 'Address', 'ph.bizNote': 'Footer note (e.g. Thank you for your purchase!)', 'toast.bizSaved': '✅ Business details saved',
    hello: 'Hi, {name}', 'hello.sub': 'Pick what you like and we will get it ready.',
    'menu.empty': 'No products here yet', 'menu.emptyHint': 'Come back in a little while, we are getting the menu ready.',
    'btn.addOne': 'Add', 'aria.less': 'Remove one', 'aria.more': 'Add one',
    'item.one': 'item', 'item.many': 'items', 'btn.viewCart': 'View cart',
    'cart.title': 'Your cart', 'cart.each': '{price} each', 'cart.payq': 'How will you pay?',
    'cart.keep': 'Keep shopping', 'cart.send': 'Place order', 'cart.empty': 'Your cart is empty',
    'cart.emptyHint': 'Add fruit or curtido from the menu.', 'cart.clear': 'Empty cart',
    'err.pay': 'Choose how you will pay: cash or card.', 'toast.sent': '✅ Order placed. Thank you!',
    'empty.noOrders': "You haven't ordered anything yet", 'empty.noOrdersHint': 'When you order, you will see your order route here.',
    'btn.seeMenu': 'See the menu', route: 'Your order route',
    'inv.no': 'Invoice No. {n}', 'inv.date': 'Date', 'inv.client': 'Customer', 'inv.pay': 'Payment method',
    'inv.item': 'Item', 'inv.qty': 'Qty', 'inv.unit': 'Price', 'inv.amount': 'Amount',
    'inv.thanks': 'Thank you for your purchase!', 'inv.notice': 'Proof of purchase. Not a tax document.',
    'inv.download': 'Download', 'inv.print': 'Print / save as PDF', 'inv.close': 'Close', 'inv.file': 'invoice'
  }
};
let theme = DB.get('theme', 'light'); // claro u oscuro, lo elige cada persona
const applyTheme = () => { document.documentElement.dataset.theme = theme; };
applyTheme();
function toggleTheme() { theme = theme === 'dark' ? 'light' : 'dark'; DB.set('theme', theme); applyTheme(); render(); }
let lang = DB.get('lang', 'es'); // español por defecto; cada persona puede cambiarlo con el selector 🌐
if (!LANGS[lang]) lang = 'es';
document.documentElement.lang = lang;
const t = (k, vars) => {
  let s = I18N[lang][k] ?? I18N.es[k] ?? k;
  if (vars) for (const [a, b] of Object.entries(vars)) s = s.split('{' + a + '}').join(b);
  return s;
};
function setLang(l) { lang = l; DB.set('lang', l); document.documentElement.lang = l; render(); }
function langSelect() {
  return h('select', { class: 'langsel', 'aria-label': t('language'), onchange: e => setLang(e.target.value) },
    Object.entries(LANGS).map(([k, v]) => h('option', { value: k, selected: k === lang }, '🌐 ' + v)));
}
const fmtDate = d => new Date(d).toLocaleString(LOCALES[lang], { dateStyle: 'short', timeStyle: 'short' });
const fmtShort = d => new Date(d).toLocaleString(LOCALES[lang], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const plural = (n, base) => t(n === 1 ? base + '.one' : base + '.many');
const payLabel = id => t('pay.' + id);

// ---------- Catálogo ----------
const CATS = [{ id: 'fruta', emoji: '🍉' }, { id: 'curtido', emoji: '🥬' }];
// Banco de fruta: [emoji, nombre en español, nombre en inglés]
const FRUITS = {
  mango: ['🥭', 'Mango', 'Mango'], sandia: ['🍉', 'Sandía', 'Watermelon'], pina: ['🍍', 'Piña', 'Pineapple'],
  melon: ['🍈', 'Melón', 'Cantaloupe'], papaya: ['🍈', 'Papaya', 'Papaya'], naranja: ['🍊', 'Naranja', 'Orange'],
  mandarina: ['🍊', 'Mandarina', 'Tangerine'], limon: ['🍋', 'Limón', 'Lime'], banano: ['🍌', 'Banano', 'Banana'],
  platano: ['🍌', 'Plátano', 'Plantain'], uva: ['🍇', 'Uvas', 'Grapes'], fresa: ['🍓', 'Fresa', 'Strawberry'],
  manzana: ['🍎', 'Manzana', 'Apple'], pera: ['🍐', 'Pera', 'Pear'], durazno: ['🍑', 'Durazno', 'Peach'],
  coco: ['🥥', 'Coco', 'Coconut'], kiwi: ['🥝', 'Kiwi', 'Kiwi'], aguacate: ['🥑', 'Aguacate', 'Avocado'],
  cereza: ['🍒', 'Cereza', 'Cherry'], guayaba: ['🍐', 'Guayaba', 'Guava'], maracuya: ['🍈', 'Maracuyá', 'Passion fruit'],
  jocote: ['🍒', 'Jocote', 'Jocote (hog plum)'], nance: ['🍋', 'Nance', 'Nance'], maranon: ['🍎', 'Marañón', 'Cashew apple'],
  mamey: ['🥭', 'Mamey', 'Mamey'], zapote: ['🥭', 'Zapote', 'Sapote'], tamarindo: ['🌰', 'Tamarindo', 'Tamarind'],
  mamon: ['🍈', 'Mamón', 'Spanish lime'], granadilla: ['🍊', 'Granadilla', 'Sweet granadilla'],
  pitahaya: ['🍈', 'Pitahaya', 'Dragon fruit'], mora: ['🫐', 'Mora', 'Blackberry']
};
const isBank = p => !!(p.key && !p.custom && FRUITS[p.key]);
const displayName = p => isBank(p) ? FRUITS[p.key][lang === 'en' ? 2 : 1] : p.name;
function emojiFor(p) {
  if (p.key && FRUITS[p.key]) return FRUITS[p.key][0];
  if (p.cat === 'curtido') return '🥬';
  const n = norm(p.name);
  const hit = Object.entries(FRUITS).find(([k, v]) => n.includes(k) || n.includes(norm(v[1])) || n.includes(norm(v[2])));
  return hit ? hit[1][0] : '🍎';
}
function photoTo(file, size, cb) { // reduce la foto a un cuadrado pequeño para guardarla ligera
  const r = new FileReader();
  r.onload = () => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const m = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, size, size);
      cb(c.toDataURL('image/jpeg', 0.8));
    };
    img.src = r.result;
  };
  r.readAsDataURL(file);
}

// Frutas que suben despacito por el fondo (pocas y tenues)
(function () {
  const layer = h('div', { class: 'bgfx', 'aria-hidden': 'true' });
  ['🍉', '🥭', '🍍', '🥬', '🍊', '🍓', '🍋', '🍇', '🍌'].forEach((e, i) => {
    layer.append(h('span', { style: `left:${4 + i * 10.5}%;font-size:${32 + Math.random() * 22}px;animation-duration:${34 + Math.random() * 26}s;animation-delay:-${Math.random() * 50}s` }, e));
  });
  document.body.prepend(layer);
})();

// ---------- Datos y sesión ----------
const products = () => DB.get('products', []);
const orders = () => DB.get('orders', []);
const clients = () => DB.get('clients', []);
const adminPass = () => DB.get('adminPass', null); // null = todavía no se ha creado la cuenta de administrador
const adminUser = () => DB.get('adminUser', 'admin');
const orderNo = o => String(o.num || 0).padStart(4, '0');
const itemName = i => { const p = products().find(x => x.id === i.id); return p ? displayName(p) : i.name; };

// ---------- Horario de entrega ----------
// Por defecto: lunes a sábado de 8:00 a 17:00, horarios cada 30 min, aviso mínimo de 30 min y pedidos hasta con 7 días de anticipación.
const DAY = { on: true, from: '08:00', to: '17:00' };
const DEFAULT_SCHED = { days: { 0: { ...DAY, on: false }, 1: { ...DAY }, 2: { ...DAY }, 3: { ...DAY }, 4: { ...DAY }, 5: { ...DAY }, 6: { ...DAY } }, step: 30, lead: 30, ahead: 365, bulk: 10, closed: [] };
const getSched = () => {
  const sv = DB.get('schedule', {});
  const m = { ...DEFAULT_SCHED, ...sv, days: { ...DEFAULT_SCHED.days, ...(sv.days || {}) }, closed: sv.closed || [] };
  if (sv.v !== 2 && Number(sv.ahead) < 365) m.ahead = 365; // versión anterior: ahora hay calendario real
  return m;
};
const pad2 = n => String(n).padStart(2, '0');
const dateKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;  // 'AAAA-MM-DD' en hora local
const toMin = hhmm => { const [a, b] = hhmm.split(':').map(Number); return a * 60 + b; };
const fromKey = (key, hhmm = '00:00') => { const [y, m, d] = key.split('-').map(Number); const [a, b] = hhmm.split(':').map(Number); return new Date(y, m - 1, d, a, b); };
// Horas disponibles de un día (respeta días cerrados, horas de atención, intervalo y aviso mínimo)
function slotsFor(key, now = new Date()) {
  const sc = getSched();
  if (sc.closed.includes(key)) return [];
  const day = sc.days[fromKey(key).getDay()];
  if (!day || !day.on || !day.from || !day.to) return [];
  const out = [];
  for (let m = toMin(day.from); m <= toMin(day.to); m += Number(sc.step) || 30) {
    const hhmm = `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
    if (fromKey(key, hhmm).getTime() >= now.getTime() + (Number(sc.lead) || 0) * 60000) out.push(hhmm);
  }
  return out;
}
function availableDays(now = new Date()) {
  const sc = getSched(), out = [];
  for (let i = 0; i < (Number(sc.ahead) || 365); i++) {
    const key = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
    if (slotsFor(key, now).length) out.push(key);
  }
  return out;
}

// Calendario mensual real: se puede navegar a cualquier mes (diciembre, enero…); solo se pueden elegir los días disponibles
function calendar(w, days, draw) {
  const avail = new Set(days);
  if (!state.calMonth || !/^\d{4}-\d{2}$/.test(state.calMonth)) state.calMonth = (w.day || days[0]).slice(0, 7);
  const [y, m] = state.calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1), nDays = new Date(y, m, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // semana empieza en lunes
  const goto = d => { const n = new Date(y, m - 1 + d, 1); state.calMonth = `${n.getFullYear()}-${pad2(n.getMonth() + 1)}`; draw(); };
  const minM = days[0].slice(0, 7), maxM = days[days.length - 1].slice(0, 7);
  const names = [...Array(7)].map((_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(LOCALES[lang], { weekday: 'short' }).slice(0, 2));
  const cells = [...Array(lead)].map(() => h('span', { class: 'cd empty' }));
  for (let d = 1; d <= nDays; d++) {
    const key = `${y}-${pad2(m)}-${pad2(d)}`, ok = avail.has(key);
    cells.push(h('button', { type: 'button', class: 'cd' + (ok ? ' ok' : ' off') + (key === w.day ? ' sel' : '') + (key === dateKey(new Date()) ? ' hoy' : ''), disabled: !ok, 'aria-label': dayLabel(key), 'aria-pressed': key === w.day ? 'true' : 'false',
      onclick: () => { w.day = key; w.time = ''; draw(); } }, d));
  }
  return h('div', { class: 'cal' },
    h('div', { class: 'calhead' },
      h('button', { type: 'button', class: 'sec round', 'aria-label': t('cal.prev'), disabled: state.calMonth <= minM, onclick: () => goto(-1) }, '‹'),
      h('div', { class: 'mon', 'aria-live': 'polite' }, h('b', {}, first.toLocaleDateString(LOCALES[lang], { month: 'long' })), h('small', {}, String(y))),
      h('button', { type: 'button', class: 'sec round', 'aria-label': t('cal.next'), disabled: state.calMonth >= maxM, onclick: () => goto(1) }, '›')),
    h('div', { class: 'calgrid' }, names.map(n => h('span', { class: 'cw' }, n)), ...cells));
}

// ---------- Entrega: dirección, ubicación, distancia y costo de envío ----------
const getShip = () => ({ lat: null, lng: null, base: 1, perKm: 0.5, maxKm: 15, ...DB.get('ship', {}) });
const hasPt = (a, b) => typeof a === 'number' && typeof b === 'number' && isFinite(a) && isFinite(b);
function kmBetween(a, b, c, d) { // distancia en línea recta (fórmula de Haversine)
  const r = x => x * Math.PI / 180, dLa = r(c - a), dLo = r(d - b);
  const q = Math.sin(dLa / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLo / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(q));
}
const mapLink = (lat, lng) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`; // OpenStreetMap: no necesita cuenta de Google
const routeLink = (lat, lng) => { const s = getShip(); return hasPt(s.lat, s.lng) ? `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${s.lat}%2C${s.lng}%3B${lat}%2C${lng}` : mapLink(lat, lng); };
// Cotiza el envío: { fee, km, out } — fee null = "por confirmar" (falta ubicación del cliente o del local)
function quote(d) {
  if (!d || d.mode === 'pickup') return { fee: 0, km: null, out: false };
  const s = getShip();
  if (!hasPt(d.lat, d.lng) || !hasPt(s.lat, s.lng)) return { fee: null, km: null, out: false };
  const km = kmBetween(s.lat, s.lng, d.lat, d.lng);
  return { fee: Math.round((s.base + s.perKm * km) * 100) / 100, km, out: s.maxKm > 0 && km > s.maxKm };
}
const fmtKm = km => km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(1) + ' km';
const locate = () => new Promise((res, rej) => {
  if (!navigator.geolocation) return rej(new Error('unsupported'));
  navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }), e => rej(e), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
});
async function geocode(q) { // busca una dirección escrita (OpenStreetMap Nominatim); necesita internet
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=sv&q=' + encodeURIComponent(q), { signal: ctl.signal, headers: { Accept: 'application/json' } });
    const j = await r.json();
    return j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
  } finally { clearTimeout(tm); }
}
// ---------- Mapa dentro de la aplicación (Leaflet + OpenStreetMap, necesita internet) ----------
let leafletP = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletP) return leafletP;
  leafletP = new Promise((res, rej) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css'; document.head.append(css);
    const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js';
    sc.onload = () => res(window.L); sc.onerror = () => { leafletP = null; rej(new Error('leaflet')); };
    document.head.append(sc);
  });
  return leafletP;
}
const DEFAULT_CENTER = [13.6929, -89.2182]; // San Salvador
const pinIcon = (L, html, cls = 'pin') => L.divIcon({ html, className: cls, iconSize: null, iconAnchor: cls === 'pin' ? [15, 28] : [0, 0] });
// Devuelve el contenedor del mapa; `setup(L, map)` agrega marcadores. Si no hay internet muestra un aviso.
function mapBox(height, center, zoom, setup) {
  const box = h('div', { class: 'map', style: `height:${height}px` }, h('p', { class: 'muted', style: 'padding:12px' }, t('map.loading')));
  setTimeout(() => loadLeaflet().then(L => {
    if (!box.isConnected) return;
    box.replaceChildren();
    const map = L.map(box).setView(center || DEFAULT_CENTER, zoom || 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    setup(L, map);
    setTimeout(() => map.invalidateSize(), 250);
  }).catch(() => { box.replaceChildren(h('p', { class: 'err', style: 'padding:12px' }, t('map.fail'))); }));
  return box;
}

const newDeliv = () => ({ mode: 'delivery', address: '', ref: '', lat: null, lng: null, acc: null, msg: '', busy: false });

// ---------- Pago con tarjeta SIMULADO (no se cobra dinero real; nunca se guarda el número completo ni el CVV) ----------
const MIN_CARD = 5; // la tarjeta solo se acepta si el pedido pasa de $5
const luhn = n => { let sum = 0, alt = false; for (let i = n.length - 1; i >= 0; i--) { let d = +n[i]; if (alt) { d *= 2; if (d > 9) d -= 9; } sum += d; alt = !alt; } return n.length >= 13 && sum % 10 === 0; };
const cardBrand = n => /^4/.test(n) ? 'Visa' : /^(5[1-5]|2[2-7])/.test(n) ? 'Mastercard' : /^3[47]/.test(n) ? 'Amex' : t('pay.tarjeta');
function cardForm(total, check, place) {
  const c = state.card || (state.card = { num: '', name: '', exp: '', cvv: '' });
  const num = h('input', { inputmode: 'numeric', autocomplete: 'cc-number', placeholder: '1234 5678 9012 3456', maxlength: 23, value: c.num, 'aria-label': t('card.num'),
    oninput: e => { const d = e.target.value.replace(/\D/g, '').slice(0, 19); c.num = d.replace(/(.{4})/g, '$1 ').trim(); e.target.value = c.num; } });
  const name = h('input', { autocomplete: 'cc-name', placeholder: t('card.name'), value: c.name, 'aria-label': t('card.name'), oninput: e => { c.name = e.target.value; } });
  const exp = h('input', { inputmode: 'numeric', autocomplete: 'cc-exp', placeholder: 'MM/AA', maxlength: 5, value: c.exp, 'aria-label': t('card.exp'),
    oninput: e => { let d = e.target.value.replace(/\D/g, '').slice(0, 4); if (d.length > 2) d = d.slice(0, 2) + '/' + d.slice(2); c.exp = d; e.target.value = d; } });
  const cvv = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'cc-csc', placeholder: 'CVV', maxlength: 4, value: c.cvv, 'aria-label': 'CVV',
    oninput: e => { c.cvv = e.target.value.replace(/\D/g, '').slice(0, 4); e.target.value = c.cvv; } });
  const msg = h('p', { class: 'err', role: 'alert' });
  const btn = h('button', { class: 'go', type: 'submit' }, t('card.pay', { total: money(total) }));
  const submit = e => {
    e.preventDefault();
    const digits = c.num.replace(/\s/g, ''), [mm, yy] = c.exp.split('/').map(Number), now = new Date();
    if (!luhn(digits)) return void (msg.textContent = t('card.badNum'));
    if (c.name.trim().length < 3) return void (msg.textContent = t('card.badName'));
    if (!mm || mm < 1 || mm > 12 || !yy || new Date(2000 + yy, mm, 1) <= now) return void (msg.textContent = t('card.badExp'));
    if (c.cvv.length < 3) return void (msg.textContent = t('card.badCvv'));
    const when = check(); if (!when) return;
    msg.textContent = ''; btn.disabled = true; btn.textContent = t('card.processing');
    setTimeout(() => {
      if (digits.endsWith('0002')) { btn.disabled = false; btn.textContent = t('card.pay', { total: money(total) }); msg.textContent = t('card.declined'); return; }
      const card = { brand: cardBrand(digits), last4: digits.slice(-4) };
      state.card = null;
      place(when, { paid: true, payRef: 'SIM-' + Date.now().toString(36).toUpperCase(), card });
    }, 1300);
  };
  return h('form', { class: 'cardform', onsubmit: submit, autocomplete: 'on' },
    h('div', { class: 'cardvisual' }, h('span', {}, '💳'), h('small', {}, t('card.sim'))),
    num, name, h('div', { class: 'row' }, exp, cvv), h('p', { class: 'muted' }, t('card.testHint')), msg, btn);
}

function openNow(now = new Date()) {
  const sc = getSched();
  if (sc.closed.includes(dateKey(now))) return false;
  const day = sc.days[now.getDay()];
  if (!day || !day.on) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= toMin(day.from) && m <= toMin(day.to);
}
function dayLabel(key) {
  const diff = Math.round((fromKey(key).getTime() - fromKey(dateKey(new Date())).getTime()) / 86400000);
  const base = fromKey(key).toLocaleDateString(LOCALES[lang], { weekday: 'long', day: 'numeric', month: 'short' });
  return (diff === 0 ? t('when.today') + ', ' : diff === 1 ? t('when.tomorrow') + ', ' : '') + base;
}
const timeLabel = hhmm => fromKey('2000-01-01', hhmm).toLocaleTimeString(LOCALES[lang], { hour: 'numeric', minute: '2-digit' });
function whenLabel(o) {
  if (!o.when || o.when.type !== 'later') return t('when.asap');
  return new Date(o.when.at).toLocaleString(LOCALES[lang], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// La sesión se guarda en el dispositivo (localStorage) si marcó "Mantener la sesión iniciada"; si no, solo mientras esté abierta la pestaña.
const SKEY = 'session_' + PAGE;
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SKEY) || sessionStorage.getItem(SKEY) || 'null'); } catch { return null; }
}
const state = { session: loadSession(), adminTab: 'pedidos', orderFilter: 'activos', clientTab: 'pedir', cat: 'todo', cart: {}, pay: '', when: { mode: '', day: '', time: '' }, flash: '' };
if (state.session && ((PAGE === 'admin') !== (state.session.role === 'admin'))) state.session = null;
if (state.session?.role === 'admin' && !adminPass()) state.session = null;
const loadCart = () => state.session?.role === 'cliente' ? DB.get('cart_' + state.session.email, {}) : {};
const saveCart = () => { if (state.session?.role === 'cliente') DB.set('cart_' + state.session.email, state.cart); };
state.cart = loadCart();

function setSession(s, remember) {
  if (remember === undefined) remember = localStorage.getItem(SKEY) !== null;
  try {
    localStorage.removeItem(SKEY); sessionStorage.removeItem(SKEY);
    if (s) (remember ? localStorage : sessionStorage).setItem(SKEY, JSON.stringify(s));
  } catch {}
  state.session = s; state.pay = ''; state.deliv = null; state.when = { mode: '', day: '', time: '' };
  state.cart = loadCart();
  render();
}

// ---------- Avisos ----------
function toast(msg, ms = 6000) {
  const box = document.getElementById('toasts');
  [...box.children].forEach(x => { if (x.textContent === msg) x.remove(); }); // sin avisos repetidos
  while (box.children.length >= 3) box.firstChild.remove();                   // máximo 3 a la vez
  const el = h('div', { class: 'toast', role: 'status' }, msg);
  box.append(el);
  setTimeout(() => el.remove(), ms);
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1175].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.2, ctx.currentTime + i * 0.2);
      o.start(ctx.currentTime + i * 0.2); o.stop(ctx.currentTime + i * 0.2 + 0.18);
    });
  } catch {}
}
function notifyNewOrder(o) {
  toast(t('notify.toast', { name: o.clientName, total: money(o.total), pay: t('payw.' + o.pay), when: whenLabel(o) }), 10000); beep();
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(t('notify.title'), { body: `${o.clientName}: ${o.items.map(i => i.qty + ' ' + itemName(i)).join(', ')} (${money(o.total)})` });
  }
  updateTitle();
}
function updateTitle() {
  const n = orders().filter(o => o.status === 'nuevo').length;
  document.title = (state.session?.role === 'admin' && n ? `(${n}) ` : '') + (PAGE === 'admin' ? t('adminTitle') : t('brand'));
}

// Sincroniza entre pestañas (administrador y cliente en el mismo navegador)
const SYNC_KEYS = ['products', 'orders', 'clients', 'adminProfile', 'biz', 'schedule', 'ship'];
function dataChanged(keys) {
  if (!state.session || !keys.some(k => SYNC_KEYS.includes(k))) return;
  if (state.session.role === 'admin') {
    if (['productos', 'horario', 'ventas', 'ajustes', 'perfil'].includes(state.adminTab)) { updateBadge(); return; } // no interrumpir lo que se está editando
  } else if (keys.length === 1 && keys[0] === 'orders' && state.clientTab !== 'pedidos') return;
  if (document.querySelector('.overlay')) return; // no cerrar el carrito ni la factura
  render();
}
window.addEventListener('storage', e => {
  if (e.key === 'orders') {
    const oldIds = new Set(JSON.parse(e.oldValue || '[]').map(o => o.id));
    const nuevos = JSON.parse(e.newValue || '[]').filter(o => !oldIds.has(o.id));
    if (state.session?.role === 'admin') nuevos.forEach(notifyNewOrder);
  }
  dataChanged([e.key]);
});

// ---------- Inicio de sesión ----------
// Pega aquí tu "Client ID" de Google. Con él, SOLO entran correos Gmail reales y verificados.
// Déjalo vacío para usar el modo básico (solo revisa que el Gmail tenga formato válido).
const GOOGLE_CLIENT_ID = '';

// Reglas reales de Gmail: 6 a 30 caracteres, solo letras, números y puntos; sin punto al inicio, al final ni dos seguidos.
const validGmail = e => /^(?!.*\.\.)[a-z0-9][a-z0-9.]{4,28}[a-z0-9]@gmail\.com$/.test(e);

function decodeJwt(tk) {
  const p = tk.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p), c => c.charCodeAt(0))));
}
function loginClient(email, name, phone = '', photo = '', remember = true) {
  const list = clients();
  let c = list.find(x => x.email === email);
  if (!c) {
    c = { email, name, phone, photo, created: new Date().toISOString() };
    list.push(c); DB.set('clients', list);
    toast(t('toast.accountCreated'));
  }
  setSession({ role: 'cliente', email: c.email, name: c.name }, remember);
}
function googleButton(err) {
  const holder = h('div', { style: 'display:flex;justify-content:center;min-height:44px;margin:8px 0' });
  const s = h('script', { src: 'https://accounts.google.com/gsi/client', async: true });
  s.onload = () => {
    google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: r => {
      try {
        const d = decodeJwt(r.credential);
        if (!d.email || !d.email_verified) { err.textContent = t('err.notVerified'); return; }
        loginClient(d.email.toLowerCase(), d.name || d.email.split('@')[0], '', d.picture || '', true);
      } catch { err.textContent = t('err.googleFail'); }
    } });
    google.accounts.id.renderButton(holder, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', locale: lang });
  };
  s.onerror = () => { err.textContent = t('err.googleLoad'); };
  document.head.append(s);
  return holder;
}

function loginView() {
  const box = h('div', { class: 'card' });
  const err = h('p', { class: 'err', role: 'alert' });
  const remember = h('input', { type: 'checkbox', checked: true });
  const rememberRow = h('label', { class: 'remember' }, remember, t('remember'));
  let form;
  if (PAGE !== 'admin') {
    // Clientes: solo escriben el correo. El nombre y el teléfono se piden únicamente si la cuenta es nueva.
    const mail = h('input', { type: 'email', name: 'email', autocomplete: 'email', placeholder: t('ph.email'), value: DB.get('lastEmail', '') });
    const name = h('input', { name: 'name', autocomplete: 'name', placeholder: t('ph.name') });
    const tel = h('input', { type: 'tel', name: 'tel', autocomplete: 'tel', placeholder: t('ph.phone') });
    const extra = h('div', { class: 'row' }, name, tel);
    const hint = h('p', { class: 'muted' });
    const submit = h('button', { type: 'submit' });
    const sync = () => {
      const e = mail.value.trim().toLowerCase();
      const valid = validGmail(e), known = valid && clients().some(c => c.email === e);
      extra.style.display = valid && !known ? 'flex' : 'none';
      hint.textContent = known ? t('login.welcomeBack') : valid ? t('login.newAccount') : t('login.hint');
      submit.textContent = valid && !known ? t('btn.createEnter') : t('btn.enter');
    };
    mail.addEventListener('input', sync);
    const go = () => {
      err.textContent = '';
      const email = mail.value.trim().toLowerCase();
      if (!validGmail(email)) { err.textContent = t('err.gmail'); return; }
      const known = clients().some(c => c.email === email);
      if (!known && !name.value.trim()) { err.textContent = t('err.needName'); return; }
      DB.set('lastEmail', email);
      loginClient(email, name.value.trim(), tel.value.trim(), '', remember.checked);
    };
    form = GOOGLE_CLIENT_ID
      ? h('div', {}, h('p', { class: 'muted' }, t('login.google')), googleButton(err))
      : h('form', { novalidate: true, onsubmit: e => { e.preventDefault(); go(); } },
          hint, h('div', { class: 'row' }, mail), extra, rememberRow, h('div', { class: 'row' }, submit));
    sync();
  } else {
    // Administrador: usuario y contraseña propios. El navegador puede ofrecer guardar la contraseña.
    const first = !adminPass();
    const u = h('input', { name: 'username', autocomplete: 'username', placeholder: t('ph.user') });
    const p = h('input', { type: 'password', name: 'password', autocomplete: first ? 'new-password' : 'current-password', placeholder: t('ph.pass') });
    const p2 = h('input', { type: 'password', name: 'password2', autocomplete: 'new-password', placeholder: t('ph.pass2') });
    const go = () => {
      err.textContent = '';
      if (first) {
        if (u.value.trim().length < 3) { err.textContent = t('err.user3'); return; }
        if (p.value.length < 6) { err.textContent = t('err.pass6'); return; }
        if (p.value !== p2.value) { err.textContent = t('err.passMatch'); return; }
        DB.set('adminUser', u.value.trim()); DB.set('adminPass', p.value);
        toast(t('toast.adminCreated'));
      } else if (u.value.trim() !== adminUser() || p.value !== adminPass()) {
        err.textContent = t('err.badLogin'); return;
      }
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      setSession({ role: 'admin', name: DB.get('adminProfile', { name: 'Administrador' }).name }, remember.checked);
    };
    // Olvidé la contraseña: borra solo el usuario y la contraseña; los productos, pedidos y clientes se quedan.
    const resetAdmin = () => {
      if (!confirm(t('admin.resetConfirm'))) return;
      try { localStorage.removeItem('adminUser'); localStorage.removeItem('adminPass'); localStorage.removeItem(SKEY); sessionStorage.removeItem(SKEY); } catch {}
      state.session = null; toast(t('toast.resetDone')); render();
    };
    form = h('form', { onsubmit: e => { e.preventDefault(); go(); } },
      h('p', { class: 'muted' }, first ? t('admin.first') : t('admin.only')),
      h('div', { class: 'row' }, u, p), first ? h('div', { class: 'row' }, p2) : null, rememberRow,
      h('div', { class: 'row' }, h('button', { type: 'submit' }, first ? t('btn.createEnter') : t('btn.enter'))),
      first ? null : h('div', { class: 'row' }, h('button', { type: 'button', class: 'sec small', onclick: resetAdmin }, t('admin.forgot'))));
  }
  box.append(form, err);
  return h('div', { class: 'login' },
    h('div', { class: 'langbar' }, langSelect(), h('button', { class: 'sec themebtn', 'aria-label': t('theme.' + (theme === 'dark' ? 'light' : 'dark')), title: t('theme.' + (theme === 'dark' ? 'light' : 'dark')), onclick: toggleTheme }, theme === 'dark' ? '☀️' : '🌙')),
    h('div', { class: 'box' }, h('div', { class: 'panel' },
      h('div', { class: 'sign' }, h('span', {}, '🌿'), PAGE === 'admin' ? t('adminTitle') : t('brand')),
      h('p', { class: 'sub' }, PAGE === 'admin' ? t('adminTagline') : t('tagline')),
      box)));
}

// ---------- Perfil ----------
function avatar(p, size = 40) {
  const s = `width:${size}px;height:${size}px;border-radius:50%;flex:none;border:2.5px solid var(--tinta);`;
  return p && p.photo
    ? h('img', { src: p.photo, alt: '', style: s + 'object-fit:cover' })
    : h('div', { style: s + `background:var(--ocre);color:var(--tinta);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:${Math.round(size / 2)}px` }, ((p && p.name) || '?')[0].toUpperCase());
}
function currentProfile() {
  if (state.session.role === 'admin') return DB.get('adminProfile', { name: 'Administrador', email: '', phone: '', photo: '' });
  return clients().find(c => c.email === state.session.email) || { name: state.session.name, email: state.session.email };
}
function profileView() {
  const isAdmin = state.session.role === 'admin';
  const p = { ...currentProfile() };
  const prev = h('div', {}, avatar(p, 96));
  const name = h('input', { value: p.name || '', placeholder: t('ph.name') });
  const mail = h('input', { value: p.email || '', placeholder: t('ph.mail'), disabled: !isAdmin });
  const tel = h('input', { value: p.phone || '', placeholder: t('ph.phone') });
  const file = h('input', { type: 'file', accept: 'image/*', onchange: e => {
    const f = e.target.files[0]; if (!f) return;
    photoTo(f, 128, d => { p.photo = d; prev.replaceChildren(avatar(p, 96)); });
  } });
  const save = () => {
    if (!name.value.trim()) return toast(t('err.name'));
    p.name = name.value.trim(); p.phone = tel.value.trim();
    if (isAdmin) { p.email = mail.value.trim(); DB.set('adminProfile', p); }
    else {
      const l = clients(); const i = l.findIndex(c => c.email === p.email);
      if (i >= 0) l[i] = { ...l[i], name: p.name, phone: p.phone, photo: p.photo };
      DB.set('clients', l);
    }
    toast(t('toast.profileSaved'));
    setSession({ ...state.session, name: p.name });
  };
  return h('section', { class: 'card' }, h('h3', {}, isAdmin ? t('profile.admin') : t('profile.mine')),
    h('div', { class: 'row' }, prev, file),
    h('div', { class: 'row' }, name), h('div', { class: 'row' }, mail), h('div', { class: 'row' }, tel),
    isAdmin ? null : h('p', { class: 'muted' }, t('profile.mailLocked')),
    h('div', { class: 'row' }, h('button', { onclick: save }, t('btn.saveProfile'))));
}

// ---------- Encabezado (letrero + herramientas) ----------
function header() {
  const cartBtn = PAGE !== 'admin'
    ? h('button', { class: 'cartbtn', 'aria-label': t('cart'), title: t('cart'), onclick: openSheet }, '🛒', h('span', { id: 'cartCount', class: 'badge' }))
    : null;
  return h('header', {},
    h('div', { class: 'bar' },
      h('div', { class: 'sign' }, h('span', {}, '🌿'), PAGE === 'admin' ? t('adminTitle') : t('brand')),
      h('div', { class: 'tools' }, syncDot(), langSelect(), h('button', { class: 'sec themebtn', 'aria-label': t('theme.' + (theme === 'dark' ? 'light' : 'dark')), title: t('theme.' + (theme === 'dark' ? 'light' : 'dark')), onclick: toggleTheme }, theme === 'dark' ? '☀️' : '🌙'), cartBtn,
        h('div', { class: 'me' }, avatar(currentProfile(), 36), h('span', { class: 'me-name' }, state.session.name),
          h('button', { class: 'sec small', onclick: () => setSession(null) }, t('logout'))))));
}
function tabsNav(list, current, onPick) {
  return h('nav', { class: 'tabs' }, list.map(([id, label]) =>
    h('button', { class: current === id ? 'on' : 'sec', onclick: () => onPick(id) }, label,
      id === 'pedidos' && PAGE === 'admin' ? h('span', { id: 'badge', class: 'badge' }) : null)));
}

// ---------- Factura ----------
function invoiceHtml(o) {
  const biz = DB.get('biz', {});
  const rows = o.items.map(i => `<tr><td>${esc(itemName(i))}</td><td class="n">${i.qty}</td><td class="n">${money(i.price)}</td><td class="n">${money(i.qty * i.price)}</td></tr>`).join('');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${esc(t('inv.no', { n: orderNo(o) }))}</title><style>
body{font-family:'Segoe UI',Arial,sans-serif;color:#23331f;margin:0;padding:24px;background:#fff}
.inv{max-width:700px;margin:0 auto;border:2px solid #2f5a2c;border-radius:14px;padding:26px}
h1{margin:0 0 4px;font-size:28px;color:#2f5a2c}
.top{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;border-bottom:2px dashed #c9a06a;padding-bottom:14px;margin-bottom:14px}
.muted{color:#5d6b55;font-size:13px;line-height:1.5}
.no{font-size:20px;font-weight:800;text-align:right}
table{width:100%;border-collapse:collapse;margin-top:12px}
th{text-align:left;font-size:12px;color:#5d6b55;border-bottom:2px solid #23331f;padding:6px 4px}
td{padding:8px 4px;border-bottom:1px dotted #b9c5a3}
.n{text-align:right;white-space:nowrap}
.tot{display:flex;justify-content:flex-end;gap:28px;font-size:22px;font-weight:800;margin-top:16px}
.foot{margin-top:22px;text-align:center}
@media print{body{padding:0}.inv{border:0}}
</style></head><body><div class="inv">
<div class="top"><div><h1>🌿 ${esc(biz.name || t('brand'))}</h1><div class="muted">${esc(biz.address || '')}${biz.address && biz.phone ? '<br>' : ''}${esc(biz.phone || '')}</div></div>
<div><div class="no">${esc(t('inv.no', { n: orderNo(o) }))}</div><div class="muted" style="text-align:right">${esc(t('inv.date'))}: ${esc(fmtDate(o.date))}</div></div></div>
<div class="muted"><b>${esc(t('inv.client'))}:</b> ${esc(o.clientName)} (${esc(o.clientEmail)})<br>${o.delivery ? '<b>' + esc(t('deliv.title')) + ':</b> ' + (o.delivery.mode === 'pickup' ? esc(t('deliv.pickup')) : esc(o.delivery.address || t('deliv.gpsOnly'))) + '<br>' : ''}<b>${esc(t('inv.pay'))}:</b> ${esc(payLabel(o.pay))}${o.paid ? ' · ' + esc(t('pay.paid')) + (o.card ? ' ' + esc(o.card.brand) + ' ****' + esc(o.card.last4) : '') + ' (' + esc(o.payRef || '') + ')' : ''}<br><b>${esc(t('inv.when'))}:</b> ${esc(whenLabel(o))}</div>
<table><thead><tr><th>${esc(t('inv.item'))}</th><th class="n">${esc(t('inv.qty'))}</th><th class="n">${esc(t('inv.unit'))}</th><th class="n">${esc(t('inv.amount'))}</th></tr></thead><tbody>${rows}</tbody></table>
${o.delivery && o.delivery.mode === 'delivery' && o.fee != null ? `<div class="tot" style="font-size:15px;font-weight:600"><span>${esc(t('deliv.fee'))}${o.delivery.km != null ? ' (' + esc(fmtKm(o.delivery.km)) + ')' : ''}</span><span>${money(o.fee)}</span></div>` : ''}
<div class="tot"><span>${esc(t('total'))}</span><span>${money(o.total)}</span></div>
<div class="foot"><div>${esc(biz.note || t('inv.thanks'))}</div><div class="muted" style="margin-top:6px">${esc(t('inv.notice'))}</div></div>
</div></body></html>`;
}
function openInvoice(o) {
  const html = invoiceHtml(o);
  const overlay = h('div', { class: 'overlay mid', onclick: e => { if (e.target === overlay) close(); } });
  const frame = h('iframe', { class: 'invframe', title: t('inv.no', { n: orderNo(o) }) });
  const esc2 = e => { if (e.key === 'Escape') close(); };
  const close = () => { document.removeEventListener('keydown', esc2); overlay.remove(); };
  document.addEventListener('keydown', esc2);
  const download = () => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const a = h('a', { href: url, download: `${t('inv.file')}-${orderNo(o)}.html` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };
  const print = () => { frame.contentWindow.focus(); frame.contentWindow.print(); };
  overlay.append(h('div', { class: 'sheet', role: 'dialog', 'aria-label': t('invoice') },
    h('h3', {}, '🧾 ' + t('inv.no', { n: orderNo(o) })), frame,
    h('div', { class: 'row sb' }, h('button', { class: 'sec', onclick: close }, t('inv.close')),
      h('span', { class: 'row', style: 'margin:0' }, h('button', { class: 'sec', onclick: download }, '⬇ ' + t('inv.download')), h('button', { class: 'go', onclick: print }, '🖨 ' + t('inv.print'))))));
  document.body.append(overlay);
  frame.srcdoc = html;
}

// ======================= ADMINISTRADOR =======================
function updateBadge() {
  const b = document.getElementById('badge');
  const n = orders().filter(o => o.status === 'nuevo').length;
  if (b) { b.textContent = n; b.style.display = n ? 'inline' : 'none'; }
  updateTitle();
}

// ---------- Registro de ventas: cada pedido ENTREGADO es una venta, con el día en que se entregó ----------
const saleDate = o => new Date(((o.log || []).slice().reverse().find(x => x.s === 'entregado') || {}).d || o.date);
const sales = () => orders().filter(o => o.status === 'entregado').map(o => ({ o, at: saleDate(o) })).sort((a, b) => b.at - a.at);
const monthKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const expenses = () => DB.get('expenses', {});
const csvCell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
function adminSales() {
  if (!state.salesMonth) state.salesMonth = monthKey(new Date());
  const stat = (v, l) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, l));
  const all = sales(), mk = state.salesMonth;
  const inMonth = all.filter(x => monthKey(x.at) === mk);
  const total = inMonth.reduce((a, x) => a + x.o.total, 0);
  const byPay = id => inMonth.filter(x => x.o.pay === id).reduce((a, x) => a + x.o.total, 0);
  const [y, m] = mk.split('-').map(Number);
  const gastos = Number(expenses()[mk]) || 0;

  const shift = d => { const n = new Date(y, m - 1 + d, 1); state.salesMonth = monthKey(n); render(); };
  const monthIn = h('input', { type: 'month', value: mk, 'aria-label': t('sales.month'), onchange: e => { if (e.target.value) { state.salesMonth = e.target.value; setTimeout(render); } } });
  const gasto = h('input', { type: 'number', min: '0', step: '0.01', value: gastos || '', placeholder: '0.00', 'aria-label': t('sales.expenses'), style: 'max-width:120px',
    onchange: e => { const ex = expenses(); ex[mk] = Math.max(0, Number(e.target.value) || 0); DB.set('expenses', ex); setTimeout(render); } });
  const profit = total - gastos;

  const q = h('input', { type: 'search', placeholder: t('sales.search'), value: state.salesQ || '', 'aria-label': t('sales.search'), style: 'flex:1 1 200px', oninput: e => { state.salesQ = e.target.value; list(); } });
  const dayIn = h('input', { type: 'date', value: state.salesDay || '', 'aria-label': t('sales.day'), onchange: e => { state.salesDay = e.target.value; list(); } });
  const results = h('div', {});
  const rowOf = x => h('div', { class: 'srow' },
    h('b', {}, '#' + orderNo(x.o)), h('span', { class: 'muted' }, x.at.toLocaleTimeString(LOCALES[lang], { hour: '2-digit', minute: '2-digit' })),
    h('span', { class: 'sname' }, x.o.clientName, h('small', { class: 'muted' }, x.o.items.map(i => `${i.qty}× ${itemName(i)}`).join(', '))),
    h('span', { class: 'tag' }, payLabel(x.o.pay)), h('b', { class: 'sum' }, money(x.o.total)));
  const list = () => {
    const text = (state.salesQ || '').trim().toLowerCase(), day = state.salesDay || '';
    const searching = !!(text || day);
    const src = searching ? all : inMonth;
    const found = src.filter(x => {
      if (day && dateKey(x.at) !== day) return false;
      if (!text) return true;
      const hay = [orderNo(x.o), x.o.clientName, x.o.clientEmail, dateKey(x.at), x.at.toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'long', year: 'numeric' }), ...x.o.items.map(i => itemName(i))].join(' ').toLowerCase();
      return text.split(/\s+/).every(w => hay.includes(w));
    });
    const kids = [h('p', { class: 'muted' }, searching ? t('sales.found', { n: found.length, total: money(found.reduce((a, x) => a + x.o.total, 0)) }) : t('sales.inMonth', { n: found.length }))];
    if (!found.length) kids.push(h('div', { class: 'card empty' }, h('div', { class: 'big' }, '🧾'), h('p', { class: 'muted' }, t('sales.none'))));
    const groups = {};
    found.forEach(x => (groups[dateKey(x.at)] ||= []).push(x));
    Object.keys(groups).sort().reverse().forEach(k => kids.push(h('section', { class: 'card sday' },
      h('div', { class: 'row sb' }, h('h4', {}, fromKey(k).toLocaleDateString(LOCALES[lang], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })), h('b', {}, money(groups[k].reduce((a, x) => a + x.o.total, 0)))),
      ...groups[k].map(rowOf))));
    results.replaceChildren(...kids);
  };
  const exportCsv = () => {
    const rows = [['Factura', 'Fecha', 'Hora', 'Cliente', 'Correo', 'Productos', 'Pago', 'Total'],
      ...inMonth.slice().reverse().map(x => [orderNo(x.o), dateKey(x.at), x.at.toLocaleTimeString(LOCALES[lang], { hour: '2-digit', minute: '2-digit' }), x.o.clientName, x.o.clientEmail, x.o.items.map(i => `${i.qty} ${itemName(i)}`).join('; '), x.o.pay, x.o.total.toFixed(2)])];
    const blob = new Blob(['﻿' + rows.map(r => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `ventas-${mk}.csv` }); document.body.append(a); a.click(); a.remove();
  };
  list();
  return h('div', {},
    h('section', { class: 'card' },
      h('div', { class: 'row sb' },
        h('button', { class: 'sec round', 'aria-label': t('cal.prev'), onclick: () => shift(-1) }, '‹'),
        h('div', { style: 'text-align:center' }, h('h3', { style: 'margin:0;text-transform:capitalize' }, new Date(y, m - 1, 1).toLocaleDateString(LOCALES[lang], { month: 'long', year: 'numeric' }).replace(' de ', ' · ')), monthIn),
        h('button', { class: 'sec round', 'aria-label': t('cal.next'), onclick: () => shift(1) }, '›')),
      h('div', { class: 'stats' },
        stat(money(total), t('sales.total')), stat(inMonth.length, t('sales.count')),
        stat(money(byPay('efectivo')), t('pay.efectivo')), stat(money(byPay('tarjeta')), t('pay.tarjeta'))),
      h('div', { class: 'row', style: 'align-items:center' }, h('label', {}, t('sales.expenses')), gasto, h('span', { class: 'muted' }, t('sales.expHint'))),
      h('div', { class: 'row sb profit' + (profit < 0 ? ' neg' : '') }, h('b', {}, t('sales.profit')), h('b', { class: 'big' }, money(profit))),
      h('div', { class: 'row' }, h('button', { class: 'sec small', onclick: exportCsv, disabled: !inMonth.length }, '⬇ ' + t('sales.csv')))),
    h('section', { class: 'card' }, h('h3', {}, '🔎 ' + t('sales.find')), h('div', { class: 'row' }, q, dayIn, h('button', { class: 'sec small', onclick: () => { state.salesQ = ''; state.salesDay = ''; render(); } }, t('sales.clear')))),
    results);
}

function adminMap() {
  const sp = getShip(), f = state.mapFilter || 'activos';
  const list = orders().filter(o => f === 'todos' || (f === 'activos' ? o.status !== 'entregado' : o.status === 'entregado'));
  const withLoc = list.filter(o => o.delivery?.mode === 'delivery' && hasPt(o.delivery.lat, o.delivery.lng));
  const without = list.filter(o => o.delivery?.mode === 'delivery' && !hasPt(o.delivery.lat, o.delivery.lng));
  const chips = h('div', { class: 'chips' }, [['activos', t('f.active')], ['entregado', t('f.done')], ['todos', t('f.all')]].map(([id, l]) =>
    h('button', { class: 'small ' + (f === id ? 'on' : 'sec'), onclick: () => { state.mapFilter = id; render(); } }, l)));
  const pts = withLoc.map(o => [o.delivery.lat, o.delivery.lng]).concat(hasPt(sp.lat, sp.lng) ? [[sp.lat, sp.lng]] : []);
  const map = mapBox(420, pts[0] || null, 12, (L, mp) => {
    if (hasPt(sp.lat, sp.lng)) L.marker([sp.lat, sp.lng], { icon: pinIcon(L, '🏪') }).addTo(mp).bindTooltip(t('map.shop'));
    withLoc.forEach(o => {
      const d = o.delivery;
      if (hasPt(sp.lat, sp.lng)) L.polyline([[sp.lat, sp.lng], [d.lat, d.lng]], { color: '#9c2f4f', weight: 2, dashArray: '6 6', opacity: .6 }).addTo(mp);
      const pop = h('div', {}, h('b', {}, `#${orderNo(o)} ${o.clientName}`), h('div', {}, d.address || t('deliv.gpsOnly')),
        d.km != null ? h('div', {}, '📏 ' + t('deliv.dist', { km: fmtKm(d.km) })) : h('span'),
        h('div', {}, t('st.' + o.status) + ' · ' + money(o.total)),
        h('a', { href: routeLink(d.lat, d.lng), target: '_blank', rel: 'noopener' }, '🧭 ' + t('deliv.route')));
      L.marker([d.lat, d.lng], { icon: pinIcon(L, `<span class="mpin ${o.status}">#${orderNo(o)}</span>`, 'mpinwrap') }).addTo(mp).bindPopup(pop);
    });
    if (pts.length > 1) mp.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
  });
  return h('div', {}, chips,
    Sync.on ? h('span') : h('p', { class: 'err' }, t('sync.mapOff')),
    hasPt(sp.lat, sp.lng) ? h('span') : h('p', { class: 'err' }, t('map.noShop')),
    map,
    h('p', { class: 'muted' }, t('map.count', { n: withLoc.length })),
    without.length ? h('section', { class: 'card' }, h('h4', {}, t('map.noLoc')), ...without.map(o => h('div', { class: 'muted' }, `#${orderNo(o)} ${o.clientName} — ${o.delivery.address || ''}`))) : h('span'));
}

function adminView() {
  const tabs = [['pedidos', t('tab.aorders')], ['mapa', t('tab.map')], ['productos', t('tab.products')], ['horario', t('tab.schedule')], ['ventas', t('tab.sales')], ['clientes', t('tab.clients')], ['perfil', t('tab.profile')], ['ajustes', t('tab.settings')]];
  const panels = { pedidos: adminOrders, mapa: adminMap, productos: adminProducts, horario: adminSchedule, ventas: adminSales, clientes: adminClients, perfil: profileView, ajustes: adminSettings };
  setTimeout(updateBadge);
  return h('div', {}, header(), h('main', { class: 'wrap' },
    tabsNav(tabs, state.adminTab, id => { state.adminTab = id; render(); }),
    panels[state.adminTab]()));
}

const STEPS = ['nuevo', 'preparando', 'camino', 'entregado'];

// Datos de entrega de un pedido (para el administrador y el cliente)
function deliveryInfo(o, admin) {
  const d = o.delivery;
  if (!d) return h('span');
  if (d.mode === 'pickup') return h('div', { class: 'dinfo' }, '🏪 ' + t('deliv.pickup'));
  const hasLoc = hasPt(d.lat, d.lng);
  const feeSet = o.fee !== null && o.fee !== undefined;
  const kids = [h('div', {}, '🛵 ' + (d.address || t('deliv.gpsOnly')) + (d.ref ? ' — ' + d.ref : ''))];
  if (hasLoc) {
    const links = [h('a', { href: mapLink(d.lat, d.lng), target: '_blank', rel: 'noopener' }, '🗺️ ' + t('deliv.seeMap'))];
    if (admin) links.push(' · ', h('a', { href: routeLink(d.lat, d.lng), target: '_blank', rel: 'noopener' }, '🧭 ' + t('deliv.route')));
    kids.push(h('div', { class: 'muted' }, ...links));
  }
  if (d.km !== null && d.km !== undefined) kids.push(h('div', { class: 'muted' }, '📏 ' + t('deliv.dist', { km: fmtKm(d.km) })));
  if (feeSet) kids.push(h('div', { class: 'muted' }, t('deliv.fee') + ': ' + money(o.fee)));
  else if (admin) {
    const inp = h('input', { type: 'number', min: '0', step: '0.25', placeholder: '0.00', 'aria-label': t('deliv.fee'), style: 'max-width:110px' });
    kids.push(h('div', { class: 'row', style: 'align-items:center' }, h('span', { class: 'err' }, t('deliv.tbdAdmin')), inp,
      h('button', { class: 'small', onclick: () => setOrderFee(o.id, inp.value) }, t('deliv.setFee'))));
  } else kids.push(h('div', { class: 'muted' }, t('deliv.tbdClient')));
  return h('div', { class: 'dinfo' }, ...kids);
}
function setOrderFee(id, v) {
  const fee = Number(v);
  if (!isFinite(fee) || fee < 0 || v === '') return toast(t('err.fee'));
  const l = orders(), o = l.find(x => x.id === id); if (!o) return;
  o.fee = Math.round(fee * 100) / 100; o.total = Math.round(((o.subtotal ?? o.total) + o.fee) * 100) / 100;
  DB.set('orders', l); render();
}
function adminOrders() {
  const all = orders();
  const today = new Date().toDateString();
  const sales = all.filter(o => new Date(o.date).toDateString() === today).reduce((s, o) => s + o.total, 0);
  const nuevos = all.filter(o => o.status === 'nuevo').length;
  const stat = (v, l, cls = '') => h('div', { class: 'stat ' + cls }, h('b', {}, v), h('span', {}, l));
  const stats = h('div', { class: 'stats' }, stat(nuevos, t('stat.new'), nuevos ? 'alert' : ''), stat(money(sales), t('stat.today')), stat(clients().length, t('stat.clients')));

  const filters = [['activos', t('f.active')], ['entregado', t('f.done')], ['todos', t('f.all')]];
  const chips = h('div', { class: 'chips' }, filters.map(([id, l]) =>
    h('button', { class: 'small ' + (state.orderFilter === id ? 'on' : 'sec'), onclick: () => { state.orderFilter = id; render(); } }, l)));

  // Los pedidos por atender se ordenan por la hora a la que hay que entregarlos; los demás, del más nuevo al más viejo.
  const dueMs = o => o.when?.type === 'later' ? new Date(o.when.at).getTime() : new Date(o.date).getTime();
  const list = all.filter(o => state.orderFilter === 'todos' || (state.orderFilter === 'activos' ? o.status !== 'entregado' : o.status === 'entregado'))
    .sort((a, b) => state.orderFilter === 'activos' ? dueMs(a) - dueMs(b) : new Date(b.date) - new Date(a.date));
  const next = { nuevo: 'preparando', preparando: 'camino', camino: 'entregado' };

  const body = list.length ? list.map(o => h('article', { class: 'ticket ' + o.status },
    h('div', { class: 't-head' }, h('b', {}, `#${orderNo(o)} ${o.clientName}`), h('span', { class: 'tag ' + o.status }, t('st.' + o.status))),
    h('div', { class: 't-body' },
      h('div', { class: 'muted' }, o.clientEmail), h('div', { class: 'muted' }, fmtDate(o.date)),
      h('div', { class: 'when' + (o.when?.type === 'later' ? ' later' : '') }, '🕒 ' + t('when.for', { when: whenLabel(o) })),
      deliveryInfo(o, true),
      o.items.map(i => h('div', { class: 'leader' }, h('span', {}, `${i.qty} × ${itemName(i)}`), h('i'), h('b', {}, money(i.qty * i.price)))),
      h('div', { class: 't-foot' }, h('span', { class: 'sum' }, t('total') + ' ' + money(o.total)), h('span', { class: 'tag' }, payLabel(o.pay))),
      h('div', { class: 'row' },
        next[o.status] ? h('button', { class: next[o.status] === 'camino' ? 'go' : '', onclick: () => setOrderStatus(o.id, next[o.status]) }, t('next.' + next[o.status])) : null,
        h('button', { class: 'sec small', onclick: () => openInvoice(o) }, '🧾 ' + t('invoice'))))))
    : h('div', { class: 'card empty' }, h('div', { class: 'big' }, '🧺'),
        h('h3', {}, state.orderFilter === 'entregado' ? t('empty.noDelivered') : t('empty.noActive')), h('p', { class: 'muted' }, t('empty.hint')));
  return h('div', {}, stats, chips, body);
}
function setOrderStatus(id, status) {
  const l = orders(); const o = l.find(x => x.id === id);
  if (o) { o.status = status; (o.log = o.log || []).push({ s: status, d: new Date().toISOString() }); }
  DB.set('orders', l); render();
}

function adminSchedule() {
  const sc = getSched();
  const names = [1, 2, 3, 4, 5, 6, 0].map(i => [i, new Date(2024, 0, 7 + i).toLocaleDateString(LOCALES[lang], { weekday: 'long' })]);
  const saveDay = (i, patch) => { const cur = getSched(); cur.days[i] = { ...cur.days[i], ...patch }; DB.set('schedule', cur); toast(t('toast.schSaved')); };
  const rows = names.map(([i, nm]) => {
    const d = sc.days[i];
    const from = h('input', { type: 'time', value: d.from, disabled: !d.on, 'aria-label': t('sch.from') });
    const to = h('input', { type: 'time', value: d.to, disabled: !d.on, 'aria-label': t('sch.to') });
    const txt = h('span', {}, d.on ? t('sch.open') : t('sch.closed'));
    const sw = h('input', { type: 'checkbox', checked: !!d.on, onchange: e => {
      const on = e.target.checked; from.disabled = to.disabled = !on; txt.textContent = on ? t('sch.open') : t('sch.closed');
      row.classList.toggle('out', !on); saveDay(i, { on });
    } });
    const hours = which => e => {
      const cur = getSched().days[i], next = { ...cur, [which]: e.target.value };
      if (!next.from || !next.to || toMin(next.from) >= toMin(next.to)) { e.target.value = cur[which]; toast(t('err.hours')); return; }
      saveDay(i, { [which]: e.target.value });
    };
    from.addEventListener('change', hours('from')); to.addEventListener('change', hours('to'));
    const row = h('div', { class: 'prow sched' + (d.on ? '' : ' out') }, h('div', { class: 'nm bname' }, nm),
      h('label', { class: 'switch' }, sw, h('span', { class: 'sl' }), txt),
      h('label', { class: 'tm' }, t('sch.from'), from), h('label', { class: 'tm' }, t('sch.to'), to));
    return row;
  });
  const fmtMin = n => n === 0 ? t('sch.noNotice') : n % 60 === 0 ? (n / 60) + ' h' : n + ' min';
  const fmtDays = n => `${n} ${n === 1 ? t('day.one') : t('day.many')}`;
  const pick = (opts, cur, fmt, key) => h('select', { class: 'langsel', onchange: e => { const cc = getSched(); cc[key] = Number(e.target.value); cc.v = 2; DB.set('schedule', cc); toast(t('toast.schSaved')); } },
    opts.map(v => h('option', { value: v, selected: v === Number(cur) }, fmt(v))));
  const options = h('div', {},
    h('div', { class: 'row' }, h('span', {}, t('sch.step')), pick([15, 30, 45, 60], sc.step, fmtMin, 'step')),
    h('div', { class: 'row' }, h('span', {}, t('sch.lead')), pick([0, 30, 60, 120, 240], sc.lead, fmtMin, 'lead')),
    h('div', { class: 'row' }, h('span', {}, t('sch.bulk1')), pick([3, 5, 10, 15, 20, 30, 50], sc.bulk, n => String(n), 'bulk'), h('span', {}, t('sch.bulk2'))),
    h('div', { class: 'row' }, h('span', {}, t('sch.ahead')), pick([30, 90, 180, 365, 730], sc.ahead, fmtDays, 'ahead'), h('span', {}, t('sch.aheadEnd'))));

  // Días completos que no atiendes (feriado, viaje, no hay fruta…)
  const todayKey = dateKey(new Date());
  const closeDay = key => {
    if (!key) { toast(t('err.pickDate')); return; }
    const cur = getSched(); if (!cur.closed.includes(key)) cur.closed.push(key); cur.closed.sort(); DB.set('schedule', cur);
    const n = orders().filter(o => o.status !== 'entregado' && o.when?.type === 'later' && dateKey(new Date(o.when.at)) === key).length;
    render(); if (n) toast(t('sch.hasOrders', { n }), 9000);
  };
  const dateIn = h('input', { type: 'date', min: todayKey, 'aria-label': t('when.day') });
  const closedList = sc.closed.filter(k => k >= todayKey);
  const closedCard = h('section', { class: 'card' }, h('h3', {}, '🚫 ' + t('sch.closedTitle')), h('p', { class: 'muted' }, t('sch.closedHint')),
    h('div', { class: 'row' }, dateIn, h('button', { onclick: () => closeDay(dateIn.value) }, t('sch.closeDay')), h('button', { class: 'sec', onclick: () => closeDay(todayKey) }, t('sch.closeToday'))),
    closedList.length ? h('hr') : h('p', { class: 'muted' }, t('sch.noClosed')),
    closedList.map(k => h('div', { class: 'prow' },
      h('div', { class: 'nm bname' }, fromKey(k).toLocaleDateString(LOCALES[lang], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(' De ', ' de ')),
      h('button', { class: 'sec small', onclick: () => { const cur = getSched(); cur.closed = cur.closed.filter(x => x !== k); DB.set('schedule', cur); render(); } }, t('sch.reopen')))));
  return h('div', {}, h('section', { class: 'card' }, h('h3', {}, '🕒 ' + t('sch.title')), h('p', { class: 'muted' }, t('sch.hint')), h('div', {}, rows), h('hr'), options), closedCard);
}

function updateProduct(id, patch) {
  const l = products(); const p = l.find(x => x.id === id); if (p) Object.assign(p, patch); DB.set('products', l);
}
function productThumb(p) {
  const inp = h('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: e => {
    const f = e.target.files[0]; if (f) photoTo(f, 200, d => { updateProduct(p.id, { photo: d }); render(); });
  } });
  return h('label', { class: 'thumb edit', title: t('thumb.title') }, p.photo ? h('img', { src: p.photo, alt: displayName(p) }) : emojiFor(p), inp);
}

// Una fila de producto: foto, nombre, precio y el interruptor "Hay / No hay"
function productRow(p, after) {
  const row = h('div', { class: 'prow' + (p.available ? '' : ' out') });
  const stockTxt = h('span', {}, p.available ? t('stock.yes') : t('stock.no'));
  const sw = h('input', { type: 'checkbox', checked: !!p.available, onchange: e => {
    if (e.target.checked && !(p.price > 0)) { e.target.checked = false; toast(t('toast.needPrice')); return; }
    p.available = e.target.checked; updateProduct(p.id, { available: p.available });
    stockTxt.textContent = p.available ? t('stock.yes') : t('stock.no'); row.classList.toggle('out', !p.available);
    after && after();
  } });
  const price = h('input', { type: 'number', step: '0.01', min: '0', placeholder: t('ph.price'), value: p.price > 0 ? p.price : '', 'aria-label': t('ph.price'), onchange: e => {
    const v = parseFloat(e.target.value) || 0; p.price = v;
    const patch = { price: v };
    if (v <= 0 && p.available) { patch.available = false; p.available = false; sw.checked = false; stockTxt.textContent = t('stock.no'); row.classList.add('out'); }
    updateProduct(p.id, patch); toast(t('toast.priceUpdated')); after && after();
  } });
  const nameEl = isBank(p)
    ? h('div', { class: 'nm bname' }, displayName(p))
    : h('input', { class: 'nm', value: p.name, 'aria-label': t('ph.name'), onchange: e => updateProduct(p.id, { name: e.target.value.trim() || p.name, custom: true }) });
  row.append(...[productThumb(p), nameEl,
    h('label', { class: 'pr' }, '$', price),
    h('label', { class: 'switch' }, sw, h('span', { class: 'sl' }), stockTxt),
    p.photo ? h('button', { class: 'sec small', onclick: () => { updateProduct(p.id, { photo: '' }); render(); } }, t('btn.removePhoto')) : null,
    isBank(p) ? null : h('button', { class: 'red small', 'aria-label': t('btn.delete') + ' ' + displayName(p), onclick: () => { if (confirm(t('confirm.delete', { name: displayName(p) }))) { DB.set('products', products().filter(x => x.id !== p.id)); render(); } } }, t('btn.delete'))].filter(Boolean));
  return row;
}

// Formulario para agregar un producto propio (nombre, precio, foto opcional)
function addForm(cat, placeholder, title) {
  const nameIn = h('input', { placeholder, style: 'flex:1 1 200px' });
  const priceIn = h('input', { type: 'number', step: '0.01', min: '0', placeholder: t('ph.price'), style: 'width:110px' });
  let newPhoto = '';
  const photoIn = h('input', { type: 'file', accept: 'image/*', onchange: e => { const f = e.target.files[0]; if (f) photoTo(f, 200, d => newPhoto = d); else newPhoto = ''; } });
  const add = () => {
    if (!nameIn.value.trim()) { toast(t('err.productName')); return; }
    const price = parseFloat(priceIn.value) || 0;
    const l = products(); l.push({ id: uid(), cat, name: nameIn.value.trim(), custom: true, price, photo: newPhoto, available: price > 0 });
    DB.set('products', l); render();
  };
  return h('form', { onsubmit: e => { e.preventDefault(); add(); } }, title ? h('h4', { style: 'margin:16px 0 4px' }, title) : null,
    h('div', { class: 'row' }, nameIn, priceIn),
    h('div', { class: 'row' }, h('span', { class: 'muted' }, t('photoOpt')), photoIn, h('button', { type: 'submit' }, t('btn.add'))));
}

function bankCard() {
  let q = '', filt = 'todas';
  const list = h('div'), count = h('p', { class: 'muted bankcount' }), chips = h('div', { class: 'chips' });
  const fruits = () => products().filter(p => p.cat === 'fruta');
  const drawCount = () => { const all = fruits(); count.textContent = t('bank.count', { n: all.filter(p => p.available).length, total: all.length }); };
  const drawChips = () => chips.replaceChildren(...[['todas', t('f.all')], ['hay', t('stock.yes')], ['nohay', t('stock.no')]].map(([id, l]) =>
    h('button', { type: 'button', class: 'small ' + (filt === id ? 'on' : 'sec'), onclick: () => { filt = id; drawChips(); drawList(); } }, l)));
  const after = () => { drawCount(); if (filt !== 'todas') drawList(); };
  const drawList = () => {
    drawCount();
    const rows = fruits()
      .filter(p => (filt === 'todas' || (filt === 'hay' ? p.available : !p.available)) && norm(displayName(p)).includes(norm(q)))
      .sort((a, b) => displayName(a).localeCompare(displayName(b), lang));
    list.replaceChildren(...(rows.length ? rows.map(p => productRow(p, after)) : [h('p', { class: 'muted' }, t('bank.noMatch'))]));
  };
  const search = h('input', { type: 'search', placeholder: t('bank.search'), 'aria-label': t('bank.search'), style: 'flex:1 1 180px', oninput: e => { q = e.target.value; drawList(); } });
  const allOut = h('button', { class: 'sec small', onclick: () => {
    if (!confirm(t('bank.confirmAllOut'))) return;
    DB.set('products', products().map(p => p.cat === 'fruta' ? { ...p, available: false } : p)); drawList();
  } }, t('bank.allOut'));
  drawChips(); drawList();
  return h('section', { class: 'card' }, h('h3', {}, t('bank.title')), h('p', { class: 'muted' }, t('bank.hint')),
    h('div', { class: 'row' }, search, allOut), chips, count, list,
    h('hr'), addForm('fruta', t('ph.fruitName'), t('bank.addTitle')));
}
function adminProducts() {
  const curtidos = products().filter(p => p.cat === 'curtido');
  return h('div', {}, bankCard(),
    h('section', { class: 'card' }, h('h3', {}, t('curtido.title')),
      addForm('curtido', t('ph.curtidoName')),
      curtidos.length ? h('hr') : h('p', { class: 'muted' }, t('empty.noneHere')),
      curtidos.map(p => productRow(p))));
}

function adminClients() {
  const cl = clients();
  if (!cl.length) return h('div', { class: 'card empty' }, h('div', { class: 'big' }, '👥'), h('h3', {}, t('empty.noClients')), h('p', { class: 'muted' }, t('empty.noClientsHint')));
  return h('div', {}, cl.map(c => {
    const mine = orders().filter(o => o.clientEmail === c.email);
    return h('section', { class: 'card cli' }, avatar(c, 56),
      h('div', {}, h('h4', {}, c.name), h('div', {}, c.email + (c.phone ? '  ·  ' + c.phone : '')),
        h('div', { class: 'muted' }, t('client.since', { date: new Date(c.created).toLocaleDateString(LOCALES[lang]), n: mine.length, w: plural(mine.length, 'order'), total: money(mine.reduce((s, o) => s + o.total, 0)) }))));
  }));
}

function adminSettings() {
  const cur = h('input', { type: 'password', name: 'current', autocomplete: 'current-password', placeholder: t('ph.curPass') });
  const usr = h('input', { name: 'username', autocomplete: 'username', value: adminUser(), placeholder: t('ph.user') });
  const a = h('input', { type: 'password', name: 'new', autocomplete: 'new-password', placeholder: t('ph.newPass') });
  const save = () => {
    if (cur.value !== adminPass()) return toast(t('err.curPass'));
    if (usr.value.trim().length < 3) return toast(t('err.user3'));
    if (a.value && a.value.length < 6) return toast(t('err.pass6'));
    DB.set('adminUser', usr.value.trim());
    if (a.value) DB.set('adminPass', a.value);
    cur.value = ''; a.value = ''; toast(t('toast.accessUpdated'));
  };
  const biz = DB.get('biz', {});
  const bName = h('input', { value: biz.name || '', placeholder: t('ph.bizName') });
  const bPhone = h('input', { value: biz.phone || '', placeholder: t('ph.bizPhone') });
  const bAddr = h('input', { value: biz.address || '', placeholder: t('ph.bizAddr'), style: 'flex:1 1 100%' });
  const bNote = h('input', { value: biz.note || '', placeholder: t('ph.bizNote'), style: 'flex:1 1 100%' });
  const saveBiz = () => { DB.set('biz', { name: bName.value.trim(), phone: bPhone.value.trim(), address: bAddr.value.trim(), note: bNote.value.trim() }); toast(t('toast.bizSaved')); };
  const sh = getShip();
  const latIn = h('input', { type: 'number', step: 'any', value: sh.lat ?? '', placeholder: t('ship.lat'), 'aria-label': t('ship.lat') });
  const lngIn = h('input', { type: 'number', step: 'any', value: sh.lng ?? '', placeholder: t('ship.lng'), 'aria-label': t('ship.lng') });
  const baseIn = h('input', { type: 'number', min: '0', step: '0.25', value: sh.base, 'aria-label': t('ship.base') });
  const kmIn = h('input', { type: 'number', min: '0', step: '0.05', value: sh.perKm, 'aria-label': t('ship.perKm') });
  const maxIn = h('input', { type: 'number', min: '0', step: '1', value: sh.maxKm, 'aria-label': t('ship.max') });
  const here = () => locate().then(p => { latIn.value = p.lat.toFixed(6); lngIn.value = p.lng.toFixed(6); toast(t('ship.got')); }).catch(() => toast(t('deliv.gpsFail')));
  const saveShip = () => {
    const lat = latIn.value === '' ? null : Number(latIn.value), lng = lngIn.value === '' ? null : Number(lngIn.value);
    if ((lat === null) !== (lng === null) || (lat !== null && (Math.abs(lat) > 90 || Math.abs(lng) > 180))) return toast(t('ship.badLoc'));
    DB.set('ship', { lat, lng, base: Math.max(0, Number(baseIn.value) || 0), perKm: Math.max(0, Number(kmIn.value) || 0), maxKm: Math.max(0, Number(maxIn.value) || 0) });
    toast(t('ship.saved'));
  };
  let shopMark = null;
  const pick = mapBox(220, hasPt(sh.lat, sh.lng) ? [sh.lat, sh.lng] : null, hasPt(sh.lat, sh.lng) ? 15 : 12, (L, map) => {
    const put = (lat, lng) => { latIn.value = (+lat).toFixed(6); lngIn.value = (+lng).toFixed(6); if (shopMark) shopMark.setLatLng([lat, lng]); else shopMark = L.marker([lat, lng], { icon: pinIcon(L, '🏪'), draggable: true }).addTo(map).on('dragend', () => { const p = shopMark.getLatLng(); put(p.lat, p.lng); }); };
    if (hasPt(sh.lat, sh.lng)) put(sh.lat, sh.lng);
    map.on('click', e => put(e.latlng.lat, e.latlng.lng));
  });
  const lab = (txt, el) => h('label', { class: 'fld' }, h('span', { class: 'muted' }, txt), el);
  const syncCard = h('section', { class: 'card' }, h('h3', {}, t('sync.title')), h('p', { class: 'muted' }, syncDot(), ' ', Sync.on ? t('sync.noteOn') : t('sync.noteOff')),
    ...(Sync.on ? [] : [h('p', { class: 'muted' }, t('sync.s1')), h('p', { class: 'muted' }, t('sync.s2')), h('p', { class: 'muted' }, t('sync.s3'))]), h('p', { class: 'err' }, t('sync.warn')));
  return h('div', {}, syncCard,
    h('form', { class: 'card', onsubmit: e => { e.preventDefault(); saveShip(); } }, h('h3', {}, '🛵 ' + t('ship.title')), h('p', { class: 'muted' }, t('ship.help')),
      pick, h('p', { class: 'muted' }, t('map.pickHint')),
      h('div', { class: 'row' }, lab(t('ship.lat'), latIn), lab(t('ship.lng'), lngIn)),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'sec small', onclick: here }, '📍 ' + t('ship.here'))),
      h('div', { class: 'row' }, lab(t('ship.base'), baseIn), lab(t('ship.perKm'), kmIn), lab(t('ship.max'), maxIn)),
      h('div', { class: 'row' }, h('button', { type: 'submit' }, t('btn.saveChanges')))),
    h('form', { class: 'card', onsubmit: e => { e.preventDefault(); save(); } }, h('h3', {}, t('set.access')),
      h('div', { class: 'row' }, usr), h('div', { class: 'row' }, a), h('div', { class: 'row' }, cur, h('button', { type: 'submit' }, t('btn.saveChanges'))),
      h('hr'), h('button', { type: 'button', class: 'sec', onclick: () => { if ('Notification' in window) Notification.requestPermission().then(r => toast(t('toast.notifState', { s: r }))); } }, t('set.notif'))),
    h('form', { class: 'card', onsubmit: e => { e.preventDefault(); saveBiz(); } }, h('h3', {}, t('set.biz')),
      h('div', { class: 'row' }, bName, bPhone), h('div', { class: 'row' }, bAddr), h('div', { class: 'row' }, bNote),
      h('div', { class: 'row' }, h('button', { type: 'submit' }, t('btn.saveChanges')))));
}

// ======================= CLIENTE =======================
let barEl = null;
const MAX_QTY = 999;
// Campo para escribir la cantidad (además de − y +); se aplica al salir del campo o con Enter
function qtyInput(p, after) {
  const apply = e => {
    const v = Math.min(MAX_QTY, Math.max(0, parseInt(e.target.value, 10) || 0));
    state.cart[p.id] = v; saveCart(); after();
  };
  return h('input', { class: 'qtyin', type: 'number', inputmode: 'numeric', min: '0', max: String(MAX_QTY), step: '1', value: state.cart[p.id] || 0, 'aria-label': t('aria.qty'), onchange: apply,
    onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }, onfocus: e => e.target.select() });
}
const cartLines = () => products().filter(p => p.available && state.cart[p.id] > 0);
const cartCount = () => cartLines().reduce((s, p) => s + state.cart[p.id], 0);
const cartTotal = () => cartLines().reduce((s, p) => s + state.cart[p.id] * p.price, 0);
function refreshBar() {
  const n = cartCount();
  const c = document.getElementById('cartCount');
  if (c) { c.textContent = n; c.style.display = n ? 'inline-block' : 'none'; }
  if (barEl) {
    barEl.classList.toggle('show', n > 0);
    barEl.querySelector('.cb-text').textContent = `🛒 ${n} ${plural(n, 'item')} · ${money(cartTotal())}`;
  }
}

function clientView() {
  const tabs = [['pedir', t('tab.menu')], ['pedidos', t('tab.orders')], ['perfil', t('tab.profile')]];
  const content = state.clientTab === 'pedidos' ? clientOrders() : state.clientTab === 'perfil' ? profileView() : clientMenu();
  barEl = null;
  const view = h('div', {}, header(), h('main', { class: 'wrap' },
    tabsNav(tabs, state.clientTab, id => { state.clientTab = id; render(); }), content));
  if (state.clientTab === 'pedir') {
    barEl = h('div', { class: 'cartbar' }, h('span', { class: 'cb-text' }), h('button', { onclick: openSheet }, t('btn.viewCart')));
    view.append(barEl);
  }
  return view;
}

function clientMenu() {
  const hello = h('div', { class: 'hello' }, h('h2', {}, t('hello', { name: state.session.name.split(' ')[0] })), h('p', { class: 'muted' }, t('hello.sub')));
  const cats = [['todo', t('cat.all')], ...CATS.map(c => [c.id, c.emoji + ' ' + t('cat.' + c.id)])];
  const chips = h('div', { class: 'chips' }, cats.map(([id, l]) =>
    h('button', { class: 'small ' + (state.cat === id ? 'on' : 'sec'), onclick: () => { state.cat = id; render(); } }, l)));
  const order = { fruta: 0, curtido: 1 };
  const prods = products().filter(p => p.available && p.price > 0 && (state.cat === 'todo' || p.cat === state.cat))
    .sort((a, b) => (order[a.cat] - order[b.cat]) || displayName(a).localeCompare(displayName(b), lang));
  const body = prods.length ? h('div', { class: 'grid' }, prods.map(productCard))
    : h('div', { class: 'card empty' }, h('div', { class: 'big' }, '🧺'), h('h3', {}, t('menu.empty')), h('p', { class: 'muted' }, t('menu.emptyHint')));
  return h('div', {}, hello, chips, body);
}

function productCard(p) {
  const ctl = h('div', { class: 'ctl' });
  const set = d => { state.cart[p.id] = Math.max(0, (state.cart[p.id] || 0) + d); saveCart(); draw(); refreshBar(); };
  const draw = () => {
    const q = state.cart[p.id] || 0;
    ctl.replaceChildren(...(q
      ? [h('button', { class: 'sec round', 'aria-label': t('aria.less'), onclick: () => set(-1) }, '−'), qtyInput(p, () => { draw(); refreshBar(); }), h('button', { class: 'round', 'aria-label': t('aria.more'), onclick: () => set(1) }, '+')]
      : [h('button', { class: 'add', onclick: () => set(1) }, t('btn.addOne'))]));
  };
  draw();
  return h('article', { class: 'pcard ' + p.cat },
    h('div', { class: 'pimg' }, p.photo ? h('img', { src: p.photo, alt: displayName(p) }) : h('span', { class: 'big' }, emojiFor(p))),
    h('div', { class: 'sticker' }, money(p.price)),
    h('div', { class: 'pbody' }, h('h4', {}, displayName(p)), ctl));
}

// El carrito: resumen del pedido, forma de pago y envío
function openSheet() {
  const overlay = h('div', { class: 'overlay', onclick: e => { if (e.target === overlay) close(); } });
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-label': t('cart.title') });
  overlay.append(panel);
  const esc = e => { if (e.key === 'Escape') close(); };
  const dispose = () => { document.removeEventListener('keydown', esc); overlay.remove(); };
  const close = () => { dispose(); render(); };
  document.addEventListener('keydown', esc);

  const draw = () => {
    const lines = cartLines();
    if (!lines.length) {
      panel.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'big' }, '🛒'), h('h3', {}, t('cart.empty')), h('p', { class: 'muted' }, t('cart.emptyHint')),
        h('button', { onclick: () => { state.clientTab = 'pedir'; close(); } }, t('btn.seeMenu'))));
      return;
    }
    const err = h('p', { class: 'err', role: 'alert' });
    if (state.flash) { err.textContent = state.flash; state.flash = ''; }
    const change = (p, d) => { state.cart[p.id] = Math.max(0, (state.cart[p.id] || 0) + d); saveCart(); draw(); refreshBar(); };
    const sub = lines.reduce((s, p) => s + state.cart[p.id] * p.price, 0);
    const bulkMax = getSched().bulk, big = lines.filter(p => state.cart[p.id] > bulkMax);
    const dv = state.deliv || (state.deliv = newDeliv()), qt = quote(dv), total = sub + (qt.fee || 0);
    const cardMsg = sub <= MIN_CARD ? t('pay.cardMin', { min: money(MIN_CARD) }) : qt.fee === null ? t('pay.cardFee') : '';
    const cardOk = !cardMsg;
    if (state.pay === 'tarjeta' && !cardOk) state.pay = '';

    // ¿Para cuándo? Lo antes posible (solo si estamos abiertos) o programado según el horario del administrador
    const open = openNow(), days = availableDays(), w = state.when;
    if (!w.mode || (w.mode === 'asap' && !open)) w.mode = open ? 'asap' : 'later';
    let slots = [];
    if (w.mode === 'later' && days.length) {
      if (!days.includes(w.day)) { w.day = days[0]; w.time = ''; state.calMonth = ''; }
      slots = slotsFor(w.day);
      if (!slots.includes(w.time)) w.time = slots[0];
    }
    const timeSel = h('select', { class: 'langsel wsel', 'aria-label': t('when.time'), onchange: e => { w.time = e.target.value; } },
      slots.map(k => h('option', { value: k, selected: k === w.time }, timeLabel(k))));
    const whenBox = [
      h('h4', { style: 'margin:10px 0 0' }, t('when.title')),
      h('div', { class: 'pay' },
        h('button', { class: w.mode === 'asap' ? 'on' : 'sec', disabled: !open, onclick: () => { w.mode = 'asap'; draw(); } }, h('span', { class: 'e' }, '⚡'), t('when.asap')),
        h('button', { class: w.mode === 'later' ? 'on' : 'sec', onclick: () => { w.mode = 'later'; draw(); } }, h('span', { class: 'e' }, '📅'), t('when.later'))),
      open ? null : h('p', { class: 'muted' }, t('when.closedNow')),
      big.length && w.mode === 'asap' ? h('div', { class: 'dinfo' }, t('bulk.warn', { n: bulkMax, names: big.map(displayName).join(', ') }), ' ', h('button', { class: 'small go', onclick: () => { w.mode = 'later'; draw(); } }, '📅 ' + t('when.later'))) : null,
      w.mode === 'later' ? (days.length ? h('div', {}, calendar(w, days, draw), h('div', { class: 'row' }, h('b', {}, dayLabel(w.day)), timeSel)) : h('p', { class: 'err' }, t('when.none'))) : null
    ].filter(Boolean);

    const delivBox = () => {
      const upd = patch => { Object.assign(dv, patch); draw(); };
      const addr = h('input', { style: 'flex:1 1 100%', value: dv.address, placeholder: t('deliv.addr'), 'aria-label': t('deliv.addr'), autocomplete: 'street-address', oninput: e => { dv.address = e.target.value; } });
      const ref = h('input', { style: 'flex:1 1 100%', value: dv.ref, placeholder: t('deliv.ref'), 'aria-label': t('deliv.ref'), oninput: e => { dv.ref = e.target.value; } });
      const useGps = () => { upd({ busy: true, msg: t('deliv.locating') }); locate().then(p => upd({ ...p, busy: false, msg: '' })).catch(() => upd({ busy: false, msg: t('deliv.gpsFail') })); };
      const findAddr = () => {
        if (dv.address.trim().length < 4) return upd({ msg: t('err.addr') });
        upd({ busy: true, msg: t('deliv.searching') });
        geocode(dv.address.trim()).then(p => p ? upd({ ...p, acc: null, busy: false, msg: '' }) : upd({ busy: false, msg: t('deliv.notFound') })).catch(() => upd({ busy: false, msg: t('deliv.notFound') }));
      };
      const info = [];
      if (hasPt(dv.lat, dv.lng)) info.push(h('p', { class: 'dinfo' }, '📍 ' + t('deliv.saved') + (dv.acc ? ` (±${Math.round(dv.acc)} m)` : ''), ' · ', h('a', { href: mapLink(dv.lat, dv.lng), target: '_blank', rel: 'noopener' }, t('deliv.seeMap'))));
      if (qt.km !== null) info.push(h('p', { class: 'dinfo' }, '📏 ' + t('deliv.dist', { km: fmtKm(qt.km) }) + ' · ' + t('deliv.fee') + ' ' + money(qt.fee)));
      else if (dv.mode === 'delivery') info.push(h('p', { class: 'muted' }, t('deliv.pending')));
      const sp = getShip(), hasStore = hasPt(sp.lat, sp.lng), hasMe = hasPt(dv.lat, dv.lng);
      const mine = mapBox(230, hasMe ? [dv.lat, dv.lng] : hasStore ? [sp.lat, sp.lng] : null, hasMe ? 15 : 13, (L, map) => {
        if (hasStore) L.marker([sp.lat, sp.lng], { icon: pinIcon(L, '🏪') }).addTo(map).bindTooltip(t('map.shop'));
        const set = (lat, lng) => upd({ lat, lng, acc: null, msg: '' });
        if (hasMe) {
          const me = L.marker([dv.lat, dv.lng], { icon: pinIcon(L, '📍'), draggable: true }).addTo(map);
          me.on('dragend', () => { const p = me.getLatLng(); set(p.lat, p.lng); });
          if (hasStore) map.fitBounds([[sp.lat, sp.lng], [dv.lat, dv.lng]], { padding: [34, 34], maxZoom: 16 });
        }
        map.on('click', e => set(e.latlng.lat, e.latlng.lng));
      });
      return [
        h('h4', { style: 'margin:10px 0 0' }, t('deliv.title')),
        h('div', { class: 'pay' },
          h('button', { class: dv.mode === 'delivery' ? 'on' : 'sec', onclick: () => upd({ mode: 'delivery' }) }, h('span', { class: 'e' }, '🛵'), t('deliv.delivery')),
          h('button', { class: dv.mode === 'pickup' ? 'on' : 'sec', onclick: () => upd({ mode: 'pickup' }) }, h('span', { class: 'e' }, '🏪'), t('deliv.pickup'))),
        ...(dv.mode === 'pickup' ? [h('p', { class: 'muted' }, (DB.get('biz', {}).address ? DB.get('biz', {}).address + ' · ' : '') + t('deliv.pickupHint'))] : [
          h('div', { class: 'row' }, addr), h('div', { class: 'row' }, ref),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'sec small', disabled: dv.busy, onclick: useGps }, '📍 ' + t('deliv.useGps')),
            h('button', { type: 'button', class: 'sec small', disabled: dv.busy, onclick: findAddr }, '🔎 ' + t('deliv.find'))),
          dv.msg ? h('p', { class: 'muted', role: 'status' }, dv.msg) : h('span'), mine, h('p', { class: 'muted' }, t('map.hint')), ...info,
          qt.out ? h('p', { class: 'err' }, t('deliv.out', { km: getShip().maxKm })) : h('span')])
      ];
    };
    const check = () => {
      if (!state.pay) { err.textContent = t('err.pay'); return null; }
      if (w.mode === 'asap' && big.length) { err.textContent = t('err.bulk', { n: bulkMax }); return null; }
      if (dv.mode === 'delivery') {
        if (!dv.address.trim() && !hasPt(dv.lat, dv.lng)) { err.textContent = t('err.addr'); return null; }
        if (qt.out) { err.textContent = t('deliv.out', { km: getShip().maxKm }); return null; }
      }
      if (state.pay === 'tarjeta' && !cardOk) { err.textContent = cardMsg; return null; }
      if (w.mode === 'later') {
        if (!w.day || !w.time || !slotsFor(w.day).includes(w.time)) { state.flash = days.length ? t('err.slotGone') : t('when.none'); draw(); return null; }
        return { type: 'later', at: fromKey(w.day, w.time).toISOString() };
      }
      if (!openNow()) { state.flash = t('when.closedNow'); draw(); return null; }
      return { type: 'asap' };
    };
    const place = (when, extra = {}) => {
      const items = lines.map(p => ({ id: p.id, name: p.name, price: p.price, qty: state.cart[p.id] }));
      const o = { id: uid(), num: 0, clientEmail: state.session.email, clientName: state.session.name, items, total, pay: state.pay, when, status: 'nuevo', date: new Date().toISOString(), subtotal: sub, ...extra };
      o.delivery = dv.mode === 'pickup' ? { mode: 'pickup' } : { mode: 'delivery', address: dv.address.trim(), ref: dv.ref.trim(), lat: dv.lat, lng: dv.lng, km: qt.km };
      o.fee = qt.fee; // null = el administrador lo confirma
      state.deliv = null;
      o.log = [{ s: 'nuevo', d: o.date }];
      const localNum = () => orders().reduce((m, x) => Math.max(m, x.num || 0), 0) + 1;
      const commit = num => {
        o.num = num; DB.set('orders', [...orders(), o]);
        state.cart = {}; saveCart(); state.pay = ''; state.when = { mode: '', day: '', time: '' }; state.clientTab = 'pedidos';
        dispose(); toast(t('toast.sent')); render();
      };
      if (Sync.on) Sync.nextNum().then(commit, () => commit(localNum())); else commit(localNum());
    };
    const send = () => { const when = check(); if (when) place(when); };
    const ppBox = h('div', { class: 'ppbox' }, state.pay === 'tarjeta' ? cardForm(total, check, place) : h('span'));
    panel.replaceChildren(
      h('h3', {}, '🛒 ' + t('cart.title')),
      ...lines.map(p => h('div', { class: 'line' },
        h('div', {}, h('b', {}, displayName(p)), h('div', { class: 'muted' }, t('cart.each', { price: money(p.price) }))),
        h('div', { class: 'ctl' }, h('button', { class: 'sec round', 'aria-label': t('aria.less'), onclick: () => change(p, -1) }, '−'), qtyInput(p, () => { draw(); refreshBar(); }), h('button', { class: 'round', 'aria-label': t('aria.more'), onclick: () => change(p, 1) }, '+')))),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'sec small', onclick: () => { state.cart = {}; saveCart(); refreshBar(); draw(); } }, t('cart.clear'))),
      ...whenBox,
      ...delivBox(),
      h('h4', { style: 'margin:10px 0 0' }, t('cart.payq')),
      h('div', { class: 'pay' }, ['efectivo', 'tarjeta'].map(id =>
        h('button', { class: state.pay === id ? 'on' : 'sec', disabled: id === 'tarjeta' && !cardOk, onclick: () => { state.pay = id; draw(); } }, h('span', { class: 'e' }, payLabel(id).split(' ')[0]), payLabel(id).split(' ').slice(1).join(' ')))),
      cardOk ? h('span') : h('p', { class: 'muted' }, cardMsg),
      dv.mode === 'delivery' ? h('div', { class: 'row sb muted' }, h('span', {}, t('deliv.fee')), h('span', {}, qt.fee === null ? t('deliv.tbd') : money(qt.fee))) : h('span'),
      h('div', { class: 'total' }, h('span', {}, t('total')), h('span', {}, money(total) + (qt.fee === null && dv.mode === 'delivery' ? ' +' : ''))),
      state.pay === 'tarjeta' ? ppBox : h('span'),
      err,
      h('div', { class: 'row sb' }, h('button', { class: 'sec', onclick: close }, t('cart.keep')), state.pay === 'tarjeta' ? h('span') : h('button', { class: 'go', onclick: send }, t('cart.send'))));
  };
  draw();
  document.body.append(overlay);
}

// Mis pedidos: cada pedido muestra su ruta (Recibido → Preparando → En camino → Entregado) con la hora de cada paso
function clientOrders() {
  const mine = orders().filter(o => o.clientEmail === state.session.email).reverse();
  if (!mine.length) return h('div', { class: 'card empty' }, h('div', { class: 'big' }, '🧾'), h('h3', {}, t('empty.noOrders')),
    h('p', { class: 'muted' }, t('empty.noOrdersHint')), h('button', { onclick: () => { state.clientTab = 'pedir'; render(); } }, t('btn.seeMenu')));
  return h('div', {}, mine.map(o => {
    const idx = STEPS.indexOf(o.status);
    const when = s => (o.log || []).find(x => x.s === s)?.d;
    return h('article', { class: 'ticket ' + o.status },
      h('div', { class: 't-head' }, h('b', {}, `#${orderNo(o)}  ${fmtDate(o.date)}`), h('span', { class: 'tag ' + o.status }, t('st.' + o.status))),
      h('div', { class: 't-body' },
        h('div', { class: 'when' + (o.when?.type === 'later' ? ' later' : '') }, '🕒 ' + t('when.for', { when: whenLabel(o) })),
        deliveryInfo(o, false),
        o.items.map(i => h('div', { class: 'leader' }, h('span', {}, `${i.qty} × ${itemName(i)}`), h('i'), h('b', {}, money(i.qty * i.price)))),
        h('div', { class: 't-foot' }, h('span', { class: 'sum' }, t('total') + ' ' + money(o.total)), h('span', { class: 'tag' }, payLabel(o.pay))),
        h('div', { class: 'muted route' }, t('route')),
        h('ol', { class: 'track' }, STEPS.map((s, i) => h('li', { class: i <= idx ? 'done' : '' }, h('span', {}, t('tr.' + s)), i <= idx && when(s) ? h('small', {}, fmtShort(when(s))) : null))),
        h('div', { class: 'row' }, h('button', { class: 'sec small', onclick: () => openInvoice(o) }, '🧾 ' + t('invoice')))));
  }));
}

// ---------- Arranque ----------
(function init() {
  // Banco de fruta: la primera vez se cargan todas las frutas (sin precio y como "No hay"); el administrador las activa.
  if (!DB.get('bankSeeded', false)) {
    const l = products();
    Object.keys(FRUITS).forEach(k => {
      if (!l.some(p => p.key === k)) l.push({ id: 'b_' + k, key: k, cat: 'fruta', name: FRUITS[k][1], price: 0, photo: '', available: false });
    });
    DB.set('products', l); DB.set('bankSeeded', true);
  }
  // Pedidos antiguos: asigna número de factura y ruta si les faltan
  const l = orders(); let max = l.reduce((m, o) => Math.max(m, o.num || 0), 0), ch = false;
  l.forEach(o => {
    if (!o.num) { o.num = ++max; ch = true; }
    if (!o.log) { o.log = [{ s: o.status, d: o.date }]; ch = true; }
  });
  if (ch) DB.set('orders', l);
})();

// ---------- Dibujar ----------
function render() {
  $app.replaceChildren(!state.session ? loginView() : state.session.role === 'admin' ? adminView() : clientView());
  if (PAGE !== 'admin' && state.session) refreshBar();
  updateTitle();
}
render();
Sync.start(dataChanged);