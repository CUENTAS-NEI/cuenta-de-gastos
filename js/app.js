/* Mis Cuentas — interfaz. Los datos viven en tu hoja de Google; aquí solo se muestran y se anotan. */
(function () {
  'use strict';
  const { Core, Charts, Acceso } = window;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const LS = { cx: 'mc.conexion', datos: 'mc.datos', filtros: 'mc.filtros', ultCat: 'mc.ultimaCategoria', saldos: 'mc.saldos', saldosPend: 'mc.saldosPendientes', saldosMig: 'mc.saldosSubidos' };
  const leer = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* almacenamiento lleno o bloqueado */ } };
  const borrarLS = k => { try { localStorage.removeItem(k); } catch (e) { } };
  // sesión que dura hasta cerrar la app (cuando no se marca "no volver a pedirla")
  const SS = {
    leer: k => { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } },
    guardar: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
    borrar: k => { try { sessionStorage.removeItem(k); } catch (e) { } }
  };

  const S = {
    cx: null,               // {url, token}
    recordar: true,         // ¿se queda abierta la sesión en este dispositivo?
    acceso: null,           // contenido de acceso.json (cifrado)
    accesoNuevo: null,      // acceso.json recién creado, pendiente de subir
    data: null,             // {cfg, cats, movs}
    saldos: {},             // { 'YYYY-MM': céntimos al terminar el mes } — los anota el usuario
    saldosHoja: false,      // ¿la hoja de Google guarda los saldos (pestaña Saldos)?
    sync: null,             // fecha de la última sincronización
    F: Object.assign({}, Core.FILTRO_VACIO),
    vista: 'resumen', limite: 150, editando: null,
    inf: null, infSel: null, pAnio: null   // periodo de Informes, informe abierto, año de la hoja de periodo
  };

  /* ---------------- API ---------------- */
  async function api(action, extra) {
    let r, j;
    try {
      r = await fetch(S.cx.url, {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita la comprobación CORS previa
        body: JSON.stringify(Object.assign({ token: S.cx.token, action }, extra || {}))
      });
    } catch (e) { throw new Error('No hay conexión con Google. Revisa internet y vuelve a intentarlo.'); }
    try { j = await r.json(); } catch (e) {
      throw new Error('La API no ha respondido como esperaba. Comprueba la dirección y que esté publicada para "Cualquier usuario".');
    }
    if (!j.ok) { const err = new Error(j.error || 'Error desconocido.'); err.code = j.code; throw err; }
    return j;
  }

  function guardarDatos() {
    if (S.recordar) guardar(LS.datos, { data: S.data, sync: (S.sync || new Date()).toISOString() });
  }

  async function sincronizar(silencioso) {
    estado('Actualizando…');
    try {
      const j = await api('getAll');
      S.data = j.data; S.sync = new Date();
      guardarDatos();
      ajustarFiltros(); render();
      estado('Actualizado a las ' + hora(S.sync));
      sincronizarSaldos();
      return true;
    } catch (e) {
      if (e.code === 'AUTH') { claveCaducada(); return false; }
      estado(S.sync ? 'Sin conexión · datos de las ' + hora(S.sync) : 'Sin conexión');
      if (!silencioso || !S.data) aviso(e.message, true);
      return false;
    }
  }
  /* Saldos en la hoja (pestaña Saldos). Si el Apps Script aún no lo admite, se quedan en el móvil
     y se suben solos en cuanto pueda. Pendientes: { 'YYYY-MM': céntimos | null (borrar) }. */
  let subiendoSaldos = false;
  async function sincronizarSaldos() {
    if (subiendoSaldos || !S.cx) return;
    subiendoSaldos = true;
    try {
      const pend = leer(LS.saldosPend) || {};
      if (!leer(LS.saldosMig)) Object.keys(S.saldos).forEach(k => { if (!(k in pend)) pend[k] = S.saldos[k]; });
      let j = await api('getSaldos');             // falla con «Acción desconocida» si el script es antiguo
      const habia = Object.keys(pend).length;
      for (const k of Object.keys(pend)) {
        await api('setSaldo', { mes: k, saldo: pend[k] === null ? null : pend[k] / 100 });
        delete pend[k]; guardar(LS.saldosPend, pend);
      }
      guardar(LS.saldosMig, true);
      if (habia) j = await api('getSaldos');
      S.saldosHoja = true;
      S.saldos = Object.assign({}, j.saldos || {});
      const nuevos = leer(LS.saldosPend) || {};  // anotados mientras se sincronizaba
      Object.keys(nuevos).forEach(k => { if (nuevos[k] === null) delete S.saldos[k]; else S.saldos[k] = nuevos[k]; });
      guardar(LS.saldos, S.saldos);
      if (S.data) render();
    } catch (e) { S.saldosHoja = false; /* sin conexión o script antiguo: siguen en el móvil */ }
    finally {
      subiendoSaldos = false;
      if (S.saldosHoja && Object.keys(leer(LS.saldosPend) || {}).length) setTimeout(sincronizarSaldos, 500); // anotados mientras tanto
    }
  }

  const hora = d => d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const estado = t => { $('#estado').textContent = t; };

  /* ---------------- acceso ---------------- */
  async function iniciar() {
    if (location.hash.indexOf('#cfg=') === 0) history.replaceState(null, '', location.pathname + location.search); // enlaces antiguos: ya no se usan
    enlazar();
    pintarInstalar(); Acceso.alCambiarInstalar(pintarInstalar);
    const f = leer(LS.filtros); if (f) S.F = Object.assign({}, Core.FILTRO_VACIO, f);
    S.saldos = leer(LS.saldos) || {};

    S.cx = leer(LS.cx); S.recordar = !!S.cx;
    if (!S.cx) S.cx = SS.leer(LS.cx);
    if (S.cx) { entrarApp(); return; }

    mostrarPuerta('entrada'); // mientras se comprueba si existe acceso.json
    $('#enBoton').disabled = true;
    S.acceso = await Acceso.cargar();
    $('#enBoton').disabled = false;
    if (S.acceso) { mostrarPuerta('entrada'); setTimeout(() => $('#enClave').focus(), 50); }
    else mostrarPuerta('preparar');
  }

  function entrarApp() {
    const cache = S.recordar ? leer(LS.datos) : null;
    if (cache && cache.data) { S.data = cache.data; S.sync = new Date(cache.sync); }
    $('#entrada').hidden = true; $('#preparar').hidden = true; $('#app').hidden = false;
    if (S.data) { ajustarFiltros(); render(); estado('Datos de las ' + hora(S.sync)); }
    sincronizar(true);
  }

  function mostrarPuerta(cual, error) {
    $('#app').hidden = true;
    $('#entrada').hidden = cual !== 'entrada';
    $('#preparar').hidden = cual !== 'preparar';
    $('#irEntrada').hidden = !S.acceso;
    if (cual === 'entrada') $('#enError').textContent = error || '';
    if (cual === 'preparar') $('#prError').textContent = error || '';
  }

  function guardarSesion(cx, recordar) {
    S.cx = cx; S.recordar = recordar;
    if (recordar) { guardar(LS.cx, cx); SS.borrar(LS.cx); }
    else { SS.guardar(LS.cx, cx); borrarLS(LS.cx); borrarLS(LS.datos); }
  }

  function cerrarSesion() {
    // los saldos se conservan en el móvil (y en la hoja, si el script ya los guarda)
    [LS.cx, LS.datos, LS.ultCat].forEach(borrarLS); SS.borrar(LS.cx);
    S.cx = null; S.data = null; S.sync = null;
    cerrarHojas();
    $('#enClave').value = '';
  }

  async function claveCaducada() {
    cerrarSesion();
    S.acceso = S.acceso || await Acceso.cargar();
    mostrarPuerta('preparar', 'La clave de Apps Script ya no es válida (¿la has cambiado?). Vuelve a preparar el acceso con la clave nueva.');
  }

  async function entrar(e) {
    e.preventDefault();
    const clave = $('#enClave').value;
    if (!clave) { $('#enError').textContent = 'Escribe tu contraseña.'; return; }
    const b = $('#enBoton'); b.disabled = true; b.textContent = 'Comprobando…'; $('#enError').textContent = '';
    try {
      if (!S.acceso) S.acceso = await Acceso.cargar();
      if (!S.acceso) { mostrarPuerta('preparar', 'Todavía no hay ningún acceso preparado. Hazlo aquí una vez.'); return; }
      const cx = await Acceso.descifrar(S.acceso, clave);
      guardarSesion(cx, $('#enRecordar').checked);
      $('#enClave').value = '';
      entrarApp();
    } catch (err) {
      $('#enError').textContent = err.message === 'CLAVE' ? 'Esa no es la contraseña. Prueba otra vez.' : 'No se ha podido comprobar: ' + err.message;
      $('#enClave').select();
    } finally { b.disabled = false; b.textContent = 'Entrar'; }
  }

  function revisarClaves(c1, c2) {
    if (c1.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
    if (c1 !== c2) return 'Las dos contraseñas no coinciden.';
    return '';
  }

  function descargarAcceso(acc) {
    descargar(new TextEncoder().encode(JSON.stringify(acc, null, 1)), 'acceso.json', 'application/json');
  }

  async function preparar(e) {
    e.preventDefault();
    const url = $('#prUrl').value.trim(), token = $('#prToken').value.trim();
    const c1 = $('#prClave1').value, c2 = $('#prClave2').value;
    let err = '';
    if (!/^https:\/\/script\.google(usercontent)?\.com\/.+\/exec/.test(url)) err = 'La dirección debe ser la de la aplicación web de Apps Script y terminar en /exec.';
    else if (token.length < 20) err = 'La clave de Apps Script es la cadena larga que tienes en el editor (mínimo 20 caracteres).';
    else err = revisarClaves(c1, c2);
    if (err) { $('#prError').textContent = err; return; }
    const b = $('#prBoton'); b.disabled = true; $('#prError').textContent = '';
    try {
      b.textContent = 'Comprobando la conexión…';
      S.cx = { url, token };
      try { await api('ping'); } catch (e2) { S.cx = null; throw new Error(e2.code === 'AUTH' ? 'La clave de Apps Script no es correcta.' : e2.message); }
      b.textContent = 'Cifrando…';
      S.accesoNuevo = await Acceso.cifrar(S.cx, c1);
      S.acceso = S.accesoNuevo;
      guardarSesion(S.cx, true);
      ['#prToken', '#prClave1', '#prClave2'].forEach(s => { $(s).value = ''; });
      descargarAcceso(S.accesoNuevo);
      entrarApp();
      abrirHoja('#hojaSubir');
    } catch (e2) { $('#prError').textContent = e2.message; }
    finally { b.disabled = false; b.textContent = 'Crear acceso y entrar'; }
  }

  async function cambiarClave(e) {
    e.preventDefault();
    const err = revisarClaves($('#ccClave1').value, $('#ccClave2').value);
    if (err) { $('#ccError').textContent = err; return; }
    const b = $('#ccBoton'); b.disabled = true; b.textContent = 'Cifrando…';
    try {
      S.accesoNuevo = await Acceso.cifrar(S.cx, $('#ccClave1').value);
      $('#ccClave1').value = ''; $('#ccClave2').value = '';
      cerrarHojas();
      descargarAcceso(S.accesoNuevo);
      abrirHoja('#hojaSubir');
    } catch (e2) { $('#ccError').textContent = e2.message; }
    finally { b.disabled = false; b.textContent = 'Crear archivo nuevo'; }
  }

  /* ---------------- instalar ---------------- */
  function pintarInstalar() {
    const st = Acceso.estadoInstalar();
    const html = {
      boton: '<p><b>Tenla en tu pantalla de inicio</b> y ábrela como una app más.</p><button type="button" class="btn primario" data-accion="instalar">Instalar app</button>',
      ios: '<p><b>Tenla en tu pantalla de inicio:</b> en Safari pulsa el botón <b>Compartir</b> <span class="ico-compartir" aria-hidden="true"></span> y luego <b>«Añadir a pantalla de inicio»</b>.</p>',
      manual: '<p><b>Tenla en tu pantalla de inicio:</b> abre el menú del navegador <b>⋮</b> y elige <b>«Instalar aplicación»</b> o <b>«Añadir a pantalla de inicio»</b>.</p>',
      hecho: ''
    }[st.modo];
    $$('[data-instalar]').forEach(el => { el.innerHTML = html; el.hidden = !html; });
  }

  /* ---------------- periodo y filtros ----------------
     S.F.anio / S.F.mes: periodo (Resumen y Movimientos). S.F.tipo / S.F.cats: solo filtran Movimientos. */
  const hoyYm = () => { const d = new Date(); return Core.ymDe(d.getFullYear(), d.getMonth() + 1); };
  const mesesConDatos = () => [...new Set(S.data.movs.map(m => m.fecha.slice(0, 7)))].sort();
  const modo = F => F.anio === 'all' ? 'todo' : F.mes === 'all' ? 'anio' : 'mes';
  const Fper = () => ({ anio: S.F.anio, mes: S.F.mes, tipo: 'all', cats: [] });
  const nombreMesLargo = ym => Core.cap(Core.MESES[+ym.slice(5) - 1]) + ' ' + ym.slice(0, 4);
  const nombreMes = ym => Core.MESES[+ym.slice(5) - 1];
  function primerAnio() { const a = Core.aniosConDatos(S.data.movs); return a.length ? a[0] : new Date().getFullYear(); }

  function ajustarFiltros() {
    if (!leer(LS.filtros) || S.F.version !== 2) { // primera vez (o filtros de la versión anterior): el último mes con datos
      const ms = mesesConDatos(), ym = ms.length ? ms[ms.length - 1] : hoyYm();
      Object.assign(S.F, { anio: +ym.slice(0, 4), mes: +ym.slice(5), version: 2 });
      guardar(LS.filtros, S.F);
    }
    if (S.F.anio === 'all') S.F.mes = 'all';
    const validas = new Set(S.data.cats.map(c => Core.claveCat(c.tipo, c.nombre)));
    S.F.cats = S.F.cats.filter(k => validas.has(k));
  }
  function setFiltro(cambio) {
    Object.assign(S.F, cambio);
    if (cambio.tipo && cambio.tipo !== 'all') S.F.cats = S.F.cats.filter(k => k.startsWith(cambio.tipo + '|'));
    S.limite = 150;
    guardar(LS.filtros, S.F);
    render();
  }
  function moverPeriodo(d) {
    const m = modo(S.F);
    if (m === 'mes') { let y = S.F.anio, mo = S.F.mes + d; if (mo < 1) { mo = 12; y--; } if (mo > 12) { mo = 1; y++; } setFiltro({ anio: y, mes: mo }); }
    else if (m === 'anio') setFiltro({ anio: S.F.anio + d });
  }
  function pintarPeriodo() {
    const m = modo(S.F);
    $('#periodo').hidden = !(S.vista === 'resumen' || S.vista === 'movs');
    $('#pEt').textContent = m === 'todo' ? 'Desde el principio' : m === 'anio' ? 'Año ' + S.F.anio : nombreMesLargo(Core.ymDe(S.F.anio, S.F.mes));
    $('#pAnt').style.visibility = $('#pSig').style.visibility = m === 'todo' ? 'hidden' : '';
    const hoy = hoyYm();
    $('#pSig').disabled = m === 'mes' ? Core.ymDe(S.F.anio, S.F.mes) >= hoy : m === 'anio' && S.F.anio >= +hoy.slice(0, 4);
    $('#pAnt').disabled = m === 'mes' ? S.F.anio < primerAnio() || (S.F.anio === primerAnio() && S.F.mes === 1) : m === 'anio' && S.F.anio <= primerAnio();
  }

  // hoja de periodo: año arriba y los 12 meses
  function abrirPeriodo() { S.pAnio = S.F.anio === 'all' ? new Date().getFullYear() : S.F.anio; pintarHojaPeriodo(); abrirHoja('#hojaPeriodo'); }
  function pintarHojaPeriodo() {
    const con = new Set(mesesConDatos()), hoy = hoyYm(), m = modo(S.F);
    $('#hpAnio').textContent = S.pAnio;
    $('#hpAnt').disabled = S.pAnio <= primerAnio();
    $('#hpSig').disabled = S.pAnio >= +hoy.slice(0, 4);
    $('#hpMeses').innerHTML = Core.MES_C.map((c, i) => {
      const ym = Core.ymDe(S.pAnio, i + 1);
      const on = m === 'mes' && S.F.anio === S.pAnio && S.F.mes === i + 1;
      return `<button type="button" data-mes="${i + 1}" class="${on ? 'on' : ''} ${con.has(ym) ? '' : 'sin'}"${ym > hoy ? ' disabled' : ''}${on ? ' aria-pressed="true"' : ''}>${Core.cap(c)}</button>`;
    }).join('');
    $('#hpTodoAnio').textContent = 'Todo ' + S.pAnio;
    $('#hpTodoAnio').classList.toggle('on', m === 'anio' && S.F.anio === S.pAnio);
    $('#hpTodo').classList.toggle('on', m === 'todo');
  }

  // hoja de filtros de Movimientos
  function abrirFiltro() { pintarHojaFiltro(); abrirHoja('#hojaFiltro'); }
  function pintarHojaFiltro() {
    $(`#hojaFiltro input[name="ftipo"][value="${S.F.tipo}"]`).checked = true;
    const grupos = [['gasto', 'Gastos'], ['ingreso', 'Ingresos']].filter(([t]) => S.F.tipo === 'all' || S.F.tipo === t);
    $('#listaCats').innerHTML = grupos.map(([t, et]) => `<fieldset><legend>${grupos.length > 1 ? et : 'Categorías'}</legend>` +
      Core.catsDe(S.data.cats, t).map(n => { const k = Core.claveCat(t, n); return `<label class="chk"><input type="checkbox" value="${esc(k)}"${S.F.cats.indexOf(k) >= 0 ? ' checked' : ''}><span>${esc(n)}</span></label>`; }).join('') +
      '</fieldset>').join('');
    const n = Core.filtrar(S.data.movs, S.F).length;
    $('#fVer').textContent = n === 1 ? 'Ver 1 movimiento' : `Ver ${n} movimientos`;
  }
  function pintarChips() {
    const chips = [];
    if (S.F.tipo !== 'all') chips.push(`<button type="button" class="chip" data-quitar="tipo">${S.F.tipo === 'gasto' ? 'Solo gastos' : 'Solo ingresos'}<span aria-hidden="true">×</span></button>`);
    S.F.cats.forEach(k => chips.push(`<button type="button" class="chip" data-quitar="${esc(k)}">${esc(k.split('|')[1])}<span aria-hidden="true">×</span></button>`));
    $('#chips').innerHTML = chips.join('') + (chips.length > 1 ? '<button type="button" class="enlace" data-quitar="todo">Quitar todos</button>' : '');
    $('#chips').hidden = !chips.length;
    const n = (S.F.tipo !== 'all' ? 1 : 0) + S.F.cats.length;
    $('#fBadge').textContent = n; $('#fBadge').hidden = !n;
    $('#btnFiltrar').classList.toggle('activo', n > 0);
  }

  /* ---------------- render ---------------- */
  function render() {
    if (!S.data) return;
    pintarPeriodo();
    $('#fab').hidden = !(S.vista === 'resumen' || S.vista === 'movs');
    if (S.vista === 'resumen') pintarResumen();
    if (S.vista === 'movs') pintarLista();
    if (S.vista === 'informes') pintarInformes();
    if (S.vista === 'ajustes') pintarAjustes();
  }

  function pintarResumen() {
    const { cats, movs } = S.data;
    const F = Fper(), m = modo(F);
    const t = Core.totales(Core.filtrar(movs, F));

    // cifra protagonista: lo gastado en el periodo, con contexto
    const ym = m === 'mes' ? Core.ymDe(F.anio, F.mes) : null;
    $('#hEt').textContent = m === 'mes' ? `Gastado en ${nombreMes(ym)}` : m === 'anio' ? `Gastado en ${F.anio}` : 'Gastado en total';
    $('#hNum').textContent = Core.eurC(t.gas);
    let comp = '';
    if (m === 'mes') {
      const ant = Core.ymAnterior(ym), [ya, ma] = ant.split('-').map(Number);
      const gAnt = Core.totales(Core.filtrar(movs, { anio: ya, mes: ma, tipo: 'all', cats: [] })).gas;
      if (ym === hoyYm()) comp = gAnt ? `Mes en curso · en ${nombreMes(ant)}, ${Core.eurC(gAnt)}` : 'Mes en curso';
      else if (gAnt && t.gas) {
        const p = Math.round((t.gas - gAnt) / gAnt * 100);
        comp = p === 0 ? `Lo mismo que en ${nombreMes(ant)}` : `<b class="${p > 0 ? 'sube' : 'baja'}">${p > 0 ? '▲' : '▼'} ${Math.abs(p)} %</b> ${p > 0 ? 'más' : 'menos'} que en ${nombreMes(ant)} (${Core.eurC(gAnt)})`;
      }
    } else {
      const n = Core.mesesRango(movs, F.anio).length;
      if (n > 1) comp = `Media de ${Core.eurC(Math.round(t.gas / n))} al mes`;
    }
    $('#hComp').innerHTML = comp; $('#hComp').hidden = !comp;

    const item = (et, c, cls) => `<div class="${cls || ''}"><dt>${et}</dt><dd class="num">${Core.eurC(c)}</dd></div>`;
    $('#kpis').innerHTML = item('Ingresos', t.ing, 'ing') + item('Ingresos − gastos', t.res, t.res < 0 ? 'neg' : 'pos');

    // por categoría: se puede tocar para ver los movimientos
    const lista = Core.filtrar(movs, F);
    for (const [tipo, id, color] of [['gasto', '#gCatGas', '--c-gasto'], ['ingreso', '#gCatIng', '--c-ingreso']]) {
      const filas = Core.porCategoria(lista, cats, tipo, false).sort((a, b) => b.c - a.c).map(r => ({ nombre: r.nombre, v: r.c / 100 }));
      const total = filas.reduce((s, r) => s + r.v, 0);
      Charts.barras($(id), filas, { color, total, fmt: v => Core.eur(v), vacio: tipo === 'gasto' ? 'Sin gastos en este periodo.' : 'Sin ingresos en este periodo.' });
      $$(id + ' li').forEach((li, i) => {
        li.dataset.cat = Core.claveCat(tipo, filas[i].nombre); li.tabIndex = 0; li.setAttribute('role', 'button');
        li.setAttribute('aria-label', `${filas[i].nombre}, ${Core.eur(filas[i].v)}. Ver movimientos`);
      });
    }

    // mes a mes del año (o de todo, si el periodo es «desde el principio»)
    const serie = Core.serieMensual(movs, { anio: F.anio, mes: 'all', tipo: 'all', cats: [] }, S.saldos);
    const variosAnios = new Set(serie.map(x => x.y)).size > 1;
    $('#tGMeses').textContent = F.anio === 'all' ? 'Mes a mes' : `Mes a mes en ${F.anio}`;
    const dat = serie.map(x => ({ ym: x.ym, et: Core.etiquetaMes(x.ym, variosAnios).slice(0, variosAnios ? 6 : 3), ing: x.ing / 100, gas: x.gas / 100, res: x.res / 100 }));
    $('#gMeses').innerHTML = dat.length ? '' : '<p class="vacio">No hay movimientos en este periodo.</p>';
    Charts.columnas($('#gMeses'), dat, {
      aria: 'Ingresos y gastos por mes',
      html: d => `<b>${nombreMesLargo(d.ym)}</b><span><i style="background:var(--c-ingreso)"></i>Ingresos ${Core.eur(d.ing)}</span><span><i style="background:var(--c-gasto)"></i>Gastos ${Core.eur(d.gas)}</span><span>Resultado ${Core.eur(d.res)}</span>`
    });
    const tabla = (cab, filas) => `<table class="tabla"><thead><tr>${cab.map((h, i) => `<th${i ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${filas.map(f => `<tr>${f.map((c, i) => `<td${i ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    $('#tMeses').innerHTML = tabla(['Mes', 'Ingresos', 'Gastos', 'Resultado'], dat.map(d => [nombreMesLargo(d.ym), Core.eur(d.ing), Core.eur(d.gas), Core.eur(d.res)]));
  }
  function verCategoria(k) {
    S.F.tipo = 'all'; S.F.cats = [k]; S.limite = 150; guardar(LS.filtros, S.F);
    $('#buscar').value = '';
    irA('movs');
  }

  function pintarLista() {
    pintarChips();
    const q = $('#buscar').value.trim().toLowerCase();
    let lista = Core.ordenar(Core.filtrar(S.data.movs, S.F)).reverse();
    if (q) lista = lista.filter(m => (m.concepto + ' ' + m.categoria).toLowerCase().includes(q));
    const ol = $('#lista');
    if (!lista.length) {
      const filtrado = Core.hayFiltroDeContenido(S.F);
      ol.innerHTML = `<li class="vacio">${q ? 'Ningún movimiento coincide con la búsqueda.' : filtrado ? 'No hay movimientos con estos filtros en este periodo.' : 'No hay movimientos en este periodo. Pulsa «Anotar» para añadir uno.'}</li>`;
      $('#masMovs').hidden = true; return;
    }
    // totales por mes para los separadores
    const porMes = {};
    lista.forEach(m => { const k = m.fecha.slice(0, 7); porMes[k] = (porMes[k] || 0) + (m.tipo === 'ingreso' ? 1 : -1) * Core.cents(m.importe); });
    let html = '', mesAct = '';
    lista.slice(0, S.limite).forEach(m => {
      const ym = m.fecha.slice(0, 7);
      if (ym !== mesAct) {
        mesAct = ym;
        html += `<li class="sep"><span>${nombreMesLargo(ym)}</span><span class="num">${Core.eurC(porMes[ym])}</span></li>`;
      }
      const ing = m.tipo === 'ingreso';
      html += `<li><button type="button" class="mov" data-id="${esc(m.id)}">
        <span class="mov-txt"><span class="mov-con">${esc(m.concepto || m.categoria)}</span><span class="mov-sub">${esc(m.categoria)} · ${esc(Core.fmtFecha(m))}</span></span>
        <span class="mov-imp num ${ing ? 'ing' : 'gas'}">${ing ? '+' : '−'}${esc(Core.eur(m.importe))}</span></button></li>`;
    });
    ol.innerHTML = html;
    $('#masMovs').hidden = lista.length <= S.limite;
  }

  /* ---------------- informes ----------------
     Dos bloques, cada uno con su periodo: el cierre de un mes y los informes de un año. */
  const INF_MES = [
    ['mensual', 'Informe mensual completo', 'Saldos, resumen por categoría y todos los movimientos.'],
    ['detalle', 'Movimientos del mes', 'La lista completa, con fecha y concepto.']
  ];
  const INF_ANIO = [
    ['secretario', 'Para el Secretario', 'Totales del año por categoría.'],
    ['anual', 'Anual', 'Total del año por categoría, con porcentajes.'],
    ['meses', 'Por meses', 'Ingresos, gastos y resultado de cada mes, con tus saldos.'],
    ['catmeses', 'Categorías por meses', 'Cada categoría mes a mes.'],
    ['detalle', 'Movimientos del año', 'Todos los movimientos del año.']
  ];
  function iniciarInf() {
    if (S.inf) return;
    let ym;
    if (modo(S.F) === 'mes') ym = Core.ymDe(S.F.anio, S.F.mes);
    else { const ms = mesesConDatos(); ym = ms.length ? ms[ms.length - 1] : hoyYm(); }
    S.inf = { ym, anio: +ym.slice(0, 4) };
  }
  function Finf(ambito) {
    if (ambito === 'mes') { const [y, m] = S.inf.ym.split('-').map(Number); return { anio: y, mes: m, tipo: 'all', cats: [] }; }
    return { anio: S.inf.anio, mes: 'all', tipo: 'all', cats: [] };
  }
  const docDe = (id, ambito) => Core.construirInforme(id, { cfg: S.data.cfg, cats: S.data.cats, movs: S.data.movs, F: Finf(ambito), saldos: S.saldos });
  const filaInf = ([id, nombre, desc], ambito) => {
    const vacio = docDe(id, ambito).vacio;
    return `<button type="button" class="inf-fila" data-inf="${id}" data-ambito="${ambito}"${vacio ? ' disabled' : ''}><span><b>${nombre}</b><small>${vacio ? 'Sin movimientos en este periodo.' : desc}</small></span><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  };

  function pintarInformes() {
    iniciarInf();
    const hoy = hoyYm();
    $('#cMes').textContent = nombreMesLargo(S.inf.ym);
    $('#cSig').disabled = S.inf.ym >= hoy;
    $('#cAnt').disabled = +S.inf.ym.slice(0, 4) < primerAnio();
    pintarSaldos();
    const vacioMes = docDe('secretario', 'mes').vacio;
    $('#btnSecretario').disabled = vacioMes;
    $('#cVacio').hidden = !vacioMes;
    $('#infMes').innerHTML = [['secretario', 'Para el Secretario', 'Ver antes de descargar, o en Excel.']].concat(INF_MES).map(x => filaInf(x, 'mes')).join('');
    $('#aAnio').textContent = S.inf.anio;
    $('#aSig').disabled = S.inf.anio >= +hoy.slice(0, 4);
    $('#aAnt').disabled = S.inf.anio <= primerAnio();
    $('#infAnio').innerHTML = INF_ANIO.map(x => filaInf(x, 'anio')).join('');
    $('#btnTodoXlsx').disabled = docDe('anual', 'anio').vacio;
  }
  function moverMesInf(d) {
    let [y, m] = S.inf.ym.split('-').map(Number); m += d;
    if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
    S.inf.ym = Core.ymDe(y, m); S.inf.anio = y;
    $('#sError').textContent = '';
    pintarInformes();
  }

  function abrirInforme(id, ambito) {
    S.infSel = { id, ambito };
    const doc = docDe(id, ambito);
    $('#tInf').textContent = ({ secretario: 'Para el Secretario', mensual: 'Informe mensual', anual: 'Informe anual', meses: 'Por meses', catmeses: 'Categorías por meses', detalle: 'Movimientos' })[id];
    $('#previa').innerHTML = docHtml(doc);
    $('#btnCompartir').hidden = !puedeCompartir();
    abrirHoja('#hojaInf');
  }

  /* ---------------- saldos anotados a mano ---------------- */
  const fmtSaldo = c => c === null ? '' : (c / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
  /** texto -> céntimos; '' si está vacío; NaN si no se entiende. Admite negativos. */
  function leerSaldo(s) {
    s = String(s).replace(/[\s€]/g, '');
    if (!s) return '';
    const neg = /^[-−]/.test(s); if (neg) s = s.slice(1);
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    return (neg ? -1 : 1) * Math.round(Number(s) * 100);
  }
  function ponerSaldo(ym, c) {
    if (c === '' || c === null) delete S.saldos[ym]; else S.saldos[ym] = c;
    guardar(LS.saldos, S.saldos);
    const pend = leer(LS.saldosPend) || {};
    pend[ym] = (c === '' || c === null) ? null : c;
    guardar(LS.saldosPend, pend);
    sincronizarSaldos();
  }
  function pintarSaldos() {
    const ym = S.inf.ym, ant = Core.ymAnterior(ym);
    const [y, m] = ym.split('-').map(Number), sig = Core.ymDe(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
    const ini = Core.saldoIni(S.saldos, ym), fin = Core.saldoFin(S.saldos, ym);
    if (document.activeElement !== $('#sIni')) $('#sIni').value = fmtSaldo(ini);
    if (document.activeElement !== $('#sFin')) $('#sFin').value = fmtSaldo(fin);
    $('#sIniAyuda').textContent = `El de cierre de ${nombreMes(ant)}.`;
    $('#sFinAyuda').textContent = `Será el de inicio de ${nombreMes(sig)}.`;
    const sug = Core.saldoSugerido(S.data.movs, S.saldos, ym);
    const p = $('#sSugerido');
    if (sug === null) { p.hidden = false; p.innerHTML = '<span>Anota el saldo al empezar y te sugiero el del final.</span>'; }
    else if (sug === fin) { p.hidden = true; }
    else {
      p.hidden = false;
      p.innerHTML = `Sugerido: <b class="num">${esc(Core.eurC(sug))}</b> <span>(inicio + ingresos − gastos anotados)</span> <button type="button" class="btn peq" id="sUsar">Usar</button>`;
      p.dataset.valor = sug;
    }
  }
  function cambiarSaldo(input, ym) {
    const c = leerSaldo(input.value);
    if (Number.isNaN(c)) { $('#sError').textContent = 'Escribe un importe como 1234,56 (o déjalo vacío).'; return; }
    $('#sError').textContent = '';
    ponerSaldo(ym, c);
    pintarInformes();
  }

  function docHtml(doc) {
    const meta = doc.meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(Core.textoCelda(v))}</dd></div>`).join('');
    const secs = doc.secciones.map(sec => {
      const cab = sec.sinCabecera ? '' : `<thead><tr>${sec.cols.map(c => `<th class="${c.num ? 'num' : ''}">${esc(c.h)}</th>`).join('')}</tr></thead>`;
      const filas = sec.filas.map(f => `<tr class="${f.k || ''}">${f.c.map((c, j) => `<td class="${(sec.cols[j] || {}).num || (c && typeof c === 'object') ? 'num' : ''}">${esc(Core.textoCelda(c, sec))}</td>`).join('')}</tr>`).join('');
      return `<div class="p-sec ${sec.sinCabecera && sec.cols.length <= 3 ? 'estrecha' : ''}">${sec.titulo ? `<h4 class="tono-${sec.tono}">${esc(sec.titulo)}</h4>` : ''}<div class="desliza"><table class="tabla">${cab}<tbody>${filas}</tbody></table></div></div>`;
    }).join('');
    const notas = (doc.notas || []).map(n => `<p class="nota">${esc(n)}</p>`).join('');
    return `<h3>${esc(doc.titulo)}</h3><dl class="p-meta">${meta}</dl>${secs}${notas}`;
  }

  let pdfLibP = null;
  function cargarPdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    return pdfLibP || (pdfLibP = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/pdf-lib.min.js';
      s.onload = () => res(window.PDFLib);
      s.onerror = () => { pdfLibP = null; rej(new Error('No se pudo cargar el generador de PDF. Revisa la conexión.')); };
      document.head.appendChild(s);
    }));
  }
  async function pdfDe(doc) { return PDFW.crearPdf(doc, Core.textoCelda, await cargarPdfLib()); }

  function descargar(bytes, nombre, tipo) {
    const url = URL.createObjectURL(new Blob([bytes], { type: tipo }));
    const a = document.createElement('a');
    a.href = url; a.download = nombre; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
  }
  const MIME_PDF = 'application/pdf', MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  function puedeCompartir() {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: MIME_PDF })] })); } catch (e) { return false; }
  }

  async function conBoton(btn, fn) {
    const txt = btn.textContent; btn.disabled = true; btn.textContent = 'Preparando…';
    try { await fn(); } catch (e) { if (e && e.name !== 'AbortError') aviso(e.message || String(e), true); }
    finally { btn.disabled = false; btn.textContent = txt; }
  }

  /* ---------------- ajustes ---------------- */
  function pintarAjustes() {
    const { cfg, cats, movs } = S.data;
    const fila = (k, v) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`;
    const nSaldos = Object.keys(S.saldos).length;
    $('#ajustesDatos').innerHTML = fila('Nombre', cfg.nombre || '—') +
      fila('Categorías', `${cats.filter(c => c.tipo === 'gasto').length} de gasto · ${cats.filter(c => c.tipo === 'ingreso').length} de ingreso`) +
      fila('Movimientos', movs.length) +
      fila('Saldos anotados', nSaldos ? `${nSaldos} ${nSaldos === 1 ? 'mes' : 'meses'} ${S.saldosHoja ? '(guardados en tu hoja, pestaña Saldos)' : '(guardados en este dispositivo)'}` : 'Ninguno') +
      fila('Última actualización', S.sync ? S.sync.toLocaleString('es-ES') : '—');
    $('#ajSesion').textContent = S.recordar
      ? 'Este dispositivo recuerda tu sesión: entras directamente al abrir la app.'
      : 'Este dispositivo te pide la contraseña cada vez que abres la app.';
  }

  /* ---------------- hoja de movimiento ---------------- */
  function abrirMov(mov) {
    S.editando = mov || null;
    const f = $('#formMov');
    $('#tMov').textContent = mov ? 'Editar movimiento' : 'Anotar';
    const tipo = mov ? mov.tipo : (f.tipo.value || 'gasto');
    f.querySelector(`input[name="tipo"][value="${tipo}"]`).checked = true;
    rellenarCategorias(tipo, mov ? mov.categoria : null);
    $('#mImporte').value = mov ? String(mov.importe).replace('.', ',') : '';
    $('#mConcepto').value = mov ? mov.concepto : '';
    $('#mFecha').value = mov ? mov.fecha : hoyIso();
    $('#mBorrar').hidden = !mov; $('#mBorrar').dataset.confirmar = '';
    $('#mBorrar').textContent = 'Eliminar';
    $('#mOtro').hidden = !!mov;
    $('#mError').textContent = '';
    if (mov && mov.origen === 'migración') $('#mError').textContent = 'Este movimiento viene de las pestañas antiguas y no tenía día: revisa la fecha si la cambias.';
    abrirHoja('#hojaMov');
    setTimeout(() => $('#mImporte').focus(), 60);
  }
  function hoyIso() { const d = new Date(); return `${d.getFullYear()}-${Core.pad2(d.getMonth() + 1)}-${Core.pad2(d.getDate())}`; }

  function rellenarCategorias(tipo, elegida) {
    const ult = (leer(LS.ultCat) || {})[tipo];
    const nombres = Core.catsDe(S.data.cats, tipo);
    const sel = $('#mCategoria');
    const actual = elegida || (nombres.indexOf(ult) >= 0 ? ult : '');
    sel.innerHTML = '<option value="" disabled>Elige una categoría</option>' + nombres.map(n => `<option>${esc(n)}</option>`).join('');
    sel.value = actual;
    rellenarConceptos();
  }
  function rellenarConceptos() {
    const cat = $('#mCategoria').value;
    const vistos = new Set();
    Core.ordenar(S.data.movs).reverse().forEach(m => { if ((!cat || m.categoria === cat) && m.concepto && vistos.size < 40) vistos.add(m.concepto); });
    $('#conceptos').innerHTML = [...vistos].map(c => `<option value="${esc(c)}">`).join('');
  }

  function leerImporte(s) {
    s = String(s).replace(/[\s€]/g, '');
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : NaN;
  }

  async function guardarMov(e) {
    e.preventDefault();
    const f = $('#formMov');
    const otro = e.submitter && e.submitter.dataset.otro === '1';
    const mov = {
      tipo: f.tipo.value, categoria: $('#mCategoria').value, concepto: $('#mConcepto').value.trim(),
      importe: leerImporte($('#mImporte').value), fecha: $('#mFecha').value
    };
    const err = !(mov.importe > 0) ? 'Escribe un importe mayor que 0 (por ejemplo 12,50).' :
      !mov.categoria ? 'Elige una categoría.' : !/^\d{4}-\d{2}-\d{2}$/.test(mov.fecha) ? 'Elige una fecha.' : '';
    if (err) { $('#mError').textContent = err; return; }
    const botones = $$('#formMov .hoja-pie .btn'); botones.forEach(b => { b.disabled = true; });
    $('#mError').textContent = '';
    try {
      if (S.editando) {
        const j = await api('update', { id: S.editando.id, mov });
        const i = S.data.movs.findIndex(m => m.id === S.editando.id);
        if (i >= 0) S.data.movs[i] = j.mov;
        aviso('Cambios guardados');
      } else {
        const j = await api('add', { mov });
        S.data.movs.push(j.mov);
        const u = leer(LS.ultCat) || {}; u[mov.tipo] = mov.categoria; guardar(LS.ultCat, u);
        aviso((mov.tipo === 'gasto' ? 'Gasto' : 'Ingreso') + ' guardado: ' + Core.eur(mov.importe));
      }
      guardarDatos();
      render();
      if (otro) { $('#mImporte').value = ''; $('#mConcepto').value = ''; rellenarConceptos(); $('#mImporte').focus(); }
      else cerrarHojas();
    } catch (e2) {
      if (e2.code === 'AUTH') claveCaducada();
      else $('#mError').textContent = e2.message;
    } finally { botones.forEach(b => { b.disabled = false; }); }
  }

  async function borrarMov() {
    const b = $('#mBorrar');
    if (!b.dataset.confirmar) {
      b.dataset.confirmar = '1'; b.textContent = 'Pulsa otra vez para eliminar';
      setTimeout(() => { b.dataset.confirmar = ''; b.textContent = 'Eliminar'; }, 4000);
      return;
    }
    b.disabled = true;
    try {
      await api('delete', { id: S.editando.id });
      S.data.movs = S.data.movs.filter(m => m.id !== S.editando.id);
      guardarDatos();
      cerrarHojas(); render(); aviso('Movimiento eliminado');
    } catch (e) { $('#mError').textContent = e.message; }
    finally { b.disabled = false; }
  }

  /* ---------------- hojas, avisos, navegación ---------------- */
  let foco = null;
  function abrirHoja(sel) { foco = document.activeElement; $(sel).hidden = false; document.body.classList.add('con-hoja'); }
  function cerrarHojas() { $$('.hoja-fondo').forEach(h => { h.hidden = true; }); document.body.classList.remove('con-hoja'); if (foco && foco.focus) foco.focus(); }

  let tAviso;
  function aviso(txt, error) {
    const a = $('#aviso');
    a.textContent = txt; a.classList.toggle('error', !!error); a.hidden = false;
    clearTimeout(tAviso); tAviso = setTimeout(() => { a.hidden = true; }, error ? 6000 : 2800);
  }

  function irA(v) {
    S.vista = v;
    $$('.vista').forEach(s => { s.hidden = s.id !== 'v-' + v; });
    $$('.pestanas button').forEach(b => { if (b.dataset.v === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    render();
    window.scrollTo(0, 0);
  }

  function enlazar() {
    $('#formEntrada').addEventListener('submit', entrar);
    $('#formPreparar').addEventListener('submit', preparar);
    $('#formClave').addEventListener('submit', cambiarClave);
    $('#irPreparar').addEventListener('click', () => mostrarPuerta('preparar'));
    $('#irEntrada').addEventListener('click', () => mostrarPuerta('entrada'));
    $$('[data-ver]').forEach(b => b.addEventListener('click', () => {
      const i = document.getElementById(b.dataset.ver);
      const ver = i.type === 'password';
      i.type = ver ? 'text' : 'password';
      b.textContent = ver ? 'Ocultar' : 'Ver';
      i.focus();
    }));
    document.addEventListener('click', async e => {
      if (!e.target.closest('[data-accion="instalar"]')) return;
      if (await Acceso.instalar()) aviso('Instalada. Ya la tienes en tu pantalla de inicio.');
    });
    $('#btnCambiarClave').addEventListener('click', () => { $('#ccError').textContent = ''; abrirHoja('#hojaClave'); setTimeout(() => $('#ccClave1').focus(), 60); });
    $('#btnBajarOtra').addEventListener('click', () => { if (S.accesoNuevo) descargarAcceso(S.accesoNuevo); });
    $('#btnSalir').addEventListener('click', async () => {
      cerrarSesion();
      S.acceso = S.acceso || await Acceso.cargar();
      mostrarPuerta(S.acceso ? 'entrada' : 'preparar');
    });
    $('#btnRecargar').addEventListener('click', async () => { if (await sincronizar(false)) aviso('Datos actualizados'); });

    // periodo
    $('#pAnt').addEventListener('click', () => moverPeriodo(-1));
    $('#pSig').addEventListener('click', () => moverPeriodo(1));
    $('#pTexto').addEventListener('click', abrirPeriodo);
    $('#hpAnt').addEventListener('click', () => { S.pAnio--; pintarHojaPeriodo(); });
    $('#hpSig').addEventListener('click', () => { S.pAnio++; pintarHojaPeriodo(); });
    $('#hpMeses').addEventListener('click', e => { const b = e.target.closest('[data-mes]'); if (!b) return; setFiltro({ anio: S.pAnio, mes: +b.dataset.mes }); cerrarHojas(); });
    $('#hpTodoAnio').addEventListener('click', () => { setFiltro({ anio: S.pAnio, mes: 'all' }); cerrarHojas(); });
    $('#hpTodo').addEventListener('click', () => { setFiltro({ anio: 'all', mes: 'all' }); cerrarHojas(); });

    // filtros de Movimientos
    $('#btnFiltrar').addEventListener('click', abrirFiltro);
    $$('#hojaFiltro input[name="ftipo"]').forEach(r => r.addEventListener('change', () => { setFiltro({ tipo: r.value }); pintarHojaFiltro(); }));
    $('#listaCats').addEventListener('change', () => { setFiltro({ cats: $$('#listaCats input:checked').map(i => i.value) }); pintarHojaFiltro(); });
    $('#fQuitar').addEventListener('click', () => { setFiltro({ tipo: 'all', cats: [] }); pintarHojaFiltro(); });
    $('#chips').addEventListener('click', e => {
      const b = e.target.closest('[data-quitar]'); if (!b) return;
      const q = b.dataset.quitar;
      if (q === 'todo') setFiltro({ tipo: 'all', cats: [] });
      else if (q === 'tipo') setFiltro({ tipo: 'all' });
      else setFiltro({ cats: S.F.cats.filter(k => k !== q) });
    });

    // tocar una categoría del resumen
    ['#gCatGas', '#gCatIng'].forEach(id => {
      $(id).addEventListener('click', e => { const li = e.target.closest('li[data-cat]'); if (li) verCategoria(li.dataset.cat); });
      $(id).addEventListener('keydown', e => { const li = e.target.closest('li[data-cat]'); if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); verCategoria(li.dataset.cat); } });
    });

    // informes
    $('#cAnt').addEventListener('click', () => moverMesInf(-1));
    $('#cSig').addEventListener('click', () => moverMesInf(1));
    $('#aAnt').addEventListener('click', () => { S.inf.anio--; pintarInformes(); });
    $('#aSig').addEventListener('click', () => { S.inf.anio++; pintarInformes(); });
    $('#sIni').addEventListener('change', e => cambiarSaldo(e.target, Core.ymAnterior(S.inf.ym)));
    $('#sFin').addEventListener('change', e => cambiarSaldo(e.target, S.inf.ym));
    $('#sSugerido').addEventListener('click', e => {
      if (!e.target.closest('#sUsar')) return;
      ponerSaldo(S.inf.ym, +$('#sSugerido').dataset.valor);
      $('#sFin').value = fmtSaldo(Core.saldoFin(S.saldos, S.inf.ym));
      pintarInformes();
    });
    ['#infMes', '#infAnio'].forEach(id => $(id).addEventListener('click', e => {
      const b = e.target.closest('.inf-fila'); if (b) abrirInforme(b.dataset.inf, b.dataset.ambito);
    }));
    $('#btnSecretario').addEventListener('click', e => conBoton(e.currentTarget, async () => {
      const doc = docDe('secretario', 'mes');
      descargar(await pdfDe(doc), doc.archivo + '.pdf', MIME_PDF);
    }));
    $('#btnPdf').addEventListener('click', e => conBoton(e.currentTarget, async () => {
      const doc = docDe(S.infSel.id, S.infSel.ambito);
      descargar(await pdfDe(doc), doc.archivo + '.pdf', MIME_PDF);
    }));
    $('#btnXlsx').addEventListener('click', e => conBoton(e.currentTarget, async () => {
      const doc = docDe(S.infSel.id, S.infSel.ambito);
      descargar(XLSXW.crearXlsx([doc], Core.textoCelda), doc.archivo + '.xlsx', MIME_XLSX);
    }));
    $('#btnCompartir').addEventListener('click', e => conBoton(e.currentTarget, async () => {
      const doc = docDe(S.infSel.id, S.infSel.ambito);
      const file = new File([await pdfDe(doc)], doc.archivo + '.pdf', { type: MIME_PDF });
      await navigator.share({ files: [file], title: doc.titulo });
    }));
    $('#btnTodoXlsx').addEventListener('click', e => conBoton(e.currentTarget, async () => {
      const docs = INF_ANIO.map(([id]) => docDe(id, 'anio')).filter(d => !d.vacio);
      if (!docs.length) throw new Error('No hay movimientos en este año.');
      descargar(XLSXW.crearXlsx(docs, Core.textoCelda), `Informes_${S.inf.anio}.xlsx`, MIME_XLSX);
    }));

    $$('.pestanas button').forEach(b => b.addEventListener('click', () => irA(b.dataset.v)));
    $('#fab').addEventListener('click', () => abrirMov(null));
    $('#lista').addEventListener('click', e => {
      const b = e.target.closest('.mov'); if (!b) return;
      abrirMov(S.data.movs.find(m => m.id === b.dataset.id));
    });
    $('#masMovs').addEventListener('click', () => { S.limite += 150; pintarLista(); });
    let tBus; $('#buscar').addEventListener('input', () => { clearTimeout(tBus); tBus = setTimeout(pintarLista, 150); });

    $('#formMov').addEventListener('submit', guardarMov);
    $$('#formMov input[name="tipo"]').forEach(r => r.addEventListener('change', () => rellenarCategorias(r.value, null)));
    $('#mCategoria').addEventListener('change', rellenarConceptos);
    $('#mBorrar').addEventListener('click', borrarMov);
    $$('[data-cerrar]').forEach(b => b.addEventListener('click', cerrarHojas));
    $$('.hoja-fondo').forEach(h => h.addEventListener('click', e => { if (e.target === h) cerrarHojas(); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrarHojas(); });

    let tRes;
    window.addEventListener('resize', () => { clearTimeout(tRes); tRes = setTimeout(() => { if (S.vista === 'resumen' && S.data) pintarResumen(); }, 150); });
    document.addEventListener('visibilitychange', () => { // al volver a la app, refrescar si han pasado 5 min
      if (document.visibilityState === 'visible' && S.cx && S.sync && Date.now() - S.sync > 5 * 60 * 1000) sincronizar(true);
    });
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => { });
  }
  iniciar();
})();
